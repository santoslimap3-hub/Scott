// bot/logger/rag_outcomes.js
// ────────────────────────────────────────────────────────────────────────────
// Append-only log of every reply the bot sends together with the retrieved
// example IDs that fed the prompt. A separate offline script will join this
// against subsequent partner behavior (engaged back? promoted to higher
// stage? booked a call?) and rewrite the per-example outcome_score in the
// indexes.
//
// One JSONL line per send:
//   {
//     ts:                ISO timestamp
//     channel:           "post" | "comment" | "dm-opener" | "dm"
//     dm_stage:          "qualify" | "offer-call" | "send-calendly" | null
//     intent:            string | null
//     sales_stage:       string | null
//     partner:           name
//     partner_stage:     0..6 (persons-DB stage at send time)
//     retrieved_ids:     [example_id, ...]   ← from the RAG corpus
//     reply_text:        what the bot actually sent
//     post_href:         optional thread URL
//   }
//
// Failure here must never block a send — every write is wrapped in try/catch.
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const fs   = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "..", "..", "data", "rag_outcomes.jsonl");

function ensureDir() {
    var dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logSend(entry) {
    try {
        ensureDir();
        var record = {
            ts:             new Date().toISOString(),
            channel:        entry.channel        || null,
            dm_stage:       entry.dm_stage       || null,
            intent:         entry.intent         || null,
            sales_stage:    entry.sales_stage    || null,
            partner:        entry.partner        || null,
            partner_stage:  typeof entry.partner_stage === "number" ? entry.partner_stage : null,
            retrieved_ids:  Array.isArray(entry.retrieved_ids) ? entry.retrieved_ids : [],
            reply_text:     (entry.reply_text || "").substring(0, 1200),
            post_href:      entry.post_href      || null,
        };
        fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
    } catch (err) {
        console.warn("[rag_outcomes] log failed: " + err.message);
    }
}

function path_() { return LOG_FILE; }

module.exports = { logSend: logSend, path: path_ };
