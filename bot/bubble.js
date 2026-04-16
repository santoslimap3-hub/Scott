/**
 * bubble.js — shared helpers for the ⟨BUBBLE⟩ delimiter.
 *
 * The fine-tuned model emits multi-bubble DM replies by inserting ⟨BUBBLE⟩
 * between segments. The bot splits on that delimiter and sends each segment
 * as a separate DM bubble.
 *
 * Post / comment replies on Skool are always single-bubble, so for those
 * channels we collapse any accidental delimiters into a single space.
 */

const BUBBLE_DELIM = "⟨BUBBLE⟩";

/**
 * Split an assistant reply into individual bubble strings.
 * Returns an array of non-empty trimmed strings.
 */
function splitBubbles(text) {
    if (!text) return [];
    return text
        .split(BUBBLE_DELIM)
        .map(function(s){ return s.trim(); })
        .filter(function(s){ return s.length > 0; });
}

/**
 * Strip all bubble markers and collapse into a single clean string.
 * Use for channels that can't multi-bubble (post/comment replies).
 */
function collapseBubbles(text) {
    if (!text) return "";
    return text.split(BUBBLE_DELIM).map(function(s){ return s.trim(); }).filter(Boolean).join(" ");
}

/**
 * Compute a realistic inter-bubble pause.
 *   - longer pause before longer bubbles (proportional to chars, capped)
 *   - random jitter to avoid robotic rhythm
 *
 * Returns ms.
 */
function interBubbleDelayMs(nextBubbleText) {
    var len = (nextBubbleText || "").length;
    // ~40 wpm typing baseline, but we add a "thinking + tab-switch" window
    var base = 400 + Math.min(len * 18, 2800); // 0.4s min, ~3s max planning
    var jitter = Math.floor(Math.random() * 900) - 200; // -200..+700
    return Math.max(250, base + jitter);
}

module.exports = {
    BUBBLE_DELIM: BUBBLE_DELIM,
    splitBubbles: splitBubbles,
    collapseBubbles: collapseBubbles,
    interBubbleDelayMs: interBubbleDelayMs,
};
