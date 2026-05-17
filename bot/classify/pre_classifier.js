// classify/pre_classifier.js
// ────────────────────────────────────────────────────────────────────────────
// REPLY / ACK / NO_REPLY router for short inbound messages.
//
// Runs before the generation model on every:
//   - notification engagement reply (Phase 1 of the cycle)
//   - inbound DM (Phase 1 of the cycle)
//
// Why: the current bot writes long, awkward, philosophical responses to
// "thank you" and 🔥. The fix is to gate those messages behind a cheap
// classifier that decides whether to write back at all.
//
// Output shape:
//   {
//     action:        "REPLY" | "ACK" | "NO_REPLY",
//     ack_template:  "emoji" | "mirror" | "brotherhood-2word" | null,
//     reason:        string (<= 8 words)
//   }
//
// Decision rules baked into the prompt (mirrored from §6 of the unified plan):
//
//   NO_REPLY  emoji-only ("🔥", "💯", "👍", "❤️");
//             single word ("facts", "fr", "🤝");
//             generic gratitude with nothing new ("thank you", "ty");
//             conversation has naturally closed; partner said goodbye.
//
//   ACK       gratitude with a sliver of substance ("thank you, that was helpful");
//             short reaction that deserves a small mirror ("damn that's deep");
//             a one-liner the bot would look weird ignoring but doesn't need a paragraph.
//
//   REPLY     a real question, a story, a substantive disagreement,
//             a follow-up that opens the conversation,
//             or any partner message ≥ ~12 words with content.
//
// Cheap by design — gpt-4o-mini, 60-token cap, single call.
// On any failure, falls back to ACK with template "emoji" — safer than REPLY
// (no novel generation) and friendlier than NO_REPLY (avoids ignoring the partner).
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const VALID_ACTIONS   = ["REPLY", "ACK", "NO_REPLY"];
const VALID_TEMPLATES = ["emoji", "mirror", "brotherhood-2word"];

const FALLBACK = Object.freeze({
    action:       "ACK",
    ack_template: "emoji",
    reason:       "fallback (classifier error)",
});

// ── System prompt built once at startup ──────────────────────────────────────
const SYSTEM_PROMPT = [
    "You route short inbound messages for a Skool community bot.",
    "Decide whether the bot should write a full reply, send a tiny acknowledgement, or stay silent.",
    "Return JSON only.",
    "",
    "ACTIONS:",
    "  REPLY     — partner sent something with real content: a question, story, disagreement,",
    "              follow-up that opens the conversation, OR any message >= ~12 substantive words.",
    "  ACK       — short reaction that deserves a small mirror, OR gratitude with a sliver of substance.",
    "              The bot would look weird ignoring it but doesn't need a paragraph.",
    "  NO_REPLY  — emoji-only, single-word agreement (\"facts\", \"fr\"), bare \"thank you\" / \"ty\"",
    "              with nothing new, the conversation has naturally closed, or the partner already",
    "              said something resembling goodbye.",
    "",
    "ACK templates (only set when action=ACK):",
    "  emoji              short emoji reaction",
    "  mirror             echo partner's emoji back",
    "  brotherhood-2word  short phrase like \"anytime, brother\" / \"all love\"",
    "",
    "Bias on borderline cases (be strict — default to silence):",
    "  - bare gratitude with no substance: 90% NO_REPLY / 10% ACK",
    "  - emoji-only:                       95% NO_REPLY /  5% ACK (mirror)",
    "  - one-word agreement:               90% NO_REPLY / 10% ACK",
    "  - short reaction without question:  90% NO_REPLY / 10% ACK",
    "  - 'good point' / 'makes sense' / 'true' style:  90% NO_REPLY",
    "  - anything that doesn't move the conversation forward: NO_REPLY",
    "",
    "Default HARD toward silence. The bot has been over-replying — if in doubt, NO_REPLY.",
    "Only choose ACK when ignoring would be socially awkward (rare).",
    "Only choose REPLY when the partner clearly invites a substantive response",
    "(question, story, disagreement, follow-up that opens the conversation).",
    "",
    'Output: {"action":"REPLY|ACK|NO_REPLY","ack_template":"emoji|mirror|brotherhood-2word|null","reason":"<=8 words"}',
].join("\n");

// ── User prompt builder ──────────────────────────────────────────────────────

function buildUserPrompt(input) {
    var lines = [];

    var partnerName = (input && input.partnerName) || "Partner";
    lines.push("Partner: " + partnerName);

    if (input && input.context) {
        lines.push("Context: " + String(input.context).substring(0, 200));
    }

    // Show last 1-2 messages of prior conversation so "is this closing the
    // thread?" can be judged correctly.
    if (input && Array.isArray(input.recent) && input.recent.length > 0) {
        lines.push("");
        lines.push("Recent thread:");
        var recent = input.recent.slice(-3);
        for (var i = 0; i < recent.length; i++) {
            var m = recent[i] || {};
            var who = m.role === "bot" ? "Bot" : partnerName;
            lines.push(who + ": " + String(m.text || "").substring(0, 200));
        }
    }

    lines.push("");
    lines.push("Latest from " + partnerName + ":");
    lines.push(String((input && input.text) || "").substring(0, 600));

    lines.push("");
    lines.push("Output JSON only.");
    return lines.join("\n");
}

// ── Sanitize the model output ────────────────────────────────────────────────

function sanitize(parsed) {
    var action = VALID_ACTIONS.indexOf(parsed && parsed.action) !== -1
        ? parsed.action
        : "NO_REPLY";

    var template = null;
    if (action === "ACK") {
        template = VALID_TEMPLATES.indexOf(parsed && parsed.ack_template) !== -1
            ? parsed.ack_template
            : "emoji";
    }

    var reason = parsed && typeof parsed.reason === "string"
        ? parsed.reason.substring(0, 80)
        : "";

    return { action: action, ack_template: template, reason: reason };
}

// ── Heuristic short-circuit ──────────────────────────────────────────────────
// Avoid an LLM round-trip when the partner's message is unambiguously tiny.
// This isn't a hard rule — it just skips the call when we already know the
// answer and the LLM would almost certainly agree.

function quickShortcut(text) {
    var trimmed = (text || "").trim();
    if (!trimmed) return { action: "NO_REPLY", ack_template: null, reason: "empty message" };

    // Very short — emoji-only or a single tiny word
    if (trimmed.length <= 3) {
        return { action: "NO_REPLY", ack_template: null, reason: "too short" };
    }

    // Pure single-word / emoji-only acknowledgements
    var lower = trimmed.toLowerCase();
    var solo = ["thanks", "thank you", "ty", "tysm", "ok", "okay", "k",
                "facts", "fr", "true", "word", "based", "🤝", "💯", "🔥"];
    if (solo.indexOf(lower) !== -1) {
        return { action: "NO_REPLY", ack_template: null, reason: "bare ack" };
    }

    return null; // no shortcut — fall through to LLM
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Decide whether to REPLY, ACK, or stay silent on a short inbound message.
 *
 * @param {Object} input
 *   @param {string} input.text          — the partner's latest message
 *   @param {string} [input.partnerName]
 *   @param {string} [input.context]     — surface label e.g. "DM", "notification"
 *   @param {Array}  [input.recent]      — last 1-3 messages in the thread
 *   @param {boolean} [input.skipShortcut] — disable the heuristic for tests
 * @returns {Promise<{action: string, ack_template: ?string, reason: string}>}
 */
async function classifyInbound(input) {
    if (!input.skipShortcut) {
        var shortcut = quickShortcut(input.text);
        if (shortcut) return shortcut;
    }

    try {
        var model = process.env.PRE_CLASSIFIER_MODEL || "opus-4.7";

        var completion = await openai.chat.completions.create({
            model:       model,
            max_tokens:  80,
            temperature: 0.1,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user",   content: buildUserPrompt(input) },
            ],
        });

        var raw = (completion.choices[0].message.content || "").trim();
        var fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) raw = fenceMatch[1].trim();

        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (_) {
            // Try to extract a JSON object from a noisy response
            var braceMatch = raw.match(/\{[\s\S]*\}/);
            parsed = braceMatch ? JSON.parse(braceMatch[0]) : null;
        }

        return sanitize(parsed || {});

    } catch (err) {
        console.error("⚠️  PRE_CLASSIFIER ERROR — falling back: " + err.message);
        return Object.assign({}, FALLBACK);
    }
}

module.exports = classifyInbound;
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.buildUserPrompt = buildUserPrompt;
module.exports.FALLBACK = FALLBACK;
module.exports.VALID_ACTIONS = VALID_ACTIONS;
module.exports.VALID_TEMPLATES = VALID_TEMPLATES;
