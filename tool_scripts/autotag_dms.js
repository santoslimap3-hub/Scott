/**
 * tool_scripts/autotag_dms.js
 *
 * Auto-tags all 4,016 Scott messages in data/dm_classified.json using GPT-4o-mini
 * with Scott's own 183 hand-corrected DMs (data/scott_dm_corrections.json) as ground
 * truth + few-shot examples, plus deterministic hard rules for the obvious cases.
 *
 * What it does:
 *   1. Reads data/dm_classified.json and groups by Contact (sorted by timestamp).
 *   2. Reads data/scott_dm_corrections.json (183 of Scott's manual corrections).
 *   3. Matches each correction to the corresponding row(s) in dm_classified.json
 *      by scott_reply text (full match + line-by-line for multi-message replies),
 *      stamps `scott_validated=true`. These FROZEN messages never go to the LLM.
 *   4. Applies a deterministic hard-rule pass (calendly/voice/sticker/single-emoji ack).
 *   5. For remaining Scott messages, sends conversation context (prev 5 msgs) to
 *      gpt-4o-mini with 25 stratified few-shots from the corrections.
 *   6. Validates output against allowed tag values; retries on schema fail.
 *   7. Writes tags back to data/dm_classified.json (after a timestamped backup).
 *   8. Saves an audit log for spot-checking.
 *
 * Modes:
 *   node tool_scripts/autotag_dms.js                # full run
 *   node tool_scripts/autotag_dms.js --eval         # self-eval on held-out corrections
 *   node tool_scripts/autotag_dms.js --dry-run      # no file writes
 *   node tool_scripts/autotag_dms.js --limit 50     # only N LLM messages
 *
 * Requires:
 *   - bot/.env with OPENAI_API_KEY
 *   - bot/node_modules/openai (already installed)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ─── Manual .env loader ───────────────────────────────────────────────────────
(function loadEnv(envPath) {
    try {
        var raw = fs.readFileSync(envPath);
        var text = raw.toString("utf8").replace(/^﻿/, "").replace(/\0/g, "");
        var lines = text.split(/\r?\n/);
        for (var line of lines) {
            line = line.trim();
            if (!line || line.startsWith("#")) continue;
            var eqIdx = line.indexOf("=");
            if (eqIdx < 0) continue;
            var key = line.substring(0, eqIdx).trim();
            var val = line.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
            if (key && !process.env[key]) process.env[key] = val;
        }
    } catch (e) { /* .env not found */ }
})(path.join(__dirname, "../bot/.env"));

// ─── Load OpenAI from bot/node_modules ────────────────────────────────────────
const BOT_MODULES = path.join(__dirname, "../bot/node_modules");
const OpenAI = require(path.join(BOT_MODULES, "openai"));

// ─── Optional proxy support (for sandbox environments) ────────────────────────
// On the user's machine this is a no-op. In a sandbox where HTTPS goes through
// localhost:3128, we route the OpenAI SDK through an https-proxy-agent.
function buildHttpAgent() {
    var proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;
    if (!proxyUrl) return null;
    var helperPath = "/tmp/proxy-helper/node_modules/https-proxy-agent/dist/index.js";
    if (!fs.existsSync(helperPath)) return null;
    try {
        var mod = require(helperPath);
        var Cls = mod.HttpsProxyAgent || mod.default;
        return new Cls(proxyUrl);
    } catch (e) {
        return null;
    }
}

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, "../data");
const CLASSIFIED_PATH = path.join(DATA_DIR, "dm_classified.json");
const CORRECTIONS_PATH = path.join(DATA_DIR, "scott_dm_corrections.json");
const ROLES_PATH      = path.join(DATA_DIR, "contact_roles.json");  // Phase 2.1: LLM-labeled roles
const BACKUP_PATH     = path.join(DATA_DIR, "dm_classified_backup_pre_autotag.json");
const AUDIT_PATH      = path.join(__dirname, "autotag_dms_audit.json");
const EVAL_REPORT_PATH = path.join(__dirname, "autotag_dms_eval.json");

// ─── Config ───────────────────────────────────────────────────────────────────
// Phase 1 fix (2026-04-27): bumped from gpt-4o-mini → gpt-4o. The 4o-mini failure
// mode "collapse to engagement-nurture/acknowledgement when uncertain" is a
// small-model symptom that goes away at 4o. Cost on a 4,016-message run is
// ~$8 vs ~$1 — irrelevant for a one-time tagging pass.
const MODEL       = process.env.AUTOTAG_MODEL || "gpt-4o";
const TEMPERATURE = 0;        // deterministic classification
const CONCURRENCY = 6;
const SAVE_EVERY  = 25;
const NUM_FEWSHOTS = 50;
const CONTEXT_WINDOW = 15;    // bumped from 5 — relationship inference needs more context

// ─── CLI args ─────────────────────────────────────────────────────────────────
const ARGS    = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const EVAL_MODE = ARGS.includes("--eval");
const LIMIT   = (() => {
    var i = ARGS.indexOf("--limit");
    return i >= 0 ? parseInt(ARGS[i + 1], 10) : Infinity;
})();

// ─── Valid tag vocabularies (from Scott's 183 corrections) ────────────────────
const VALID_TONES = [
    "hype", "brotherhood", "motivational", "authority", "direct", "casual",
    "self-aggrandization", "teasing-future-value", "praise", "humor",
    "empathy", "storytelling", "vulnerability", "tough-love", "mystery-teasing",
    "chit-chat", "bonding-rapport", "gratitude", "curiosity", "questions",
    "supportive-helpful", "acknowledgement",
];
const VALID_INTENTS = [
    "acknowledgement", "engagement-nurture", "community-building",
    "authority-proofing", "value-delivery", "close-to-call", "social-proof",
    "redirect", "info-gathering", "lead-qualification", "pain-agitation",
    "objection-handling", "funneling",
];

// Phase 2.2 — rare-intent merge policy. Four intents (pain-agitation,
// social-proof, objection-handling, lead-qualification) have ≤2 examples each
// in the corrections file and are statistically unlearnable from few-shot
// prompting. We collapse them to their nearest semantic sibling at eval time
// so the model is not penalized for predicting the catch-all when ground
// truth was a rare class. Both the expected and predicted intents are routed
// through canonicalIntent() before comparison.
//
// The model is still allowed to predict these directly (the validator does
// not strip them), but the eval treats them as their canonical sibling.
const RARE_INTENT_MERGE = {
    "pain-agitation":     "info-gathering",   // probing a prospect's pain → info-gathering
    "social-proof":       "authority-proofing", // sharing wins to a prospect → authority-proofing
    "objection-handling": "redirect",         // addressing an objection → redirect
    "lead-qualification": "info-gathering",   // testing enrollment criteria → info-gathering
};
function canonicalIntent(intent) {
    if (!intent) return intent;
    return RARE_INTENT_MERGE[intent] || intent;
}
const VALID_SALES_STAGES = ["awareness", "engagement", "nurture", "ask"];
const VALID_DM_STAGES = [
    "connect", "gather-intel", "frame-outcome", "share-authority",
    "offer-call", "send-calendly", "nurture-free",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function loadJson(filepath) {
    var raw = fs.readFileSync(filepath, "utf8").replace(/\0+$/, "");
    return JSON.parse(raw);
}

function saveJson(filepath, data) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
}

function saveClassified(filepath, arr) {
    var replacer = function(k, v) {
        if (k === "_idx" || k === "_ts") return undefined;
        return v;
    };
    fs.writeFileSync(filepath, JSON.stringify(arr, replacer, 2), "utf8");
}

function normalizeText(txt) {
    if (typeof txt !== "string") return "";
    return txt.replace(/ /g, " ").trim().replace(/\s+/g, " ");
}

function parseDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    var m = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    var month = parseInt(m[1], 10);
    var day   = parseInt(m[2], 10);
    var year  = parseInt(m[3], 10);
    var t = String(timeStr).match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (!t) return null;
    var hr = parseInt(t[1], 10);
    var mn = parseInt(t[2], 10);
    var sc = parseInt(t[3], 10);
    var ampm = t[4].toUpperCase();
    if (ampm === "PM" && hr < 12) hr += 12;
    if (ampm === "AM" && hr === 12) hr = 0;
    return new Date(year, month - 1, day, hr, mn, sc);
}

function isScottMsg(m) { return m.Speaker === "Scott"; }
function isLeadMsg(m)  { return m.Speaker === "Lead" || m.Speaker === "Participant 1"; }

function groupByContact(messages) {
    var byContact = new Map();
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        m._idx = i;
        m._ts = parseDateTime(m.Date, m.Time);
        var key = m.Contact || "(unknown)";
        if (!byContact.has(key)) byContact.set(key, []);
        byContact.get(key).push(m);
    }
    for (var arr of byContact.values()) {
        arr.sort(function(a, b) {
            var at = a._ts ? a._ts.getTime() : 0;
            var bt = b._ts ? b._ts.getTime() : 0;
            if (at !== bt) return at - bt;
            return a._idx - b._idx;
        });
    }
    return byContact;
}

function contextWindow(convo, idx, n) {
    var start = Math.max(0, idx - n);
    return convo.slice(start, idx);
}

// ─── Contact role inference ──────────────────────────────────────────────────
// Big lever for accuracy. The model can't tell from 5–15 messages alone whether
// the recipient is an existing student, a friend, or a fresh prospect. We
// pre-compute a coarse role for every Contact and inject it into the prompt.
//
// Roles:
//   in-program-or-personal  Scott has a long-running thread with this person —
//                           friend, peer, or current student. Default nonsales=true,
//                           sales_stage=nurture, intent=engagement-nurture/ack.
//   prospect-active         A Calendly link, Meet link, or "ready for our call"
//                           has happened in the recent window. Default nonsales=false,
//                           sales_stage=ask, intent often close-to-call.
//   prospect-cold           Scott welcomed them to the community but no call has
//                           been arranged. Default nonsales=false if Scott is
//                           qualifying / building rapport with sales intent.
//   unknown                 Not enough signal — let the model decide from context.
const RECENT_WINDOW = 15;
const HIGH_VOLUME_THRESHOLD = 25;

function _hasCalendlyLike(text) {
    return /calendly\.com|meet\.google\.com|hangouts\.google\.com|zoom\.us\/j\//i.test(text);
}
function _hasWelcome(text) {
    return /welcome to (the |our )?(community|family|tribe|group|nation|brotherhood|crew)|glad to have you|good to have you|stoked to have you|happy to have you/i.test(text);
}
function _aboutContactBiz(text) {
    // Scott discussing the contact's own business → likely peer/student, not prospect
    return /your (community|funnel|students|coaching|brand|offer|sales|ad spend|ads|business|subscribers|members|niche|content|posts|landing page|webinar|calls|enrollments|pricing|copy|hook|skool)/i.test(text);
}

function computeContactRole(convo) {
    var scottMsgs = convo.filter(isScottMsg);
    var scottCount = scottMsgs.length;

    var allText = convo.map(function(m){ return normalizeText(m.Message); }).join(" ").toLowerCase();
    var scottText = scottMsgs.map(function(m){ return normalizeText(m.Message); }).join(" ").toLowerCase();

    // "Recent" = last RECENT_WINDOW messages of the convo
    var recent = convo.slice(-RECENT_WINDOW);
    var recentText = recent.map(function(m){ return normalizeText(m.Message); }).join(" ").toLowerCase();

    var hasCalendlyEver = _hasCalendlyLike(allText);
    var hasCalendlyRecent = _hasCalendlyLike(recentText);
    var hasWelcome = _hasWelcome(scottText);
    var aboutContactBiz = _aboutContactBiz(scottText);

    // Recent calendar/Calendly → prospect-active (highest priority, even if also a student)
    if (hasCalendlyRecent) return "prospect-active";

    // Long-running convo → in-program-or-personal
    if (scottCount >= HIGH_VOLUME_THRESHOLD) return "in-program-or-personal";

    // Calendly was sent at some point but not recently AND volume is mid → still active funnel
    if (hasCalendlyEver && scottCount < HIGH_VOLUME_THRESHOLD) return "prospect-active";

    // Welcome sent + short convo, no calendar → cold prospect being warmed up
    if (hasWelcome && scottCount <= 20 && !hasCalendlyEver) return "prospect-cold";

    // Scott talks about the contact's own biz → not a prospect, more peer/student
    if (aboutContactBiz) return "in-program-or-personal";

    return "unknown";
}

function computeContactRoles(byContact) {
    var roles = new Map();
    for (var pair of byContact) {
        roles.set(pair[0], computeContactRole(pair[1]));
    }
    return roles;
}

// Phase 2.1 — load LLM-labeled contact roles from data/contact_roles.json if
// present (built one-time by tool_scripts/label_contact_roles.js). The LLM
// roles are far more reliable than the lexical heuristic; we use them as the
// primary source and fall back to the heuristic only for any contact missing
// from the file (e.g., new conversations added after the labeling run).
function loadLlmContactRoles(filepath) {
    try {
        if (!fs.existsSync(filepath)) return null;
        var data = JSON.parse(fs.readFileSync(filepath, "utf8"));
        var out = new Map();
        for (var k of Object.keys(data)) {
            if (data[k] && typeof data[k].role === "string") out.set(k, data[k].role);
        }
        return out;
    } catch (e) {
        return null;
    }
}

function mergeContactRoles(byContact, llmRoles) {
    // LLM roles win when present; otherwise fall back to the heuristic.
    var merged = new Map();
    for (var pair of byContact) {
        var contact = pair[0];
        if (llmRoles && llmRoles.has(contact)) {
            merged.set(contact, llmRoles.get(contact));
        } else {
            merged.set(contact, computeContactRole(pair[1]));
        }
    }
    return merged;
}

// Used in eval mode where we only have last_10_messages, not the full convo.
// We squeeze every signal we can out of those 10 messages.
function computeRoleFromContext(lastMessages, scottReply) {
    var msgs = lastMessages || [];
    var allText = msgs.map(function(m){ return m.text || ""; }).join(" ").toLowerCase()
        + " " + (scottReply || "").toLowerCase();
    var scottMsgs = msgs.filter(function(m){ return m.role === "assistant"; });
    var leadMsgs  = msgs.filter(function(m){ return m.role === "user"; });
    var scottText = scottMsgs.map(function(m){ return m.text || ""; }).join(" ").toLowerCase()
        + " " + (scottReply || "").toLowerCase();
    var leadText = leadMsgs.map(function(m){ return m.text || ""; }).join(" ").toLowerCase();

    // Hard signals first.
    if (_hasCalendlyLike(allText)) return "prospect-active";
    if (_hasWelcome(scottText)) return "prospect-cold";
    if (_aboutContactBiz(scottText)) return "in-program-or-personal";

    // Soft signals — try to find in-program-or-personal cues from the texture
    // of the conversation, since most "unknown" corrections are actually
    // friend/student talk that just doesn't trip the hard signals.
    var brotherhoodRx = /\b(brother|bro|king|fam|man|brotha|broski)\b/i;
    var scottBroCount = scottMsgs.filter(function(m){ return brotherhoodRx.test(m.text || ""); }).length;
    var leadBroCount  = leadMsgs.filter(function(m){ return brotherhoodRx.test(m.text || ""); }).length;

    // Established mutual brotherhood vocab → friend/peer/student
    if (scottBroCount >= 2 || (scottBroCount >= 1 && leadBroCount >= 1)) return "in-program-or-personal";

    // Personal-life topics from Scott → friend talk
    var personalLifeRx = /\bmy (wife|girlfriend|gf|family|son|daughter|kid|home|country|trip|flight|mom|dad|brother|sister|dog|cat|life|partner|love)\b|\b(moved to|back in|flew to|landed in|just got home|tomorrow night|last night|this morning)\b|\b(i'm at|i'm in|i'm parking|i just|grabbing|driving|eating)\b/i;
    if (personalLifeRx.test(scottText)) return "in-program-or-personal";

    // Lead also talking about personal life back to Scott → established friendship
    var leadPersonalRx = /\b(my |our )(wife|girlfriend|family|son|daughter|kid|home|trip|flight|mom|dad)\b|\b(yesterday|today|tomorrow|last night|this morning)\b/i;
    if (leadPersonalRx.test(leadText) && scottMsgs.length >= 3) return "in-program-or-personal";

    // Voice notes / stickers / images / "audio omitted" → friend talk
    if (/\b(audio omitted|sticker omitted|image omitted|voice call|voice note)\b/i.test(allText)) return "in-program-or-personal";

    // 5+ Scott messages in last_10 = active dialogue, likely established
    if (scottMsgs.length >= 5) return "in-program-or-personal";

    // 3+ Scott messages and 3+ Lead messages = active two-way dialogue → established.
    // The previous threshold was too conservative; in eval the bulk of "unknown"
    // are actually established threads with friends/students.
    if (scottMsgs.length >= 3 && leadMsgs.length >= 3) return "in-program-or-personal";

    // First-name address from Scott to the lead in a non-pitch message → personal.
    if (/\b(hey|yo|sup|what'?s up|good morning|good night|gn|gm)\b/i.test(scottText)
        && scottMsgs.length >= 2) return "in-program-or-personal";

    return "unknown";
}

const ROLE_GUIDANCE = {
    "in-program-or-personal":
        "Scott has a long-running, established relationship with this contact (friend, peer, or in-program student). " +
        "STRONG PRIOR: nonsales=true ~85% of the time. Flip to nonsales=false ONLY if Scott is explicitly closing or upselling THIS recipient on a NEW offer (rare). Discussing money / ads / funnels / 'next week I'm selling' is friendship/student business-talk, NOT a sales motion. " +
        "STRONG PRIOR on sales_stage: nurture is the default (~70%). Only pick engagement when the message has a clear engagement signal (RULE 3 (a)/(b)/(c)/(d)). " +
        "intent: engagement-nurture (~50%), acknowledgement (~25%), redirect (~10%) cover most cases. value-delivery / info-gathering / authority-proofing combined are <15% — only pick them when the message unmistakably does that thing.",
    "prospect-active":
        "A Calendly link, Meet/Zoom link, or scheduled call is part of the recent thread. nonsales=false by default. sales_stage usually ask (when scheduling is in play) or engagement (when actively qualifying/teaching). Intent often close-to-call, info-gathering, or value-delivery. dm_stage usually send-calendly or offer-call.",
    "prospect-cold":
        "Scott welcomed this contact to his community recently and has not yet scheduled a call. Early-funnel prospect. Default nonsales=false when Scott is qualifying, teasing future value, or building authority; nonsales=true only for pure pleasantries. Apply RULE 3 for sales_stage.",
    "unknown":
        "Insufficient role signal. Decide everything from message content + context. Lean toward nonsales=true (≈65% of Scott's DMs are nonsales=true) and nurture (≈60% of sales_stages) when in doubt.",
};

// ─── Match corrections to messages (full + line-by-line) ─────────────────────
function matchCorrections(messages, corrections, byContact) {
    var matchedByIdx = new Map();

    var scottByLine = new Map();
    var scottByFull = new Map();
    for (var convo of byContact.values()) {
        for (var i = 0; i < convo.length; i++) {
            var m = convo[i];
            if (!isScottMsg(m)) continue;
            if (typeof m.Message !== "string") continue;
            var full = normalizeText(m.Message).toLowerCase().substring(0, 250);
            if (!full) continue;
            if (!scottByFull.has(full)) scottByFull.set(full, []);
            scottByFull.get(full).push({ msg: m, i: i, convo: convo });

            var firstLine = normalizeText(m.Message.split("\n")[0]).toLowerCase().substring(0, 200);
            if (firstLine) {
                if (!scottByLine.has(firstLine)) scottByLine.set(firstLine, []);
                scottByLine.get(firstLine).push({ msg: m, i: i, convo: convo });
            }
            var fullKey200 = full.substring(0, 200);
            if (fullKey200 && fullKey200 !== firstLine) {
                if (!scottByLine.has(fullKey200)) scottByLine.set(fullKey200, []);
                scottByLine.get(fullKey200).push({ msg: m, i: i, convo: convo });
            }
        }
    }

    function scorePrevLead(c, candidate) {
        var lastMsgs = c.last_10_messages || [];
        var lastUser = "";
        for (var k = lastMsgs.length - 1; k >= 0; k--) {
            if (lastMsgs[k].role === "user") {
                lastUser = normalizeText(lastMsgs[k].text).toLowerCase().substring(0, 200);
                break;
            }
        }
        if (!lastUser) return 0;
        var convo = candidate.convo, ci = candidate.i;
        var prevLeadText = "";
        for (var j = ci - 1; j >= 0; j--) {
            if (isLeadMsg(convo[j])) {
                prevLeadText = normalizeText(convo[j].Message).toLowerCase().substring(0, 200);
                break;
            }
        }
        if (!prevLeadText) return 0;
        if (lastUser === prevLeadText) return 2;
        if (lastUser.substring(0, 60) && prevLeadText.indexOf(lastUser.substring(0, 60)) >= 0) return 1;
        if (prevLeadText.substring(0, 60) && lastUser.indexOf(prevLeadText.substring(0, 60)) >= 0) return 1;
        return 0;
    }

    function pickBest(candidates, c) {
        var best = null, bestScore = -1;
        for (var cand of candidates) {
            if (matchedByIdx.has(cand.msg._idx)) continue;
            var s = scorePrevLead(c, cand);
            if (s > bestScore) { bestScore = s; best = cand; }
        }
        return best;
    }

    var unmatchedIds = [];
    var contactByCorrectionId = new Map();   // correction_id -> Contact (for eval role lookup)
    for (var c of corrections) {
        var reply = c.scott_reply || "";
        if (!reply) { unmatchedIds.push(c.correction_id); continue; }
        var fullKey = normalizeText(reply).toLowerCase().substring(0, 250);
        var claimed = false;

        var cands = scottByFull.get(fullKey);
        if (cands && cands.length > 0) {
            var best = pickBest(cands, c);
            if (best) {
                matchedByIdx.set(best.msg._idx, { new_tags: c.new_tags, correction_id: c.correction_id });
                contactByCorrectionId.set(c.correction_id, best.msg.Contact || null);
                claimed = true;
            }
        }

        if (!claimed) {
            var lines = reply.split(/\n+/).map(function(s){return s.trim();}).filter(Boolean);
            var anyLineClaimed = false;
            for (var line of lines) {
                var lineKey = normalizeText(line).toLowerCase().substring(0, 200);
                if (!lineKey) continue;
                var lineCands = scottByLine.get(lineKey) || scottByFull.get(lineKey);
                if (!lineCands || lineCands.length === 0) continue;
                var pick = pickBest(lineCands, c);
                if (pick) {
                    matchedByIdx.set(pick.msg._idx, { new_tags: c.new_tags, correction_id: c.correction_id });
                    if (!contactByCorrectionId.has(c.correction_id)) {
                        contactByCorrectionId.set(c.correction_id, pick.msg.Contact || null);
                    }
                    anyLineClaimed = true;
                }
            }
            if (anyLineClaimed) claimed = true;
        }

        if (!claimed) unmatchedIds.push(c.correction_id);
    }

    return {
        matchedByIdx: matchedByIdx,
        unmatchedCorrectionIds: unmatchedIds,
        contactByCorrectionId: contactByCorrectionId,
    };
}

// ─── Hard-rule pass ───────────────────────────────────────────────────────────
// Strip directional/zero-width marks that WhatsApp exports often inject before
// "image omitted" / "audio omitted" / "sticker omitted" tokens.
// Covers U+200B..U+200F, U+202A..U+202E, U+2060, U+FEFF.
var _FORMATTING_RX = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]", "g");
function _stripFormatting(s) {
    return String(s || "").replace(_FORMATTING_RX, "").trim();
}

function applyHardRules(message) {
    var t = normalizeText(message);
    if (!t) {
        return { rule: "empty-message",
            tags: { tone_tags: ["chit-chat"], intent: "engagement-nurture", sales_stage: "nurture", dm_stage: null, nonsales: true } };
    }
    var stripped = _stripFormatting(t);
    var lower = stripped.toLowerCase();

    // Pure-media message — message body is *only* the omitted-media token.
    // We tolerate leading/trailing whitespace, U+200E LTR marks, and an optional period.
    if (
        /^(audio|sticker|image|video|gif|file|gif|photo)\s+omitted\.?$/i.test(stripped) ||
        /voice call.*?(no answer|missed|hung up)/i.test(lower) ||
        /^voice call\b/i.test(stripped)
    ) {
        return { rule: "media-omitted",
            tags: { tone_tags: ["chit-chat"], intent: "engagement-nurture", sales_stage: "nurture", dm_stage: null, nonsales: true } };
    }

    // Mixed message: actual content followed by an omitted-media token (e.g.
    // "bro Ad-tivity's payment came my way. ‎image omitted"). Strip the trailing
    // omitted-media token so downstream rules see only the real content.
    var mediaTrailer = /\s*(audio|sticker|image|video|gif|file|photo)\s+omitted\.?\s*$/i;
    if (mediaTrailer.test(stripped) && stripped.replace(mediaTrailer, "").trim().length > 0) {
        // Re-route through this function with the content-only portion.
        var coreOnly = stripped.replace(mediaTrailer, "").trim();
        if (coreOnly && coreOnly !== stripped) {
            t = coreOnly;
            lower = t.toLowerCase();
            // Fall through into the rules below, which now operate on coreOnly.
        }
    }

    if (/calendly\.com/i.test(t)) {
        return { rule: "calendly-link",
            tags: { tone_tags: ["direct", "casual"], intent: "close-to-call", sales_stage: "ask", dm_stage: "send-calendly", nonsales: false } };
    }

    if (/meet\.google\.com|hangouts\.google\.com|zoom\.us\/j\//i.test(t)) {
        return { rule: "meet-link",
            tags: { tone_tags: ["direct", "casual"], intent: "close-to-call", sales_stage: "ask", dm_stage: "offer-call", nonsales: false } };
    }

    if (
        /ready for our call/i.test(lower) ||
        /\bsee you in (a |an )?\d+\s*(min|minutes|hour|hours|hr|hrs)\b/i.test(lower) ||
        /our call in \d/i.test(lower)
    ) {
        return { rule: "call-imminent",
            tags: { tone_tags: ["direct", "questions"], intent: "close-to-call", sales_stage: "ask", dm_stage: "send-calendly", nonsales: false } };
    }

    // Explicit call-pitch — Scott proposes a call without a Calendly link yet.
    // Distinct from call-imminent (which is for confirmed/upcoming calls) and from
    // calendly-link (which has the URL). Triggers `ask + close-to-call` even when
    // the message also contains hype/brotherhood vocabulary.
    if (
        /\blet'?s (schedule|hop on|jump on|get on|do) (a |an )?(call|meet|chat|meeting|google meet|zoom|hangout)\b/i.test(lower) ||
        /\b(schedule|book|set up|hop on|jump on|get on) (a |an )?(call|meeting|chat|meet|zoom)\b/i.test(lower) ||
        /\bgot time for (a |an )?(call|meet|chat)\b/i.test(lower) ||
        /\bwhen are you free for (a |an )?(call|meet|chat)\b/i.test(lower)
    ) {
        return { rule: "call-pitch",
            tags: { tone_tags: ["direct", "motivational"], intent: "close-to-call", sales_stage: "ask", dm_stage: "offer-call", nonsales: false } };
    }

    // ── Phase 3.1 intent rules — high-precision signals only ──
    // community-building: welcome message to a new member or pointer to introduce
    // themselves in the community. Very narrow regex to avoid false positives.
    if (
        /\bwelcome to (the |our |my )?(community|family|tribe|group|nation|brotherhood|crew|team|skool|gang)\b/i.test(lower) ||
        /\b(introduce yourself|say hello|say hi)\b.*\b(community|gang|group|nation|brotherhood)\b/i.test(lower) ||
        /skool\.com\/[^\s]+\/say-hello/i.test(t)
    ) {
        return { rule: "welcome-community",
            tags: { tone_tags: ["brotherhood", "casual", "direct"], intent: "community-building", sales_stage: "nurture", dm_stage: "connect", nonsales: false } };
    }

    // redirect: very narrow "decline / pass / sit out" pattern. Only fires when
    // the message OPENS with one of these markers — anything mid-sentence is
    // ambiguous and routed to the LLM. This avoids the "no, but..." false-positive
    // pattern where "no" is a soft acknowledgement before agreeing.
    if (
        /^(i don'?t think (so|i)|i'?ll have to (sit this|pass)|i'?m not going to|i'?m gonna pass|nah\b|no thanks)/i.test(stripped)
    ) {
        return { rule: "decline-redirect",
            tags: { tone_tags: ["direct", "casual"], intent: "redirect", sales_stage: "nurture", dm_stage: null, nonsales: true } };
    }

    var emojiOnly = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(t);
    var wordCount = t.split(/\s+/).filter(Boolean).length;
    var ackPhrases = /^(thanks|thank you|thx|cheers|epic|sweet|nice|amazing|love it|awesome|bet|sure|yes|yeah|yep|got it|cool|nice one|good|all good|np|no worries)([\s,!.\-]*(bro|brother|man|king|fam|mate)?[\s.!?]*)?$/i;

    if (emojiOnly && wordCount <= 4) {
        return { rule: "emoji-only",
            tags: { tone_tags: ["hype"], intent: "acknowledgement", sales_stage: "nurture", dm_stage: null, nonsales: true } };
    }
    if (wordCount <= 5 && ackPhrases.test(t.replace(/\s+/g, " "))) {
        return { rule: "short-ack",
            tags: { tone_tags: ["gratitude", "casual"], intent: "acknowledgement", sales_stage: "nurture", dm_stage: null, nonsales: true } };
    }

    return null;
}

// ─── Few-shot selection: stratified by ROLE × output combo ────────────────────
// Round 2 change: previously stratified only by output combo, which meant the
// few-shots could be heavily biased toward one role. Now we first ensure ≥6
// shots per role bucket, then within each bucket stratify by output combo.
function _roleForCorrection(c, contactRoles, contactByCorrectionId) {
    if (contactByCorrectionId && contactRoles) {
        var contact = contactByCorrectionId.get(c.correction_id);
        if (contact && contactRoles.has(contact)) return contactRoles.get(contact);
    }
    return computeRoleFromContext(c.last_10_messages, c.scott_reply);
}

function selectFewShots(corrections, n, contactRoles, contactByCorrectionId) {
    // Skip corrections with empty intent/sales_stage — degenerate.
    var pool = corrections.filter(function(c) {
        var nt = c.new_tags || {};
        return (nt.intent || "").trim() && (nt.sales_stage || "").trim();
    });

    // Bucket by role first.
    var byRole = { "in-program-or-personal": [], "prospect-active": [], "prospect-cold": [], "unknown": [] };
    for (var c of pool) {
        var role = _roleForCorrection(c, contactRoles, contactByCorrectionId);
        if (!byRole[role]) byRole[role] = [];
        byRole[role].push(c);
    }

    // Within each role, sub-stratify by output combo.
    function comboKey(c) {
        var nt = c.new_tags || {};
        return [nt.sales_stage || "", nt.intent || "", nt.dm_stage || "null", String(nt.nonsales)].join("|");
    }
    function pickFromBucket(bucket, count, alreadyPicked) {
        var byCombo = new Map();
        for (var c of bucket) {
            var k = comboKey(c);
            if (!byCombo.has(k)) byCombo.set(k, []);
            byCombo.get(k).push(c);
        }
        var combos = Array.from(byCombo.entries()).sort(function(a, b) { return b[1].length - a[1].length; });
        var out = [];
        var idx = 0;
        while (out.length < count) {
            var made = false;
            for (var [k, list] of combos) {
                if (out.length >= count) break;
                var pick = list[idx];
                if (pick && !alreadyPicked.has(pick.correction_id)) {
                    out.push(pick);
                    alreadyPicked.add(pick.correction_id);
                    made = true;
                }
            }
            if (!made) break;
            idx++;
        }
        return out;
    }

    var picked = [];
    var pickedIds = new Set();

    // Round-1 distribution: 84 matched corrections, ~half in-program-or-personal,
    // ~quarter prospect-active, ~10% prospect-cold, rest unknown. Allocate
    // proportionally to that — but enforce a floor of 6 per role.
    var allocations = {
        "in-program-or-personal": Math.min(byRole["in-program-or-personal"].length, Math.max(6, Math.floor(n * 0.45))),
        "prospect-active":        Math.min(byRole["prospect-active"].length,        Math.max(6, Math.floor(n * 0.25))),
        "prospect-cold":          Math.min(byRole["prospect-cold"].length,          Math.max(6, Math.floor(n * 0.15))),
        "unknown":                Math.min(byRole["unknown"].length,                Math.max(6, Math.floor(n * 0.15))),
    };
    // Trim allocations down to budget n.
    var roleOrder = ["in-program-or-personal", "prospect-active", "prospect-cold", "unknown"];
    var totalAlloc = roleOrder.reduce(function(s, r) { return s + allocations[r]; }, 0);
    if (totalAlloc > n) {
        // Proportional shrink.
        var scale = n / totalAlloc;
        for (var r of roleOrder) allocations[r] = Math.floor(allocations[r] * scale);
    }

    for (var r of roleOrder) {
        var got = pickFromBucket(byRole[r], allocations[r], pickedIds);
        picked = picked.concat(got);
    }

    // Top up to n if we underfilled (e.g., a role bucket was small).
    if (picked.length < n) {
        var leftover = pool.filter(function(c) { return !pickedIds.has(c.correction_id); });
        var topUp = pickFromBucket(leftover, n - picked.length, pickedIds);
        picked = picked.concat(topUp);
    }

    return picked;
}

// ─── Contrast example picker (Phase 1 fix) ───────────────────────────────────
// Hand-authored contrast examples in the prompt were teaching the model the
// wrong answer — e.g. the original Contrast B used the "Infinite gratitude"
// quote labeled `nurture+ack`, but Scott's actual correction labels that exact
// message `engagement+ack`. The model was being explicitly mistrained.
//
// We now pick contrast examples FROM the few-shot pool (Scott's verbatim
// labels) at prompt-build time, so every demonstration matches ground truth.
// In eval mode the few-shots are the train set, so this also avoids leaking
// held-out items into the system prompt.
function _renderContrastEx(c, narrative) {
    if (!c) return null;
    var t = c.new_tags || {};
    var out = {
        tone_tags: t.tone_tags || [],
        intent: t.intent || "",
        sales_stage: t.sales_stage || "",
        dm_stage: t.dm_stage !== undefined ? t.dm_stage : null,
        nonsales: t.nonsales,
    };
    var reply = (c.scott_reply || "").replace(/\n+/g, " / ").substring(0, 280);
    var lines = ["  [Scott]: " + reply, "  Output: " + JSON.stringify(out)];
    if (narrative) lines.push("    (" + narrative + ")");
    return lines.join("\n");
}

function pickContrastExamples(fewShots) {
    // Each entry tries multiple predicates from most-specific to most-general
    // so the function still produces output even when the few-shot pool
    // doesn't contain a perfect archetype match.
    function find(preds) {
        for (var i = 0; i < preds.length; i++) {
            var hit = fewShots.find(preds[i]);
            if (hit) return hit;
        }
        return null;
    }

    var has = function(c, intent, ss, ns) {
        var t = c.new_tags || {};
        return t.intent === intent &&
               (ss === undefined || t.sales_stage === ss) &&
               (ns === undefined || t.nonsales === ns);
    };
    var lengthBetween = function(c, lo, hi) {
        var len = (c.scott_reply || "").length;
        return len >= lo && len <= hi;
    };

    return {
        // Pair A — short ack vs long ack: both intent=ack but sales_stage differs.
        ack_short:  find([
            function(c) { return has(c,"acknowledgement","nurture",true) && lengthBetween(c,1,30); },
            function(c) { return has(c,"acknowledgement","nurture",true) && lengthBetween(c,1,60); },
        ]),
        ack_long:   find([
            function(c) { return has(c,"acknowledgement","engagement",true) && lengthBetween(c,40,400); },
            function(c) { return has(c,"acknowledgement","engagement") && lengthBetween(c,40,400); },
        ]),

        // Pair B — chatty engagement-nurture vs qualifying question (info-gathering).
        en_chatty:  find([
            function(c) { return has(c,"engagement-nurture","engagement",true) && lengthBetween(c,40,300); },
            function(c) { return has(c,"engagement-nurture","engagement"); },
        ]),
        info_gather: find([
            function(c) { return has(c,"info-gathering","engagement",false) && /\?/.test(c.scott_reply || ""); },
            function(c) { return has(c,"info-gathering",undefined,false); },
            function(c) { return has(c,"info-gathering"); },
        ]),

        // Pair C — friendly redirect vs explicit call pitch.
        redirect:   find([
            function(c) { return has(c,"redirect","nurture",true); },
            function(c) { return has(c,"redirect"); },
        ]),
        close_call: find([
            function(c) { return has(c,"close-to-call","ask",false); },
            function(c) { return has(c,"close-to-call"); },
        ]),

        // Pair D — authority-proofing vs value-delivery (both to prospect, often
        // confused with engagement-nurture).
        authority:  find([
            function(c) { return has(c,"authority-proofing","engagement",false); },
            function(c) { return has(c,"authority-proofing"); },
        ]),
        value:      find([
            function(c) { return has(c,"value-delivery",undefined,false); },
            function(c) { return has(c,"value-delivery"); },
        ]),

        // Pair E — community-building (welcome message to new member).
        community:  find([
            function(c) { return has(c,"community-building"); },
        ]),
    };
}

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt(fewShots) {
    var lines = [];
    lines.push("You label one of Scott Northwolf's outbound DMs. Scott is a high-ticket sales coach for self-improvement coaches on Skool. He messages hundreds of men daily — some are brand-new prospects he is trying to enroll, some are existing students he is coaching, some are personal friends, some are random people pitching him. Output strict JSON only — no prose, no markdown, no explanation.");
    lines.push("");
    lines.push("OUTPUT SCHEMA (all five fields required):");
    lines.push("  tone_tags:   array of 1–5 strings from " + JSON.stringify(VALID_TONES));
    lines.push("  intent:      exactly one string from " + JSON.stringify(VALID_INTENTS));
    lines.push("  sales_stage: exactly one string from " + JSON.stringify(VALID_SALES_STAGES));
    lines.push("  dm_stage:    one string from " + JSON.stringify(VALID_DM_STAGES) + ", or JSON null");
    lines.push("  nonsales:    boolean (true or false)");
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("RULE 0 — TOPIC vs RELATIONSHIP  ← read this twice");
    lines.push("══════════════════════════════════════════════");
    lines.push("Scott talks about business topics — sales, ad spend, funnels, money, content,");
    lines.push("offers, marketing — CONSTANTLY with friends and existing students. Those are");
    lines.push("the TOPIC, not the INTENT. nonsales is determined by WHO the recipient is and");
    lines.push("WHETHER this specific message is moving THEM through HIS sales funnel — never");
    lines.push("by the words 'sales', 'funnel', 'ad', 'money', 'community' appearing in the text.");
    lines.push("");
    lines.push("Every user prompt opens with a 'Contact relationship:' line. TRUST IT. It's");
    lines.push("computed from the full conversation history (Calendly links, welcomes, message");
    lines.push("volume) and is more reliable than what you can infer from the 15-message window.");
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("RULE 1 — NONSALES  (most important decision)");
    lines.push("══════════════════════════════════════════════");
    lines.push("nonsales=true means Scott has NO sales intent in THIS specific message —");
    lines.push("he is not trying to book a call, enroll someone, or advance a sales pipeline.");
    lines.push("");
    lines.push("NONSALES DEFAULTS BY CONTACT RELATIONSHIP — these are STRONG priors. Override");
    lines.push("only when the specific message unambiguously contradicts the prior:");
    lines.push("  Contact relationship = in-program-or-personal → nonsales=true ALMOST ALWAYS");
    lines.push("    (~85%). Friends, peers, or existing students. Business-topic talk (money,");
    lines.push("    ads, funnels, '$10K month', 'next week I start selling', wins, advice,");
    lines.push("    explanations) is friendship/student business-talk, NOT a sales motion aimed");
    lines.push("    at this recipient. The ONLY override is if Scott is explicitly pitching them");
    lines.push("    a NEW offer / asking them to enroll / sending Calendly to book a sales call.");
    lines.push("    A friendly question, an explanation, a wisdom-drop, or a long worldview rant");
    lines.push("    is NOT a sales motion to a friend/student.");
    lines.push("  Contact relationship = prospect-active → nonsales=false by default.");
    lines.push("  Contact relationship = prospect-cold → nonsales=false when qualifying,");
    lines.push("    teasing, building authority, welcoming. Pure pleasantries → nonsales=true.");
    lines.push("  Contact relationship = unknown → use the message + context. ≈65% of");
    lines.push("    Scott's messages are nonsales=true; lean true when in doubt.");
    lines.push("");
    lines.push("ALWAYS nonsales=true regardless of relationship:");
    lines.push("  ✓ Voice notes, stickers, image/audio omitted, emoji-only.");
    lines.push("  ✓ Short acks: 'sure', 'got it', 'yeah', 'thanks bro', 'epic', 'fire'.");
    lines.push("  ✓ Personal banter, philosophical musings, storytelling.");
    lines.push("  ✓ Empathy, check-ins, moral support.");
    lines.push("  ✓ Scott being pitched TO (he's the buyer, not the seller).");
    lines.push("  ✓ Internal partner/team coordination (expenses, logistics).");
    lines.push("");
    lines.push("nonsales=false is ONLY for messages where Scott is actively pushing THIS");
    lines.push("recipient down HIS funnel: booking a call, qualifying a prospect, sending a");
    lines.push("Calendly link, welcoming them into the community, or explicitly offering his");
    lines.push("program. Discussing business topics with someone who is already in or already");
    lines.push("declined → nonsales=true.");
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("RULE 2 — DM_STAGE");
    lines.push("══════════════════════════════════════════════");
    lines.push("  nonsales=true  → dm_stage MUST be null (in 95%+ of cases).");
    lines.push("  nonsales=false → pick one that fits:");
    lines.push("    connect         = first welcoming message to a new community member");
    lines.push("    gather-intel    = Scott asks questions to qualify a prospect");
    lines.push("    frame-outcome   = Scott paints the result/transformation for a prospect");
    lines.push("    share-authority = Scott shares wins/credibility to impress a prospect");
    lines.push("    offer-call      = Scott proposes a Google Meet / Zoom call");
    lines.push("    send-calendly   = Scott sends a Calendly link or asks to confirm a booked call");
    lines.push("    nurture-free    = Scott delivers value/community content without a hard ask");
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("RULE 3 — SALES_STAGE  (never null)");
    lines.push("══════════════════════════════════════════════");
    lines.push("ACTUAL DISTRIBUTION (use as a strong prior):");
    lines.push("  nurture     ~60%   ← DEFAULT — most of Scott's DMs are nurture");
    lines.push("  engagement  ~25%   ← only with specific signals (see below)");
    lines.push("  ask         ~13%   ← only when scheduling is explicit");
    lines.push("  awareness   ~0.5%  ← almost never (first cold outreach only)");
    lines.push("");
    lines.push("DEFAULT TO nurture. Only choose engagement if AT LEAST ONE is true:");
    lines.push("  (a) Scott is asking the recipient a real qualifying / outcome question");
    lines.push("      ('what are you working on?', 'where are you stuck?', 'how are sales going?');");
    lines.push("  (b) Scott coordinates plans across multiple people or specific deliverables");
    lines.push("      ('send it to Lea', 'I'll talk to X tomorrow', 'we'll meet Friday at the venue');");
    lines.push("  (c) Scott's message is ≥40 words AND contains substantive content (info-sharing,");
    lines.push("      strategy explanation, opinion-with-reasoning) — NOT just a long voice-note");
    lines.push("      paraphrase, philosophical musing, or life update;");
    lines.push("  (d) The visible context shows an active 3+ message back-and-forth on each side");
    lines.push("      with real content (not just acks/stickers/voice notes).");
    lines.push("");
    lines.push("Choose ask ONLY when scheduling is explicit — Calendly link present, 'let's");
    lines.push("schedule a call', 'what time works?', 'are you home for our call?', confirming");
    lines.push("a specific meeting time.");
    lines.push("");
    lines.push("Examples that LOOK long but are still nurture (do NOT pick engagement for these):");
    lines.push("  ✗ 'Thanks brother. Infinite gratitude for this moment. We both live here now,");
    lines.push("    we are going to be seeing each other a lot. I feel like we have still so much");
    lines.push("    to talk about. I hope you frequent that place...' → nurture (life-update / banter)");
    lines.push("  ✗ 'I'm parking…' / 'bro Ad-tivity's payment came my way. image omitted' → nurture");
    lines.push("  ✗ 'Yes, I'm looking forward to Friday, man.' → nurture (banter, no coordination)");
    lines.push("  ✗ 'I just posted it and boosted the fuck out of it.' → nurture (1-fact statement)");
    lines.push("  ✗ A long philosophical musing or worldview rant → nurture");
    lines.push("");
    lines.push("Examples that ARE engagement:");
    lines.push("  ✓ 'Cool! What are you doing there? Family or business?' → engagement (qualifying question)");
    lines.push("  ✓ 'You can send it to Lea, she'll be posting all week. Tag me when it's up.' → engagement (coordination)");
    lines.push("  ✓ A 50-word strategic explanation with multiple distinct points → engagement");
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("RULE 4 — INTENT");
    lines.push("══════════════════════════════════════════════");
    lines.push("ACTUAL DISTRIBUTION in Scott's hand-labeled corpus (use as a prior):");
    lines.push("  engagement-nurture ≈ 34%   ← MOST COMMON. Casual back-and-forth that isn't");
    lines.push("                              a pure ack, isn't qualifying, isn't pitching.");
    lines.push("  acknowledgement    ≈ 14%");
    lines.push("  close-to-call      ≈ 9%");
    lines.push("  value-delivery     ≈ 8%   (prospects only — see anti-pattern below)");
    lines.push("  info-gathering     ≈ 8%");
    lines.push("  authority-proofing ≈ 8%");
    lines.push("  community-building ≈ 7%");
    lines.push("  redirect           ≈ 6%");
    lines.push("  funneling          ≈ 3%");
    lines.push("  pain-agitation, social-proof, objection-handling, lead-qualification: rare");
    lines.push("");
    lines.push("DEFINITIONS:");
    lines.push("  engagement-nurture = the catch-all for casual chatty back-and-forth — friendship");
    lines.push("                       talk, peer banter, in-program student talk that doesn't fit");
    lines.push("                       a more specific bucket. THIS IS THE LARGEST BUCKET — use it");
    lines.push("                       when the message is conversational and there's no clear");
    lines.push("                       qualifying / pitching / authority-flexing / explicit ack.");
    lines.push("  acknowledgement    = the message's core function is to confirm, agree, or react");
    lines.push("                       (short or medium). 'Thanks bro', 'got it', 'fucking G!',");
    lines.push("                       'amazing', 'sure', 'yes it's fire'. NOT chatty replies");
    lines.push("                       that contain back-and-forth content — those are engagement-nurture.");
    lines.push("  redirect           = Scott pivots, declines, deflects, or steers away. 'No thanks',");
    lines.push("                       'I'll have to sit this one out', 'no bro, that's not how it works'.");
    lines.push("  close-to-call      = Scott explicitly proposes, schedules, or confirms a call.");
    lines.push("  info-gathering     = Scott asks qualifying questions of a PROSPECT specifically");
    lines.push("                       to advance them through the funnel. Casual questions to a");
    lines.push("                       friend or student are engagement-nurture, NOT info-gathering.");
    lines.push("  authority-proofing = Scott makes confident worldview assertions specifically aimed");
    lines.push("                       at impressing a prospect. Confident-sounding text to a peer or");
    lines.push("                       student is engagement-nurture, not authority-proofing.");
    lines.push("  value-delivery     = Scott deliberately coaches/teaches A PROSPECT (someone who");
    lines.push("                       has not yet enrolled) to build desire for his program. If the");
    lines.push("                       recipient is in-program-or-personal, this is NEVER the right");
    lines.push("                       intent — even when Scott is dropping wisdom or explaining strategy.");
    lines.push("  community-building = first welcome to a new community member or connecting people.");
    lines.push("  social-proof       = Scott shares his own income/wins/client results to a prospect.");
    lines.push("  pain-agitation     = Scott amplifies the prospect's problem to create urgency.");
    lines.push("  objection-handling = Scott addresses an objection about enrolling.");
    lines.push("  lead-qualification = Scott explicitly tests enrollment criteria.");
    lines.push("  funneling          = Scott directs someone to a specific pipeline step.");
    lines.push("");
    lines.push("KEY ANTI-PATTERNS:");
    lines.push("");
    lines.push("ACK BOUNDARY — the most consequential decision:");
    lines.push("  acknowledgement is the right intent when the message's PRIMARY function is to");
    lines.push("  confirm/agree/react. Use the WORD-COUNT TEST:");
    lines.push("    ≤ 5 words, no question, no info → almost always acknowledgement");
    lines.push("    6–15 words, opens with thanks/great/amazing AND no question AND no plan");
    lines.push("        → acknowledgement");
    lines.push("    16+ words OR contains a question → engagement-nurture (or other specific intent)");
    lines.push("");
    lines.push("  Examples that ARE acknowledgement (do NOT pick engagement-nurture for these):");
    lines.push("    ✓ 'Thanks, bro!' / 'Got it' / 'Amazing brother' → acknowledgement");
    lines.push("    ✓ 'Bro' / 'image omitted' (single token) → acknowledgement");
    lines.push("    ✓ 'Great, man. I still don't understand how you want the payment.' → acknowledgement");
    lines.push("        (acknowledgement of context, no real engagement)");
    lines.push("    ✓ 'Good morning, Lea. That's actually pretty good!' → acknowledgement");
    lines.push("");
    lines.push("  Examples that are NOT acknowledgement (engagement-nurture instead):");
    lines.push("    ✗ 'Thanks bro, by the way I'm planning to start going Saturdays...' → engagement-nurture");
    lines.push("    ✗ 'Great, you can send it to Lea, she'll be posting all week long...' → engagement-nurture");
    lines.push("");
    lines.push("VALUE-DELIVERY / INFO-GATHERING / AUTHORITY-PROOFING — RARE for in-program contacts:");
    lines.push("  These are LOW-FREQUENCY intents (~5% each among in-program-or-personal contacts).");
    lines.push("  Pick them ONLY when the message UNMISTAKABLY does the thing:");
    lines.push("    info-gathering    = Scott explicitly asks a qualifying question to MOVE someone");
    lines.push("                        through the funnel ('what's your offer?', 'how much are you");
    lines.push("                        making?'). A casual / curious question to a friend is");
    lines.push("                        engagement-nurture, NOT info-gathering.");
    lines.push("    value-delivery    = Scott deliberately TEACHES a strategy/framework with the");
    lines.push("                        explicit purpose of building desire to enroll. Sharing");
    lines.push("                        information / explaining a fact / giving advice to a friend");
    lines.push("                        is engagement-nurture, NOT value-delivery.");
    lines.push("    authority-proofing= Scott makes a confident worldview/expertise assertion");
    lines.push("                        targeted at impressing a prospect. Confident-sounding text");
    lines.push("                        to a friend or student is engagement-nurture, NOT authority-");
    lines.push("                        proofing.");
    lines.push("  When in doubt for in-program-or-personal contacts → engagement-nurture, not these.");
    lines.push("");
    lines.push("OTHER RULES:");
    lines.push("  ✗ Do not predict acknowledgement for messages where Scott is proposing/scheduling");
    lines.push("    a call → close-to-call regardless of warm tone.");
    lines.push("  ✗ Do not predict acknowledgement for messages where Scott declines/deflects/");
    lines.push("    pivots → redirect ('no bro', 'I'll have to sit this one out', 'nah').");
    lines.push("  ✓ engagement-nurture is the modal class (~34% overall, ~50% for in-program). Reach");
    lines.push("    for it whenever a message is chatty back-and-forth that isn't a pure ack and");
    lines.push("    doesn't fit a more specific bucket.");
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("RULE 5 — TONE TAGS  (pick 1–5; aim for ~3–4)");
    lines.push("══════════════════════════════════════════════");
    lines.push("Scott's actual usage frequency (use as priors):");
    lines.push("  direct (39%), casual (31%), authority (30%), questions (27%), motivational (26%),");
    lines.push("  hype (23%), chit-chat (23%), brotherhood (21%), teasing-future-value (21%),");
    lines.push("  self-aggrandization (18%), bonding-rapport (17%), curiosity (14%),");
    lines.push("  supportive-helpful (13%), praise (11%), empathy (10%), mystery-teasing (9%),");
    lines.push("  storytelling (9%), humor (8%), gratitude (7%), tough-love (6%), vulnerability (3%).");
    lines.push("");
    lines.push("DEFINITIONS (and when to add):");
    lines.push("  questions            = ALWAYS add if the message contains a literal '?'.");
    lines.push("  direct               = blunt, no-nonsense, declarative — 'no bro', 'I don't',");
    lines.push("                          short imperatives, period-ended assertions. Scott's");
    lines.push("                          MOST common tone — add it liberally when he is");
    lines.push("                          stating a fact/opinion without hedging.");
    lines.push("  authority            = confident worldview / expertise assertions, 'this is");
    lines.push("                          how it works', explanations of his framework.");
    lines.push("  hype                 = high-energy excitement — ALL-CAPS words, intensifiers");
    lines.push("                          ('fucking', 'huge', 'massive'), 'LFG', '!!!', fire");
    lines.push("                          emoji, exclamation pile-ups. NOT just any enthusiasm,");
    lines.push("                          but Scott uses this 23% — be willing to add it whenever");
    lines.push("                          there's energy/intensity.");
    lines.push("  chit-chat            = casual NON-business banter — life updates, food, sleep,");
    lines.push("                          parking, weather, voice notes / stickers / image-only");
    lines.push("                          messages, 'what's up', 'good morning'.");
    lines.push("  casual               = relaxed conversational tone (overlaps chit-chat). Use");
    lines.push("                          casual when the message is light/relaxed but discusses");
    lines.push("                          business; use chit-chat when the topic is purely social.");
    lines.push("  brotherhood          = ADD ONLY when 'brother/bro/king/fam/man' is the FOCUS");
    lines.push("                          of the address (multiple uses, or used as the core");
    lines.push("                          rhetorical device). Do not add for any single passing");
    lines.push("                          'bro' — that's just Scott's vocabulary.");
    lines.push("  motivational         = encouragement, push-forward energy, 'let's go'.");
    lines.push("  self-aggrandization  = Scott talks about HIS scale/wins/'what I'm building'/");
    lines.push("                          'I'm running'/'my community'/'my brand'/'$X/month'/'I'm");
    lines.push("                          launching'. Common — Scott does this often. ADD whenever");
    lines.push("                          the message centers his own activity/scale.");
    lines.push("  teasing-future-value = hints at things to come — 'see you Friday', 'we'll talk");
    lines.push("                          soon', 'you'll see', 'more adventures', 'next chapter',");
    lines.push("                          'just wait', 'next week', 'tomorrow', any explicit");
    lines.push("                          forward reference. Used 21% — add liberally.");
    lines.push("  mystery-teasing      = cryptic hooks — 'I'm building something HUGE', 'big things");
    lines.push("                          coming', 'you have no idea what's about to drop'.");
    lines.push("  praise               = explicit compliment — 'fucking G!', 'amazing', 'beast'.");
    lines.push("  empathy              = emotional validation, 'I get it', 'no worries'.");
    lines.push("  gratitude            = thanking the recipient.");
    lines.push("  bonding-rapport      = warmth, shared moments, 'we/us/our'.");
    lines.push("  storytelling         = Scott narrates an event/experience.");
    lines.push("  vulnerability        = admits weakness, fear, uncertainty, mistake.");
    lines.push("  curiosity            = genuine interest in recipient's situation.");
    lines.push("  supportive-helpful   = offering help / resources / a way forward.");
    lines.push("  tough-love           = pushing back, calling out weakness, no-coddling honesty.");
    lines.push("  humor                = ONLY if something is genuinely funny / a joke.");
    lines.push("");
    lines.push("Scott-signature tones — add liberally when the cue is present:");
    lines.push("  self-aggrandization  = Scott talks about HIS own scale/vision/wins/money/'what I'm");
    lines.push("                          building'. Common — Scott does this often.");
    lines.push("  teasing-future-value = hints at things to come. 'see you Friday', 'we'll talk soon',");
    lines.push("                          'you'll see', 'more adventures', 'next chapter', 'just wait'.");
    lines.push("  mystery-teasing      = cryptic hooks designed to intrigue. 'I'm building something");
    lines.push("                          HUGE', 'big things coming', 'you have no idea what's about");
    lines.push("                          to drop'.");
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("CONTRAST EXAMPLES — verbatim from Scott's labels (ground truth)");
    lines.push("══════════════════════════════════════════════");
    lines.push("These are the most error-prone boundaries. Examples below are pulled");
    lines.push("verbatim from Scott's hand-corrections — the labels are ground truth.");
    lines.push("");

    var contrasts = pickContrastExamples(fewShots);
    var contrastBlocks = [];

    var ackPair = [];
    if (contrasts.ack_short) ackPair.push(_renderContrastEx(contrasts.ack_short, "short pure ack → ack+nurture+nonsales=true"));
    if (contrasts.ack_long)  ackPair.push(_renderContrastEx(contrasts.ack_long,  "longer ack within active dialogue — STILL ack, but engagement (not nurture)"));
    if (ackPair.length) contrastBlocks.push("Contrast A — short ack vs long ack:\n" + ackPair.join("\n\n"));

    var enPair = [];
    if (contrasts.en_chatty)  enPair.push(_renderContrastEx(contrasts.en_chatty,  "chatty back-and-forth → engagement-nurture+engagement"));
    if (contrasts.info_gather) enPair.push(_renderContrastEx(contrasts.info_gather, "qualifying question to prospect → info-gathering+engagement+nonsales=false"));
    if (enPair.length) contrastBlocks.push("Contrast B — chatty engagement-nurture vs info-gathering qualifying question:\n" + enPair.join("\n\n"));

    var pitchPair = [];
    if (contrasts.redirect)   pitchPair.push(_renderContrastEx(contrasts.redirect,   "friendly correction/decline → redirect+nurture+nonsales=true"));
    if (contrasts.close_call) pitchPair.push(_renderContrastEx(contrasts.close_call, "explicit call pitch → close-to-call+ask+nonsales=false"));
    if (pitchPair.length) contrastBlocks.push("Contrast C — friendly redirect vs explicit call pitch:\n" + pitchPair.join("\n\n"));

    var teachPair = [];
    if (contrasts.authority) teachPair.push(_renderContrastEx(contrasts.authority, "confident worldview to prospect → authority-proofing+engagement+nonsales=false"));
    if (contrasts.value)     teachPair.push(_renderContrastEx(contrasts.value,     "deliberate teaching to prospect → value-delivery+nonsales=false"));
    if (teachPair.length) contrastBlocks.push("Contrast D — authority-proofing vs value-delivery (both to prospects):\n" + teachPair.join("\n\n"));

    if (contrasts.community) {
        contrastBlocks.push("Contrast E — community-building welcome:\n" + _renderContrastEx(contrasts.community, "first-touch welcome → community-building+nonsales=false"));
    }

    lines.push(contrastBlocks.join("\n\n"));
    lines.push("");
    lines.push("══════════════════════════════════════════════");
    lines.push("FEW-SHOT EXAMPLES — Scott's own labeled DMs");
    lines.push("══════════════════════════════════════════════");
    fewShots.forEach(function(c, i) {
        var ctx = (c.last_10_messages || []).slice(-5);
        var ctxLines = ctx.map(function(m) {
            var role = m.role === "assistant" ? "Scott" : "Lead";
            return "  [" + role + "]: " + (m.text || "").substring(0, 160);
        }).join("\n");
        var nt = c.new_tags || {};
        var out = {
            tone_tags: nt.tone_tags || [],
            intent: nt.intent || "",
            sales_stage: nt.sales_stage || "",
            dm_stage: nt.dm_stage !== undefined ? nt.dm_stage : null,
            nonsales: nt.nonsales,
        };
        lines.push("");
        lines.push("Example " + (i + 1) + ":");
        if (ctxLines) lines.push("Context:\n" + ctxLines);
        lines.push("[Scott]: " + (c.scott_reply || "").substring(0, 350));
        lines.push("Output: " + JSON.stringify(out));
    });
    lines.push("");
    lines.push("Return JSON only — all five fields, no extra keys.");
    return lines.join("\n");
}

function buildUserPrompt(message, contextMsgs, contactRole) {
    var lines = [];
    var role = contactRole || "unknown";
    var guidance = ROLE_GUIDANCE[role] || ROLE_GUIDANCE["unknown"];
    lines.push("Contact relationship: " + role);
    lines.push("(" + guidance + ")");
    lines.push("");
    if (contextMsgs.length) {
        lines.push("Context (oldest first):");
        contextMsgs.forEach(function(m) {
            var who = isScottMsg(m) ? "Scott" : (isLeadMsg(m) ? "Lead" : m.Speaker);
            lines.push("  [" + who + "]: " + normalizeText(m.Message).substring(0, 280));
        });
        lines.push("");
    }
    lines.push("Label this Scott message:");
    lines.push("[Scott]: " + normalizeText(message.Message).substring(0, 600));
    lines.push("");
    lines.push("Return JSON only.");
    return lines.join("\n");
}

// --- LLM call + validation ---------------------------------------------------
async function classify(openai, systemPrompt, message, contextMsgs, contactRole) {
    var userPrompt = buildUserPrompt(message, contextMsgs, contactRole);
    for (var attempt = 0; attempt < 2; attempt++) {
        try {
            var completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: TEMPERATURE,
                max_tokens: 300,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
            });
            var raw = completion.choices[0].message.content.trim();
            var parsed = JSON.parse(raw);
            var validated = validate(parsed, message && message.Message);
            if (validated) return validated;
        } catch (e) {
            if (attempt === 1) console.error("  LLM error after retry: " + (e.message || e));
        }
    }
    return {
        tone_tags: ["casual"], intent: "engagement-nurture", sales_stage: "nurture",
        dm_stage: null, nonsales: true, _fallback: true,
    };
}

// Deterministic tone enforcement. Scott's labeling has consistent triggers that the
// LLM keeps missing (it drifts toward safe defaults like brotherhood/casual/
// bonding-rapport). This adds the missed tones AFTER the LLM call without
// removing what the LLM picked, capped at 5.
function enforceTonePatterns(message, modelTones) {
    var msg = String(message || "");
    var lower = msg.toLowerCase();
    var out = Array.isArray(modelTones) ? modelTones.slice() : [];
    var has = function(t) { return out.indexOf(t) >= 0; };
    var add = function(t) { if (!has(t) && out.length < 5 && VALID_TONES.includes(t)) out.push(t); };

    // questions — system prompt already says "ALWAYS add if message contains '?'"
    if (/\?/.test(msg)) add("questions");

    // hype — Scott uses this 23% of the time, not just for ALL-CAPS. Also fires on
    // intensifiers like "fucking", "huge", "fire emoji", and exclamations with caps.
    var capWords = msg.match(/\b[A-Z]{3,}\b/g) || [];
    if (
        capWords.length >= 1 ||
        /\b(fucking|fuckin'|huge|massive|insane|fire emoji|let'?s f?u?c?k?i?n?g?\s*go+|let'?s go+|lfg)\b/i.test(msg) ||
        /!{2,}/.test(msg)
    ) add("hype");

    // self-aggrandization — Scott talks about HIS scale/wins/building.
    if (
        /\bi'?m (building|running|launching|creating|hosting|leading|the|doing) /i.test(msg) ||
        /\bi (built|created|launched|founded|started|run) /i.test(msg) ||
        /\bmy (community|funnel|brand|company|business|program|coaching|brotherhood|tribe|empire|vision|mission|movement)\b/i.test(msg) ||
        /\bi'?m at \$?\d+k\b/i.test(msg)
    ) add("self-aggrandization");

    // teasing-future-value — Scott constantly hints at future things.
    if (
        /\b(see you|see u|catch you|talk soon|talk to you soon|more (adventures|to come)|next (chapter|week|month)|just wait|you'?ll see|big things coming|stay tuned|coming soon|in the works|looking forward|can'?t wait|we'?ll (see|talk|meet|catch|be))\b/i.test(lower) ||
        /\b(going to be|gonna be) (seeing|meeting|talking|hanging|together|here|catching)/i.test(lower) ||
        (/\b(tomorrow|friday|saturday|sunday|monday|tuesday|wednesday|thursday|next week|tonight)\b/i.test(lower) &&
         /\b(meet|see|call|chat|hop|catch|going|forward|talk|do|start|begin|drop|launch|let'?s)\b/i.test(lower))
    ) add("teasing-future-value");

    // chit-chat — non-business banter cues. Scott uses chit-chat 23% (almost as
    // often as casual). The model picks "casual" by default; add chit-chat when
    // the message is about life/personal/banter rather than business content.
    if (
        /\b(parking|driving|grabbing|eating|just got home|tired|tomorrow night|last night|this morning|good morning|good night|gn|gm|brother ?hood thing|pool party|dinner|lunch|breakfast|coffee|food|sleep|woke up)\b/i.test(lower) ||
        /\b(audio omitted|sticker omitted|image omitted|voice note)\b/i.test(lower)
    ) add("chit-chat");

    // direct — Scott's most-used tone (39%). Triggers on blunt/no-nonsense markers.
    if (
        /^(no[,.\s]|nope[,.\s]|i don'?t|i won'?t|that'?s not|that'?s wrong|wrong|nah\b)/i.test(msg.trim()) ||
        /\b(period|end of story|simple as that|that'?s it|no debate)\b/i.test(lower)
    ) add("direct");

    // brotherhood — already over-predicted. Only add if NOT already there and the
    // message has multiple brotherhood markers (not just one passing "bro").
    var broCount = (msg.match(/\b(brother|bro|king|fam|brotha|broski)\b/gi) || []).length;
    if (broCount >= 2) add("brotherhood");

    // ── DAMPENING — remove over-default tones the model adds incorrectly ──
    var wordCount = msg.split(/\s+/).filter(Boolean).length;
    var isShortAck = wordCount <= 8 && !/\?/.test(msg);
    var drop = function(t) { var i = out.indexOf(t); if (i >= 0) out.splice(i, 1); };

    // motivational on short pure-ack messages is the most common over-default.
    // Scott uses motivational only for genuine push-forward energy, not for "thanks bro!".
    if (isShortAck && !/\b(let'?s go|let'?s do|push|grind|crush|level up|keep going|up only)\b/i.test(lower)) {
        drop("motivational");
    }

    // bonding-rapport on messages without "we/us/our" is usually wrong.
    if (!/\b(we|us|our|together|both)\b/i.test(lower) && !/\b(brother|bro|king|fam)\b/i.test(lower)) {
        drop("bonding-rapport");
    }

    // supportive-helpful when the message is purely a brag / self-update — drop.
    if (/\bi'?m at \$?\d+k\b|\bi'?m running|\bi just (posted|launched|closed|built)\b/i.test(msg)
        && !/\byou\b/i.test(lower)) {
        drop("supportive-helpful");
    }

    // Ensure at least one tag.
    if (out.length === 0) out.push("casual");
    return out.slice(0, 5);
}

// Deterministic sales_stage post-processing. The LLM frequently confuses
// engagement vs nurture; we override on hard textual signals.
function enforceSalesStage(message, modelStage, modelDmStage, modelNonsales) {
    var msg = String(message || "");
    var lower = msg.toLowerCase();
    var stripped = lower.trim();
    var wordCount = msg.split(/\s+/).filter(Boolean).length;

    // ── Hard ASK signals — explicit scheduling overrides everything ──
    if (
        /calendly\.com|meet\.google\.com|hangouts\.google\.com|zoom\.us\/j\//i.test(msg) ||
        /\blet'?s (schedule|hop on|jump on|get on|do) (a |an )?(call|meet|chat|meeting|google meet|zoom|hangout)\b/i.test(lower) ||
        /\b(schedule|book|set up|hop on|jump on|get on) (a |an )?(call|meeting|chat|meet|zoom)\b/i.test(lower) ||
        /\bgot time for (a |an )?(call|meet|chat)\b/i.test(lower) ||
        /\bwhen are you free for (a |an )?(call|meet|chat)\b/i.test(lower) ||
        /\bready for our call\b/i.test(lower) ||
        /\bsee you in (a |an )?\d+\s*(min|minutes|hour|hours|hr|hrs)\b/i.test(lower) ||
        /\bour call in \d/i.test(lower)
    ) {
        return "ask";
    }

    // ── Hard NURTURE signals — pure media / single-emoji / very short ──
    var emojiOnly = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(msg);
    if (emojiOnly) return "nurture";
    if (/^(audio|sticker|image|video|gif|file|photo)\s+omitted\.?$/i.test(stripped)) return "nurture";

    // Short ack patterns — single thanks / got it / nice / yes / etc.
    var shortAck = /^(thanks|thank you|thx|cheers|epic|sweet|nice|amazing|love it|awesome|bet|sure|yes|yeah|yep|got it|cool|nice one|good|all good|np|no worries|done|perfect|fire|brother|bro|man)([\s,!.\-]*(bro|brother|man|king|fam|mate)?[\s.!?]*)?$/i;
    if (wordCount <= 4 && shortAck.test(stripped)) return "nurture";

    // ── PHASE 1 FIX (2026-04-27): removed two soft overrides that flipped
    //    engagement → nurture on short / single-sentence messages. The eval
    //    showed 15 of 30 sample diffs were exactly that pattern
    //    (expected=engagement, predicted=nurture) — the post-processor was
    //    destroying correct model predictions and dragging nonsales=false→true
    //    along with it. We now trust the LLM on engagement vs nurture and only
    //    override on the hard signals above (Calendly/Meet, schedule keywords,
    //    media-omitted, emoji-only, single-word ack).

    return modelStage;
}

function validate(parsed, originalMessage) {
    if (!parsed || typeof parsed !== "object") return null;
    var tone = Array.isArray(parsed.tone_tags) ? parsed.tone_tags.filter(function(t) { return VALID_TONES.includes(t); }) : [];
    var intent = VALID_INTENTS.includes(parsed.intent) ? parsed.intent : null;
    if (!intent) return null;
    var ss = VALID_SALES_STAGES.includes(parsed.sales_stage) ? parsed.sales_stage : null;
    if (!ss) return null;
    var ds = parsed.dm_stage;
    if (ds === undefined || ds === "" || ds === "null") ds = null;
    if (ds !== null && !VALID_DM_STAGES.includes(ds)) ds = null;
    var nonsales = (parsed.nonsales === true || parsed.nonsales === false) ? parsed.nonsales : null;
    if (nonsales === null) return null;
    if (nonsales === true && ds !== null) ds = null;

    // Apply deterministic tone enforcement — fixes the model's bias toward safe defaults.
    if (originalMessage !== undefined) {
        tone = enforceTonePatterns(originalMessage, tone);
        // Sales-stage post-processor (round 2): override on hard textual signals.
        var newSs = enforceSalesStage(originalMessage, ss, ds, nonsales);
        if (newSs !== ss) {
            ss = newSs;
            // If we forced ask, the dm_stage should reflect a scheduling stage.
            if (ss === "ask" && ds === null) ds = "send-calendly";
            if (ss === "ask") nonsales = false;
            // If we forced nurture, dm_stage should be null.
            if (ss === "nurture") ds = null;
        }
    } else {
        if (tone.length === 0) tone = ["casual"];
        if (tone.length > 5) tone = tone.slice(0, 5);
    }

    return { tone_tags: tone, intent: intent, sales_stage: ss, dm_stage: ds, nonsales: nonsales };
}

// --- Concurrency helper ------------------------------------------------------
async function pmap(items, n, fn) {
    var results = new Array(items.length);
    var i = 0;
    async function worker() {
        while (true) {
            var idx = i++;
            if (idx >= items.length) return;
            results[idx] = await fn(items[idx], idx);
        }
    }
    var workers = [];
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

// --- Apply tags --------------------------------------------------------------
function applyTagsToMessage(m, tags, source, extra) {
    m.tone_tags = tags.tone_tags;
    m.intent = tags.intent;
    m.sales_stage = tags.sales_stage;
    m.dm_stage = tags.dm_stage;
    m.nonsales = tags.nonsales;
    m.ai_suggested = source === "llm";
    m.tagged_by = source;
    m.scott_validated = source === "scott";
    if (extra && extra.correction_id) m.correction_id = extra.correction_id;
    if (extra && extra.rule) m.rule = extra.rule;
    if (extra && extra.fallback) m.tag_fallback = true;
}

// --- Eval mode ---------------------------------------------------------------
function _hasFullTags(c) {
    var nt = c && c.new_tags || {};
    var hasIntent = (nt.intent || "").trim().length > 0;
    var hasSS = (nt.sales_stage || "").trim().length > 0;
    return hasIntent && hasSS;
}

async function runEval(openai, corrections, fewShotIds, contactRoles, contactByCorrectionId) {
    var heldOutAll = corrections.filter(function(c) { return !fewShotIds.has(c.correction_id); });
    var heldOut = heldOutAll.filter(_hasFullTags);
    var droppedEmpty = heldOutAll.length - heldOut.length;
    console.log("Eval set: " + heldOut.length + " held-out corrections (" + fewShotIds.size + " in few-shots)" +
        (droppedEmpty > 0 ? " | dropped " + droppedEmpty + " with empty intent/sales_stage" : ""));
    var fewShots = corrections.filter(function(c) { return fewShotIds.has(c.correction_id); });
    var systemPrompt = buildSystemPrompt(fewShots);

    function resolveRole(c) {
        // 1) If we matched the correction to a real conversation, use the
        //    production-computed role (most reliable).
        var contact = contactByCorrectionId ? contactByCorrectionId.get(c.correction_id) : null;
        if (contact && contactRoles && contactRoles.has(contact)) {
            return contactRoles.get(contact);
        }
        // 2) Otherwise fall back to last-10-messages heuristics.
        return computeRoleFromContext(c.last_10_messages, c.scott_reply);
    }

    function syntheticMsg(c) {
        var ctx = (c.last_10_messages || []).map(function(m) {
            return { Speaker: m.role === "assistant" ? "Scott" : "Lead", Message: m.text };
        });
        var target = { Speaker: "Scott", Message: c.scott_reply };
        var role = resolveRole(c);
        return { ctx: ctx, target: target, role: role };
    }

    var ruleHits = 0;
    var roleCounts = {};
    var results = await pmap(heldOut, CONCURRENCY, async function(c, idx) {
        if ((idx + 1) % 10 === 0 || idx === 0) console.log("  eval " + (idx + 1) + "/" + heldOut.length);
        var rule = applyHardRules(c.scott_reply);
        if (rule) {
            ruleHits += 1;
            return { correction_id: c.correction_id, expected: c.new_tags, predicted: rule.tags, scott_reply: c.scott_reply, source: "rule:" + rule.rule };
        }
        var s = syntheticMsg(c);
        roleCounts[s.role] = (roleCounts[s.role] || 0) + 1;
        var pred = await classify(openai, systemPrompt, s.target, s.ctx, s.role);
        return { correction_id: c.correction_id, expected: c.new_tags, predicted: pred, scott_reply: c.scott_reply, source: "llm:" + s.role };
    });
    console.log("  rule hits: " + ruleHits + " / " + heldOut.length);
    console.log("  llm role breakdown: " + JSON.stringify(roleCounts));

    var totals = { sales_stage: 0, intent: 0, intent_canonical: 0, dm_stage: 0, nonsales: 0 };
    var hits   = { sales_stage: 0, intent: 0, intent_canonical: 0, dm_stage: 0, nonsales: 0 };
    var jaccardSum = 0, jaccardCount = 0;
    var perFieldDiff = [];

    // Phase 1.4: per-class confusion matrices and per-role error breakdown.
    var confusion = {
        sales_stage: {},   // "expected -> predicted": count
        intent: {},
        intent_canonical: {},
        dm_stage: {},
        nonsales: {},
    };
    var roleErrorStats = {}; // role: { count, field_errors }
    function _bumpConfusion(field, expected, predicted) {
        var key = String(expected === null ? "null" : expected) + " -> " +
                  String(predicted === null ? "null" : predicted);
        confusion[field][key] = (confusion[field][key] || 0) + 1;
    }

    for (var r of results) {
        var e = r.expected || {}, p = r.predicted || {};

        var fieldErrors = 0;
        ["sales_stage", "intent", "dm_stage", "nonsales"].forEach(function(f) {
            totals[f] += 1;
            var ev = (e[f] === "" || e[f] === undefined) ? null : e[f];
            var pv = (p[f] === "" || p[f] === undefined) ? null : p[f];
            if (ev === pv) hits[f] += 1;
            else fieldErrors += 1;
            _bumpConfusion(f, ev, pv);
        });

        // Canonical-intent accuracy: collapse rare intents (Phase 2.2). Both
        // expected and predicted go through canonicalIntent before comparison
        // so the model isn't penalized for predicting the catch-all when
        // ground truth was a rare class with ≤2 training examples.
        totals.intent_canonical += 1;
        var ec = canonicalIntent(e.intent);
        var pc = canonicalIntent(p.intent);
        if (ec === pc) hits.intent_canonical += 1;
        _bumpConfusion("intent_canonical", ec, pc);

        var et = new Set(e.tone_tags || []), pt = new Set(p.tone_tags || []);
        var inter = 0; et.forEach(function(x) { if (pt.has(x)) inter++; });
        var union = new Set([...et, ...pt]).size;
        if (union > 0) { jaccardSum += inter / union; jaccardCount += 1; }
        if (e.sales_stage !== p.sales_stage || e.intent !== p.intent) perFieldDiff.push(r);

        // Per-source field-error count (e.g., "llm:in-program-or-personal", "rule:short-ack").
        var src = r.source || "unknown";
        if (!roleErrorStats[src]) roleErrorStats[src] = { count: 0, field_errors: 0 };
        roleErrorStats[src].count += 1;
        roleErrorStats[src].field_errors += fieldErrors;
    }

    // Sort confusion keys by count desc for readable JSON output.
    function sortConfusion(m) {
        var entries = Object.entries(m).sort(function(a, b) { return b[1] - a[1]; });
        var out = {};
        for (var [k, v] of entries) out[k] = v;
        return out;
    }
    Object.keys(confusion).forEach(function(k) { confusion[k] = sortConfusion(confusion[k]); });

    var report = {
        eval_size: heldOut.length,
        few_shots_used: fewShots.length,
        model: MODEL,
        accuracy: {
            sales_stage: hits.sales_stage / totals.sales_stage,
            intent: hits.intent / totals.intent,
            intent_canonical: hits.intent_canonical / totals.intent_canonical,
            dm_stage: hits.dm_stage / totals.dm_stage,
            nonsales: hits.nonsales / totals.nonsales,
        },
        tone_jaccard: jaccardCount ? jaccardSum / jaccardCount : 0,
        rule_hits: ruleHits,
        llm_role_breakdown: roleCounts,
        per_source_error_stats: roleErrorStats,
        confusion: confusion,
        sample_diffs: perFieldDiff,  // Phase 1.4: save ALL diffs, not just first 30
    };

    console.log("\n=== EVAL REPORT ===");
    console.log("model:             " + MODEL);
    console.log("sales_stage acc:   " + (report.accuracy.sales_stage * 100).toFixed(1) + "%");
    console.log("intent acc:        " + (report.accuracy.intent * 100).toFixed(1) + "%");
    console.log("intent (canonical):" + (report.accuracy.intent_canonical * 100).toFixed(1) + "%  (after rare-intent merge)");
    console.log("dm_stage acc:      " + (report.accuracy.dm_stage * 100).toFixed(1) + "%");
    console.log("nonsales acc:      " + (report.accuracy.nonsales * 100).toFixed(1) + "%");
    console.log("tone Jaccard:      " + report.tone_jaccard.toFixed(2));
    console.log("\nTop sales_stage confusions:");
    Object.entries(confusion.sales_stage).slice(0, 6).forEach(function(pair) {
        console.log("  " + pair[0] + ": " + pair[1]);
    });
    console.log("Top intent confusions:");
    Object.entries(confusion.intent).slice(0, 8).forEach(function(pair) {
        console.log("  " + pair[0] + ": " + pair[1]);
    });
    console.log("Per-source field-errors per item:");
    Object.entries(roleErrorStats).sort(function(a, b) { return b[1].count - a[1].count; }).forEach(function(pair) {
        var v = pair[1];
        var avg = v.count ? (v.field_errors / v.count).toFixed(2) : "0.00";
        console.log("  " + pair[0] + ": " + v.count + " items, avg " + avg + " errors/item");
    });
    if (!DRY_RUN) {
        saveJson(EVAL_REPORT_PATH, report);
        console.log("Wrote " + EVAL_REPORT_PATH);
    }
    return report;
}

// --- Main --------------------------------------------------------------------
async function main() {
    if (!process.env.OPENAI_API_KEY) {
        console.error("ERROR: OPENAI_API_KEY not set (check bot/.env)");
        process.exit(1);
    }
    var openaiCfg = { apiKey: process.env.OPENAI_API_KEY };
    var agent = buildHttpAgent();
    if (agent) { openaiCfg.httpAgent = agent; console.log("Using HTTPS proxy: " + (process.env.HTTPS_PROXY || process.env.https_proxy)); }
    var openai = new OpenAI(openaiCfg);

    console.log("Loading data...");
    var classified = loadJson(CLASSIFIED_PATH);
    var corrections = loadJson(CORRECTIONS_PATH);
    console.log("  " + classified.length + " messages, " + corrections.length + " corrections");

    var byContact = groupByContact(classified);
    console.log("  " + byContact.size + " unique conversations");

    console.log("Matching corrections to messages...");
    var match = matchCorrections(classified, corrections, byContact);
    console.log("  Matched " + match.matchedByIdx.size + " message rows from " + (corrections.length - match.unmatchedCorrectionIds.length) + " corrections");
    if (match.unmatchedCorrectionIds.length > 0) {
        console.log("  Unmatched correction count: " + match.unmatchedCorrectionIds.length + " (likely from a different DM source)");
    }

    console.log("Computing contact roles...");
    var llmRoles = loadLlmContactRoles(ROLES_PATH);
    var contactRoles;
    if (llmRoles && llmRoles.size > 0) {
        contactRoles = mergeContactRoles(byContact, llmRoles);
        var llmCovered = 0, heuristicCovered = 0;
        for (var c of byContact.keys()) (llmRoles.has(c) ? llmCovered++ : heuristicCovered++);
        console.log("  Source: " + ROLES_PATH);
        console.log("  Coverage: " + llmCovered + " from LLM file, " + heuristicCovered + " from heuristic fallback");
    } else {
        contactRoles = computeContactRoles(byContact);
        console.log("  Source: lexical heuristic (no contact_roles.json found — run label_contact_roles.js for higher accuracy)");
    }
    var roleStats = { "in-program-or-personal": 0, "prospect-active": 0, "prospect-cold": 0, "unknown": 0 };
    for (var v of contactRoles.values()) roleStats[v] = (roleStats[v] || 0) + 1;
    console.log("  Roles: " + JSON.stringify(roleStats));

    var fewShots = selectFewShots(corrections, NUM_FEWSHOTS, contactRoles, match.contactByCorrectionId);
    var fewShotIds = new Set(fewShots.map(function(c) { return c.correction_id; }));
    var fewShotRoleStats = { "in-program-or-personal": 0, "prospect-active": 0, "prospect-cold": 0, "unknown": 0 };
    for (var fs of fewShots) {
        var fsRole = _roleForCorrection(fs, contactRoles, match.contactByCorrectionId);
        fewShotRoleStats[fsRole] = (fewShotRoleStats[fsRole] || 0) + 1;
    }
    console.log("  Picked " + fewShots.length + " few-shot examples (by role: " + JSON.stringify(fewShotRoleStats) + ")");

    if (EVAL_MODE) {
        await runEval(openai, corrections, fewShotIds, contactRoles, match.contactByCorrectionId);
        return;
    }

    var systemPrompt = buildSystemPrompt(fewShots);

    var stats = { frozen: 0, rule: 0, llm_pending: 0, llm_done: 0, skipped_already_done: 0 };
    var llmTargets = [];
    var ruleAudit = [];
    var frozenAudit = [];

    for (var convo of byContact.values()) {
        for (var i = 0; i < convo.length; i++) {
            var m = convo[i];
            if (!isScottMsg(m)) continue;

            if (m.scott_validated === true || m.tagged_by === "rule" || m.tagged_by === "llm") {
                stats.skipped_already_done += 1;
                continue;
            }

            var matched = match.matchedByIdx.get(m._idx);
            if (matched) {
                applyTagsToMessage(m, matched.new_tags, "scott", { correction_id: matched.correction_id });
                stats.frozen += 1;
                frozenAudit.push({ idx: m._idx, contact: m.Contact, message: String(m.Message || "").substring(0, 120), correction_id: matched.correction_id });
                continue;
            }

            var rule = applyHardRules(m.Message);
            if (rule) {
                applyTagsToMessage(m, rule.tags, "rule", { rule: rule.rule });
                stats.rule += 1;
                ruleAudit.push({ idx: m._idx, contact: m.Contact, message: String(m.Message || "").substring(0, 120), rule: rule.rule, tags: rule.tags });
                continue;
            }

            var ctx = contextWindow(convo, i, CONTEXT_WINDOW);
            var role = contactRoles.get(m.Contact || "(unknown)") || "unknown";
            llmTargets.push({ msg: m, ctx: ctx, role: role });
            stats.llm_pending += 1;
        }
    }

    console.log("Plan: frozen=" + stats.frozen + " rule=" + stats.rule + " llm=" + stats.llm_pending + " (skipped already done=" + stats.skipped_already_done + ")");

    if (!DRY_RUN) {
        if (!fs.existsSync(BACKUP_PATH)) {
            console.log("Writing backup to " + BACKUP_PATH);
            saveClassified(BACKUP_PATH, classified);
        }
        saveClassified(CLASSIFIED_PATH, classified);
    }

    var targets = llmTargets.slice(0, isFinite(LIMIT) ? LIMIT : llmTargets.length);
    console.log("Running LLM on " + targets.length + " messages (concurrency=" + CONCURRENCY + ")...");
    var llmAudit = [];
    var done = 0;

    await pmap(targets, CONCURRENCY, async function(item, idx) {
        var pred = await classify(openai, systemPrompt, item.msg, item.ctx, item.role);
        var fellBack = pred._fallback === true;
        delete pred._fallback;
        applyTagsToMessage(item.msg, pred, "llm", fellBack ? { fallback: true } : undefined);
        if (item.role) item.msg.contact_role = item.role;
        stats.llm_done += 1;
        llmAudit.push({
            idx: item.msg._idx,
            contact: item.msg.Contact,
            message: String(item.msg.Message || "").substring(0, 200),
            tags: pred,
            fallback: fellBack || undefined,
        });
        done += 1;
        if (done % SAVE_EVERY === 0) {
            console.log("  llm progress: " + done + "/" + targets.length + " (" + Math.round(100*done/targets.length) + "%)");
            if (!DRY_RUN) saveClassified(CLASSIFIED_PATH, classified);
        }
    });

    if (!DRY_RUN) {
        saveClassified(CLASSIFIED_PATH, classified);
        saveJson(AUDIT_PATH, {
            run_at: new Date().toISOString(),
            stats: stats,
            unmatched_correction_ids: match.unmatchedCorrectionIds,
            few_shot_ids_used: Array.from(fewShotIds),
            frozen_sample: frozenAudit.slice(0, 50),
            rule_sample: ruleAudit.slice(0, 50),
            llm_sample: llmAudit.slice(0, 100),
        });
        console.log("Wrote audit log to " + AUDIT_PATH);
    }

    console.log("\nDONE. Final stats: " + JSON.stringify(stats));
}

main().catch(function(e) {
    console.error("FATAL:", e.stack || e);
    process.exit(1);
});
