// =============================================================================
// agentic/dedup.js
//
// The single source of truth that enforces the no-duplicates guarantee:
//   * never two replies under the same notification
//   * never two value comments under the same post (or comment URL)
//
// Persisted to bot/agentic/dedup_ledger.json. Atomic writes via .tmp + rename.
//
// Notification key:
//   normalizeHref(href) + "::" + normalizeName(author) + "::" + sha1(snippet)
//
// Comment key:
//   normalizeHref(post_or_comment_url)
// =============================================================================

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const LEDGER_FILE = path.join(__dirname, "dedup_ledger.json");

// ---- key helpers -----------------------------------------------------------

function normalizeHref(href) {
    if (!href || typeof href !== "string") return "";
    try {
        var u = new URL(href);
        var pathname = (u.pathname || "").replace(/\/+$/, "");
        return (u.origin + pathname).toLowerCase();
    } catch (_) {
        return href.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
    }
}

function normalizeName(name) {
    if (!name || typeof name !== "string") return "";
    return name
        .replace(/Â/g, "")
        .replace(/[   ]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function sha1(str) {
    return crypto.createHash("sha1").update(str || "", "utf8").digest("hex").substring(0, 16);
}

function notifKey(href, author, snippet) {
    var snip = (snippet || "").substring(0, 200);
    return normalizeHref(href) + "::" + normalizeName(author) + "::" + sha1(snip);
}

function commentKey(url) {
    return normalizeHref(url);
}

// ---- persistence -----------------------------------------------------------

function ensureShape(ledger) {
    var safe = (ledger && typeof ledger === "object" && !Array.isArray(ledger)) ? ledger : {};
    if (!safe.notifications  || typeof safe.notifications  !== "object") safe.notifications  = {};
    if (!safe.comments_left  || typeof safe.comments_left  !== "object") safe.comments_left  = {};
    return safe;
}

function load() {
    try {
        if (fs.existsSync(LEDGER_FILE)) {
            return ensureShape(JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")));
        }
    } catch (_) {}
    return ensureShape({});
}

function save(ledger) {
    var safe = ensureShape(ledger);
    var tmp = LEDGER_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, LEDGER_FILE);
}

// ---- public api ------------------------------------------------------------

function alreadyRepliedToNotif(ledger, href, author, snippet) {
    var k = notifKey(href, author, snippet);
    return !!ledger.notifications[k];
}

function markNotifReplied(ledger, href, author, snippet, meta) {
    var k = notifKey(href, author, snippet);
    ledger.notifications[k] = {
        repliedAt: new Date().toISOString(),
        href:      href,
        author:    author || "",
        snippet:   (snippet || "").substring(0, 240),
        meta:      meta || null,
    };
    save(ledger);
}

function alreadyCommentedOn(ledger, url) {
    return !!ledger.comments_left[commentKey(url)];
}

function markCommentLeft(ledger, url, meta) {
    var k = commentKey(url);
    ledger.comments_left[k] = {
        leftAt: new Date().toISOString(),
        url:    url,
        meta:   meta || null,
    };
    save(ledger);
}

module.exports = {
    load,
    save,
    notifKey,
    commentKey,
    alreadyRepliedToNotif,
    markNotifReplied,
    alreadyCommentedOn,
    markCommentLeft,
};
