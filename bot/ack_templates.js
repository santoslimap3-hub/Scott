// ack_templates.js
// ────────────────────────────────────────────────────────────────────────────
// Hardcoded short reactions used when the pre-classifier returns ACK.
//
// The fine-tuned model is BYPASSED for these — that's the whole point.
// The current bot's failure mode is "wrap a 'thanks' in three sentences of
// brotherhood preamble." This file is the antidote: pick one of these,
// print it verbatim, do not pass through any LLM.
//
// Three template families per §6 of AUTO_REPLY_V2_UNIFIED_PLAN.md:
//
//   emoji              — single emoji, no text
//   mirror             — echo the partner's emoji back
//   brotherhood-2word  — short brotherhood phrase
// ────────────────────────────────────────────────────────────────────────────

"use strict";

// Short emoji reactions — used when the partner sent something tiny
const EMOJI_POOL = [
    "🔥",
    "💯",
    "🙏",
];

// Short brotherhood phrases — used when text feels appropriate over an emoji
const BROTHERHOOD_TWO_WORD_POOL = [
    "anytime, brother",
    "all love",
    "🔥 brother",
    "you got it",
];

// Set of emoji we'll mirror back if the partner sends them
const MIRRORABLE_EMOJI = new Set([
    "👊", "🔥", "💯", "🙏", "🤝", "❤️", "💪", "👏", "👍", "🫡", "⚡",
]);

function pickRandom(pool) {
    return pool[Math.floor(Math.random() * pool.length)];
}

function extractFirstEmoji(text) {
    if (!text || typeof text !== "string") return null;
    // Match emoji-like codepoints. Conservative — covers our mirror set.
    var match = text.match(/[☀-➿\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2700}-\u{27BF}]/u);
    return match ? match[0] : null;
}

/**
 * Render an ACK reaction.
 * @param {string} template   — one of: "emoji" | "mirror" | "brotherhood-2word"
 * @param {string} [partnerText] — what the partner said (only needed for mirror)
 * @returns {string} the literal text to send. Never empty.
 */
function renderAck(template, partnerText) {
    switch (template) {
        case "mirror":
            var emoji = extractFirstEmoji(partnerText || "");
            if (emoji && MIRRORABLE_EMOJI.has(emoji)) return emoji;
            // Fall through to emoji pool if nothing to mirror
            return pickRandom(EMOJI_POOL);

        case "brotherhood-2word":
            return pickRandom(BROTHERHOOD_TWO_WORD_POOL);

        case "emoji":
        default:
            return pickRandom(EMOJI_POOL);
    }
}

module.exports = {
    renderAck:                  renderAck,
    EMOJI_POOL:                 EMOJI_POOL,
    BROTHERHOOD_TWO_WORD_POOL:  BROTHERHOOD_TWO_WORD_POOL,
    MIRRORABLE_EMOJI:           MIRRORABLE_EMOJI,
    extractFirstEmoji:          extractFirstEmoji,
};
