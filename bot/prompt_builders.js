"use strict";

function clipText(text, maxLen) {
    var value = typeof text === "string" ? text.trim() : "";
    if (!value) return "";
    if (!maxLen || value.length <= maxLen) return value;
    return value.substring(0, maxLen).trim();
}

function buildPersonBlock(name, gender, role) {
    return [
        "Name: " + (name || "Unknown"),
        "Gender: " + (gender || "unknown"),
        "Role: " + (role || "lead (prospect)"),
    ].join("\n");
}

function buildHistoryBlock(lines) {
    return (lines || []).join("\n");
}

function buildReplyToBlock(tag, author, text) {
    return "[" + (tag || "MESSAGE") + "] " + (author || "Unknown") + ": " + (text || "");
}

function dbHistoryToLines(dbHistory, botName, includeDMs) {
    var lines = [];
    if (!dbHistory || dbHistory.length === 0) return lines;

    for (var i = 0; i < dbHistory.length; i++) {
        var h = dbHistory[i];
        if (!h || !h.type) continue;

        switch (h.type) {
            case "post":
                lines.push("[POST] " + (h.author || "Unknown") + ": " + clipText(h.title || "(no title)", 200));
                if (h.body) lines.push(clipText(h.body, 400));
                break;
            case "comment":
                lines.push("[COMMENT] " + (h.author || "Unknown") + ": " + clipText(h.text, 300));
                break;
            case "scott_reply":
                lines.push("[COMMENT] " + (h.author || botName || "Jack Walford") + ": " + clipText(h.text, 300));
                break;
            case "dm":
                if (includeDMs) {
                    var dmAuthor = h.sender === "bot"
                        ? (h.author || botName || "Jack Walford")
                        : (h.author || "Unknown");
                    lines.push("[DM] " + dmAuthor + ": " + clipText(h.text, 300));
                }
                break;
        }
    }

    return lines;
}

function threadToLines(thread) {
    var lines = [];
    if (!thread || thread.length === 0) return lines;

    for (var i = 0; i < thread.length; i++) {
        var item = thread[i];
        if (!item || !item.author || !item.text) continue;
        lines.push("[COMMENT] " + item.author + ": " + clipText(item.text, 300));
    }

    return lines;
}

function dmMessagesToHistoryLines(messages, partnerName, botName) {
    var lines = [];
    if (!messages || messages.length < 2) return lines;

    var priorMessages = messages.slice(0, messages.length - 1);
    for (var i = 0; i < priorMessages.length; i++) {
        var message = priorMessages[i];
        var author = message.role === "bot"
            ? (botName || "Jack Walford")
            : (partnerName || "Unknown");
        lines.push("[DM] " + author + ": " + clipText(message.text, 300));
    }

    return lines;
}

function buildInteractionHistoryText(lines) {
    return lines && lines.length > 0
        ? lines.join("\n")
        : "No prior interactions available.";
}

function buildCommentInteractionHistory(dbHistory, botName) {
    return buildInteractionHistoryText(dbHistoryToLines(dbHistory, botName, true));
}

function buildDMInteractionHistory(partnerName, dbHistory, currentMessages, botName) {
    var lines = dbHistoryToLines(dbHistory, botName, true)
        .concat(dmMessagesToHistoryLines(currentMessages, partnerName, botName));
    return buildInteractionHistoryText(lines);
}

function buildPostUserPrompt(post) {
    var parts = [];
    if (post && post.title) parts.push(clipText(post.title, 300));
    if (post && post.body) parts.push(clipText(post.body, 1200));
    return parts.join("\n\n").trim() || "(no post text)";
}

function buildCommentUserPrompt(comment) {
    return clipText(comment && comment.text, 600) || "(no comment text)";
}

function buildDMUserPrompt(partnerName, dbHistory, currentMessages) {
    var lastMessage = currentMessages && currentMessages.length > 0
        ? currentMessages[currentMessages.length - 1]
        : null;
    return clipText(lastMessage && lastMessage.text, 600) || "(no message text)";
}

module.exports = {
    buildPersonBlock: buildPersonBlock,
    buildHistoryBlock: buildHistoryBlock,
    buildReplyToBlock: buildReplyToBlock,
    dbHistoryToLines: dbHistoryToLines,
    threadToLines: threadToLines,
    dmMessagesToHistoryLines: dmMessagesToHistoryLines,
    buildInteractionHistoryText: buildInteractionHistoryText,
    buildCommentInteractionHistory: buildCommentInteractionHistory,
    buildDMInteractionHistory: buildDMInteractionHistory,
    buildPostUserPrompt: buildPostUserPrompt,
    buildCommentUserPrompt: buildCommentUserPrompt,
    buildDMUserPrompt: buildDMUserPrompt,
};
