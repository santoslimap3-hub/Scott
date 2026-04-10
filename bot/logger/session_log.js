/**
 * logger/session_log.js
 *
 * Records every post/comment the bot replies to, along with the
 * classifier tags chosen, and the generated reply.
 *
 * Two files are written to bot/logs/ after each cycle:
 *   - YYYY-MM-DD_HHMMSS_session.json  (raw data — for programmatic use)
 *   - YYYY-MM-DD_HHMMSS_session.md    (human-readable — share with client)
 *
 * Usage:
 *   const log = require('./logger/session_log');
 *   log.addEntry({ type, postAuthor, postTitle, postBodyPreview,
 *                  commentAuthor, commentText, tags, reply });
 *   log.writeLogs();   // call at end of each cycle
 *   log.clear();       // call at start of a new run if you want a fresh file
 */

const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

var entries      = [];
var sessionStart = new Date();
var sessionId    = formatTimestamp(sessionStart);

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add one reply to the in-memory log.
 *
 * @param {Object} entry
 *   type            "post" | "comment" | "notif-comment"
 *   postAuthor      string
 *   postTitle       string
 *   postBodyPreview string  (first ~300 chars of post body)
 *   commentAuthor   string  (only for comment/notif-comment)
 *   commentText     string  (only for comment/notif-comment)
 *   tags            { tone_tags: [], intent: "", sales_stage: "", reasoning: "" }
 *   reply           string  (the text that was typed into Skool)
 */
function addEntry(entry) {
    entry.timestamp = new Date().toISOString();
    entries.push(entry);
    console.log('  📝 Logged entry #' + entries.length + ' (' + entry.type + ')');
}

/**
 * Write the current entries to disk.
 * Safe to call multiple times — overwrites the same session files each cycle
 * so you always have an up-to-date snapshot even if the bot crashes.
 */
function writeLogs() {
    if (entries.length === 0) return;

    // Ensure logs directory exists
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    var base    = path.join(LOGS_DIR, sessionId + '_session');
    var jsonPath = base + '.json';
    var mdPath   = base + '.md';

    fs.writeFileSync(jsonPath, JSON.stringify(entries, null, 2), 'utf8');
    fs.writeFileSync(mdPath,   buildMarkdown(entries),          'utf8');

    console.log('\n📄 Session log updated:');
    console.log('   ' + entries.length + ' entries | MD → bot/logs/' + sessionId + '_session.md\n');

    return { jsonPath: jsonPath, mdPath: mdPath };
}

/**
 * Overwrite the `type` field on the most recently added entry.
 * Used by handleNotifications to re-label comment entries as notif-comment.
 */
function patchLastType(newType) {
    if (entries.length > 0) {
        entries[entries.length - 1].type = newType;
    }
}

/**
 * Reset for a brand-new run (call this if you restart the process
 * and want separate log files rather than appending to the old one).
 * Not needed during normal cycling — the bot uses the same session
 * file until it is restarted.
 */
function clear() {
    entries      = [];
    sessionStart = new Date();
    sessionId    = formatTimestamp(sessionStart);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTimestamp(date) {
    var Y  = date.getFullYear();
    var M  = pad(date.getMonth() + 1);
    var D  = pad(date.getDate());
    var h  = pad(date.getHours());
    var m  = pad(date.getMinutes());
    var s  = pad(date.getSeconds());
    return Y + '-' + M + '-' + D + '_' + h + m + s;
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function blockQuote(text) {
    if (!text) return '';
    return text.trim().split('\n').map(function(l) { return '> ' + l; }).join('\n');
}

function buildMarkdown(entries) {
    var lines = [];

    lines.push('# OutreachAI — Classifier Review');
    lines.push('');
    lines.push('**Session started:** ' + sessionStart.toLocaleString());
    lines.push('**Items logged:**    ' + entries.length);
    lines.push('');
    lines.push('This file shows every post/comment the bot replied to, the tags the');
    lines.push('classifier chose, and the reply it generated. Review and flag anything');
    lines.push('that looks wrong — adjustments go in `bot/classify/tags.js` or `examples.js`.');
    lines.push('');

    entries.forEach(function(entry, i) {
        var num  = i + 1;
        var time = new Date(entry.timestamp).toLocaleTimeString();

        lines.push('---');
        lines.push('');
        lines.push('## ' + num + '. ' + typeLabel(entry.type) + '  ·  ' + time);
        lines.push('');

        // ── Content section ──
        if (entry.type === 'post') {
            lines.push('**Post by:** ' + (entry.postAuthor || '—'));
            lines.push('**Title:**   ' + (entry.postTitle  || '—'));
            if (entry.postBodyPreview) {
                lines.push('');
                lines.push(blockQuote(entry.postBodyPreview));
            }
        } else {
            // comment or notif-comment
            lines.push('**Post by:** ' + (entry.postAuthor   || '—') + '  ·  ' + (entry.postTitle || '—'));
            lines.push('**Comment by:** ' + (entry.commentAuthor || '—'));
            if (entry.commentText) {
                lines.push('');
                lines.push(blockQuote(entry.commentText));
            }
        }

        // ── Classifier tags ──
        lines.push('');
        lines.push('### Classifier Tags');
        lines.push('');
        lines.push('| Field | Value |');
        lines.push('|---|---|');
        lines.push('| **Tone** | ' + (entry.tags.tone_tags || []).join(', ') + ' |');
        lines.push('| **Intent** | ' + (entry.tags.intent || '—') + ' |');
        lines.push('| **Sales Stage** | ' + (entry.tags.sales_stage || '—') + ' |');
        if (entry.tags.reasoning) {
            lines.push('| **Reasoning** | *' + entry.tags.reasoning + '* |');
        }

        // ── Generated reply ──
        lines.push('');
        lines.push('### Generated Reply');
        lines.push('');
        lines.push(blockQuote(entry.reply || '(no reply generated)'));
        lines.push('');
    });

    // ── Summary table at the bottom ──
    lines.push('---');
    lines.push('');
    lines.push('## Summary Table');
    lines.push('');
    lines.push('| # | Type | Author | Intent | Stage | Tone |');
    lines.push('|---|---|---|---|---|---|');
    entries.forEach(function(entry, i) {
        var author = entry.type === 'post'
            ? (entry.postAuthor || '—')
            : (entry.commentAuthor || '—');
        lines.push(
            '| ' + (i + 1) +
            ' | ' + typeLabel(entry.type) +
            ' | ' + author +
            ' | ' + (entry.tags.intent      || '—') +
            ' | ' + (entry.tags.sales_stage || '—') +
            ' | ' + (entry.tags.tone_tags || []).join(', ') + ' |'
        );
    });
    lines.push('');

    return lines.join('\n');
}

function typeLabel(type) {
    if (type === 'post')         return '📄 Post Reply';
    if (type === 'comment')      return '💬 Comment Reply';
    if (type === 'notif-comment') return '🔔 Notification Reply';
    return type;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = { addEntry: addEntry, patchLastType: patchLastType, writeLogs: writeLogs, clear: clear };
