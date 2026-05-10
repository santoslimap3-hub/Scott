// auto_reply.js  -- v2 (unified outreach bot)
// ────────────────────────────────────────────────────────────────────────────
// Per AUTO_REPLY_V2_UNIFIED_PLAN.md §3:
//
//   PHASE 1  inbound sweep (notifications + DMs)
//   PHASE 2  feed scrape and triage (value-flex / hook / ignore)
//   PHASE 3  public replies   (cap MAX_PUBLIC_REPLIES_PER_CYCLE)
//   PHASE 4  outbound DM opens (stage-2 promoted, cap MAX_OUTBOUND_DM_OPENS_PER_CYCLE)
//   PHASE 5  cycle summary + sleep
//
// Stage-aware routing means we never blast public CTAs and never drop a
// calendly link without a lead-side green light — both are enforced in code,
// not left to the generation model.
//
// Migration note: legacy bot is at auto_reply_legacy.js, legacy DM bot at dm_reply_legacy.js
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const { chromium } = require("playwright");
const OpenAI       = require("openai");
const fs           = require("fs");
const path         = require("path");
const crypto       = require("crypto");
require("dotenv").config();

const browser_mod      = require("./skool_browser");
const personsDb        = require("./db/persons_db");
const ackTemplates     = require("./ack_templates");
const classifyInbound  = require("./classify/pre_classifier");
const classifyReply    = require("./classify/tag_classifier");
const dmSweep          = require("./dm_sweep");
const dmOutbound       = require("./dm_outbound");
const sessionLog       = require("./logger/session_log");
const ragOutcomes      = require("./logger/rag_outcomes");
const {
    collectEngagements,
    triagePosts,
    pickDeepTriageCandidates,
    applyFlexFloor,
    preFilterHardSkips,
    HOST_AUTHORS_BY_COMMUNITY,
} = require("./triage");
const {
    generateReply,
    generateEngagementReply,
} = require("./generate_reply");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
    email:    process.env.SKOOL_EMAIL,
    password: process.env.SKOOL_PASSWORD,
    model:    process.env.GENERATION_MODEL || process.env.OPENAI_MODEL || "gpt-4o",

    // Cheap, JSON-reliable model for the feed triage classifier.
    // The fine-tuned model is expensive AND worse at structured JSON output —
    // sending triage through it was silently mis-labeling posts.
    triageModel: process.env.TRIAGE_MODEL || process.env.PRE_CLASSIFIER_MODEL || "gpt-4o-mini",

    community: {
        name: process.env.COMMUNITY_NAME || "Hope Nation",
        url:  process.env.SKOOL_COMMUNITY_URL_2 || "https://www.skool.com/hope-nation-7999",
    },

    headless: process.env.HEADLESS === "true",
    dryRun:   process.env.DRY_RUN === "true",

    maxPublicReplies:    parseInt(process.env.MAX_PUBLIC_REPLIES_PER_CYCLE || "3", 10),
    maxDmReplies:        parseInt(process.env.MAX_DM_REPLIES_PER_CYCLE || "5", 10),
    maxOutboundDmOpens:  parseInt(process.env.MAX_OUTBOUND_DM_OPENS_PER_CYCLE || "2", 10),

    // Per-community flex-score floor (calibrated against Scott's actual
    // engagement on the 718-post 2026-04-29 audit):
    //   self-improvement-nation: 61% reply rate → run looser (floor 1)
    //   synthesizer:             1.8% reply rate → run tighter (floor 3)
    //   anywhere else:           use FLEX_SCORE_FLOOR env (default 2)
    flexScoreFloorByCommunity: {
        "self-improvement-nation": 1,
        "synthesizer":             3,
        _default: parseInt(process.env.FLEX_SCORE_FLOOR || "2", 10),
    },

    // How many feed pages to scrape per cycle (Skool paginates ?p=2, ?p=3, …).
    // 1 = page 1 only (~30 posts), 3 = pages 1-3 (~90 posts), etc.
    feedPagesPerCycle:   parseInt(process.env.FEED_PAGES_PER_CYCLE || "3", 10),

    cycleDelayMin:  30 * 60 * 1000,  // 30 min
    cycleDelayMax:  60 * 60 * 1000,  // 60 min
    // Extra random jitter ON TOP of the cycleDelayMin/Max range, so cycles
    // don't fall on tidy 30/45/60-minute boundaries. Default is up to 7 min.
    cycleDelayJitterMs: parseInt(process.env.CYCLE_JITTER_MS || (7 * 60 * 1000), 10),

    // Skip posts younger than this. Humans don't reply to a brand-new post in
    // 30 seconds — anyone watching post timestamps will spot the bot pattern.
    // Set to 0 to disable.
    minPostAgeMinutes: parseInt(process.env.MIN_POST_AGE_MINUTES || "10", 10),

    authorCooldown: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// Parse a relative-time string ("just now", "2m", "14h", "3d", "1w") OR an
// ISO datetime string (from a [datetime] attribute) into minutes-since-posted.
// Returns null when the input can't be parsed (caller should fail open: don't
// block the post on a parse miss, since age data is best-effort).
function parsePostAgeMinutes(ageText) {
    if (!ageText) return null;
    var s = String(ageText).trim();
    if (!s) return null;

    // ISO datetime path.
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        var t = Date.parse(s);
        if (isNaN(t)) return null;
        return Math.max(0, Math.floor((Date.now() - t) / 60000));
    }

    if (/^(just\s*now|now)$/i.test(s)) return 0;
    var m = s.match(/^(\d+)\s*([smhdw])$/i);
    if (!m) return null;
    var n = parseInt(m[1], 10);
    var unit = m[2].toLowerCase();
    if (unit === "s") return Math.max(0, Math.round(n / 60));
    if (unit === "m") return n;
    if (unit === "h") return n * 60;
    if (unit === "d") return n * 60 * 24;
    if (unit === "w") return n * 60 * 24 * 7;
    return null;
}

// ── Replied ledger (kept for backward compatibility) ────────────────────────

const REPLIED_FILE   = path.join(__dirname, "replied.json");

function normalizeName(name) {
    if (!name || typeof name !== "string") return "";
    return name.replace(/Â/g, "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
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
    var safe = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : {};
    if (!safe.__threads || typeof safe.__threads !== "object" || Array.isArray(safe.__threads)) {
        safe.__threads = {};
    }
    if (!safe.__engagements || typeof safe.__engagements !== "object" || Array.isArray(safe.__engagements)) {
        safe.__engagements = {};
    }
    return safe;
}

// Strip the "• 14h@Daniel Carter" prefix and other notification-pane chrome
// from a comment preview so two reads of the same comment in different cycles
// produce the same string (the timestamp rolls forward each cycle and would
// otherwise poison any signature built from this text).
function normalizeCommentForSignature(commentText) {
    return (commentText || "")
        .toLowerCase()
        .replace(/[·\-–—•]/g, " ")        // bullet separators
        .replace(/\b(?:just\s*now|\d+\s*[smhdw])\b/gi, " ")    // timestamps (1m, 5h, 3d, ...)
        .replace(/\b(?:like|reply|view|liked|reply\s+to)\b/gi, " ") // UI chrome
        .replace(/@daniel\s+carter\b/gi, " ")                  // bot @-mention prefix
        .replace(/@jack\s+walford\b/gi, " ")                   // alt bot name
        .replace(/\s+/g, " ")
        .trim();
}

// Build a stable signature for an engagement notification so we don't
// re-answer the same comment if it's still showing as unread next cycle.
// Notifications can repeat across cycles because the script can't actually
// mark them read on Skool's server — see notes in skool_browser.js.
//
// The text portion is a SHA1 of the FULL normalized comment, not an 80-char
// prefix. The old prefix collided when many comments shared the same opener
// ("love this brother", "fire energy", etc.) — a real second comment from the
// same partner on the same thread could be silently swallowed as a duplicate.
function engagementSignature(authorName, postHref, commentText) {
    var nA = normalizeName(authorName);
    var nT = normalizeThreadHref(postHref);
    var normalized = normalizeCommentForSignature(commentText);
    var nC = crypto.createHash("sha1").update(normalized).digest("hex");
    return nA + "::" + nT + "::" + nC;
}

// Legacy-format signature builder (80-char prefix). Kept ONLY so we can match
// engagement entries written before the SHA1 switch — once those notifications
// roll out of view, this can be deleted. Don't use for new writes.
function legacyEngagementSignature(authorName, postHref, commentText) {
    var nA = normalizeName(authorName);
    var nT = normalizeThreadHref(postHref);
    var nC = normalizeCommentForSignature(commentText).substring(0, 80).trim();
    return nA + "::" + nT + "::" + nC;
}

function alreadyAnsweredEngagement(ledger, authorName, postHref, commentText) {
    ledger = ensureLedgerShape(ledger);
    if (ledger.__engagements[engagementSignature(authorName, postHref, commentText)]) return true;
    // Backwards-compat: still dedup against legacy 80-char-prefix keys for as
    // long as Skool's notification feed keeps re-surfacing pre-cutover items.
    if (ledger.__engagements[legacyEngagementSignature(authorName, postHref, commentText)]) return true;
    return false;
}

function recordEngagementAnswered(ledger, authorName, postHref, commentText) {
    ledger = ensureLedgerShape(ledger);
    var sig = engagementSignature(authorName, postHref, commentText);
    ledger.__engagements[sig] = { at: new Date().toISOString() };
    saveLedger(ledger);
}

// Migration is now a no-op. The previous version rebuilt keys by re-running
// engagementSignature on text parsed back out of the key; that worked when
// the text portion WAS the key text, but the new signature hashes the full
// normalized comment, and the only thing in the old key is an 80-char prefix
// of that text — re-hashing the prefix would produce a key that doesn't match
// any future write. Old keys are now matched directly via the legacy fallback
// in alreadyAnsweredEngagement; new writes use the SHA1 format.
function migrateEngagementKeys(ledger) {
    return ledger;
}

function loadLedger() {
    try {
        if (fs.existsSync(REPLIED_FILE)) {
            var raw = ensureLedgerShape(JSON.parse(fs.readFileSync(REPLIED_FILE, "utf8")));
            return migrateEngagementKeys(raw);
        }
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
    var target = normalizeName(authorName);
    if (!target) return null;
    var keys = Object.keys(ledger);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === "__threads") continue;
        var entry = ledger[key];
        if (!entry || typeof entry !== "object") continue;
        if (target === normalizeName(key) || target === normalizeName(entry.authorName || key)) return entry;
    }
    return null;
}

function onCooldown(ledger, authorName) {
    var entry = getAuthorEntry(ledger, authorName);
    if (!entry) return false;
    return (Date.now() - new Date(entry.lastRepliedAt).getTime()) < CONFIG.authorCooldown;
}

function hasRepliedToThread(ledger, postHref) {
    var key = normalizeThreadHref(postHref);
    return !!(key && ledger.__threads[key]);
}

function recordReply(ledger, authorName, label, postHref) {
    ledger = ensureLedgerShape(ledger);
    var now = new Date().toISOString();
    var nA = normalizeName(authorName);
    var nT = normalizeThreadHref(postHref);
    if (nA && nA !== "Unknown") {
        ledger[nA] = { authorName: authorName || nA, lastRepliedAt: now, lastLabel: label, threadHref: nT || postHref };
    }
    if (nT) {
        ledger.__threads[nT] = { authorName: authorName || "", lastRepliedAt: now, lastLabel: label };
    }
    saveLedger(ledger);
}

// ── Bot identity helpers ────────────────────────────────────────────────────

function getBotIdentityNames(botName) {
    var names = [];
    function add(n) {
        var nn = normalizeName(n);
        if (nn && names.indexOf(nn) === -1) names.push(nn);
    }
    add(botName);
    add(process.env.BOT_NAME);
    (process.env.BOT_ALT_NAMES || "Daniel Carter").split(",").forEach(add);
    return names;
}

function isBotIdentity(name, list) {
    return list.indexOf(normalizeName(name)) !== -1;
}

function getProtectedAuthorNames() {
    var names = [];
    function add(n) {
        var nn = normalizeName(n);
        if (nn && names.indexOf(nn) === -1) names.push(nn);
    }
    add(process.env.TARGET_MEMBER);
    (process.env.SKIP_PUBLIC_REPLY_NAMES || "").split(",").forEach(add);
    return names;
}

// ── Author context for the triage classifier ───────────────────────────────

function buildAuthorContextForPost(persons, ledger, authorName) {
    var stage = personsDb.getStage(persons, authorName);
    var hist  = personsDb.getPersonHistory(persons, authorName);
    var prevReplied = hist.some(function(h) { return h.type === "scott_reply"; });
    var prevEngaged = hist.some(function(h) { return h.type === "comment"; });
    var lastInteractionDays;
    if (hist.length > 0) {
        var t = hist[hist.length - 1].timestamp;
        if (t) {
            var ms = Date.now() - new Date(t).getTime();
            if (!isNaN(ms)) lastInteractionDays = Math.floor(ms / (24 * 60 * 60 * 1000));
        }
    }
    return {
        stage:               stage,
        prevReplied:         prevReplied,
        prevEngaged:         prevEngaged,
        lastInteractionDays: lastInteractionDays,
    };
}

// ── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function randomBetween(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }

// Retry helper. Runs `fn` up to `attempts` times with exponential backoff.
// Used for network-flaky boundaries (login, feed scrape) where a single blip
// shouldn't kill the whole cycle. The error is logged each attempt; the last
// failure is rethrown so the caller can decide what to do.
async function withRetry(fn, opts) {
    var attempts = (opts && opts.attempts) || 2;
    var baseMs   = (opts && opts.baseMs)   || 4000;
    var label    = (opts && opts.label)    || "operation";
    var lastErr;
    for (var i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            var isLast = (i === attempts - 1);
            console.warn("  [retry] " + label + " attempt " + (i + 1) + "/" + attempts +
                " failed: " + err.message + (isLast ? " (giving up)" : ""));
            if (!isLast) {
                var wait = baseMs * Math.pow(2, i) + randomBetween(0, 1500);
                await sleep(wait);
            }
        }
    }
    throw lastErr;
}

async function countdown(ms, label) {
    var totalSec = Math.ceil(ms / 1000);
    for (var rem = totalSec; rem > 0; rem--) {
        var m = Math.floor(rem / 60), s = rem % 60;
        process.stdout.write("\r" + label + " " + (m > 0 ? m + "m " : "") + s + "s   ");
        await sleep(1000);
    }
    process.stdout.write("\r" + label + " -- done                    \n");
}

// ── PHASE 1: inbound sweep (notifications + DMs) ───────────────────────────

async function runPhase1Notifications(page, botName, persons, ledger, summary) {
    console.log("\n[PHASE 1a] notifications");
    var engagements = [];
    try {
        await page.goto(CONFIG.community.url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(3000);

        var hasNotifs = await browser_mod.hasUnreadNotifications(page);
        if (!hasNotifs) {
            console.log("  no unread notifications");
            return;
        }
        var altNames = (process.env.BOT_ALT_NAMES || "Daniel Carter").split(",").map(function(s){ return s.trim(); });
        engagements = await collectEngagements(page, [botName].concat(altNames));
    } catch (notifErr) {
        console.warn("  [warn] " + notifErr.message);
        return;
    }

    for (var e = 0; e < engagements.length; e++) {
        var eng = engagements[e];
        eng.community = CONFIG.community.name;
        eng.personContext = personsDb.buildPersonContext(persons, eng.authorName);

        // Skip if we've already answered THIS specific engagement comment.
        // (Distinct from thread-level cooldown — a partner posting a fresh
        // reply on the same thread should still get a response.)
        if (alreadyAnsweredEngagement(ledger, eng.authorName, eng.postHref, eng.commentText)) {
            console.log("  [NOTIF/" + eng.authorName + "] SKIP — already answered this comment");
            summary.push({ type: "notif", author: eng.authorName, action: "DUP_SKIP" });
            continue;
        }

        // Always log what we extracted from the notification, so we can see
        // why the classifier reaches its verdict.
        console.log("  [NOTIF/" + eng.authorName + "] preview text: \"" +
            (eng.commentText || "").substring(0, 120) + "\"" +
            ((eng.commentText || "").length > 120 ? "..." : ""));

        // Decide whether to fetch the real comment from the post page.
        // The notification preview is "scaffold-only" when, after stripping
        // timestamps / "Reply" / "Like" UI chrome, basically nothing remains —
        // i.e. Skool gave us "5h" or "just now Reply" rather than the comment.
        var ctRaw = (eng.commentText || "").trim();
        var ctStripped = ctRaw
            .replace(/\b(?:just now|\d+\s*[smhdw])\b/gi, "")        // timestamps
            .replace(/\b(?:like|reply|view|reply\s+to|liked)\b/gi, "")  // UI chrome
            .replace(/[·\-–—•]/g, "")
            .replace(/\s+/g, " ")
            .trim();
        var needsFetch = ctRaw.length < 15 || ctStripped.length < 8;

        // Navigate to the post by CLICKING the notification card (which marks
        // it read on Skool's server) rather than via page.goto. Falls back to
        // page.goto if the card can't be located in the dropdown.
        var navigated = false;
        try {
            navigated = await browser_mod.clickNotificationByMatch(
                page, eng.postHref, eng.snippet || ""
            );
        } catch (navErr) {
            console.warn("    [warn] clickNotificationByMatch threw: " + navErr.message);
        }
        if (!navigated) {
            try {
                await page.goto(eng.postHref, { waitUntil: "domcontentloaded", timeout: 30000 });
                await sleep(2000);
            } catch (gotoErr) {
                console.warn("    [warn] page.goto fallback failed: " + gotoErr.message + " — skipping engagement");
                summary.push({ type: "notif", author: eng.authorName, action: "NAV_FAILED" });
                continue;
            }
        }

        // Double-reply guard: if the bot has ALREADY replied to this commenter
        // on this post (their last reply starts with @CommentAuthor), record
        // it in the ledger and skip. Catches the case where the engagement
        // signature shifted between cycles (preview text changed shape) so
        // ledger dedup missed it.
        try {
            var dup = await browser_mod.botHasReplyToComment(page, botName, eng.authorName);
            if (dup) {
                console.log("  [NOTIF/" + eng.authorName + "] SKIP — bot already replied to this commenter on this post (DOM check)");
                recordReply(ledger, eng.authorName, "engagement-dup-skip", eng.postHref);
                recordEngagementAnswered(ledger, eng.authorName, eng.postHref, eng.commentText);
                summary.push({ type: "notif", author: eng.authorName, action: "DUP_SKIP_DOM" });
                continue;
            }
        } catch (dupErr) {
            console.warn("    [warn] dup-check threw: " + dupErr.message + " — proceeding cautiously");
        }

        if (needsFetch) {
            console.log("  [NOTIF/" + eng.authorName + "] preview is scaffold-only " +
                "(raw=" + ctRaw.length + " chars, stripped=\"" + ctStripped + "\") — fetching real comment from post");
            var fetchOk = false;
            try {
                var realText = await browser_mod.readCommentTextByAuthor(page, eng.authorName);
                if (realText && realText.length >= 4) {
                    eng.commentText = realText;
                    fetchOk = true;
                    console.log("    fetched: \"" + realText.substring(0, 120) + (realText.length > 120 ? "..." : "") + "\"");
                } else {
                    console.log("    [warn] couldn't find " + eng.authorName + "'s comment on the post — skipping engagement (would have generated a generic reply against empty text)");
                }
            } catch (fetchErr) {
                console.warn("    [warn] fetch real comment failed: " + fetchErr.message + " — skipping engagement");
            }
            if (!fetchOk) {
                summary.push({ type: "notif", author: eng.authorName, action: "FETCH_FAILED" });
                continue;
            }
        }

        // Pre-classifier first — silence the "thank you" weirdness
        var pre = await classifyInbound({
            partnerName: eng.authorName,
            text:        eng.commentText,
            context:     "notification",
        });
        console.log("  [NOTIF/" + eng.authorName + "] " + pre.action +
            (pre.ack_template ? " (" + pre.ack_template + ")" : "") + " — " + pre.reason);

        if (pre.action === "NO_REPLY") {
            // Stage promotion still happens — they engaged with us.
            personsDb.promote(persons, eng.authorName, 2, "engaged on our reply (no-text)");
            summary.push({ type: "notif", author: eng.authorName, action: "NO_REPLY" });
            continue;
        }

        var replyText;
        if (pre.action === "ACK") {
            replyText = ackTemplates.renderAck(pre.ack_template, eng.commentText);
            console.log("    ACK → " + replyText);
        } else {
            try {
                replyText = await generateEngagementReply(openai, eng, CONFIG.model);
                console.log("    REPLY → " + replyText);
            } catch (genErr) {
                console.warn("    [warn] generation failed: " + genErr.message);
                continue;
            }
        }

        if (!CONFIG.dryRun) {
            try {
                // Already on the post page (navigated via clickNotificationByMatch
                // or page.goto fallback above). Just type and submit.
                await browser_mod.typeCommentReply(page, {
                    author: eng.authorName,
                    text: eng.commentText || "",
                }, replyText);
                await browser_mod.submitReply(page, { inlineTarget: true });
            } catch (sendErr) {
                console.warn("    [warn] send failed: " + sendErr.message);
                continue;
            }
        }

        recordReply(ledger, eng.authorName, "engagement", eng.postHref);
        recordEngagementAnswered(ledger, eng.authorName, eng.postHref, eng.commentText);
        personsDb.addInteraction(persons, eng.authorName, {
            type: "scott_reply",
            post_title: "",
            author: botName,
            text: replyText,
            timestamp: new Date().toISOString(),
        });
        // They engaged with us → stage 2 (publicly-warm)
        personsDb.promote(persons, eng.authorName, 2, "engaged on our reply");

        ragOutcomes.logSend({
            channel:       "comment",
            intent:        pre.action === "ACK" ? "acknowledgement" : "engagement-nurture",
            partner:       eng.authorName,
            partner_stage: personsDb.getStage(persons, eng.authorName),
            retrieved_ids: (eng._ragExampleIds) || [],
            reply_text:    replyText,
            post_href:     eng.postHref,
        });

        summary.push({ type: "notif", author: eng.authorName, action: pre.action });

        sessionLog.addEntry({
            type:           "notif-comment",
            postAuthor:     "",                          // not captured for notification path
            postTitle:      "",                          // not captured for notification path
            postBodyPreview: "",
            postHref:       eng.postHref,
            commentAuthor:  eng.authorName,
            commentText:    eng.commentText || "",
            tags: {
                tone_tags:   [],
                intent:      pre.action === "ACK" ? "acknowledgement" : "engagement-nurture",
                sales_stage: "engagement",
                reasoning:   pre.reason || "",
                ack_template: pre.ack_template || null,
            },
            reply: replyText,
        });
    }

    // Clear the bell badge: even items we ledger-skipped (already replied to
    // in a previous cycle) still show as unread on Skool until they're
    // explicitly marked read. The "Mark all as read" button in the dropdown
    // header does this for everything currently in the dropdown — including
    // the ones we just processed via clickNotificationByMatch (those are
    // already read) and the ones we skipped on the ledger (those are not).
    //
    // We only do this if we actually had at least one engagement to deal with
    // — otherwise we'd be opening the dropdown every cycle just to close it.
    if (engagements.length > 0) {
        try {
            await markAllNotificationsReadIfPossible(page);
        } catch (markErr) {
            console.warn("  [warn] mark-all-as-read failed: " + markErr.message);
        }
    }
}

// Open the bell, click the "Mark all as read" link in the dropdown header,
// then dismiss. This clears the unread badge for everything currently visible
// in the dropdown — useful at the END of Phase 1 to keep the badge in sync
// with what the bot has already triaged.
async function markAllNotificationsReadIfPossible(page) {
    var opened = await browser_mod.clickNotificationBell(page);
    if (!opened) {
        console.log("  [mark-read] bell didn't open — skipping");
        return;
    }
    await sleep(700);
    var clicked = await page.evaluate(function() {
        function isVis(n) {
            if (!n) return false;
            var s = window.getComputedStyle(n);
            if (s.display === "none" || s.visibility === "hidden") return false;
            var r = n.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }
        var nodes = Array.from(document.querySelectorAll(
            'a, button, [role="button"], span, div'
        )).filter(isVis);
        var match = nodes.find(function(el) {
            var t = (el.textContent || "").trim().toLowerCase();
            return t === "mark all as read";
        });
        if (!match) return false;
        var target = match.closest('a, button, [role="button"]') || match;
        try {
            ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function(type) {
                target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
        } catch (_) { try { target.click(); } catch (__) {} }
        return true;
    });
    if (clicked) {
        console.log("  [mark-read] clicked 'Mark all as read' — bell badge should clear");
        await sleep(800);
    } else {
        console.log("  [mark-read] 'Mark all as read' link not found in dropdown");
    }
    try { await page.keyboard.press("Escape"); } catch (_) {}
    await sleep(200);
}

async function runPhase1Dms(page, botName, persons, summary) {
    console.log("\n[PHASE 1b] DM sweep");
    try {
        var result = await dmSweep.sweepDMs({
            page:    page,
            botName: botName,
            persons: persons,
            openai:  openai,
            opts: {
                maxReplies:    CONFIG.maxDmReplies,
                dryRun:        CONFIG.dryRun,
            },
        });
        for (var i = 0; i < (result.decisions || []).length; i++) {
            var d = result.decisions[i];
            summary.push({ type: "dm", author: d.partner, action: d.action });
        }
        console.log("  handled " + result.handled + " DM(s)");
    } catch (sweepErr) {
        console.warn("  [warn] DM sweep failed: " + sweepErr.message);
    }
}

// ── Community resolution (for triage tuning) ───────────────────────────────
//
// Map the configured Skool community URL onto a canonical key like
// "self-improvement-nation" or "synthesizer" so triage can pick the right
// flex floor, hard-skip category list, and host-author allowlist.
// Skool slugs sometimes carry numeric suffixes (e.g. "hope-nation-7999"), so
// we use substring matching rather than strict equality.
function resolveCommunityKey(url) {
    var lower = (url || "").toLowerCase();
    if (lower.indexOf("self-improvement-nation") !== -1) return "self-improvement-nation";
    if (lower.indexOf("synthesizer") !== -1) return "synthesizer";
    if (lower.indexOf("synthesiser") !== -1) return "synthesizer"; // British spelling
    return null;
}

function getCommunityFlexFloor() {
    var key = resolveCommunityKey(CONFIG.community.url);
    var byCom = CONFIG.flexScoreFloorByCommunity || {};
    if (key != null && byCom[key] != null) return byCom[key];
    return byCom._default != null ? byCom._default : 2;
}

function getHostAuthorsForCommunity() {
    var key = resolveCommunityKey(CONFIG.community.url);
    if (!key) return [];
    return (HOST_AUTHORS_BY_COMMUNITY && HOST_AUTHORS_BY_COMMUNITY[key]) || [];
}

// ── PHASE 2: feed scrape + triage ──────────────────────────────────────────

async function runPhase2Triage(page, persons, ledger) {
    console.log("\n[PHASE 2] feed scrape + triage");
    var allPosts = await withRetry(function() {
        return browser_mod.getAllPosts(page, CONFIG.community.url, CONFIG.feedPagesPerCycle);
    }, { attempts: 2, baseMs: 4000, label: "getAllPosts" });

    // Annotate each post with author context BEFORE classification
    for (var p = 0; p < allPosts.length; p++) {
        allPosts[p].authorContext = buildAuthorContextForPost(persons, ledger, allPosts[p].author);
    }

    // Hard-skip pre-filter: drop confirmed-zero categories and title patterns
    // before paying the LLM. On Synthesizer this typically removes ~80% of
    // the feed; on SIN it usually removes nothing.
    var communityKey = resolveCommunityKey(CONFIG.community.url);
    preFilterHardSkips(allPosts, communityKey);
    var preFilteredPosts = allPosts.filter(function(post) { return post.preFiltered; });
    var toClassify       = allPosts.filter(function(post) { return !post.preFiltered; });
    if (preFilteredPosts.length > 0) {
        console.log("  pre-filter: " + preFilteredPosts.length + " hard-skipped, " +
            toClassify.length + " sent to LLM" +
            (communityKey ? " (community=" + communityKey + ")" : ""));
    }

    if (toClassify.length > 0) {
        await triagePosts(openai, toClassify, CONFIG.triageModel, { contextLabel: "feed cards" });
    }
    var triaged = allPosts;

    var floor = getCommunityFlexFloor();
    var hostAuthors = getHostAuthorsForCommunity();
    var hostSet = {};
    hostAuthors.forEach(function(n) { hostSet[(n || "").trim().toLowerCase()] = true; });

    var anyActionable = triaged.some(function(post) {
        if (post.label === "hook") return true;
        if (post.label !== "value-flex") return false;
        var effFloor = floor;
        if (hostSet[(post.author || "").trim().toLowerCase()]) effFloor = Math.max(0, floor - 1);
        return (post.flex_score || 0) >= effFloor;
    });

    if (!anyActionable) {
        var deepCandidates = pickDeepTriageCandidates(triaged, 5);
        if (deepCandidates.length > 0) {
            console.log("  deep-triage rechecking " + deepCandidates.length + " ambiguous post(s)...");
            for (var dc = 0; dc < deepCandidates.length; dc++) {
                try {
                    await browser_mod.openPostAndGetBody(page, deepCandidates[dc]);
                    deepCandidates[dc].authorContext = buildAuthorContextForPost(persons, ledger, deepCandidates[dc].author);
                } catch (deepErr) {
                    console.warn("  [warn] deep scrape failed: " + deepErr.message);
                }
            }
            await triagePosts(openai, deepCandidates, CONFIG.triageModel, { contextLabel: "full post bodies" });
        }
    }

    return triaged;
}

// ── PHASE 3: public replies ────────────────────────────────────────────────

function filterEligible(posts, ledger, persons, botIdentities, protectedNames) {
    var out = [];
    var minAge = CONFIG.minPostAgeMinutes || 0;
    (posts || []).forEach(function(p) {
        if (!p) return;
        var reason = null;
        if (p.label === "ignore") reason = "label=ignore";
        else if (hasRepliedToThread(ledger, p.href)) reason = "already-replied-to-thread";
        else if (isBotIdentity(p.author, botIdentities)) reason = "bot-identity";
        else if (protectedNames.indexOf(normalizeName(p.author)) !== -1) reason = "protected-name";
        else if (onCooldown(ledger, p.author)) reason = "author-cooldown";
        else if (personsDb.getStage(persons, p.author) >= 2) reason = "stage>=2 (Phase 4 territory)";
        else if (minAge > 0) {
            // Age gate: don't reply to a post that's still warm. Humans take
            // minutes to read + respond. Failing-open (age unknown) is on
            // purpose — we don't want a missing scrape field to silently
            // block the entire feed.
            var ageMin = parsePostAgeMinutes(p.ageText);
            if (ageMin !== null && ageMin < minAge) {
                reason = "too-fresh(" + ageMin + "m, floor=" + minAge + "m)";
            }
        }

        if (reason) {
            // Surface why a non-ignore post got cut so triage decisions are debuggable.
            if (p.label !== "ignore") {
                console.log("  [P3 cut] " + (p.author || "?") + " — " + reason +
                    " — " + (p.title || "").substring(0, 60));
            }
            return;
        }
        out.push(p);
    });
    return out;
}

async function runPhase3PublicReplies(page, persons, ledger, triaged, botName, summary) {
    console.log("\n[PHASE 3] public replies (cap " + CONFIG.maxPublicReplies + ")");

    var botIdentities  = getBotIdentityNames(botName);
    var protectedNames = getProtectedAuthorNames();

    var eligible    = filterEligible(triaged, ledger, persons, botIdentities, protectedNames);
    var floor       = getCommunityFlexFloor();
    var hostAuthors = getHostAuthorsForCommunity();
    var withFloor   = applyFlexFloor(eligible, floor, { hostAuthors: hostAuthors });
    var toReply     = withFloor.slice(0, CONFIG.maxPublicReplies);

    console.log("  eligible " + eligible.length +
        " → after floor (>=" + floor +
        (hostAuthors.length > 0 ? "; -1 for [" + hostAuthors.join(", ") + "]" : "") +
        ") " + withFloor.length +
        " → replying to " + toReply.length);

    for (var i = 0; i < toReply.length; i++) {
        var post = toReply[i];
        console.log("\n  POST " + (i + 1) + "/" + toReply.length + " [" + post.label.toUpperCase() +
            (post.label === "value-flex" ? " f" + post.flex_score : "") + "]");
        console.log("    by " + post.author + ": " + (post.title || "").substring(0, 60));

        try {
            post = await browser_mod.openPostAndGetBody(page, post);
            post.community = CONFIG.community.name;

            if (hasRepliedToThread(ledger, post.href)) {
                console.log("    [skip] already-replied-to-thread (post-open recheck)");
                continue;
            }
            if (isBotIdentity(post.author, botIdentities)) {
                console.log("    [skip] author is the bot itself");
                continue;
            }
            if (protectedNames.indexOf(normalizeName(post.author)) !== -1) {
                console.log("    [skip] author is in protected-names list");
                continue;
            }
            if (onCooldown(ledger, post.author)) {
                console.log("    [skip] author is on 7-day cooldown");
                continue;
            }
            if (await browser_mod.alreadyCommented(page, botName)) {
                console.log("    [skip] " + botName + " already commented on this post (DOM check) — re-recording in ledger");
                recordReply(ledger, post.author, post.label, post.href);
                continue;
            }

            // Run tag_classifier so the RAG retriever can filter examples by
            // intent/sales_stage. Falls back to defaults on failure.
            try {
                var preTags = await classifyReply({
                    postAuthor: post.author,
                    postTitle:  post.title,
                    postBody:   post.body,
                });
                post.intent      = preTags.intent;
                post.sales_stage = preTags.sales_stage;
                post.tone_tags   = preTags.tone_tags;
                console.log("    [TAGS] intent=" + preTags.intent + " stage=" + preTags.sales_stage +
                    " tone=" + (preTags.tone_tags || []).join(","));
            } catch (tagErr) {
                console.warn("    [warn] tag_classifier failed: " + tagErr.message);
            }

            var replyText = await generateReply(openai, post, CONFIG.model);
            console.log("    REPLY: " + replyText);

            // generateReply returns "" when the model failed quality checks
            // twice in a row. Skip the post entirely rather than ship junk.
            if (!replyText) {
                console.log("    [skip] reply was rejected by quality gate — not posting");
                summary.push({ type: "post-skipped", label: post.label, author: post.author, title: post.title, reason: "quality_gate" });
                continue;
            }

            if (!CONFIG.dryRun) {
                await browser_mod.typeReply(page, replyText);
                await browser_mod.submitReply(page);
            }

            recordReply(ledger, post.author, post.label, post.href);
            personsDb.addInteraction(persons, post.author, {
                type: "scott_reply",
                post_title: post.title,
                author: botName,
                text: replyText,
                timestamp: new Date().toISOString(),
            });
            personsDb.promote(persons, post.author, 1, "public reply sent");

            ragOutcomes.logSend({
                channel:       "post",
                intent:        post.intent,
                sales_stage:   post.sales_stage,
                partner:       post.author,
                partner_stage: personsDb.getStage(persons, post.author),
                retrieved_ids: post._ragExampleIds || [],
                reply_text:    replyText,
                post_href:     post.href,
            });

            summary.push({ type: "post", label: post.label, author: post.author, title: post.title });

            sessionLog.addEntry({
                type:            "post",
                postAuthor:      post.author || "",
                postTitle:       post.title  || "",
                postBodyPreview: (post.body || "").substring(0, 300),
                postHref:        post.href || "",
                tags: {
                    tone_tags:   [],
                    intent:      "value-flex",
                    sales_stage: post.label === "hook" ? "qualification" : "nurture",
                    reasoning:   "label=" + (post.label || "?") +
                                 " topic=" + (post.topic || "?") +
                                 " flex_score=" + (post.flex_score != null ? post.flex_score : "?") +
                                 (post.reason ? " — " + post.reason : ""),
                },
                reply: replyText,
            });
        } catch (postErr) {
            console.warn("    [warn] post reply error: " + postErr.message);
        }
    }
}

// ── PHASE 4: outbound DM opens ─────────────────────────────────────────────

async function runPhase4Outbound(page, persons, botName, summary) {
    console.log("\n[PHASE 4] outbound DM opens (cap " + CONFIG.maxOutboundDmOpens + ")");
    if (CONFIG.maxOutboundDmOpens <= 0) {
        console.log("  cap is 0 — skipping");
        return;
    }
    if (process.env.DISABLE_OUTBOUND_DMS === "true") {
        console.log("  DISABLE_OUTBOUND_DMS=true — skipping (community doesn't allow DMs)");
        return;
    }
    try {
        var result = await dmOutbound.runOutboundOpens({
            page:    page,
            botName: botName,
            persons: persons,
            openai:  openai,
            opts: {
                maxOpens: CONFIG.maxOutboundDmOpens,
                dryRun:   CONFIG.dryRun,
            },
        });
        for (var i = 0; i < (result.decisions || []).length; i++) {
            var d = result.decisions[i];
            summary.push({ type: "dm-out", author: d.partner, action: d.action, reason: d.reason });
            if (d.action === "ERROR") {
                console.warn("  [DM-OUT/ERROR] " + d.partner + " — " + (d.reason || "(no reason)"));
            }
        }
        console.log("  opened " + result.opened + " DM(s)");
    } catch (outErr) {
        console.warn("  [warn] outbound failed: " + outErr.message);
    }
}

// ── Main cycle ──────────────────────────────────────────────────────────────

async function runCycle(page, botName, cycle) {
    var ledger  = loadLedger();
    var persons = personsDb.loadPersons();
    var summary = [];

    console.log("\n" + "=".repeat(60));
    console.log("CYCLE " + cycle + (CONFIG.dryRun ? "  [DRY RUN]" : ""));
    console.log("=".repeat(60));

    // PHASE 1 — inbound sweep
    await runPhase1Notifications(page, botName, persons, ledger, summary);
    await runPhase1Dms(page, botName, persons, summary);

    // PHASE 2 — feed triage
    var triaged = await runPhase2Triage(page, persons, ledger);

    await runPhase3PublicReplies(page, persons, ledger, triaged, botName, summary);

    // PHASE 4 — outbound DM opens
    await runPhase4Outbound(page, persons, botName, summary);

    // PHASE 5 — summary
    console.log("\n" + "=".repeat(60));
    console.log("CYCLE " + cycle + " SUMMARY");
    console.log("-".repeat(60));
    var counts = { post: 0, notif: 0, dm: 0, "dm-out": 0 };
    summary.forEach(function(s) { if (counts.hasOwnProperty(s.type)) counts[s.type]++; });
    console.log("  posts:        " + counts.post);
    console.log("  notif acts:   " + counts.notif);
    console.log("  dm replies:   " + counts.dm);
    console.log("  dm opens:     " + counts["dm-out"]);
    summary.forEach(function(s, idx) {
        var tag = s.type === "post" ? "[" + (s.label || "").toUpperCase() + "]"
                : s.type === "notif" ? "[NOTIF/" + s.action + "]"
                : s.type === "dm"     ? "[DM/" + s.action + "]"
                                      : "[DM-OUT/" + s.action + "]";
        console.log("  " + (idx + 1) + ". " + tag + " " + s.author);
    });
    console.log("=".repeat(60));

    // Persist a per-session log of every reply sent (notif + post). The logger
    // writes both JSON (programmatic) and Markdown (review-friendly) into
    // data/logs/. Safe to call each cycle — it overwrites the same file with
    // the cumulative session contents.
    try {
        sessionLog.writeLogs();
    } catch (logErr) {
        console.warn("[warn] session log write failed: " + logErr.message);
    }

    return summary;
}

// ── Entry point ─────────────────────────────────────────────────────────────

(async function main() {
    if (require.main !== module) return;

    if (CONFIG.dryRun) console.log("[DRY RUN] no replies will be submitted\n");

    // One log file per process boot.
    sessionLog.clear();

    // Run a one-shot stage backfill on boot — idempotent.
    try {
        var bootPersons = personsDb.loadPersons();
        personsDb.backfillStages(bootPersons);
    } catch (bfErr) {
        console.warn("[boot] stage backfill failed: " + bfErr.message);
    }

    var browser = await chromium.launch({ headless: CONFIG.headless, slowMo: 50 });
    var context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport:  { width: 1280, height: 900 },
    });
    var page = await context.newPage();

    var botName = await withRetry(function() {
        return browser_mod.login(page, CONFIG.email, CONFIG.password);
    }, { attempts: 2, baseMs: 5000, label: "login" });

    var cycle = 1;
    while (true) {
        try {
            await runCycle(page, botName, cycle);
        } catch (err) {
            console.error("[error] cycle " + cycle + ": " + err.message);
            try { await page.goto("https://www.skool.com", { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (_) {}
        }
        cycle++;
        // Base delay in the [min, max] band, plus a small extra jitter so
        // cycles don't hit on tidy 30/45/60-minute boundaries.
        var baseDelay = randomBetween(CONFIG.cycleDelayMin, CONFIG.cycleDelayMax);
        var jitter    = CONFIG.cycleDelayJitterMs > 0
            ? randomBetween(0, CONFIG.cycleDelayJitterMs) : 0;
        await countdown(baseDelay + jitter, "Next cycle in:");
    }
})();

module.exports = {
    runCycle:                  runCycle,
    buildAuthorContextForPost: buildAuthorContextForPost,
};
