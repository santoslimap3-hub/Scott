/**
 * tool_scripts/label_contact_roles.js
 *
 * One-time LLM pass that labels every Contact in data/dm_classified.json with a
 * role (in-program-or-personal | prospect-active | prospect-cold | unknown)
 * and writes the result to data/contact_roles.json.
 *
 * The auto-tagger (tool_scripts/autotag_dms.js) reads this file at startup if
 * present and uses it instead of the heuristic computeContactRole() detector.
 *
 * Eval evidence (Round 1, 2026-04-27):
 *   - 18 of 30 sample diffs were role=in-program-or-personal with 1.78
 *     field-errors per diff. Most of these were prospects misclassified as
 *     friends because the heuristic fires on superficial signals (Scott uses
 *     "bro" twice, 5+ messages, etc.). Once role flips, the prompt's
 *     "STRONG PRIOR: nonsales=true ~85%" guidance pushes everything wrong.
 *   - All 9 nonsales=false→true errors trace back to a misclassified role.
 *
 * Why an LLM does better here: it can see the full conversation arc — was a
 * Calendly link sent, was the recipient welcomed as a new member, is Scott
 * coaching them on their business (peer/student) vs probing for theirs
 * (prospect), etc. The heuristic only sees lexical proxies for those signals.
 *
 * Usage:
 *   node tool_scripts/label_contact_roles.js              # full pass
 *   node tool_scripts/label_contact_roles.js --dry-run    # no writes
 *   node tool_scripts/label_contact_roles.js --limit 20   # only first N
 *   node tool_scripts/label_contact_roles.js --refresh    # re-label all
 *                                                          # (default: skip
 *                                                          # contacts already
 *                                                          # in the file)
 *
 * Cost: ~370 contacts × ~600 tokens prompt + ~50 tokens response with gpt-4o
 * is ≈ $0.50 for a full pass. Re-run when new contacts are added.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// ─── Manual .env loader (mirrors autotag_dms.js) ──────────────────────────────
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

const BOT_MODULES = path.join(__dirname, "../bot/node_modules");
const OpenAI = require(path.join(BOT_MODULES, "openai"));

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

// ─── Paths / config ───────────────────────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, "../data");
const CLASSIFIED_PATH = path.join(DATA_DIR, "dm_classified.json");
const ROLES_PATH      = path.join(DATA_DIR, "contact_roles.json");

const MODEL       = process.env.ROLE_MODEL || "gpt-4o";
const TEMPERATURE = 0;
const CONCURRENCY = 6;
const SAVE_EVERY  = 25;

const ARGS    = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const REFRESH = ARGS.includes("--refresh");
const LIMIT   = (() => {
    var i = ARGS.indexOf("--limit");
    return i >= 0 ? parseInt(ARGS[i + 1], 10) : Infinity;
})();

const VALID_ROLES = ["in-program-or-personal", "prospect-active", "prospect-cold", "unknown"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function loadJson(filepath) {
    var raw = fs.readFileSync(filepath, "utf8").replace(/\0+$/, "");
    return JSON.parse(raw);
}
function saveJson(filepath, data) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
}
function normalizeText(txt) {
    if (typeof txt !== "string") return "";
    return txt.replace(/ /g, " ").trim().replace(/\s+/g, " ");
}
function parseDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    var m = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    var t = String(timeStr).match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
    if (!t) return null;
    var hr = parseInt(t[1], 10), mn = parseInt(t[2], 10), sc = parseInt(t[3], 10);
    var ampm = t[4].toUpperCase();
    if (ampm === "PM" && hr < 12) hr += 12;
    if (ampm === "AM" && hr === 12) hr = 0;
    return new Date(parseInt(m[3],10), parseInt(m[1],10)-1, parseInt(m[2],10), hr, mn, sc);
}
function isScottMsg(m) { return m.Speaker === "Scott"; }

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

// ─── Build the per-contact summary that goes to the LLM ──────────────────────
// Compact summary: total message counts, presence of hard signals, and a
// curated sample of the conversation (first 3 Scott msgs, last 3 Scott msgs,
// any "welcome to the community" line, any Calendly/Meet link). This
// preserves the strongest cues without sending the entire transcript.
function buildContactSummary(contact, convo) {
    var scottMsgs = convo.filter(isScottMsg);
    var leadMsgs  = convo.filter(function(m) { return !isScottMsg(m); });
    var allText   = convo.map(function(m){ return normalizeText(m.Message); }).join(" ");
    var scottText = scottMsgs.map(function(m){ return normalizeText(m.Message); }).join(" ");

    var hasCalendly = /calendly\.com/i.test(allText);
    var hasMeet     = /meet\.google\.com|hangouts\.google\.com|zoom\.us\/j\//i.test(allText);
    var hasWelcome  = /welcome to (the |our |my )?(community|family|tribe|group|nation|brotherhood|crew|team|skool|gang)/i.test(scottText);
    var hasSchedule = /\b(let'?s (schedule|hop on|jump on|get on|do)|when are you free|got time for) (a |an )?(call|meet|chat)/i.test(scottText);
    var aboutTheirBiz = /\byour (community|funnel|students|coaching|brand|offer|sales|ad spend|ads|business|subscribers|members|niche|content|posts|landing page|webinar|calls|enrollments|pricing|copy|hook|skool)\b/i.test(scottText);

    function takeMessages(arr, n) {
        return arr.slice(0, n).map(function(m) {
            var who = isScottMsg(m) ? "Scott" : "Lead";
            return "[" + who + "]: " + normalizeText(m.Message).substring(0, 200);
        });
    }
    var first3 = takeMessages(convo.slice(0, 6), 6);   // first ~6 messages of the convo
    var last3  = takeMessages(convo.slice(-6), 6);     // last ~6 messages of the convo

    return {
        contact: contact,
        scott_msg_count: scottMsgs.length,
        lead_msg_count: leadMsgs.length,
        signals: {
            calendly_link_present: hasCalendly,
            meet_or_zoom_link_present: hasMeet,
            welcome_message_sent_by_scott: hasWelcome,
            schedule_pitch_by_scott: hasSchedule,
            scott_discusses_their_business: aboutTheirBiz,
        },
        first_messages: first3,
        last_messages: last3,
    };
}

// ─── System prompt for the role classifier ───────────────────────────────────
var SYSTEM_PROMPT = [
    "You classify the relationship between Scott Northwolf and one of his DM contacts.",
    "Scott runs a high-ticket coaching program for self-improvement coaches on Skool.",
    "He DMs hundreds of men: brand-new prospects, current students, friends/peers, and",
    "people pitching HIM. You pick exactly one role for this contact based on the",
    "summary you are given. Output strict JSON only.",
    "",
    "OUTPUT SCHEMA:",
    '  { "role": <one of "in-program-or-personal" | "prospect-active" | "prospect-cold" | "unknown">,',
    '    "reasoning": <one short sentence explaining the call> }',
    "",
    "ROLE DEFINITIONS:",
    "  in-program-or-personal — friend, peer, current student. Long-running thread,",
    "    Scott discusses THEIR business as if coaching them, talks about his own life,",
    "    casual personal banter, no fresh-prospect signals. The default for high-volume",
    "    threads where the dynamic is mutual.",
    "  prospect-active — a Calendly link, Google Meet/Zoom link, or scheduled call",
    "    is part of the thread (especially recent messages). Scott is actively",
    "    moving this person toward enrolling in his program.",
    "  prospect-cold — Scott welcomed this contact to his community recently and",
    "    no call has been scheduled yet. Early-funnel — Scott is qualifying or",
    "    teasing future value.",
    "  unknown — none of the above signals are clearly present.",
    "",
    "DECISION RULES (apply in order):",
    "  1. If signals.calendly_link_present OR signals.meet_or_zoom_link_present OR",
    "     signals.schedule_pitch_by_scott — role is almost certainly prospect-active.",
    "     UNLESS the conversation also shows extensive personal banter and Scott",
    "     coaching them on their OWN business (signals.scott_discusses_their_business),",
    "     in which case it's in-program-or-personal who happen to be meeting in person.",
    "  2. If signals.welcome_message_sent_by_scott AND no scheduling signal yet AND",
    "     the conversation is short (<20 Scott messages) — prospect-cold.",
    "  3. If signals.scott_discusses_their_business AND scott_msg_count >= 10 — this",
    "     is a peer/student relationship → in-program-or-personal.",
    "  4. If scott_msg_count >= 25 AND no scheduling signal — long thread → in-program-or-personal.",
    "  5. Otherwise — unknown.",
    "",
    "Return JSON only.",
].join("\n");

// ─── Per-contact LLM call ─────────────────────────────────────────────────────
async function classifyContact(openai, summary) {
    var userPrompt = [
        "Contact: " + summary.contact,
        "Scott message count: " + summary.scott_msg_count,
        "Lead message count: " + summary.lead_msg_count,
        "Signals: " + JSON.stringify(summary.signals),
        "",
        "First messages of the conversation:",
        summary.first_messages.join("\n"),
        "",
        "Last messages of the conversation:",
        summary.last_messages.join("\n"),
        "",
        "Pick the role. Return JSON only.",
    ].join("\n");

    for (var attempt = 0; attempt < 2; attempt++) {
        try {
            var completion = await openai.chat.completions.create({
                model: MODEL,
                temperature: TEMPERATURE,
                max_tokens: 150,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userPrompt },
                ],
            });
            var raw = completion.choices[0].message.content.trim();
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed.role === "string" && VALID_ROLES.includes(parsed.role)) {
                return { role: parsed.role, reasoning: String(parsed.reasoning || "").substring(0, 240) };
            }
        } catch (e) {
            if (attempt === 1) console.error("  LLM error after retry: " + (e.message || e));
        }
    }
    return { role: "unknown", reasoning: "LLM error / invalid JSON" };
}

// ─── Concurrency helper ───────────────────────────────────────────────────────
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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.OPENAI_API_KEY) {
        console.error("ERROR: OPENAI_API_KEY not set (check bot/.env)");
        process.exit(1);
    }
    var openaiCfg = { apiKey: process.env.OPENAI_API_KEY };
    var agent = buildHttpAgent();
    if (agent) { openaiCfg.httpAgent = agent; console.log("Using HTTPS proxy"); }
    var openai = new OpenAI(openaiCfg);

    console.log("Loading classified DMs...");
    var classified = loadJson(CLASSIFIED_PATH);
    var byContact = groupByContact(classified);
    console.log("  " + byContact.size + " unique contacts");

    var existing = {};
    if (fs.existsSync(ROLES_PATH) && !REFRESH) {
        try { existing = loadJson(ROLES_PATH); console.log("  found existing role file with " + Object.keys(existing).length + " entries"); }
        catch (e) { existing = {}; }
    }

    var todo = [];
    for (var [contact, convo] of byContact.entries()) {
        if (!REFRESH && existing[contact] && existing[contact].role) continue;
        todo.push({ contact: contact, convo: convo });
    }
    if (isFinite(LIMIT)) todo = todo.slice(0, LIMIT);
    console.log("Pending: " + todo.length + " contacts to label (model=" + MODEL + ", concurrency=" + CONCURRENCY + ")");

    if (todo.length === 0) {
        console.log("Nothing to do.");
        return;
    }

    var done = 0;
    var roles = Object.assign({}, existing);

    await pmap(todo, CONCURRENCY, async function(item, idx) {
        if ((idx + 1) % 10 === 0 || idx === 0) console.log("  " + (idx + 1) + "/" + todo.length);
        var summary = buildContactSummary(item.contact, item.convo);
        var result = await classifyContact(openai, summary);
        roles[item.contact] = {
            role: result.role,
            reasoning: result.reasoning,
            scott_msg_count: summary.scott_msg_count,
            lead_msg_count: summary.lead_msg_count,
            signals: summary.signals,
            labeled_at: new Date().toISOString(),
            model: MODEL,
        };
        done += 1;
        if (done % SAVE_EVERY === 0 && !DRY_RUN) {
            saveJson(ROLES_PATH, roles);
            console.log("  progress: " + done + "/" + todo.length + " (" + Math.round(100*done/todo.length) + "%) — saved");
        }
    });

    if (!DRY_RUN) {
        saveJson(ROLES_PATH, roles);
        console.log("\nWrote " + Object.keys(roles).length + " role labels to " + ROLES_PATH);
    }

    var counts = {};
    for (var k of Object.keys(roles)) {
        var r = roles[k].role || "unknown";
        counts[r] = (counts[r] || 0) + 1;
    }
    console.log("\nRole distribution: " + JSON.stringify(counts));
}

main().catch(function(e) {
    console.error("FATAL:", e.stack || e);
    process.exit(1);
});
