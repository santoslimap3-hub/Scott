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
const DATA_DIR = path.join(ROOT, "data");
const PERSONS_FILE = path.join(DATA_DIR, "persons.json");
const DM_CSV = path.join(DATA_DIR, "dm-classified.csv");
const V2_POSTS = path.join(ROOT, "scraper", "output", "fresh_skool_data.json");
const OUTPUT_FILE = path.join(DATA_DIR, "person_streams.json");

// ─── helpers ───────────────────────────────────────────────────────────────

function readJSON(p, fb) { if (!fs.existsSync(p)) return fb; try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fb; } }

function normalizeDisplay(name) {
    if (!name) return "";
    return name.toString().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
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

    // Scott's id
    var scottId = "scott-northwolf";
    if (!persons.persons[scottId]) {
        console.error("⚠  persons.json has no 'scott-northwolf' entry. Check company_members.json.");
        // still proceed with a synthetic entry so Scott messages resolve
        persons.persons[scottId] = { id: scottId, slug: scottId, displayName: "Scott Northwolf", role: "company-member:ceo", gender: "male" };
    }

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
    var v2 = readJSON(V2_POSTS, null);
    if (v2 && v2.posts) {
        v2.posts.forEach(function(postData, postIdx) {
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
    } else {
        console.log("⚠  no v2 posts file — stream will be DM-only");
    }
    console.log("  post events:           " + postEvents);
    console.log("  comment events:        " + commentEvents);
    console.log("  reply events:          " + replyEvents);
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
            totalEvents: Object.values(streams).reduce(function(s, st) { return s + st.events.length; }, 0),
            excludedStreams: Object.values(streams).filter(function(s) { return s.excludeFromTraining; }).length,
        },
        streams: streams,
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
    console.log("\n📊 streams summary");
    console.log("   persons:            " + out.counts.persons);
    console.log("   total events:       " + out.counts.totalEvents);
    console.log("   excluded streams:   " + out.counts.excludedStreams + " (company×company, not used for training)");
    console.log("💾 wrote " + OUTPUT_FILE);
}

build();