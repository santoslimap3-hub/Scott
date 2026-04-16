/**
 * build_person_streams.js — Unified per-person event timeline.
 *
 * INPUTS:
 *   data/persons.json                      (from build_persons.js)
 *   data/dm-classified.csv                 (DM source, MM/DD/YYYY dates)
 *   scraper/output/posts_scott_v2.json     (new scraper output)
 *
 * OUTPUT:
 *   data/person_streams.json
 *
 * EVENT SCHEMA:
 *   {
 *     ts:          ISO-8601 string (absolute, UTC-ish)
 *     ts_source:   "dm" | "comment_datetime" | "comment_title" | "post_datetime" | "derived"
 *     channel:     "dm" | "post" | "comment"
 *     direction:   "from_person" | "from_scott"        (only for DM/comment)
 *     speaker:     "lead" | "scott" | "other_member"
 *     text:        message body
 *     postUrl:     (for post/comment events)
 *     postTitle:   (for post/comment events)
 *     commentId:   (for comment events)
 *     bubbleIdx:   0-based index within a same-speaker contiguous run at the same ts,
 *                  used later by the JSONL generator to apply BUBBLE joining.
 *   }
 *
 * RULES:
 *   - Scott's messages are tagged speaker="scott" regardless of channel.
 *   - Company-member-to-company-member streams ARE recorded but flagged as
 *     excludeFromTraining=true. The v7 generator will skip them.
 *   - Unresolved display-only persons are still given streams — they just
 *     won't have slug-based identity for now.
 *   - DM timestamps: parsed as "MM/DD/YYYY HH:MM:SS AM/PM" and ISO-emitted.
 *     If parse fails, the row is dropped and counted.
 *   - Comment timestamps: prefer event.timestampAbsolute (ISO). If that's a
 *     "Fri, Feb 7, 2025 3:14 PM" title we parse via Date. If neither yields
 *     a usable date we fall back to the post's timestamp + a tiny per-thread
 *     offset so within-thread order is preserved. Flagged ts_source="derived".
 *   - Per-thread fallback offset: 1 minute * (thread index) + 10 seconds *
 *     (reply index within thread). Purely for ordering; don't trust the
 *     absolute value.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR        = path.join(ROOT, "data");
const SCRAPER_OUT_DIR = path.join(ROOT, "scraper", "output");
const PERSONS_FILE    = path.join(DATA_DIR, "persons.json");
const COMPANY_FILE    = path.join(DATA_DIR, "company_members.json");
const DM_CSV          = path.join(DATA_DIR, "dm-classified.csv");
const LEGACY_POSTS    = path.join(DATA_DIR, "posts_with_scott_reply_threads.json");
const OUTPUT_FILE     = path.join(DATA_DIR, "person_streams.json");
const OUTPUT_TMP      = OUTPUT_FILE + ".tmp"; // written first, then renamed (atomic)

/**
 * Find all scraper v2 output files in scraper/output/.
 * A valid v2 file has a top-level "posts" array and a "metadata" object.
 * This lets us merge Synthesizer + Self-Improvement-Nation (or any future
 * community) automatically — just point the scraper at each community with
 * a different OUTPUT_FILE name and they all get picked up here.
 *
 * The index file (posts_index_v2.json) is intentionally excluded (no "posts" key).
 */
function findAllV2PostFiles() {
    if (!fs.existsSync(SCRAPER_OUT_DIR)) return [];
    var files = fs.readdirSync(SCRAPER_OUT_DIR)
        .filter(function(f) { return f.endsWith(".json") && !f.includes("index"); })
        .map(function(f) { return path.join(SCRAPER_OUT_DIR, f); });

    var valid = [];
    files.forEach(function(fp) {
        try {
            // Peek only — read first 500 chars to check for the "posts" key
            var peek = fs.readFileSync(fp, "utf8").substring(0, 500);
            if (/"posts"\s*:/.test(peek) && /"metadata"\s*:/.test(peek)) {
                valid.push(fp);
            }
        } catch (_) {}
    });
    return valid;
}

// ─── helpers ───────────────────────────────────────────────────────────────

// LOUD readJSON: logs the actual error if a file exists but fails to parse.
// Silent swallowing was the root cause of the v7/v8 "DM-only" bug.
function readJSON(p, fb) {
    if (!fs.existsSync(p)) return fb;
    var content = fs.readFileSync(p, "utf8");
    // Strip trailing null bytes (Windows/NTFS sparse-file artifact seen in scraper output)
    var trimmed = content.replace(/\0+$/, "");
    try {
        return JSON.parse(trimmed);
    } catch (e) {
        console.error("❌ PARSE ERROR in " + path.basename(p) + ": " + e.message.substring(0, 120));
        console.error("   (returning fallback — this is likely why post/comment data is missing)");
        return fb;
    }
}

function normalizeDisplay(name) {
    if (!name) return "";
    return name.toString().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Returns true if Scott directly participated in a thread — either as the
 * top-level commenter or as one of the replies.
 *
 * Used to filter out noise: a lead's comment on a post Scott touched is only
 * meaningful training context if Scott was actually IN that specific thread.
 * Without this filter, any two people who happened to comment on the same post
 * as Scott would have random cross-talk added to their history.
 *
 * Works for both v2 (slug-based) and legacy (display-name-based) thread shapes.
 */
function threadHasScott(th, scottId) {
    var SCOTT_NORM = normalizeDisplay("Scott Northwolf");
    function isScott(authorSlug, authorDisplay) {
        if (authorSlug && authorSlug.toLowerCase() === scottId) return true;
        if (normalizeDisplay(authorDisplay || "") === SCOTT_NORM) return true;
        return false;
    }
    var c = th.comment || {};
    if (isScott(c.authorSlug, c.authorDisplay || c.author)) return true;
    return (th.replies || []).some(function(r) {
        return isScott(r.authorSlug, r.authorDisplay || r.author);
    });
}

function parseCSV(text) {
    var rows = [],
        row = [],
        field = "",
        inQ = false;
    for (var i = 0; i < text.length; i++) {
        var c = text[i];
        if (inQ) {
            if (c === '"' && text[i + 1] === '"') {
                field += '"';
                i++;
            } else if (c === '"') { inQ = false; } else field += c;
        } else {
            if (c === '"') inQ = true;
            else if (c === ',') {
                row.push(field);
                field = "";
            } else if (c === '\n') {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
            } else if (c === '\r') { /* skip */ } else field += c;
        }
    }
    if (field.length || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

// Parse "11/04/2025" + "10:26:33 PM" → ISO in local time
function parseDmDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    var dm = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!dm) return null;
    var month = parseInt(dm[1], 10),
        day = parseInt(dm[2], 10),
        year = parseInt(dm[3], 10);
    var tm = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (!tm) return null;
    var hour = parseInt(tm[1], 10),
        minute = parseInt(tm[2], 10),
        sec = parseInt(tm[3], 10);
    var ampm = tm[4].toUpperCase();
    if (ampm === "PM" && hour !== 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    var d = new Date(Date.UTC(year, month - 1, day, hour, minute, sec));
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

function parseIsoOrTitle(ts) {
    if (!ts) return null;
    // ISO 8601?
    if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
        var d = new Date(ts);
        if (!isNaN(d.getTime())) return d.toISOString();
    }
    // Title-style "Fri, Feb 7, 2025 3:14 PM"
    var d2 = new Date(ts);
    if (!isNaN(d2.getTime())) return d2.toISOString();
    return null;
}

function offsetIso(baseIso, addSeconds) {
    var d = new Date(baseIso);
    d.setSeconds(d.getSeconds() + addSeconds);
    return d.toISOString();
}

// ─── stream construction ───────────────────────────────────────────────────

function resolvePersonId(persons, displayName, slug) {
    if (slug && persons.persons[slug.toLowerCase()]) return slug.toLowerCase();
    if (!displayName) return null;
    // try name: bucket
    var id = "name:" + normalizeDisplay(displayName);
    if (persons.persons[id]) return id;
    // try any slugged person whose aliases include this display name
    var norm = normalizeDisplay(displayName);
    var match = null;
    Object.values(persons.persons).forEach(function(p) {
        if (match) return;
        if (normalizeDisplay(p.displayName) === norm) match = p.id;
        else if ((p.displayAliases || []).some(function(a) { return normalizeDisplay(a) === norm; })) match = p.id;
    });
    return match || id;
}

function build() {
    console.log("\n🧵 Building person_streams.json ...");

    var personsDoc = readJSON(PERSONS_FILE, null);
    if (!personsDoc || !personsDoc.persons) {
        console.error("persons.json missing — run build_persons.js first");
        process.exit(1);
    }
    var persons = personsDoc;

    // Resolve Scott's canonical ID from company_members.json — never hardcode.
    // His Skool slug is scott-northwolf-3818 (has numeric suffix), NOT scott-northwolf.
    // Hardcoding caused Bug 2: every Scott comment was mis-tagged as speaker="lead".
    var companyDoc = readJSON(COMPANY_FILE, { members: [] });
    var scottMember = (companyDoc.members || []).find(function(m) {
        return (m.displayName || "").toLowerCase().indexOf("scott") !== -1 &&
               (m.role || "").indexOf("ceo") !== -1;
    });
    var scottId = scottMember ? scottMember.slug : null;
    if (!scottId) {
        console.error("❌ Could not find Scott's slug in company_members.json. Post events won't be tagged correctly.");
        process.exit(1);
    }
    // Also add Scott to persons map if not already present (needed for stream creation)
    if (!persons.persons[scottId]) {
        persons.persons[scottId] = {
            id: scottId, slug: scottId, displayName: "Scott Northwolf",
            role: "company-member:ceo", gender: "male", sources: ["company_members"],
        };
    }
    console.log("  Scott canonical ID:    " + scottId);

    function isCompany(id) {
        var p = persons.persons[id];
        return p && p.role && p.role.indexOf("company-member") === 0;
    }

    // streams: id → { person, events[], excludeFromTraining }
    var streams = {};

    function streamFor(id) {
        if (!streams[id]) {
            var p = persons.persons[id] || { id: id, slug: null, displayName: id.startsWith("name:") ? id.slice(5) : id, role: "lead", gender: "male" };
            streams[id] = { person: p, events: [], excludeFromTraining: false };
        }
        return streams[id];
    }

    // ─── DM events ─────────────────────────────────────────────────────────
    var dmParsedCount = 0,
        dmFailCount = 0,
        dmCompanyCompany = 0;
    if (fs.existsSync(DM_CSV)) {
        var rows = parseCSV(fs.readFileSync(DM_CSV, "utf8"));
        var header = rows[0];
        var iDate = header.indexOf("Date"),
            iTime = header.indexOf("Time"),
            iContact = header.indexOf("Contact"),
            iSpeaker = header.indexOf("Speaker"),
            iMessage = header.indexOf("Message");
        if ([iDate, iTime, iContact, iSpeaker, iMessage].some(function(v) { return v === -1; })) {
            console.error("DM CSV header mismatch: " + header.join(","));
        } else {
            for (var i = 1; i < rows.length; i++) {
                var r = rows[i];
                if (r.length < 5) continue;
                var iso = parseDmDateTime(r[iDate], r[iTime]);
                if (!iso) { dmFailCount++; continue; }
                var contactName = (r[iContact] || "").trim();
                var speakerRaw = (r[iSpeaker] || "").trim().toLowerCase();
                var msg = r[iMessage] || "";
                if (!contactName || !msg) continue;
                var pid = resolvePersonId(persons, contactName, null);
                if (!pid) continue;
                var stream = streamFor(pid);
                var speaker, direction;
                if (speakerRaw === "scott") {
                    speaker = "scott";
                    direction = "from_scott";
                } else {
                    speaker = "lead";
                    direction = "from_person";
                }
                // If person is a company member and Scott is the other side, flag stream
                if (isCompany(pid) && pid !== scottId) {
                    stream.excludeFromTraining = true;
                    dmCompanyCompany++;
                }
                stream.events.push({
                    ts: iso,
                    ts_source: "dm",
                    channel: "dm",
                    direction: direction,
                    speaker: speaker,
                    text: msg,
                });
                dmParsedCount++;
            }
        }
    }
    console.log("  DM events parsed:      " + dmParsedCount);
    console.log("  DM rows failed:        " + dmFailCount);
    console.log("  DM company×company:    " + dmCompanyCompany + " (marked excludeFromTraining)");

    // ─── Post / comment events from v2 scrape ──────────────────────────────
    var postEvents = 0,
        commentEvents = 0,
        replyEvents = 0,
        tsDerived = 0;

    // ─── v2 scraper files (multi-community) ────────────────────────────────
    // We scan the entire scraper/output/ directory for valid v2 files so
    // Synthesizer + Self-Improvement-Nation + any future community are all
    // included automatically. Name your scraper output files anything — as
    // long as they have "posts" and "metadata" keys they will be loaded.
    var v2Files = findAllV2PostFiles();
    if (v2Files.length === 0) {
        console.log("⚠  no v2 scraper output files found in scraper/output/ — post/comment events will be missing");
        console.log("   Run: node scraper/scraper_v2.js  (for each community)");
    } else {
        console.log("  v2 scraper files found: " + v2Files.length);
        v2Files.forEach(function(fp) { console.log("    " + path.basename(fp)); });
    }

    // Merge all v2 post arrays
    var allV2Posts = [];
    v2Files.forEach(function(fp) {
        var v2 = readJSON(fp, null);
        if (!v2 || !Array.isArray(v2.posts)) {
            console.error("  ❌ skipping " + path.basename(fp) + " — not a valid v2 post file");
            return;
        }
        console.log("  " + path.basename(fp) + ": " + v2.posts.length + " posts (community: " + (v2.metadata && v2.metadata.community || "?") + ")");
        allV2Posts = allV2Posts.concat(v2.posts);
    });
    console.log("  total v2 posts to process: " + allV2Posts.length);

    if (allV2Posts.length > 0) {
        allV2Posts.forEach(function(postData, postIdx) {
            var post = postData.post;
            var postIso = parseIsoOrTitle(post.timestampAbsolute);
            if (!postIso) { postIso = post.scrapedAt || new Date().toISOString(); }

            // post event goes to the ORIGINAL AUTHOR's stream
            var authorId = resolvePersonId(persons, post.authorDisplay, post.authorSlug);
            if (authorId) {
                var authorStream = streamFor(authorId);
                var speakerForAuthor = (authorId === scottId) ? "scott" : (isCompany(authorId) ? "other_member" : "lead");
                authorStream.events.push({
                    ts: postIso,
                    ts_source: post.timestampAbsolute ? "post_datetime" : "derived",
                    channel: "post",
                    direction: "from_person",
                    speaker: speakerForAuthor,
                    text: (post.title ? post.title + "\n\n" : "") + (post.body || ""),
                    postUrl: post.url,
                    postTitle: post.title,
                });
                postEvents++;
            }

            // iterate threads in array order — used for fallback ordering
            postData.threads.forEach(function(th, tIdx) {
                // Only process threads where Scott directly participated.
                // Skipping threads he didn't touch avoids adding unrelated
                // cross-talk (two random leads commenting on the same post)
                // to either person's history stream.
                if (!threadHasScott(th, scottId)) return;

                // top-level comment
                var tIso = parseIsoOrTitle(th.comment.timestampAbsolute) ||
                    offsetIso(postIso, 60 * (tIdx + 1));
                var tSource = th.comment.timestampAbsolute ? "comment_datetime" : "derived";
                if (!th.comment.timestampAbsolute) tsDerived++;
                var cAuthorId = resolvePersonId(persons, th.comment.authorDisplay, th.comment.authorSlug);
                if (cAuthorId) {
                    var cs = streamFor(cAuthorId);
                    var cSpeaker = (cAuthorId === scottId) ? "scott" : (isCompany(cAuthorId) ? "other_member" : "lead");
                    cs.events.push({
                        ts: tIso,
                        ts_source: tSource,
                        channel: "comment",
                        direction: (cAuthorId === scottId ? "from_scott" : "from_person"),
                        speaker: cSpeaker,
                        text: th.comment.content,
                        postUrl: post.url,
                        postTitle: post.title,
                        commentId: th.comment.id,
                        parentCommentId: null,
                    });
                    commentEvents++;
                }

                // replies
                th.replies.forEach(function(reply, rIdx) {
                    var rIso = parseIsoOrTitle(reply.timestampAbsolute) ||
                        offsetIso(tIso, 10 * (rIdx + 1));
                    var rSource = reply.timestampAbsolute ? "comment_datetime" : "derived";
                    if (!reply.timestampAbsolute) tsDerived++;
                    var rAuthorId = resolvePersonId(persons, reply.authorDisplay, reply.authorSlug);
                    if (!rAuthorId) return;
                    var rs = streamFor(rAuthorId);
                    var rSpeaker = (rAuthorId === scottId) ? "scott" : (isCompany(rAuthorId) ? "other_member" : "lead");
                    // Is this a company×company stream?
                    if (isCompany(rAuthorId) && rAuthorId !== scottId) rs.excludeFromTraining = true;

                    rs.events.push({
                        ts: rIso,
                        ts_source: rSource,
                        channel: "comment",
                        direction: (rAuthorId === scottId ? "from_scott" : "from_person"),
                        speaker: rSpeaker,
                        text: reply.content,
                        postUrl: post.url,
                        postTitle: post.title,
                        commentId: reply.id,
                        parentCommentId: reply.parentId || th.comment.id || null,
                    });
                    replyEvents++;

                    // ALSO, because Scott's reply is INSIDE someone else's thread,
                    // we mirror Scott's reply into THAT someone's stream (otherwise
                    // the lead's stream has no Scott interaction record for post comments).
                    if (rAuthorId === scottId && cAuthorId && cAuthorId !== scottId) {
                        var otherStream = streamFor(cAuthorId);
                        otherStream.events.push({
                            ts: rIso,
                            ts_source: rSource,
                            channel: "comment",
                            direction: "from_scott",
                            speaker: "scott",
                            text: reply.content,
                            postUrl: post.url,
                            postTitle: post.title,
                            commentId: reply.id,
                            parentCommentId: reply.parentId || th.comment.id || null,
                            mirroredFromThread: true,
                        });
                    }
                });

                // Mirror Scott's top-level comments as a touchpoint in the post author's stream
                // (already covered above since the comment already enters cs stream;
                // but if cs is Scott, the post author's stream also needs to see it
                // because that lead posted something and Scott replied in the comments.
                // The case where Scott commented top-level on a lead's post).
                if (cAuthorId === scottId && authorId && authorId !== scottId) {
                    var authorStream2 = streamFor(authorId);
                    authorStream2.events.push({
                        ts: tIso,
                        ts_source: tSource,
                        channel: "comment",
                        direction: "from_scott",
                        speaker: "scott",
                        text: th.comment.content,
                        postUrl: post.url,
                        postTitle: post.title,
                        commentId: th.comment.id,
                        parentCommentId: null,
                        mirroredFromThread: true,
                    });
                }
            });
        });
    } // end if allV2Posts.length > 0

    // ─── Fallback: legacy posts_with_scott_reply_threads.json (SIN data) ──
    // This file has no slugs and no absolute timestamps but has real content.
    // Use it to fill gaps until a fresh SIN scrape with scraper_v2 is done.
    // Timestamps are derived (post's relative string → scrapedAt anchor → offsets).
    // The legacy file IS recognized and parsed separately so the v2 scrape of
    // Synthesizer and the legacy SIN data can coexist without duplication.
    var legacyPostEvents = 0, legacyCommentEvents = 0, legacyReplyEvents = 0;
    var LEGACY_ANCHOR = "2026-01-01T00:00:00.000Z"; // safe fallback anchor if no better date
    var legacy = readJSON(LEGACY_POSTS, null);
    if (legacy && Array.isArray(legacy)) {
        console.log("  legacy posts found:    " + legacy.length + " (SIN, display-name only, derived timestamps)");
        legacy.forEach(function(postData, postIdx) {
            if (!postData.scott_involved) return; // skip posts without Scott
            var origPost = postData.original_post || {};
            var postAnchor = LEGACY_ANCHOR; // no absolute timestamp available in legacy format
            // Derive a plausible post date from the raw "2d •" / "Feb 12 •" string
            // We can't know the scrape date from the file itself so we fall back to anchor.
            // This is acceptable — within-thread order is preserved, cross-channel ordering
            // will be approximate until a fresh scrape with scraper_v2 replaces this data.

            var postAuthorDisplay = origPost.author || "";
            var postAuthorId = resolvePersonId(persons, postAuthorDisplay, null);

            (postData.threads || []).forEach(function(th, tIdx) {
                // Same filter as v2: skip threads Scott wasn't directly in.
                if (!threadHasScott(th, scottId)) return;

                var comment = th.comment || {};
                var commentAuthorDisplay = comment.author || "";
                if (!commentAuthorDisplay) return;

                var tIso = offsetIso(postAnchor, postIdx * 3600 + tIdx * 60);
                var cAuthorId = resolvePersonId(persons, commentAuthorDisplay, null);
                if (!cAuthorId) return;

                var cSpeaker = (normalizeDisplay(commentAuthorDisplay) === normalizeDisplay("Scott Northwolf"))
                    ? "scott" : (isCompany(cAuthorId) ? "other_member" : "lead");
                // If this is Scott's comment we need to map it to scottId
                if (cSpeaker === "scott") cAuthorId = scottId;

                var cs = streamFor(cAuthorId);
                cs.events.push({
                    ts: tIso, ts_source: "derived", channel: "comment",
                    direction: cSpeaker === "scott" ? "from_scott" : "from_person",
                    speaker: cSpeaker, text: comment.content || "",
                    postUrl: origPost.url || null, postTitle: origPost.title || "",
                    commentId: null, parentCommentId: null, legacy: true,
                });
                legacyCommentEvents++;

                // Mirror Scott top-level comment to the post author's stream
                if (cSpeaker === "scott" && postAuthorId && postAuthorId !== scottId) {
                    streamFor(postAuthorId).events.push({
                        ts: tIso, ts_source: "derived", channel: "comment",
                        direction: "from_scott", speaker: "scott", text: comment.content || "",
                        postUrl: origPost.url || null, postTitle: origPost.title || "",
                        mirroredFromThread: true, legacy: true,
                    });
                }

                // replies
                (th.replies || []).forEach(function(reply, rIdx) {
                    var replyAuthorDisplay = reply.author || "";
                    if (!replyAuthorDisplay) return;
                    var rIso = offsetIso(tIso, 10 * (rIdx + 1));
                    var rSpeaker = (normalizeDisplay(replyAuthorDisplay) === normalizeDisplay("Scott Northwolf"))
                        ? "scott" : "lead";
                    var rAuthorId = rSpeaker === "scott" ? scottId : resolvePersonId(persons, replyAuthorDisplay, null);
                    if (!rAuthorId) return;

                    var rs = streamFor(rAuthorId);
                    rs.events.push({
                        ts: rIso, ts_source: "derived", channel: "comment",
                        direction: rSpeaker === "scott" ? "from_scott" : "from_person",
                        speaker: rSpeaker, text: reply.content || "",
                        postUrl: origPost.url || null, postTitle: origPost.title || "",
                        legacy: true,
                    });
                    legacyReplyEvents++;

                    // Mirror Scott reply into the top-level commenter's stream
                    if (rSpeaker === "scott" && cAuthorId !== scottId) {
                        streamFor(cAuthorId).events.push({
                            ts: rIso, ts_source: "derived", channel: "comment",
                            direction: "from_scott", speaker: "scott", text: reply.content || "",
                            postUrl: origPost.url || null, postTitle: origPost.title || "",
                            mirroredFromThread: true, legacy: true,
                        });
                    }
                });
            });
        });
        console.log("  legacy comment events: " + legacyCommentEvents);
        console.log("  legacy reply events:   " + legacyReplyEvents);
    } else {
        console.log("⚠  no legacy posts file found");
    }

    console.log("  post events (v2):      " + postEvents);
    console.log("  comment events (v2):   " + commentEvents);
    console.log("  reply events (v2):     " + replyEvents);
    console.log("  derived timestamps:    " + tsDerived + " (no absolute time found)");

    // ─── Sort and assign bubble indices within same-speaker contiguous runs ─
    Object.values(streams).forEach(function(s) {
        s.events.sort(function(a, b) { return a.ts < b.ts ? -1 : (a.ts > b.ts ? 1 : 0); });
        // bubble index: within a contiguous run of same speaker+channel, assign 0..N
        var runSpeaker = null,
            runChannel = null,
            runIdx = 0;
        s.events.forEach(function(ev) {
            if (ev.speaker === runSpeaker && ev.channel === runChannel) {
                runIdx++;
            } else {
                runSpeaker = ev.speaker;
                runChannel = ev.channel;
                runIdx = 0;
            }
            ev.bubbleIdx = runIdx;
        });
    });

    // ─── Write output ──────────────────────────────────────────────────────
    var out = {
        generatedAt: new Date().toISOString(),
        counts: {
            persons: Object.keys(streams).length,
            totalEvents: Object.values(streams).reduce(function(s, st){ return s + st.events.length; }, 0),
            excludedStreams: Object.values(streams).filter(function(s){ return s.excludeFromTraining; }).length,
        },
        streams: streams,
    };
    // Atomic write: write to .tmp then rename so a crash mid-write never
    // leaves a corrupt OUTPUT_FILE (this was Bug 1 in the v7/v8 diagnosis).
    var serialized = JSON.stringify(out, null, 2);
    fs.writeFileSync(OUTPUT_TMP, serialized);
    fs.renameSync(OUTPUT_TMP, OUTPUT_FILE);
    console.log("\n📊 streams summary");
    console.log("   persons:            " + out.counts.persons);
    console.log("   total events:       " + out.counts.totalEvents);
    console.log("   excluded streams:   " + out.counts.excludedStreams + " (company×company, not used for training)");
    console.log("💾 wrote " + OUTPUT_FILE + " (atomic rename from .tmp — no partial-write risk)");
}

build();