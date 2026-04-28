// triage.js
//
// Phase 1: Collect warm-signal notification items (someone replied to us or
// @-mentioned us). These are the highest-priority leads each cycle.
//
// Phase 2: Batched LLM triage of feed posts.
// Returns one label per post: "ignore" | "value" | "hook"
// plus a short reason string for logging and reply generation.

"use strict";

const {
    clickNotificationBell,
    getNotificationItems,
    markNotificationsRead,
    sleep,
} = require("./skool_browser");

const DEEP_TRIAGE_IGNORE_HINTS = [
    "replay",
    "workbook",
    "resource",
    "bootcamp",
    "summit",
    "hello",
    "greetings",
    "introduction",
    "newbie intro",
    "day 1 replay",
    "day 2 replay",
    "day 3 replay",
];

const DEEP_TRIAGE_SIGNAL_HINTS = [
    "help",
    "how ",
    "what ",
    "why ",
    "question",
    "coach",
    "client",
    "offer",
    "sales",
    "selling",
    "business",
    "grow",
    "scale",
    "prompt",
    "stuck",
    "struggl",
    "money",
    "human connection",
    "level",
];

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
    for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item.href) continue;
        if (!isPostThreadHref(item.href)) continue;

        var lowerText = (item.text || "").toLowerCase();
        var isEngagement = (
            lowerText.includes("replied") ||
            lowerText.includes("mentioned") ||
            lowerText.includes("commented")
        );
        if (!isEngagement) continue;

        var authorName = extractAuthorFromNotifText(item.text, allNames);
        if (!authorName) continue;

        engagements.push({
            authorName: authorName,
            postHref: item.href.split("?")[0],
            snippet: (item.text || "").substring(0, 120),
            commentText: extractCommentTextFromNotifText(item.text, authorName),
        });
    }

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

function extractAuthorFromNotifText(text, botNames) {
    var clean = (text || "").trim();
    var match = clean.match(/^([A-Z][a-zA-ZÀ-ÿ''-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ''-]+){0,2})\s+(?:replied|commented|mentioned|liked|reacted)/);
    if (!match) return null;

    var name = match[1].trim();
    for (var i = 0; i < botNames.length; i++) {
        if (botNames[i] && name.toLowerCase() === botNames[i].toLowerCase()) return null;
    }
    return name;
}

function extractCommentTextFromNotifText(text, authorName) {
    var clean = normalizeFeedText(text);
    if (!clean) return "";

    var authorPattern = escapeRegExp(authorName || "");
    if (authorPattern) {
        clean = clean.replace(
            new RegExp("^" + authorPattern + "\\s+(?:replied|commented|mentioned)(?:\\s+you)?(?:\\s+in\\s+reply)?", "i"),
            ""
        ).trim();
    }

    clean = clean.replace(/^[\u00b7\-–—\s]+/, "");
    clean = clean.replace(/^(?:just now|\d+\s*[smhdw])\b[\u00b7\-–—\s]*/i, "").trim();

    if (!clean || normalizeSpaces(clean) === normalizeSpaces(text)) {
        var fallback = normalizeSpaces(text).match(/\b(?:just now|\d+\s*[smhdw])\b[\u00b7\-–—\s]*(.+)$/i);
        if (fallback && fallback[1]) clean = fallback[1].trim();
    }

    return clean.substring(0, 120);
}

function normalizeSpaces(text) {
    return (text || "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(text) {
    return (text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFeedText(text) {
    return (text || "")
        .replace(/\u00c2/g, "")
        .replace(/[\u00a0\u2007\u202f]/g, " ")
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

function buildPostPromptBlock(post, index) {
    var author = normalizeFeedText(post.author) || "Unknown";
    var category = normalizeFeedText(post.category) || "General";
    var title = normalizeFeedText(post.title) || "(untitled)";
    var body = cleanFeedCardBody(post.body, post.title);

    return [
        "POST " + index,
        "Author: " + author,
        "Category: " + category,
        "Title: " + title,
        "Body: " + (body || "(empty)"),
    ].join("\n");
}

function normalizeLabel(label) {
    var safe = (label || "").toString().trim().toLowerCase();
    if (safe === "hook" || safe === "value" || safe === "ignore") return safe;
    return "ignore";
}

function shouldDeepInspectPost(post) {
    if (!post || normalizeLabel(post.label) !== "ignore") return false;

    var title = normalizeFeedText(post.title).toLowerCase();
    var body = cleanFeedCardBody(post.body, post.title).toLowerCase();
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

async function triagePosts(openai, posts, modelName, options) {
    if (!posts || posts.length === 0) return posts || [];
    modelName = modelName || "gpt-4o";
    options = options || {};

    var contextLabel = options.contextLabel ? " (" + options.contextLabel + ")" : "";
    console.log("[TRIAGE] Phase 2 - triaging " + posts.length + " posts" + contextLabel + "...");

    var postList = posts.map(function(post, index) {
        return buildPostPromptBlock(post, index);
    }).join("\n\n");

    var systemPrompt = [
        "You are a lead-triage classifier for a self-improvement coaching sales funnel.",
        "For each post, return one of three labels:",
        "",
        '  "hook"   - The author shows an explicit buying signal: they are asking for',
        "             mentorship/coaching, saying they are ready to invest in their",
        "             business, asking how to find a coach, or expressing urgency to",
        "             take action now. This is a direct sales opportunity.",
        "",
        '  "value"  - The author is identifiably a self-improvement, life, business, or',
        "             fitness coach (or aspiring coach) who is struggling or seeking to",
        "             grow. No explicit buying signal - reply with a useful insight to",
        "             plant authority in front of the community.",
        "",
        '  "ignore" - Everyone else: non-coaches asking general questions, wins/intros,',
        "             memes, admin announcements, event replays, resource drops, or",
        "             anything where engaging adds no lead-gen value.",
        "",
        "Base your decision on the post meaning, not on feed metadata like age,",
        "category labels, author names, or comment counts.",
        "",
        "Also provide a reason of 12 words or fewer explaining why you chose that label.",
        "",
        'Return ONLY a JSON object: { "results": [ { "index": 0, "label": "...", "reason": "..." }, ... ] }',
    ].join("\n");

    var completion = await openai.chat.completions.create({
        model: modelName,
        max_completion_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Triage each post:\n\n" + postList },
        ],
    });

    var parsed = JSON.parse(completion.choices[0].message.content);
    var results = parsed.results || parsed;

    for (var i = 0; i < results.length; i++) {
        var idx = results[i].index;
        var label = normalizeLabel(results[i].label);
        var reason = results[i].reason || "";
        if (!posts[idx]) continue;

        posts[idx].label = label;
        posts[idx].reason = reason;

        var tag = label === "hook" ? "[HOOK]" : label === "value" ? "[VALUE]" : "[IGNORE]";
        console.log("  " + tag + " " + posts[idx].title.substring(0, 55) + " - " + reason);
    }

    for (var j = 0; j < posts.length; j++) {
        if (!posts[j].label) {
            posts[j].label = "ignore";
            posts[j].reason = "";
        }
    }

    console.log("");
    return posts;
}

module.exports = { collectEngagements, triagePosts, pickDeepTriageCandidates };
