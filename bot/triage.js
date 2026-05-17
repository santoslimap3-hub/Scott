// triage.js  -- v2.1 (value-flex targeting + hard-skip pre-filter)
// ────────────────────────────────────────────────────────────────────────────
// Phase 1: Collect warm-signal notification items (someone replied to us or
//          @-mentioned us). Highest-priority leads each cycle.
//
// Phase 2: Batched LLM triage of feed posts.
//
// New v2 schema for feed posts (per AUTO_REPLY_V2_UNIFIED_PLAN.md §2):
//   {
//     label:      "value-flex" | "hook" | "ignore",
//     topic:      "discipline" | "money-mindset" | "client-acquisition" |
//                 "offer-creation" | "self-image" | "sales-call" | "habits" |
//                 "coaching-philosophy" | "general" | "off-topic",
//     flex_score: 0-3,    // 0 = nothing useful to add; 3 = clear high-value insight
//     reason:     "<= 12 words"
//   }
//
// Filtering rule used by the caller:
//   - Reject any value-flex with flex_score < 2.
//   - Hook posts pass through regardless of flex_score (rare buying signals).
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const {
    clickNotificationBell,
    getNotificationItems,
    markNotificationsRead,
    sleep,
} = require("./skool_browser");

const VALID_LABELS = ["value-flex", "hook", "ignore"];
const VALID_TOPICS = [
    "discipline",
    "money-mindset",
    "client-acquisition",
    "offer-creation",
    "self-image",
    "sales-call",
    "habits",
    "coaching-philosophy",
    "general",
    "off-topic",
];

const BOT_EXPERTISE = [
    "Bot expertise: helping coaches, consultants, and online business builders",
    "go from $0 to $10K/month — offer creation, client acquisition without ads,",
    "sales call frameworks, identity-based self-improvement, daily systems,",
    "and the inner game of high performance. Adjacent niches absolutely count:",
    "leadership coaches, sales coaches, marketing coaches, life coaches,",
    "fitness/health coaches, mindset coaches, course creators, agency owners,",
    "freelancers building service businesses, anyone selling 1:1 or group",
    "coaching. The ICP is anyone in the personal-growth, coaching, or solo",
    "business-building space — not only narrow self-improvement coaches.",
].join(" ");

// Genuinely-no-engagement-value posts: passive content drops, not people.
// Note: bare intros/greetings ARE engageable when the author is ICP, so they
// no longer auto-suppress deep triage.
//
// Additions confirmed by the 2026-04-29 718-post engagement audit (see
// `What Scott Actually Replies To`): accountability series, synthesizer dailies,
// weekly/saturday call logistics, and "level up" / city-drop prompts all had
// 0-2% engagement rates from Scott. Cheap to skip without false-skip risk.
const DEEP_TRIAGE_IGNORE_HINTS = [
    "replay", "workbook", "resource drop", "bootcamp", "summit",
    "day 1 replay", "day 2 replay", "day 3 replay",
    // additions confirmed by data:
    "accountability", "synthesizer dai", "weekly call", "saturday call",
    "community call", "strong-end", "happy weekend", "happy friday",
    "level up", "please like", "drop your city", "where are you from",
];

// ── Hard-skip pre-filter (no LLM call) ──────────────────────────────────────
//
// Calibrated against the 2026-04-29 audit (Synthesizer = 599 posts, 1.8%
// reply rate; SIN = 75 member posts, 61% reply rate). The categories and
// title patterns below cover ~93% of Synthesizer's feed at <2.5% engagement
// rates and have effectively zero false-skip risk on the audited dataset.
// Scope: per-community for categories (only Synthesizer needs them — Scott
// engages liberally inside SIN); title patterns apply globally because
// they're shape-specific (e.g. "Day 12 update", "weekly community call")
// and Skool doesn't reuse those across his SIN community.

const HARD_SKIP_CATEGORIES_BY_COMMUNITY = {
    // Match against emoji-stripped, lowercased category text.
    "synthesizer": [
        "fun",                // 1.9% engagement (1/53)
        "networking",         // 2.3% engagement (3/128)
        "wins",               // 1.5% engagement (1/66)
        "other",              // 1.3% engagement (3/231)
        "audience growth",    // 1.3% engagement (1/77)
    ],
};

const HARD_SKIP_TITLE_PATTERNS = [
    /\bday\s*\d+\b/i,                              // 0/17 — perfect skip
    /\baccountability\b/i,                         // 0/24 — perfect skip
    /synthesizer\s+dai/i,                          // 0/15 — perfect skip
    /[💥📈]\s*synthesizer/i,                       // catches the emoji-prefixed daily series
    /\bweekly\s+(?:call|community)\b/i,
    /\bsaturday\s+call\b/i,
    /\b(?:replay|workbook|resource\s+drop)\b/i,
];

// Host authors get a -1 flex-floor boost for their own community. Lea Newkirk
// is the SIN community manager — Scott engages 22/61 of her posts (36%) even
// when the post itself is low-effort host chatter.
const HOST_AUTHORS_BY_COMMUNITY = {
    "self-improvement-nation": ["Lea Newkirk"],
};

function stripEmojiAndLower(text) {
    return stripEmoji(text || "").toLowerCase();
}

function isHardSkipCategory(category, communityKey) {
    var skipList = HARD_SKIP_CATEGORIES_BY_COMMUNITY[communityKey] || [];
    if (skipList.length === 0) return false;
    var stripped = stripEmojiAndLower(category);
    return skipList.indexOf(stripped) !== -1;
}

function isHardSkipTitle(title) {
    if (!title) return false;
    for (var i = 0; i < HARD_SKIP_TITLE_PATTERNS.length; i++) {
        if (HARD_SKIP_TITLE_PATTERNS[i].test(title)) return true;
    }
    return false;
}

/**
 * Mark hard-skip posts in place. Sets label/topic/flex_score/reason and a
 * `preFiltered` flag so the caller can route around the LLM classifier.
 *
 *   preFilterHardSkips(allPosts, "synthesizer")
 *
 * On a typical 30-post Synthesizer page this drops ~25 posts before the
 * classifier runs, cutting LLM cost roughly 80% per cycle.
 */
function preFilterHardSkips(posts, communityKey) {
    if (!Array.isArray(posts)) return posts;
    for (var i = 0; i < posts.length; i++) {
        var p = posts[i];
        if (!p) continue;
        if (isHardSkipCategory(p.category, communityKey)) {
            p.label      = "ignore";
            p.topic      = "off-topic";
            p.flex_score = 0;
            p.reason     = "hard-skip category " + (p.category || "?");
            p.preFiltered = true;
            continue;
        }
        if (isHardSkipTitle(p.title)) {
            p.label      = "ignore";
            p.topic      = "off-topic";
            p.flex_score = 0;
            p.reason     = "hard-skip title pattern";
            p.preFiltered = true;
        }
    }
    return posts;
}

const DEEP_TRIAGE_SIGNAL_HINTS = [
    "help", "how ", "what ", "why ", "question",
    "coach", "client", "offer", "sales", "selling",
    "business", "grow", "scale", "prompt", "stuck", "struggl",
    "money", "human connection", "level",
    // Coach-intro and ICP signal words — these flag posts worth opening
    // for full body so we can decide whether the author is ICP.
    "introduce", "introducing", "new here", "happy to be here", "founder",
    "consultant", "trainer", "entrepreneur", "started", "building",
    "service", "agency", "course", "freelance", "mentor", "intro",
];

// ── Phase 1: notifications ───────────────────────────────────────────────────

async function collectEngagements(page, botNames) {
    var allNames = Array.isArray(botNames) ? botNames : [botNames];
    console.log("Phase 1 -- checking notifications...");

    var opened = await clickNotificationBell(page);
    if (!opened) {
        console.log("  [warn] Could not open notification bell\n");
        return [];
    }

    await sleep(1500);
    var items = await getNotificationItems(page);
    await markNotificationsRead(page);

    var engagements = [];
    var filterStats = {
        total: items.length,
        no_href: 0,
        not_post_thread: 0,
        not_engagement: 0,
        no_author: 0,
        kept: 0,
    };
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item.href) {
            filterStats.no_href++;
            continue;
        }
        if (!isPostThreadHref(item.href)) {
            filterStats.not_post_thread++;
            continue;
        }

        var lowerText = (item.text || "").toLowerCase();
        var isEngagement = (
            lowerText.includes("replied") ||
            lowerText.includes("mentioned") ||
            lowerText.includes("commented")
        );
        if (!isEngagement) {
            filterStats.not_engagement++;
            // Common but quiet: likes, follows, new posts. Log first 60 chars
            // so unexpected patterns (e.g. new verbs Skool starts using) get
            // surfaced rather than silently dropped.
            console.log("    [skip non-engagement] \"" + (item.text || "").substring(0, 60).replace(/\s+/g, " ") + "\"");
            continue;
        }

        var authorName = extractAuthorFromNotifText(item.text, allNames);
        if (!authorName) {
            filterStats.no_author++;
            console.log("    [skip no-author] \"" + (item.text || "").substring(0, 80).replace(/\s+/g, " ") + "\"");
            continue;
        }

        var commentText = extractCommentTextFromNotifText(item.text, authorName);
        engagements.push({
            authorName:  authorName,
            postHref:    item.href.split("?")[0],
            snippet:     (item.text || "").substring(0, 120),
            commentText: commentText,
        });
        filterStats.kept++;
        console.log("    [keep] " + authorName + " — \"" + (commentText || "").substring(0, 70).replace(/\s+/g, " ") + "\"");
    }

    console.log("  Filter stats: " + filterStats.total + " items → " +
        filterStats.kept + " engagements" +
        " (skipped: " + filterStats.not_engagement + " non-engagement, " +
        filterStats.not_post_thread + " non-post-thread, " +
        filterStats.no_href + " no-href, " +
        filterStats.no_author + " no-author)");
    console.log("  Found " + engagements.length + " engagement notification(s)\n");
    return engagements;
}

function isPostThreadHref(href) {
    if (!href || typeof href !== "string") return false;
    var lowerHref = href.toLowerCase();
    if (lowerHref.indexOf("skool.com/") === -1) return false;
    if (/\/chat(\?|$|\/)/.test(lowerHref)) return false;
    if (lowerHref.indexOf("/@") !== -1) return false;
    return /skool\.com\/[^/]+\/[^/?#]+/.test(lowerHref);
}

// Strip emoji / pictographs / variation selectors from a string. Skool users
// often decorate their display names with emoji ("Hil Kane 🔥"), and the leading
// snippet of a notification embeds that decoration verbatim, which used to
// break the author regex below.
function stripEmoji(text) {
    return (text || "")
        // common emoji / pictograph blocks
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F0FF}]/gu, "")
        // variation selectors, ZWJ, regional indicator pairs
        .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, "")
        // miscellaneous symbols / dingbats stragglers
        .replace(/[✀-➿⌀-⏿]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function extractAuthorFromNotifText(text, botNames) {
    var clean = stripEmoji((text || "").trim());
    var match = clean.match(/^([A-Z][a-zA-ZÀ-ÿ''-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ''-]+){0,2})\s+(?:replied|commented|mentioned|liked|reacted)/);
    if (!match) return null;

    var name = match[1].trim();
    for (var i = 0; i < botNames.length; i++) {
        if (botNames[i] && name.toLowerCase() === botNames[i].toLowerCase()) return null;
    }
    return name;
}

function extractCommentTextFromNotifText(text, authorName) {
    var clean = stripEmoji(normalizeFeedText(text));
    if (!clean) return "";

    var authorPattern = escapeRegExp(authorName || "");
    if (authorPattern) {
        clean = clean.replace(
            new RegExp("^" + authorPattern + "\\s+(?:replied|commented|mentioned)(?:\\s+you)?(?:\\s+in\\s+reply)?", "i"),
            ""
        ).trim();
    }

    clean = clean.replace(/^[·\-–—\s]+/, "");
    clean = clean.replace(/^(?:just now|\d+\s*[smhdw])\b[·\-–—\s]*/i, "").trim();

    if (!clean || normalizeSpaces(clean) === normalizeSpaces(text)) {
        var fallback = normalizeSpaces(text).match(/\b(?:just now|\d+\s*[smhdw])\b[·\-–—\s]*(.+)$/i);
        if (fallback && fallback[1]) clean = fallback[1].trim();
    }

    return clean.substring(0, 120);
}

function normalizeSpaces(text) { return (text || "").replace(/\s+/g, " ").trim(); }
function escapeRegExp(text)   { return (text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeFeedText(text) {
    return (text || "")
        .replace(/Â/g, "")
        .replace(/[   ]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanFeedCardBody(body, title) {
    var cleaned = normalizeFeedText(body);
    var cleanTitle = normalizeFeedText(title);

    if (!cleaned) return "";

    if (cleanTitle) {
        var lowerBody = cleaned.toLowerCase();
        var lowerTitle = cleanTitle.toLowerCase();
        var titleIndex = lowerBody.indexOf(lowerTitle);
        if (titleIndex !== -1) {
            cleaned = cleaned.substring(titleIndex + cleanTitle.length).trim();
        }
    }

    cleaned = cleaned
        .replace(/\b(?:last comment|new comment)\b.*$/i, "")
        .replace(/\b\d+\s*(?:new\s+)?comments?\b.*$/i, "")
        .replace(/\b\d+\s*likes?\b.*$/i, "")
        .replace(/\bjump to latest\b.*$/i, "")
        .trim();

    return cleaned;
}

// ── Author-history features for the prompt ───────────────────────────────────

function authorContextLine(post) {
    var ctx = post.authorContext || {};
    var bits = [];
    if (typeof ctx.stage === "number") bits.push("stage=" + ctx.stage);
    if (ctx.prevReplied) bits.push("we-replied-before");
    if (ctx.prevEngaged) bits.push("they-engaged-back");
    if (typeof ctx.lastInteractionDays === "number") bits.push("last=" + ctx.lastInteractionDays + "d");
    if (bits.length === 0) return "AuthorContext: new (no prior interactions)";
    return "AuthorContext: " + bits.join(" ");
}

function buildPostPromptBlock(post, index) {
    var author    = normalizeFeedText(post.author) || "Unknown";
    var category  = normalizeFeedText(post.category) || "General";
    var title     = normalizeFeedText(post.title) || "(untitled)";
    var body      = cleanFeedCardBody(post.body, post.title);

    return [
        "POST " + index,
        "Author: " + author,
        "Category: " + category,
        "Title: " + title,
        "Body: " + (body || "(empty)"),
        authorContextLine(post),
    ].join("\n");
}

// ── Sanitize one classifier result ───────────────────────────────────────────

function normalizeLabel(label) {
    var safe = (label || "").toString().trim().toLowerCase();
    // Backwards-compat: some callers / older prompts may emit "value"
    if (safe === "value") return "value-flex";
    if (VALID_LABELS.indexOf(safe) !== -1) return safe;
    return "ignore";
}

function normalizeTopic(topic) {
    var safe = (topic || "").toString().trim().toLowerCase();
    if (VALID_TOPICS.indexOf(safe) !== -1) return safe;
    return "general";
}

function normalizeFlexScore(score) {
    var n = parseInt(score, 10);
    if (isNaN(n) || n < 0) return 0;
    if (n > 3) return 3;
    return n;
}

function shouldDeepInspectPost(post) {
    if (!post || normalizeLabel(post.label) !== "ignore") return false;
    // Pre-filtered hard-skips were dropped on purpose — never reconsider them.
    if (post.preFiltered) return false;

    var title = normalizeFeedText(post.title).toLowerCase();
    var body  = cleanFeedCardBody(post.body, post.title).toLowerCase();
    var haystack = (title + " " + body).trim();

    if (!haystack) return false;
    if (DEEP_TRIAGE_IGNORE_HINTS.some(function(hint) { return title.indexOf(hint) !== -1; })) return false;
    if (haystack.indexOf("?") !== -1) return true;

    return DEEP_TRIAGE_SIGNAL_HINTS.some(function(hint) {
        return haystack.indexOf(hint) !== -1;
    });
}

function pickDeepTriageCandidates(posts, limit) {
    limit = typeof limit === "number" && limit > 0 ? limit : 5;

    return (posts || [])
        .filter(shouldDeepInspectPost)
        .sort(function(a, b) {
            var aComments = typeof a.commentCount === "number" ? a.commentCount : 0;
            var bComments = typeof b.commentCount === "number" ? b.commentCount : 0;
            if (bComments !== aComments) return bComments - aComments;

            var aBodyLen = cleanFeedCardBody(a.body, a.title).length;
            var bBodyLen = cleanFeedCardBody(b.body, b.title).length;
            return bBodyLen - aBodyLen;
        })
        .slice(0, limit);
}

// ── Phase 2: batched LLM triage ──────────────────────────────────────────────

async function triagePosts(openai, posts, modelName, options) {
    if (!posts || posts.length === 0) return posts || [];
    modelName = modelName || "opus-4.7";
    options = options || {};

    var contextLabel = options.contextLabel ? " (" + options.contextLabel + ")" : "";
    console.log("[TRIAGE] Phase 2 - triaging " + posts.length + " posts" + contextLabel + "...");

    // Batch in chunks of BATCH_SIZE so the model never has to fit a 90-post
    // results array into a single token-capped response. One batch failing
    // (parse error, timeout) leaves the others' results intact.
    var BATCH_SIZE = 25;
    if (posts.length > BATCH_SIZE) {
        for (var b = 0; b < posts.length; b += BATCH_SIZE) {
            var batch = posts.slice(b, b + BATCH_SIZE);
            // Re-call recursively per batch — relies on the single-batch path
            // below executing when batch.length <= BATCH_SIZE.
            try {
                await triagePosts(openai, batch, modelName, {
                    contextLabel: (options.contextLabel || "feed cards") +
                        " batch " + (Math.floor(b / BATCH_SIZE) + 1),
                });
            } catch (batchErr) {
                console.warn("[TRIAGE] batch starting at " + b + " failed: " + batchErr.message + " — marking as ignore");
                for (var bi = 0; bi < batch.length; bi++) {
                    if (!batch[bi].label) {
                        batch[bi].label = "ignore";
                        batch[bi].topic = "general";
                        batch[bi].flex_score = 0;
                        batch[bi].reason = "triage batch failed";
                    }
                }
            }
        }
        console.log("");
        return posts;
    }

    var postList = posts.map(function(post, index) {
        return buildPostPromptBlock(post, index);
    }).join("\n\n");

    var systemPrompt = [
        "You are a lead-triage classifier for a self-improvement coaching sales funnel.",
        "",
        BOT_EXPERTISE,
        "",
        "For each post, return:",
        '  label       — "hook" | "value-flex" | "ignore"',
        '  topic       — one of: ' + VALID_TOPICS.join(", "),
        '  flex_score  — 0 to 3 (0=nothing useful to add, 3=clear high-value insight in our wheelhouse)',
        '  reason      — <= 12 words explaining the choice',
        "",
        "Definitions:",
        '  "hook"        Author shows EXPLICIT buying intent: asking for a coach, ready to invest,',
        '                "how do I find someone who…". Rare (~2-10% of posts).',
        '  "value-flex"  Post has REAL HOOK MATERIAL the bot can riff on with substance:',
        '                  - a specific niche/positioning the bot can react to ("I help X do Y by Z")',
        '                  - a stated challenge, struggle, question, or pain point',
        '                  - a claim, opinion, or framing the bot can sharpen, agree-and-extend, or',
        '                    respectfully push back on',
        '                  - a tactical question (offer/pricing/sales/clients/discipline)',
        '                The author should be ICP (any coach, consultant, course creator, agency owner,',
        '                freelancer building a service biz, anyone in personal-growth/coaching/solo',
        '                business space). ICP alone is NOT enough — the post must give the bot',
        '                something specific to say.',
        '  "ignore"      Anything with no hook material:',
        '                  - bare intros / greetings / "new here, level me up" with no angle',
        '                  - off-topic / non-ICP authors (MLM, wedding-venue SaaS, pottery, etc.)',
        '                  - cross-promo, memes, replays, resource drops, generic life updates,',
        '                    wins where the bot has nothing distinctive to add',
        "",
        "CRITICAL: A bare intro from an ICP author is STILL ignore unless the body contains",
        "real material to react to. Posts like \"Hi I'm new, please like this so I can level up\"",
        "or \"happy to be here\" with nothing else — those are ignore. We do NOT leave generic",
        "\"welcome to the tribe\" / \"glad you're here\" replies. Every reply must add real value.",
        "",
        "Examples (calibrated against Scott's actual engagement on 718 audited posts):",
        "",
        "ENGAGE examples (Scott replied):",
        '  → "What do you do to keep being social?" (SIN / General)',
        '     Genuine member question. Scott replied with a 270-word teaching on',
        '     high-leverage social skills via competence.',
        '     → value-flex flex_score 3',
        '  → "Why are most experts broke?" (Synthesizer / Monetization)',
        '     Concrete claim about expertise→income gap. Bot can riff on positioning.',
        '     → value-flex flex_score 3',
        '  → "Introducing Myself!!" (SIN / Hero\'s Journey)',
        '     Member intro post. Scott replied "Broooooooooooo, your story gave me the chills."',
        '     → value-flex flex_score 2',
        '  → "Where in the world are you?" (SIN / General, by Lea Newkirk)',
        '     Low-effort host post but worth a touch reply. Bot says where it\'s based.',
        '     → value-flex flex_score 2',
        '     → value-flex flex_score 3',
        "",
        "SKIP examples (Scott ignored):",
        '  → "💥Synthesizer daily accountability DAY 31" (Synthesizer / Other)',
        '     Daily accountability series. 0/15 engagement on this pattern.',
        '     → ignore flex_score 0',
        '  → "🔥 Why I Didn\'t \'Break Up\' With Synthesiser Scaling 🔥" (Synth / Wins)',
        '     Pinned launch testimonial. Bot has nothing to add. 1/66 engagement on Wins.',
        '     → ignore flex_score 0',
        '  → "Where are you from?" (Synthesizer / Networking)',
        '     Same shape as Lea\'s SIN post but in outsider community. Networking',
        '     engagement in Synthesizer is 2.3%.',
        '     → ignore flex_score 0',
        '  → "Weekly community calls ☎️" (SIN / Hero\'s Journey)',
        '     Logistics announcement. 14% engagement on this pattern.',
        '     → ignore flex_score 0',
        '  → "Hi all, new here! Please like this post so I can level up." → ignore flex_score 0',
        '     (no hook material; bot would only be able to say "welcome")',
        "",
        "flex_score scale:",
        "  3 — concrete tactical question/struggle in bot wheelhouse (offer/sales/clients).",
        "  2 — ICP author with substantive hook material (niche, positioning, claim, framing).",
        "  1 — adjacent but thin (general motivation, vague, no clear angle).",
        "  0 — nothing to riff on; bot would only manage \"welcome\" / \"nice\" / \"love it\".",
        "",
        "Score flex_score honestly. If you're tempted to write \"general motivation\" — that's a 1.",
        "If the bot would just nod along — that's a 0. Reserve 3 for posts where there's a specific,",
        "tactical thing to say from the bot expertise above.",
        "",
        "Use AuthorContext when present — someone we've already engaged is a different decision than a stranger.",
        "",
        "Return ONLY a JSON object: { \"results\": [ { \"index\": 0, \"label\": \"...\", \"topic\": \"...\", \"flex_score\": N, \"reason\": \"...\" }, ... ] }",
    ].join("\n");

    var completion = await openai.chat.completions.create({
        model: modelName,
        // Headroom for ~25 posts × ~50 tokens each + JSON wrapper.
        max_completion_tokens: 2400,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: "Triage each post:\n\n" + postList },
        ],
    });

    var raw = completion.choices[0].message.content || "";
    var parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (parseErr) {
        // Salvage: if the model truncated mid-array, pull every well-formed
        // {"index":N,"label":"...","topic":"...","flex_score":N,"reason":"..."}
        // object out of the partial string. One bad batch shouldn't kill the cycle.
        console.warn("[TRIAGE] JSON parse failed (" + parseErr.message + ") — salvaging partial results");
        var rescued = [];
        var rx = /\{\s*"index"\s*:\s*(\d+)[\s\S]*?"reason"\s*:\s*"([^"]*)"\s*\}/g;
        var m;
        while ((m = rx.exec(raw)) !== null) {
            // Re-parse each object individually (lenient on field order).
            try {
                var obj = JSON.parse(m[0]);
                rescued.push(obj);
            } catch (_) { /* skip */ }
        }
        parsed = { results: rescued };
        console.warn("[TRIAGE]   rescued " + rescued.length + " of " + posts.length + " posts");
    }
    var results = parsed.results || parsed;

    for (var i = 0; i < results.length; i++) {
        var r = results[i] || {};
        var idx = r.index;
        if (!posts[idx]) continue;

        posts[idx].label      = normalizeLabel(r.label);
        posts[idx].topic      = normalizeTopic(r.topic);
        posts[idx].flex_score = normalizeFlexScore(r.flex_score);
        posts[idx].reason     = r.reason || "";

        var tag = posts[idx].label === "hook"     ? "[HOOK]"
                : posts[idx].label === "value-flex" ? "[FLEX f" + posts[idx].flex_score + "]"
                                                     : "[IGNORE]";
        console.log("  " + tag + " " + (posts[idx].title || "").substring(0, 50) +
                    " (" + posts[idx].topic + ") - " + posts[idx].reason);
    }

    for (var j = 0; j < posts.length; j++) {
        if (!posts[j].label) {
            posts[j].label      = "ignore";
            posts[j].topic      = "general";
            posts[j].flex_score = 0;
            posts[j].reason     = "";
        }
    }

    console.log("");
    return posts;
}

// ── Selection helper used by the cycle in auto_reply.js ──────────────────────

/**
 * Apply the flex-score floor.
 *   - Hook posts always pass (rare, high-value).
 *   - Value-flex posts pass only if flex_score >= floor (default 2).
 *   - Everything else is rejected.
 *
 * Optional opts:
 *   - hostAuthors: array of names that get a -1 floor boost. Used to honor
 *     Scott's elevated engagement with community managers (e.g. Lea Newkirk
 *     in Self-Improvement Nation, where 22/61 of her posts get a reply).
 *
 * Returns posts sorted: hook first, then value-flex by flex_score desc.
 */
function applyFlexFloor(posts, floor, opts) {
    var f = typeof floor === "number" ? floor : 2;
    var hostAuthors = (opts && Array.isArray(opts.hostAuthors)) ? opts.hostAuthors : [];
    var hostSet = {};
    for (var h = 0; h < hostAuthors.length; h++) {
        var key = (hostAuthors[h] || "").trim().toLowerCase();
        if (key) hostSet[key] = true;
    }
    function effectiveFloor(post) {
        var authorKey = (post.author || "").trim().toLowerCase();
        if (hostSet[authorKey]) return Math.max(0, f - 1);
        return f;
    }
    return (posts || [])
        .filter(function(p) {
            if (!p) return false;
            if (p.label === "hook") return true;
            if (p.label === "value-flex") return (p.flex_score || 0) >= effectiveFloor(p);
            return false;
        })
        .sort(function(a, b) {
            if (a.label === "hook" && b.label !== "hook") return -1;
            if (b.label === "hook" && a.label !== "hook") return  1;
            return (b.flex_score || 0) - (a.flex_score || 0);
        });
}

module.exports = {
    collectEngagements:       collectEngagements,
    triagePosts:              triagePosts,
    pickDeepTriageCandidates: pickDeepTriageCandidates,
    applyFlexFloor:           applyFlexFloor,
    preFilterHardSkips:       preFilterHardSkips,
    isHardSkipCategory:       isHardSkipCategory,
    isHardSkipTitle:          isHardSkipTitle,
    HARD_SKIP_CATEGORIES_BY_COMMUNITY: HARD_SKIP_CATEGORIES_BY_COMMUNITY,
    HARD_SKIP_TITLE_PATTERNS: HARD_SKIP_TITLE_PATTERNS,
    HOST_AUTHORS_BY_COMMUNITY: HOST_AUTHORS_BY_COMMUNITY,
    VALID_LABELS:             VALID_LABELS,
    VALID_TOPICS:             VALID_TOPICS,
    BOT_EXPERTISE:            BOT_EXPERTISE,
};
