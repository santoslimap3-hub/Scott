// ── Prompt Builders ───────────────────────────────────────────────────────────
// Builds the user-turn messages sent to the fine-tuned model.
//
// All three formats (post reply, comment reply, DM reply) follow the same
// structure matching the v6 training data format:
//
//   --- PERSON ---
//   Name: X
//   Gender: male|female|unknown
//   Role: lead (prospect) | company-member (CEO)
//   --- HISTORY ---
//   [COMMENT] Author: text
//   [POST] Author: title\nbody
//   [DM] Author: text
//   --- REPLY TO ---
//   [COMMENT|POST|DM] Author: text

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert persons DB history entries to formatted history lines.
 * For post/comment context: includes post, comment, and scott_reply entries.
 *   DM entries are skipped (DMs are injected directly from the current session).
 * For DM context (includeDMs=true): also includes prior DM entries.
 */
function dbHistoryToLines(dbHistory, botName, includeDMs) {
    var lines = [];
    if (!dbHistory || dbHistory.length === 0) return lines;

    for (var i = 0; i < dbHistory.length; i++) {
        var h = dbHistory[i];
        switch (h.type) {
            case "post":
                lines.push("[POST] " + (h.author || "Unknown") + ": " + (h.title || "(no title)"));
                if (h.body) lines.push((h.body || "").substring(0, 300));
                break;
            case "comment":
                lines.push("[COMMENT] " + (h.author || "Unknown") + ": " + (h.text || "").substring(0, 300));
                break;
            case "scott_reply":
                lines.push("[COMMENT] " + (h.author || botName || "Jack Walford") + ": " + (h.text || "").substring(0, 300));
                break;
            case "dm":
                if (includeDMs) {
                    var dmAuthor = h.sender === "bot"
                        ? (h.author || botName || "Jack Walford")
                        : (h.author || "Unknown");
                    lines.push("[DM] " + dmAuthor + ": " + (h.text || "").substring(0, 300));
                }
                break;
        }
    }
    return lines;
}

/**
 * Convert scraped thread comment objects to [COMMENT] lines.
 */
function threadToLines(thread) {
    var lines = [];
    if (!thread || thread.length === 0) return lines;
    for (var i = 0; i < thread.length; i++) {
        var t = thread[i];
        if (t.author && t.text) {
            lines.push("[COMMENT] " + t.author + ": " + t.text.substring(0, 300));
        }
    }
    return lines;
}

/**
 * Convert DM session messages to [DM] lines.
 * All messages EXCEPT the last one (which becomes REPLY TO).
 */
function dmMessagesToHistoryLines(messages, partnerName, botName) {
    var lines = [];
    if (!messages || messages.length < 2) return lines; // last message goes to REPLY TO
    var toInclude = messages.slice(0, messages.length - 1);
    for (var i = 0; i < toInclude.length; i++) {
        var m = toInclude[i];
        var author = m.role === "bot"
            ? (botName || "Jack Walford")
            : (partnerName || "Unknown");
        lines.push("[DM] " + author + ": " + (m.text || "").substring(0, 300));
    }
    return lines;
}

// ── Block builders ────────────────────────────────────────────────────────────

function buildPersonBlock(name, gender, role) {
    return [
        "--- PERSON ---",
        "Name: " + (name || "Unknown"),
        "Gender: " + (gender || "unknown"),
        "Role: " + (role || "lead (prospect)"),
    ].join("\n");
}

function buildHistoryBlock(lines) {
    if (!lines || lines.length === 0) return "";
    return "--- HISTORY ---\n" + lines.join("\n");
}

function buildReplyToBlock(tag, author, text) {
    // tag: "COMMENT" | "POST" | "DM"
    return "--- REPLY TO ---\n[" + tag + "] " + (author || "Unknown") + ": " + (text || "");
}

// ── Full user prompt builders ─────────────────────────────────────────────────

/**
 * Build user prompt for a POST reply.
 *
 * HISTORY = prior DB interactions (comments/posts/scott_replies from other threads)
 * REPLY TO = the post itself
 */
function buildPostUserPrompt(post, dbHistory, botName, gender, role) {
    var blocks = [];

    // --- PERSON ---
    blocks.push(buildPersonBlock(post.author, gender, role));

    // --- HISTORY --- (prior DB interactions only; no thread on a new post)
    var historyLines = dbHistoryToLines(dbHistory, botName, false);
    var historyBlock = buildHistoryBlock(historyLines);
    if (historyBlock) blocks.push(historyBlock);

    // --- REPLY TO ---
    var replyBody = [post.title || "(no title)"];
    if (post.body) replyBody.push(post.body.substring(0, 500));
    blocks.push("--- REPLY TO ---\n[POST] " + (post.author || "Unknown") + ": " + replyBody.join("\n"));

    return blocks.join("\n");
}

/**
 * Build user prompt for a COMMENT reply.
 *
 * HISTORY = prior DB interactions + current post as [POST] entry
 * REPLY TO = the specific comment being replied to
 *
 * The thread is included in HISTORY to give the model conversation context.
 */
function buildCommentUserPrompt(comment, dbHistory, botName, gender, role) {
    var blocks = [];

    // --- PERSON ---
    blocks.push(buildPersonBlock(comment.author, gender, role));

    // --- HISTORY ---
    var historyLines = dbHistoryToLines(dbHistory, botName, false);

    // Append the current post as a [POST] entry for context
    if (comment.postTitle || comment.postBody) {
        var postLine = "[POST] " + (comment.postAuthor || "Unknown") + ": " + (comment.postTitle || "(no title)");
        if (comment.postBody) postLine += "\n" + comment.postBody.substring(0, 300);
        historyLines.push(postLine);
    }

    // Append the scraped thread (gives comment exchange context)
    if (comment.thread && comment.thread.length > 0) {
        var threadLines = threadToLines(comment.thread);
        historyLines = historyLines.concat(threadLines);
    }

    var historyBlock = buildHistoryBlock(historyLines);
    if (historyBlock) blocks.push(historyBlock);

    // --- REPLY TO ---
    blocks.push(buildReplyToBlock("COMMENT", comment.author, (comment.text || "").substring(0, 400)));

    return blocks.join("\n");
}

/**
 * Build user prompt for a DM reply.
 *
 * HISTORY = prior DB community interactions (no DMs to avoid duplication)
 *           + current DM conversation messages (all except the last)
 * REPLY TO = the last DM message from the person
 */
function buildDMUserPrompt(partnerName, dbHistory, currentMessages, botName, gender, role) {
    var blocks = [];

    // --- PERSON ---
    blocks.push(buildPersonBlock(partnerName, gender, role));

    // --- HISTORY ---
    // Part A: prior community interactions from DB (comments/posts — skip prior DMs to avoid duplication)
    var historyLines = dbHistoryToLines(dbHistory, botName, false);

    // Part B: current DM conversation (all messages except the last)
    var dmHistLines = dmMessagesToHistoryLines(currentMessages, partnerName, botName);
    historyLines = historyLines.concat(dmHistLines);

    var historyBlock = buildHistoryBlock(historyLines);
    if (historyBlock) blocks.push(historyBlock);

    // --- REPLY TO --- (last message from the partner)
    var lastMsg = currentMessages && currentMessages.length > 0
        ? currentMessages[currentMessages.length - 1]
        : null;
    var replyText = lastMsg ? (lastMsg.text || "") : "";
    blocks.push(buildReplyToBlock("DM", partnerName, replyText.substring(0, 400)));

    return blocks.join("\n");
}

module.exports = {
    buildPersonBlock:        buildPersonBlock,
    buildHistoryBlock:       buildHistoryBlock,
    buildReplyToBlock:       buildReplyToBlock,
    dbHistoryToLines:        dbHistoryToLines,
    threadToLines:           threadToLines,
    dmMessagesToHistoryLines: dmMessagesToHistoryLines,
    buildPostUserPrompt:     buildPostUserPrompt,
    buildCommentUserPrompt:  buildCommentUserPrompt,
    buildDMUserPrompt:       buildDMUserPrompt,
};
