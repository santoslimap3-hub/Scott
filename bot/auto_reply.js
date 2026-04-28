// auto_reply.js  -- v1
// OutreachAI: Jack Walford appointment-setter bot for Skool communities.
//
// Cycle (sales-first order):
//   Phase 1 -- Respond to engagement notifications (warm leads, highest priority)
//   Phase 2 -- Scrape feed + triage posts (ignore / value / hook)
//   Phase 3 -- Reply to best 1-3 ICP/hook posts
//   Phase 5 -- Author-level dedup (skip if replied to this person in last 7 days)
//   Phase 6 -- DM queue populated by: hook reply sent, notif engagement, returning warm lead
//
// Dry-run mode: set DRY_RUN=true in .env -- logs everything, submits nothing.
// Migration note: legacy bot is at auto_reply_legacy.js

"use strict";

const { chromium } = require("playwright");
const OpenAI       = require("openai");
const fs           = require("fs");
const path         = require("path");
require("dotenv").config();

const browser_mod  = require("./skool_browser");
const { collectEngagements, triagePosts, pickDeepTriageCandidates } = require("./triage");
const { generateReply, generateEngagementReply } = require("./generate_reply");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Config -----------------------------------------------------------------

const CONFIG = {
    email:    process.env.SKOOL_EMAIL,
    password: process.env.SKOOL_PASSWORD,
    model:    process.env.OPENAI_MODEL || "gpt-4o",

    community: {
        name: process.env.COMMUNITY_NAME || "Hope Nation",
        url:  process.env.SKOOL_COMMUNITY_URL_2 || "https://www.skool.com/hope-nation-7999",
    },

    headless:   process.env.HEADLESS === "true",
    dryRun:     process.env.DRY_RUN  === "true",

    maxReplies:     parseInt(process.env.MAX_REPLIES || "3", 10),
    replyDelayMin:  3  * 60 * 1000,   // 3 min
    replyDelayMax:  15 * 60 * 1000,   // 15 min
    cycleDelayMin:  30 * 60 * 1000,   // 30 min
    cycleDelayMax:  60 * 60 * 1000,   // 60 min
    authorCooldown: 7 * 24 * 60 * 60 * 1000,  // 7 days
};

// ---- Ledger (replied.json -- keyed by author name) --------------------------

const REPLIED_FILE   = path.join(__dirname, "replied.json");
const HOT_LEADS_FILE = path.join(__dirname, "hot_leads_queue.json");

function normalizeName(name) {
    if (!name || typeof name !== "string") return "";
    return name
        .replace(/\u00c2/g, "")
        .replace(/[\u00a0\u2007\u202f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeThreadHref(href) {
    if (!href || typeof href !== "string") return "";
    try {
        var url = new URL(href);
        var pathname = (url.pathname || "").replace(/\/+$/, "");
        return (url.origin + pathname).toLowerCase();
    } catch (_) {
        return href.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    }
}

function ensureLedgerShape(ledger) {
    var safeLedger = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : {};
    if (!safeLedger.__threads || typeof safeLedger.__threads !== "object" || Array.isArray(safeLedger.__threads)) {
        safeLedger.__threads = {};
    }

    Object.keys(safeLedger).forEach(function(key) {
        if (key === "__threads") return;
        var entry = safeLedger[key];
        if (!entry || typeof entry !== "object") return;
        var threadKey = normalizeThreadHref(entry.threadHref);
        if (!threadKey) return;
        if (!safeLedger.__threads[threadKey]) {
            safeLedger.__threads[threadKey] = {
                authorName: entry.authorName || key,
                lastRepliedAt: entry.lastRepliedAt,
                lastLabel: entry.lastLabel,
            };
        }
    });

    return safeLedger;
}

function loadLedger() {
    try {
        if (fs.existsSync(REPLIED_FILE)) return ensureLedgerShape(JSON.parse(fs.readFileSync(REPLIED_FILE, "utf8")));
    } catch (_) {}
    return ensureLedgerShape({});
}

function saveLedger(ledger) {
    ledger = ensureLedgerShape(ledger);
    var tmp = REPLIED_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, REPLIED_FILE);
}

function getAuthorEntry(ledger, authorName) {
    var normalizedTarget = normalizeName(authorName);
    if (!normalizedTarget) return null;

    var keys = Object.keys(ledger);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === "__threads") continue;
        var entry = ledger[key];
        if (!entry || typeof entry !== "object") continue;
        var normalizedKey = normalizeName(key);
        var normalizedEntryName = normalizeName(entry.authorName || key);
        if (normalizedTarget === normalizedKey || normalizedTarget === normalizedEntryName) {
            return entry;
        }
    }
    return null;
}

function onCooldown(ledger, authorName) {
    var entry = getAuthorEntry(ledger, authorName);
    if (!entry) return false;
    var elapsed = Date.now() - new Date(entry.lastRepliedAt).getTime();
    return elapsed < CONFIG.authorCooldown;
}

function getThreadEntry(ledger, postHref) {
    var threadKey = normalizeThreadHref(postHref);
    if (!threadKey) return null;
    return ledger.__threads[threadKey] || null;
}

function hasRepliedToThread(ledger, postHref) {
    return !!getThreadEntry(ledger, postHref);
}

function recordReply(ledger, authorName, label, postHref) {
    ledger = ensureLedgerShape(ledger);

    var now = new Date().toISOString();
    var normalizedAuthor = normalizeName(authorName);
    var normalizedThread = normalizeThreadHref(postHref);

    if (normalizedAuthor && normalizedAuthor !== "Unknown") {
        Object.keys(ledger).forEach(function(key) {
            if (key === "__threads") return;
            if (key !== normalizedAuthor && normalizeName(key) === normalizedAuthor) delete ledger[key];
        });
        ledger[normalizedAuthor] = {
            authorName:     authorName || normalizedAuthor,
            lastRepliedAt:  now,
            lastLabel:      label,
            threadHref:     normalizedThread || postHref,
        };
    }

    if (normalizedThread) {
        ledger.__threads[normalizedThread] = {
            authorName:     authorName || "",
            lastRepliedAt:  now,
            lastLabel:      label,
        };
    }

    saveLedger(ledger);
}

function getBotIdentityNames(botName) {
    var names = [];
    function addName(name) {
        var normalized = normalizeName(name);
        if (!normalized) return;
        if (names.indexOf(normalized) === -1) names.push(normalized);
    }

    addName(botName);
    addName(process.env.BOT_NAME);
    (process.env.BOT_ALT_NAMES || "Daniel Carter")
        .split(",")
        .forEach(function(name) { addName(name); });

    return names;
}

function isBotIdentityName(name, botIdentityNames) {
    return botIdentityNames.indexOf(normalizeName(name)) !== -1;
}

function getProtectedAuthorNames() {
    var names = [];
    function addName(name) {
        var normalized = normalizeName(name);
        if (!normalized) return;
        if (names.indexOf(normalized) === -1) names.push(normalized);
    }

    addName(process.env.TARGET_MEMBER);
    (process.env.SKIP_PUBLIC_REPLY_NAMES || "")
        .split(",")
        .forEach(function(name) { addName(name); });

    return names;
}

function isProtectedAuthorName(name, protectedAuthorNames) {
    return protectedAuthorNames.indexOf(normalizeName(name)) !== -1;
}

function logTriageCounts(posts, label) {
    var counts = { hook: 0, value: 0, ignore: 0 };
    (posts || []).forEach(function(post) {
        if (post && counts.hasOwnProperty(post.label)) counts[post.label]++;
    });
    console.log("[triage] " + label + " -- hook: " + counts.hook + ", value: " + counts.value + ", ignore: " + counts.ignore);
}

function filterActionablePosts(posts, ledger, botIdentityNames, protectedAuthorNames) {
    return (posts || []).filter(function(p) {
        if (p.label === "ignore") return false;
        if (hasRepliedToThread(ledger, p.href)) {
            console.log("  [skip] Already replied to thread -- " + p.title);
            return false;
        }
        if (isBotIdentityName(p.author, botIdentityNames)) return false;
        if (isProtectedAuthorName(p.author, protectedAuthorNames)) return false;
        if (onCooldown(ledger, p.author)) {
            console.log("  [skip] Cooldown -- " + p.author + " (replied in last 7d)");
            var entry = getAuthorEntry(ledger, p.author);
            if (entry && (entry.lastLabel === "hook" || entry.lastLabel === "value")) {
                queueForDM(p.author, "returning-warm-lead", p.title, CONFIG.community.name);
            }
            return false;
        }
        return true;
    });
}

// ---- DM queue ---------------------------------------------------------------

function loadHotLeads() {
    try {
        if (fs.existsSync(HOT_LEADS_FILE)) return JSON.parse(fs.readFileSync(HOT_LEADS_FILE, "utf8"));
    } catch (_) {}
    return [];
}

function queueForDM(authorName, reason, postTitle, community) {
    if (!authorName || typeof authorName !== "string" || authorName === "Unknown") return;
    var queue = loadHotLeads();
    var alreadyQueued = queue.some(function(e) { return e.name === authorName && !e.sent; });
    if (alreadyQueued) { console.log("  -> " + authorName + " already in DM queue"); return; }
    queue.push({
        name:      authorName,
        reason:    reason,
        postTitle: postTitle || "",
        community: community || "",
        queuedAt:  new Date().toISOString(),
        sent:      false,
    });
    var tmp = HOT_LEADS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
    fs.renameSync(tmp, HOT_LEADS_FILE);
    console.log("  [HOT] Queued " + authorName + " for DM -- reason: " + reason);
}

// ---- Utilities --------------------------------------------------------------

function sleep(ms)             { return new Promise(function(r) { setTimeout(r, ms); }); }
function randomBetween(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

async function countdown(ms, label) {
    var totalSec = Math.ceil(ms / 1000);
    for (var rem = totalSec; rem > 0; rem--) {
        var m = Math.floor(rem / 60), s = rem % 60;
        process.stdout.write("\r" + label + " " + (m > 0 ? m + "m " : "") + s + "s   ");
        await sleep(1000);
    }
    process.stdout.write("\r" + label + " -- done                    \n");
}

// ---- Main cycle -------------------------------------------------------------

async function runCycle(page, botName, cycle) {
    var ledger  = loadLedger();
    var summary = [];
    var botIdentityNames = getBotIdentityNames(botName);
    var protectedAuthorNames = getProtectedAuthorNames();

    console.log("\n" + "=".repeat(60));
    console.log("CYCLE " + cycle + (CONFIG.dryRun ? "  [DRY RUN]" : ""));
    console.log("=".repeat(60) + "\n");

    // Phase 1: Engagement notifications
    var engagements = [];
    try {
        await page.goto(CONFIG.community.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(3000);

        var hasNotifs = await browser_mod.hasUnreadNotifications(page);
        if (hasNotifs) {
            var botAltNames = (process.env.BOT_ALT_NAMES || "Daniel Carter")
                .split(",").map(function(s) { return s.trim(); });
            engagements = await collectEngagements(page, [botName].concat(botAltNames));
        } else {
            console.log("Phase 1 -- no unread notifications\n");
        }
    } catch (notifErr) {
        console.warn("  [warn] Notification phase error:", notifErr.message);
    }

    for (var e = 0; e < engagements.length; e++) {
        var eng = engagements[e];
        console.log("[ENGAGEMENT] Replying to " + eng.authorName);
        try {
            eng.community = CONFIG.community.name;
            var engReply = await generateEngagementReply(openai, eng, CONFIG.model);
            console.log("  Reply: " + engReply);

            if (!CONFIG.dryRun) {
                await page.goto(eng.postHref, { waitUntil: "domcontentloaded", timeout: 30000 });
                await sleep(2000);
                await browser_mod.typeCommentReply(page, {
                    author: eng.authorName,
                    text: eng.commentText || "",
                }, engReply);
                await browser_mod.submitReply(page, { inlineTarget: true });
            } else {
                console.log("  [DRY RUN] not submitted\n");
            }

            queueForDM(eng.authorName, "notification-engagement", "", CONFIG.community.name);
            recordReply(ledger, eng.authorName, "engagement", eng.postHref);
            summary.push({ type: "engagement", author: eng.authorName });
        } catch (engErr) {
            console.warn("  [warn] Engagement reply error:", engErr.message);
        }
    }

    // Phase 2: Feed scrape + triage
    var allPosts = await browser_mod.getAllPosts(page, CONFIG.community.url);
    var triaged  = await triagePosts(openai, allPosts, CONFIG.model, { contextLabel: "feed cards" });
    logTriageCounts(triaged, "initial pass");

    var anyInitialNonIgnore = triaged.some(function(post) {
        return post.label && post.label !== "ignore";
    });

    if (!anyInitialNonIgnore) {
        var deepCandidates = pickDeepTriageCandidates(triaged, 5);
        if (deepCandidates.length > 0) {
            console.log("[triage] 0 actionable labels from feed cards. Re-checking " + deepCandidates.length + " ambiguous post(s) with full bodies...");
            for (var dc = 0; dc < deepCandidates.length; dc++) {
                try {
                    await browser_mod.openPostAndGetBody(page, deepCandidates[dc]);
                } catch (deepErr) {
                    console.warn("  [warn] Deep triage scrape failed for " + deepCandidates[dc].title + ":", deepErr.message);
                }
            }
            await triagePosts(openai, deepCandidates, CONFIG.model, { contextLabel: "full post bodies" });
            logTriageCounts(deepCandidates, "deep recheck");
        } else {
            console.log("[triage] 0 actionable labels from feed cards and no ambiguous posts were worth a full-post recheck.");
        }
    }

    // Phase 5: Author-level dedup + cooldown filter
    var actionable = filterActionablePosts(triaged, ledger, botIdentityNames, protectedAuthorNames);

    if (actionable.length === 0) {
        console.log("[triage] No actionable posts after model triage plus cooldown/dedup filters.");
        if (!triaged.some(function(post) { return post.label !== "ignore"; })) {
            console.log("[triage] This looks more like a targeting mismatch or strict criteria than a broken selector.");
        }
    }

    // hook posts first
    actionable.sort(function(a, b) {
        if (a.label === "hook" && b.label !== "hook") return -1;
        if (b.label === "hook" && a.label !== "hook") return  1;
        return 0;
    });

    var toReply = actionable.slice(0, CONFIG.maxReplies);
    console.log("[feed] " + toReply.length + " post(s) to reply to (cap: " + CONFIG.maxReplies + ")\n");

    // Phase 3: Reply to selected posts
    for (var i = 0; i < toReply.length; i++) {
        var post = toReply[i];

        console.log("-".repeat(60));
        console.log("POST " + (i + 1) + " of " + toReply.length + "  [" + post.label.toUpperCase() + "]");
        console.log("Author: " + post.author);
        console.log("Title:  " + post.title);
        console.log("Reason: " + post.reason);
        console.log("-".repeat(60));

        try {
            post = await browser_mod.openPostAndGetBody(page, post);
            post.community = CONFIG.community.name;

            if (hasRepliedToThread(ledger, post.href)) {
                console.log("[skip] Already replied to this thread\n");
                continue;
            }

            if (isBotIdentityName(post.author, botIdentityNames)) {
                console.log("[skip] Own/team post\n");
                continue;
            }

            if (isProtectedAuthorName(post.author, protectedAuthorNames)) {
                console.log("[skip] Protected post author\n");
                continue;
            }

            if (onCooldown(ledger, post.author)) {
                console.log("[skip] Cooldown -- " + post.author + " (replied in last 7d)\n");
                var authorEntry = getAuthorEntry(ledger, post.author);
                if (authorEntry && (authorEntry.lastLabel === "hook" || authorEntry.lastLabel === "value")) {
                    queueForDM(post.author, "returning-warm-lead", post.title, CONFIG.community.name);
                }
                continue;
            }

            if (await browser_mod.alreadyCommented(page, botName)) {
                console.log("[skip] Already commented on this post\n");
                recordReply(ledger, post.author, post.label, post.href);
                continue;
            }

            var replyText = await generateReply(openai, post, CONFIG.model);
            console.log("\nGENERATED REPLY:");
            console.log(replyText);
            console.log("");

            if (!CONFIG.dryRun) {
                // var delay = randomBetween(CONFIG.replyDelayMin, CONFIG.replyDelayMax);
                // await countdown(delay, "Waiting before reply:");
                console.log("[TEST] Reply delay skipped");
                await browser_mod.typeReply(page, replyText);
                await browser_mod.submitReply(page);
            } else {
                console.log("[DRY RUN] not submitted\n");
            }

            recordReply(ledger, post.author, post.label, post.href);

            // Phase 6: DM queue -- hook replies only
            if (post.label === "hook") {
                queueForDM(post.author, "hook-post-reply", post.title, CONFIG.community.name);
            }

            summary.push({ type: "post", label: post.label, author: post.author, title: post.title });

        } catch (postErr) {
            console.warn("  [warn] Post reply error:", postErr.message);
        }
    }

    // Cycle summary
    console.log("\n" + "=".repeat(60));
    console.log("CYCLE " + cycle + " SUMMARY");
    console.log("-".repeat(60));
    console.log("Posts in feed:  " + allPosts.length);
    console.log("Actionable:     " + actionable.length);
    console.log("Replies sent:   " + summary.filter(function(s) { return s.type === "post"; }).length);
    console.log("Engagements:    " + summary.filter(function(s) { return s.type === "engagement"; }).length);
    for (var j = 0; j < summary.length; j++) {
        var s = summary[j];
        var tag = s.type === "post" ? "[" + s.label.toUpperCase() + "]" : "[ENGMNT]";
        console.log("  " + (j + 1) + ". " + tag + " " + (s.title || s.author).substring(0, 50) + " -- " + s.author);
    }
    console.log("=".repeat(60) + "\n");

    return summary;
}

// ---- Entry point ------------------------------------------------------------

(async function main() {
    if (CONFIG.dryRun) console.log("[DRY RUN] no replies will be submitted\n");

    var browser = await chromium.launch({ headless: CONFIG.headless, slowMo: 50 });
    var context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport:  { width: 1280, height: 900 },
    });
    var page = await context.newPage();

    var botName = await browser_mod.login(page, CONFIG.email, CONFIG.password);

    var cycle = 1;
    while (true) {
        try {
            await runCycle(page, botName, cycle);
        } catch (err) {
            console.error("[error] Cycle " + cycle + ":", err.message);
            try { await page.goto("https://www.skool.com", { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (_) {}
        }
        cycle++;
        // var delay = randomBetween(CONFIG.cycleDelayMin, CONFIG.cycleDelayMax);
        // await countdown(delay, "Next cycle in:");
        console.log("[TEST] Cycle delay skipped");
    }
})();
