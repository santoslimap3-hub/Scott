// rag/build_index.js
// ────────────────────────────────────────────────────────────────────────────
// Read v13 JSONL, split into 3 corpora by SITUATION, infer DM sub-stages
// from the assistant text, embed each example via OpenAI text-embedding-3-small,
// write three sidecar files into rag/indexes/.
//
// Usage:
//   node rag/build_index.js                    # full hybrid build (BM25 + embeddings)
//   node rag/build_index.js --no-embeddings    # BM25-only (no API calls)
//
// Reads:
//   data/fine_tune/finetune_data_v13.jsonl
//
// Writes:
//   rag/indexes/post_replies.jsonl
//   rag/indexes/post_comments.jsonl
//   rag/indexes/dm_turns.jsonl
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const fs   = require("fs");
const path = require("path");
const OpenAI = require("openai");

// Load API key from bot/.env (which has OPENAI_API_KEY)
require("dotenv").config({ path: path.join(__dirname, "..", "bot", ".env") });

const SOURCE_FILE  = path.join(__dirname, "..", "data", "fine_tune", "finetune_data_v13.jsonl");
const OUT_DIR      = path.join(__dirname, "indexes");
const EMBED_MODEL  = process.env.EMBED_MODEL || "text-embedding-3-small";
const BATCH_SIZE   = 96;
const MAX_CHARS    = 6000;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ── DM sub-stage inference (from assistant text) ─────────────────────────────
const RX_CALENDLY = /calendly\.com|here'?s\s+my\s+link|here\s+is\s+my\s+link|book(ed)?\s+(a|the)\s+(call|time|slot)/i;
const RX_FLOAT    = /(jump|hop)\s+on\s+a\s+(quick\s+)?call|set\s+up\s+a\s+call|schedule\s+a\s+call|do\s+a\s+(quick\s+)?call|get\s+on\s+a\s+call|let'?s\s+(jump|hop|talk)/i;

function inferDmStage(assistantText) {
    var t = String(assistantText || "");
    if (RX_CALENDLY.test(t)) return "send-calendly";
    if (RX_FLOAT.test(t))    return "offer-call";
    if (t.trim().endsWith("?")) return "qualify";
    return "general-dm";
}

// ── Outcome scoring (heuristic v1; replace with logged outcomes over time) ───
function outcomeScore(corpus, dm_stage, assistantText) {
    var len = (assistantText || "").length;
    if (len < 25) return 0.7;
    if (corpus === "dm") {
        if (dm_stage === "send-calendly") return 1.5;
        if (dm_stage === "offer-call")    return 1.3;
        if (dm_stage === "qualify")       return 1.15;
        return 1.0;
    }
    if (len > 200) return 1.1;
    return 1.0;
}

// ── Tag extraction from system prompt ───────────────────────────────────────
function extractTags(systemPrompt) {
    var tags = { stage: null, intent: null, tone_tags: [] };
    if (!systemPrompt) return tags;
    var lines = systemPrompt.split("\n");
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].trim();
        if (ln.indexOf("STAGE:") === 0)        tags.stage = ln.substring(6).trim().toLowerCase();
        else if (ln.indexOf("INTENT:") === 0)  tags.intent = ln.substring(7).trim().toLowerCase();
        else if (ln.indexOf("TONE:") === 0) {
            tags.tone_tags = ln.substring(5).split(",").map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
        }
    }
    return tags;
}

function extractPerson(userPrompt) {
    var person = { name: null, gender: null, role: null };
    if (!userPrompt) return person;
    var m;
    if ((m = userPrompt.match(/Name:\s*([^\n]+)/i)))   person.name   = m[1].trim();
    if ((m = userPrompt.match(/Gender:\s*([^\n]+)/i))) person.gender = m[1].trim().toLowerCase();
    if ((m = userPrompt.match(/Role:\s*([^\n]+)/i)))   person.role   = m[1].trim().toLowerCase();
    return person;
}

function extractQueryText(userPrompt) {
    if (!userPrompt) return "";
    var idx = userPrompt.indexOf("--- REPLY TO ---");
    if (idx === -1) return userPrompt;
    return userPrompt.substring(idx + "--- REPLY TO ---".length).trim();
}

function detectCorpus(systemPrompt) {
    if (!systemPrompt) return null;
    if (systemPrompt.indexOf("Skool DM") !== -1)            return "dm";
    if (systemPrompt.indexOf("Skool post comment") !== -1)  return "post_comment";
    if (systemPrompt.indexOf("Skool post.") !== -1)         return "post";
    return null;
}

function loadExamples() {
    console.log("Reading " + SOURCE_FILE);
    var raw = fs.readFileSync(SOURCE_FILE, "utf8");
    var lines = raw.split("\n").filter(function(l) { return l.trim().length > 0; });
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var d;
        try { d = JSON.parse(lines[i]); } catch (_) { continue; }
        var msgs = d.messages || [];
        var sys = "", usr = "", ast = "";
        for (var k = 0; k < msgs.length; k++) {
            if (msgs[k].role === "system")    sys = msgs[k].content || "";
            else if (msgs[k].role === "user") usr = msgs[k].content || "";
            else if (msgs[k].role === "assistant") ast = msgs[k].content || "";
        }
        if (!ast) continue;
        var corpus = detectCorpus(sys);
        if (!corpus) continue;

        var dmStage = corpus === "dm" ? inferDmStage(ast) : null;
        var query   = extractQueryText(usr);
        if (query.length > MAX_CHARS) query = query.substring(0, MAX_CHARS);

        out.push({
            id:            "v13_" + i,
            corpus:        corpus,
            channel:       corpus === "dm" ? "dm" : (corpus === "post_comment" ? "comment" : "post"),
            dm_stage:      dmStage,
            tags:          extractTags(sys),
            person:        extractPerson(usr),
            query_text:    query,
            assistant:     ast,
            length:        ast.length,
            outcome_score: outcomeScore(corpus, dmStage, ast),
        });
    }
    console.log("  parsed " + out.length + " examples");
    return out;
}

async function embedAll(items) {
    if (process.argv.indexOf("--no-embeddings") !== -1) {
        console.log("--no-embeddings flag set — skipping embedding step (retriever will run BM25-only)");
        return;
    }
    if (!openai) {
        console.log("OPENAI_API_KEY missing — skipping embedding step (retriever will run BM25-only)");
        return;
    }
    console.log("Embedding " + items.length + " items via " + EMBED_MODEL + " in batches of " + BATCH_SIZE);
    for (var start = 0; start < items.length; start += BATCH_SIZE) {
        var batch = items.slice(start, start + BATCH_SIZE);
        var inputs = batch.map(function(it) {
            var text = it.query_text || "";
            return text.length > 0 ? text : "(empty)";
        });
        var resp;
        try { resp = await openai.embeddings.create({ model: EMBED_MODEL, input: inputs }); }
        catch (err) {
            console.error("  batch starting at " + start + " failed: " + err.message);
            throw err;
        }
        for (var b = 0; b < batch.length; b++) batch[b].embedding = resp.data[b].embedding;
        process.stdout.write("\r  embedded " + Math.min(start + BATCH_SIZE, items.length) + " / " + items.length);
    }
    process.stdout.write("\n");
}

function writeCorpus(corpus, items) {
    var outFile;
    if (corpus === "post")              outFile = path.join(OUT_DIR, "post_replies.jsonl");
    else if (corpus === "post_comment") outFile = path.join(OUT_DIR, "post_comments.jsonl");
    else if (corpus === "dm")           outFile = path.join(OUT_DIR, "dm_turns.jsonl");
    else throw new Error("unknown corpus: " + corpus);

    var lines = items.map(function(it) { return JSON.stringify(it); });
    fs.writeFileSync(outFile, lines.join("\n") + "\n");
    console.log("Wrote " + items.length + " → " + outFile);
}

(async function main() {
    if (!fs.existsSync(SOURCE_FILE)) {
        console.error("Source file not found: " + SOURCE_FILE);
        process.exit(1);
    }
    var t0 = Date.now();
    var items = loadExamples();

    var counts = { post: 0, post_comment: 0, dm: 0 };
    var dmStageCounts = { "send-calendly": 0, "offer-call": 0, "qualify": 0, "general-dm": 0 };
    items.forEach(function(it) {
        counts[it.corpus]++;
        if (it.corpus === "dm") dmStageCounts[it.dm_stage]++;
    });
    console.log("Corpora: post=" + counts.post + " post_comment=" + counts.post_comment + " dm=" + counts.dm);
    console.log("DM sub-stages:", dmStageCounts);

    await embedAll(items);

    var byCorpus = { post: [], post_comment: [], dm: [] };
    items.forEach(function(it) { byCorpus[it.corpus].push(it); });

    writeCorpus("post",         byCorpus.post);
    writeCorpus("post_comment", byCorpus.post_comment);
    writeCorpus("dm",           byCorpus.dm);

    console.log("Done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
})();
