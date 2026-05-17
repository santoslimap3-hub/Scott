// =============================================================================
// agentic/text_sanitizer.js
//
// Utility to remove @mentions and notification chrome from text before
// sending to LLMs. This prevents the model from misinterpreting mentions
// as instructions to address third parties in its reply.
//
// Example:
//   "@Pedro Lima Hey, I have a question"  ->  "Hey, I have a question"
//   "• 2h@Jack Walford Great post!"       ->  "Great post!"
//
// =============================================================================

"use strict";

/**
 * Strip ALL @mentions from text (not just bot mentions).
 * Removes patterns like "@John Doe", "@firstnamelastname", etc.
 * Handles multi-word names and keeps the rest of the text.
 */
function stripAllMentions(text) {
    if (!text) return "";
    var out = String(text);
    
    // Strip @mentions: @Name, @FirstName LastName, @FirstName M. LastName, etc.
    // This regex matches @ followed by word characters and spaces, up to word boundary.
    // Matches: @John, @John Doe, @John M Doe, @john smith, etc.
    out = out.replace(/@[\w][\w\s\.]*?(?=\s|$|[^\w\s\.])/gi, " ");
    
    // Also handle @ followed by non-ASCII characters (names with accents, etc)
    // This catches names like @Pedro Lima, @José García, etc.
    out = out.replace(/@[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\.]*?(?=\s|$|[^\w\sÀ-ÿ\.])/g, " ");
    
    // Collapse whitespace
    return out.replace(/\s+/g, " ").trim();
}

/**
 * Strip notification chrome AND all @mentions.
 * Chrome includes: leading "• 1h", "· just now", "- 2m", trailing "Reply"/"Like" tokens.
 */
function stripMentionsAndChrome(text) {
    if (!text) return "";
    var out = String(text);
    
    // Leading bullet+timestamp chrome: "• 1h", "· just now", "- 2m", etc.
    out = out.replace(/^\s*[·\-–—•]\s*(?:just\s*now|\d+\s*[smhdw])\s*/i, "");
    
    // Standalone timestamp tokens elsewhere in the text (rare but possible).
    out = out.replace(/(^|\s)(?:just\s*now|\d+\s*[smhdw])(?=\s|$)/gi, " ");
    
    // UI verbs that occasionally leak into the preview ("Like", "Reply").
    out = out.replace(/\b(?:reply\s+to|liked|^like$|^reply$)\b/gi, " ");
    
    // Strip ALL @mentions (not just bot mentions)
    out = stripAllMentions(out);
    
    // Collapse whitespace
    return out.replace(/\s+/g, " ").trim();
}

function stripSkoolCommentMeta(text) {
    if (!text) return "";
    var out = String(text).trim();
    out = stripMentionsAndChrome(out);

    // Remove leading Skool feed/comment UI prefixes like
    // "7Ayaan Ashfaq • 1d" or "8Michael Pluszek🔥 • 2d".
    out = out.replace(/^\s*\d+\s*/, "");
    out = out.replace(/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\-\.\s]{1,100}\s*[·•—–-]\s*\d+\s*[smhdw]\s*/i, "");

    // Remove any residual leading author-like prefix such as "Name:".
    out = out.replace(/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\-\.\s]{1,100}\s*[:\-–—]\s*/i, "");
    return out.replace(/\s+/g, " ").trim();
}

module.exports = {
    stripAllMentions: stripAllMentions,
    stripMentionsAndChrome: stripMentionsAndChrome,
    stripSkoolCommentMeta: stripSkoolCommentMeta,
};
