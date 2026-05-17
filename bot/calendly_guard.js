// calendly_guard.js
// ────────────────────────────────────────────────────────────────────────────
// Gates the calendly link drop on a lead-side green light.
//
// Per AUTO_REPLY_V2_UNIFIED_PLAN.md §4 — the link goes ONLY when the partner's
// last 1-2 messages contain an explicit yes:
//
//   "let's chat" / "let's talk" / "I'm down" / "yes"
//   "do you have a calendly?" / "send me a link"
//   a direct yes after the bot has floated a call
//
// Otherwise we stay in stage 4 and ask one more qualifying question.
// This is intentionally enforced in code (regex + tight LLM check) so the
// generation model CAN'T drop a link it shouldn't.
//
// Three short drop templates pulled from real Scott conversations.
// Selection is stupid-simple: the model picks an index based on partner energy.
// (Kept as plain strings — the bot prints one verbatim, no LLM round-trip.)
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_CALENDLY_URL = "https://calendly.com/northwolfscott/meeting";

// ── Drop templates ───────────────────────────────────────────────────────────
const DROP_TEMPLATES = [
    {
        id: "warm-confirm",
        text: "Awesome, let me know when you have scheduled it so I can confirm it landed on my calendar: {LINK}",
        when: "partner explicitly said yes / asked for the link",
    },
    {
        id: "stop-missing",
        text: "Let's just schedule a call so we don't keep missing each other: {LINK}",
        when: "long thread, partner agreed but tone is casual",
    },
    {
        id: "amazing-brother",
        text: "Amazing, brother. Here's my link: {LINK}",
        when: "partner is hyped / replied with high energy",
    },
];

// ── Regex green-light check ──────────────────────────────────────────────────

// These match the exact lead-side language seen in the calendly streams.
const GREEN_LIGHT_PATTERNS = [
    /\b(let'?s|lets)\s+(chat|talk|jump|hop)\b/i,
    /\b(let'?s|lets)\s+(do|set\s+up|schedule)\s+(a|the)?\s*call\b/i,
    /\bi'?m\s+down\b/i,
    /\bi'?m\s+(?:in|game)\b/i,
    /\bsounds?\s+good\b/i,
    /\bfor\s+sure\b/i,
    /^(yes|yep|yeah|yup|sure|absolutely|definitely)[\s.!]*$/i,
    /\b(do you|got|have)\s+(a|the)?\s*calend(ly|ar)\b/i,
    /\bsend\s+(me|over)\s+(a|the|your)?\s*link\b/i,
    /\bwhere\s+do\s+i\s+book\b/i,
    /\b(book|schedule|set\s+up)\s+(a|the)?\s*(call|time|slot)\b/i,
    /\bdrop\s+(me|the)?\s*(a|the)?\s*link\b/i,
];

function regexGreenLight(text) {
    if (!text || typeof text !== "string") return null;
    for (var i = 0; i < GREEN_LIGHT_PATTERNS.length; i++) {
        if (GREEN_LIGHT_PATTERNS[i].test(text)) {
            return { matched: true, pattern: GREEN_LIGHT_PATTERNS[i].toString() };
        }
    }
    return null;
}

// ── LLM tight check (run only when regex didn't match a clear yes) ───────────
// Cheap call. Returns { greenLight: bool, reason: string }.
// Only used when the bot has already floated a call and we want to be sure
// the partner's reply is actually a "yes" before sending the link.

async function llmGreenLightCheck(payload) {
    var partnerName = (payload && payload.partnerName) || "Partner";
    var lastMessages = (payload && Array.isArray(payload.recent)) ? payload.recent : [];
    var system = [
        "You decide if a Skool DM partner has clearly green-lit a sales call.",
        "Output JSON: {\"greenLight\": true|false, \"reason\": \"<= 8 words\"}.",
        "TRUE only if the partner's most recent reply is a clear yes, OR they explicitly asked for a calendly / a link / a time.",
        "FALSE for: maybe / let me think / not sure / interested but / questions / silence.",
        "When in doubt, output FALSE.",
    ].join("\n");

    var lines = ["Last messages with " + partnerName + ":", ""];
    lastMessages.slice(-4).forEach(function(m) {
        var who = m.role === "bot" ? "Jack" : partnerName;
        lines.push(who + ": " + String(m.text || "").substring(0, 240));
    });
    lines.push("");
    lines.push("Did " + partnerName + " green-light a call in their LAST message? JSON only.");

    try {
        var completion = await openai.chat.completions.create({
            model:       process.env.PRE_CLASSIFIER_MODEL || "opus-4.7",
            max_tokens:  60,
            temperature: 0.1,
            messages: [
                { role: "system", content: system },
                { role: "user",   content: lines.join("\n") },
            ],
        });
        var raw = (completion.choices[0].message.content || "").trim();
        var fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) raw = fenceMatch[1].trim();
        var parsed;
        try { parsed = JSON.parse(raw); }
        catch (_) {
            var braceMatch = raw.match(/\{[\s\S]*\}/);
            parsed = braceMatch ? JSON.parse(braceMatch[0]) : null;
        }
        return {
            greenLight: !!(parsed && parsed.greenLight === true),
            reason:    (parsed && parsed.reason) || "",
        };
    } catch (err) {
        console.error("⚠️  CALENDLY_GUARD llm check failed: " + err.message);
        return { greenLight: false, reason: "llm error — defaulting to no" };
    }
}

// ── Public: should we drop the link? ─────────────────────────────────────────

/**
 * Decide whether the bot is allowed to send the calendly link right now.
 *
 * Inputs (`payload`):
 *   partnerName            — string (for logging)
 *   partnerLastMessage     — string, the most recent message from the partner
 *   recent                 — last N messages [{ role: "bot"|"partner", text }]
 *   botFloatedCall         — bool: have we already invited them to a call?
 *   stage                  — current persons-DB stage (we expect 4 or 5)
 *   allowAuto              — feature flag (defaults to ALLOW_CALENDLY_AUTO_DROP env)
 *
 * Returns:
 *   { allowed: bool, source: "regex"|"llm"|"flag-off"|"stage", reason: string }
 */
async function shouldDropCalendly(payload) {
    var allow = (payload && typeof payload.allowAuto === "boolean")
        ? payload.allowAuto
        : (process.env.ALLOW_CALENDLY_AUTO_DROP === "true");

    if (!allow) {
        return { allowed: false, source: "flag-off", reason: "ALLOW_CALENDLY_AUTO_DROP=false" };
    }

    // Need to be at least at stage 4 (we floated a call) or partner directly asked for the link.
    var partnerLast = (payload && payload.partnerLastMessage) || "";
    var regexHit = regexGreenLight(partnerLast);

    // If the partner literally asked for a calendly/link, that's enough on its own.
    var directAsk = /calend(ly|ar)|send\s+(me|over)\s+(a|the|your)?\s*link|where\s+do\s+i\s+book/i.test(partnerLast);
    if (directAsk) {
        return { allowed: true, source: "regex", reason: "partner asked for the link" };
    }

    var floated = !!(payload && payload.botFloatedCall);
    if (!floated) {
        // No call floated yet → never drop the link spontaneously, even if the
        // partner says "yes" (they're agreeing to something else).
        return { allowed: false, source: "stage", reason: "bot has not floated a call yet" };
    }

    if (regexHit) {
        // Regex green light AFTER bot floated a call → confident yes.
        return { allowed: true, source: "regex", reason: "regex matched: " + regexHit.pattern };
    }

    // Borderline. Use the LLM tight check.
    var llm = await llmGreenLightCheck(payload);
    if (llm.greenLight) {
        return { allowed: true, source: "llm", reason: llm.reason };
    }
    return { allowed: false, source: "llm", reason: llm.reason || "llm said no" };
}

// ── Public: pick a template + render the drop line ───────────────────────────

function pickDropTemplate(partnerLastMessage) {
    var msg = (partnerLastMessage || "").toLowerCase();

    // Hyped / excited → "Amazing, brother. Here's my link"
    if (/!{1,}|let'?s\s+go|fuck\s+yeah|hell\s+yes|fire/.test(msg)) {
        return DROP_TEMPLATES[2];
    }
    // Direct ask for a link → confirm-back-when-scheduled template
    if (/calend(ly|ar)|send\s+(me|over)\s+(a|the|your)?\s*link|where\s+do\s+i\s+book/.test(msg)) {
        return DROP_TEMPLATES[0];
    }
    // Anything else → middle template
    return DROP_TEMPLATES[1];
}

function renderDropLine(template, calendlyUrl) {
    var t = template || DROP_TEMPLATES[0];
    var url = calendlyUrl || process.env.CALENDLY_URL || DEFAULT_CALENDLY_URL;
    return t.text.replace(/\{LINK\}/g, url);
}

/**
 * High-level: decide + render. Returns { drop: bool, line: string|null, info }.
 *   drop = true  → send `line` verbatim, then mark person stage 6.
 *   drop = false → fall back to "ask one more qualifying question" prompt.
 */
async function dropLine(payload) {
    var decision = await shouldDropCalendly(payload);
    if (!decision.allowed) {
        return { drop: false, line: null, info: decision };
    }
    var template = pickDropTemplate(payload && payload.partnerLastMessage);
    var line = renderDropLine(template, payload && payload.calendlyUrl);
    return {
        drop:     true,
        line:     line,
        template: template.id,
        info:     decision,
    };
}

module.exports = {
    DROP_TEMPLATES:        DROP_TEMPLATES,
    DEFAULT_CALENDLY_URL:  DEFAULT_CALENDLY_URL,
    GREEN_LIGHT_PATTERNS:  GREEN_LIGHT_PATTERNS,
    regexGreenLight:       regexGreenLight,
    llmGreenLightCheck:    llmGreenLightCheck,
    shouldDropCalendly:    shouldDropCalendly,
    pickDropTemplate:      pickDropTemplate,
    renderDropLine:        renderDropLine,
    dropLine:              dropLine,
};
