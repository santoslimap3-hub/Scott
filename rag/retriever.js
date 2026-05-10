// rag/retriever.js
// ────────────────────────────────────────────────────────────────────────────
// Hybrid BM25 + dense-embedding retriever over the v13 corpora.
//
// Public API:
//   var retriever = require("../rag/retriever");
//   await retriever.init();    // loads indexes, idempotent
//   var examples = await retriever.retrievePostReply({ post, intent, stage, k });
//   var examples = await retriever.retrievePostComment({ post, comment, stage, k });
//   var examples = await retriever.retrieveDmTurn({ recentTurns, dmStage, intent, partnerStage, k });
//
// Each call returns an array of:
//   { id, query_text, assistant, dm_stage, tags, score, breakdown }
// Sorted best-first. Empty array on any failure (the prompt builder then
// falls back to the existing hand-crafted system prompt — failure must never
// block generation).
//
// Implementation notes:
//   - Indexes are loaded once at startup and held in memory (~30 MB for
//     v13 with text-embedding-3-small at 1536 dims).
//   - Hybrid score = RRF(BM25_rank, dense_rank), then multiplied by:
//       * stage_match       (1.0 if same sales_stage, 0.5 if adjacent, 1.0 if untagged)
//       * intent_match      (1.0 if same intent, 0.7 otherwise, 1.0 if untagged)
//       * dm_stage_match    (1.0 if same dm_stage, 0.4 otherwise — hard-ish lock)
//       * outcome_score     (precomputed at index time, 0.7 to 1.5)
//   - Dedupe via cosine similarity > 0.92 between candidate embeddings.
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const fs   = require("fs");
const path = require("path");
const OpenAI = require("openai");
require("dotenv").config({ path: path.join(__dirname, "..", "bot", ".env") });

const INDEX_DIR = path.join(__dirname, "indexes");
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

// Reciprocal-rank-fusion constant. 60 is the literature default and rarely
// needs tuning — higher values flatten the contribution of top ranks, lower
// values overweight them.
const RRF_K = 60;

// Stop words for BM25 — same list the legacy retrieval used.
const STOP_WORDS = new Set("the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us are was has had been did got too very much really thing".split(/\s+/));

var openai = null;          // lazy init
var indexes = null;         // { post, post_comment, dm }
var bm25 = null;            // { post: BM25, post_comment: BM25, dm: BM25 }
var initialized = false;
var initPromise = null;

// ─── Tokenizer ──────────────────────────────────────────────────────────────

function tokenize(text) {
    return (text || "").toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(function(w) { return w.length > 2 && !STOP_WORDS.has(w); });
}

// ─── BM25 (corpus-scoped, no external deps) ─────────────────────────────────
// Standard Okapi BM25, k1=1.5, b=0.75.

function buildBM25(items) {
    var k1 = 1.5;
    var b  = 0.75;
    var N  = items.length;
    var docs = items.map(function(it) { return tokenize(it.query_text); });
    var avgDl = docs.reduce(function(s, d) { return s + d.length; }, 0) / Math.max(1, N);

    var df = {};
    for (var i = 0; i < N; i++) {
        var seen = new Set();
        for (var j = 0; j < docs[i].length; j++) seen.add(docs[i][j]);
        seen.forEach(function(t) { df[t] = (df[t] || 0) + 1; });
    }
    var idf = {};
    Object.keys(df).forEach(function(t) {
        // BM25 IDF can go negative for very common terms — clamp to 0.
        idf[t] = Math.max(0, Math.log((N - df[t] + 0.5) / (df[t] + 0.5) + 1));
    });

    var docTf = docs.map(function(tokens) {
        var tf = {};
        for (var i = 0; i < tokens.length; i++) tf[tokens[i]] = (tf[tokens[i]] || 0) + 1;
        return tf;
    });
    var dl = docs.map(function(d) { return d.length; });

    return {
        score: function(queryTokens, docIdx) {
            var s = 0;
            var tf = docTf[docIdx];
            var dlen = dl[docIdx];
            for (var i = 0; i < queryTokens.length; i++) {
                var t = queryTokens[i];
                var f = tf[t];
                if (!f) continue;
                var idfT = idf[t] || 0;
                if (idfT === 0) continue;
                var num = f * (k1 + 1);
                var den = f + k1 * (1 - b + b * (dlen / avgDl));
                s += idfT * (num / den);
            }
            return s;
        },
        size: N,
    };
}

function bm25Rank(bm, queryText) {
    var qTokens = tokenize(queryText);
    if (qTokens.length === 0) return [];
    var scores = new Array(bm.size);
    for (var i = 0; i < bm.size; i++) scores[i] = { idx: i, s: bm.score(qTokens, i) };
    scores.sort(function(a, b) { return b.s - a.s; });
    var out = {};
    for (var r = 0; r < scores.length; r++) {
        if (scores[r].s <= 0) break;
        out[scores[r].idx] = r;     // rank, 0-indexed
    }
    return out;
}

// ─── Dense (cosine similarity over precomputed unit-norm-ish vectors) ───────

function dot(a, b) {
    var s = 0;
    var n = a.length;
    for (var i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

function norm(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s);
}

// Precompute norms once at load. Items built without embeddings (--no-embeddings
// mode) get _norm=0; the dense path then short-circuits and we run BM25-only.
function precomputeNorms(items) {
    for (var i = 0; i < items.length; i++) {
        items[i]._norm = items[i].embedding ? norm(items[i].embedding) : 0;
    }
}

function cosine(a, b, normA, normB) {
    if (normA === 0 || normB === 0) return 0;
    return dot(a, b) / (normA * normB);
}

function denseRank(items, queryEmbedding) {
    if (!queryEmbedding) return {};
    // If the corpus was built without embeddings, every _norm is 0 and there's
    // nothing to rank against — short-circuit so we don't pay an O(N) loop.
    if (!items.length || !items[0].embedding) return {};
    var qNorm = norm(queryEmbedding);
    var scores = new Array(items.length);
    for (var i = 0; i < items.length; i++) {
        scores[i] = { idx: i, s: cosine(queryEmbedding, items[i].embedding, qNorm, items[i]._norm) };
    }
    scores.sort(function(a, b) { return b.s - a.s; });
    var out = {};
    // Take top 200 — anything below that can't realistically beat a hit on the
    // BM25 side after RRF, and capping keeps the merge cheap.
    var max = Math.min(200, scores.length);
    for (var r = 0; r < max; r++) out[scores[r].idx] = r;
    return out;
}

// ─── Reciprocal-rank fusion ─────────────────────────────────────────────────

function rrfFuse(bmRanks, denseRanks, n) {
    var fused = new Array(n);
    for (var i = 0; i < n; i++) {
        var s = 0;
        if (bmRanks[i]    !== undefined) s += 1 / (RRF_K + bmRanks[i]);
        if (denseRanks[i] !== undefined) s += 1 / (RRF_K + denseRanks[i]);
        fused[i] = { idx: i, s: s };
    }
    fused.sort(function(a, b) { return b.s - a.s; });
    return fused;
}

// ─── Multiplicative ranking signals ─────────────────────────────────────────

function stageMatchMul(itemStage, queryStage) {
    if (!itemStage || !queryStage) return 1.0;     // unknown side → neutral
    if (itemStage === queryStage)  return 1.0;
    var order = ["awareness", "engagement", "nurture", "ask"];
    var qi = order.indexOf(queryStage);
    var ii = order.indexOf(itemStage);
    if (qi === -1 || ii === -1)    return 0.8;
    if (Math.abs(qi - ii) === 1)   return 0.7;     // adjacent stage
    return 0.4;
}

function intentMatchMul(itemIntent, queryIntent) {
    if (!itemIntent || !queryIntent) return 1.0;
    return itemIntent === queryIntent ? 1.0 : 0.7;
}

function dmStageMatchMul(itemDmStage, queryDmStage) {
    if (!queryDmStage) return 1.0;                  // caller didn't filter
    if (!itemDmStage)  return 0.6;
    if (itemDmStage === queryDmStage) return 1.0;
    return 0.4;                                     // hard-ish lock
}

// ─── Dedupe candidates whose embeddings are near-duplicates ─────────────────

function dedupe(candidates, items, threshold) {
    threshold = threshold == null ? 0.92 : threshold;
    var kept = [];
    for (var i = 0; i < candidates.length; i++) {
        var idx = candidates[i].idx;
        var emb = items[idx].embedding;
        var nrm = items[idx]._norm;
        var dup = false;
        if (emb) {
            for (var j = 0; j < kept.length; j++) {
                var other = items[kept[j].idx];
                if (other.embedding && cosine(emb, other.embedding, nrm, other._norm) > threshold) { dup = true; break; }
            }
        } else {
            // Embedding-less fallback: dedupe by exact assistant string match.
            var ast = items[idx].assistant;
            for (var j2 = 0; j2 < kept.length; j2++) {
                if (items[kept[j2].idx].assistant === ast) { dup = true; break; }
            }
        }
        if (!dup) kept.push(candidates[i]);
    }
    return kept;
}

// ─── Loading the indexes ────────────────────────────────────────────────────

function loadIndexFile(file) {
    if (!fs.existsSync(file)) {
        throw new Error("Index file missing: " + file + " — run `node rag/build_index.js` first");
    }
    var raw = fs.readFileSync(file, "utf8");
    var items = raw.split("\n")
        .filter(function(l) { return l.trim().length > 0; })
        .map(function(l) { return JSON.parse(l); });
    precomputeNorms(items);
    return items;
}

async function init() {
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async function() {
        var t0 = Date.now();
        indexes = {
            post:         loadIndexFile(path.join(INDEX_DIR, "post_replies.jsonl")),
            post_comment: loadIndexFile(path.join(INDEX_DIR, "post_comments.jsonl")),
            dm:           loadIndexFile(path.join(INDEX_DIR, "dm_turns.jsonl")),
        };
        bm25 = {
            post:         buildBM25(indexes.post),
            post_comment: buildBM25(indexes.post_comment),
            dm:           buildBM25(indexes.dm),
        };
        if (process.env.OPENAI_API_KEY) {
            openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        }
        initialized = true;
        console.log("[retriever] loaded " + indexes.post.length + " posts, " +
            indexes.post_comment.length + " comments, " + indexes.dm.length +
            " DMs in " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    })();
    return initPromise;
}

// ─── Query embedding (live, with cheap LRU on the exact text) ───────────────

var queryEmbedCache = new Map();
var QUERY_CACHE_MAX = 256;

async function embedQuery(text) {
    if (!text || !text.trim()) return null;
    var key = text.length > 4000 ? text.substring(0, 4000) : text;
    if (queryEmbedCache.has(key)) return queryEmbedCache.get(key);
    if (!openai) return null;
    try {
        var resp = await openai.embeddings.create({ model: EMBED_MODEL, input: key });
        var vec = resp.data[0].embedding;
        queryEmbedCache.set(key, vec);
        if (queryEmbedCache.size > QUERY_CACHE_MAX) {
            // Drop oldest
            var firstKey = queryEmbedCache.keys().next().value;
            queryEmbedCache.delete(firstKey);
        }
        return vec;
    } catch (err) {
        console.warn("[retriever] embed query failed: " + err.message);
        return null;
    }
}

// ─── Generic hybrid retrieve, then post-rank ────────────────────────────────

async function hybridRetrieve(corpusName, queryText, opts) {
    opts = opts || {};
    var k = opts.k || 4;
    var items = indexes[corpusName];
    var bm = bm25[corpusName];

    var bmRanks    = bm25Rank(bm, queryText);
    var queryEmb   = await embedQuery(queryText);
    var denseRanks = denseRank(items, queryEmb);
    var fused      = rrfFuse(bmRanks, denseRanks, items.length);

    // Apply multiplicative signals
    for (var i = 0; i < fused.length; i++) {
        var it = items[fused[i].idx];
        var mul = (it.outcome_score || 1.0)
            * stageMatchMul(it.tags && it.tags.stage,    opts.stage)
            * intentMatchMul(it.tags && it.tags.intent,  opts.intent)
            * dmStageMatchMul(it.dm_stage,               opts.dmStage);
        fused[i].finalScore = fused[i].s * mul;
        fused[i].mul = mul;
    }
    fused.sort(function(a, b) { return b.finalScore - a.finalScore; });

    // Cap candidate pool before dedupe to keep things bounded
    var pool = fused.slice(0, Math.min(40, fused.length));
    var deduped = dedupe(pool, items);

    var top = deduped.slice(0, k).map(function(c) {
        var it = items[c.idx];
        return {
            id:           it.id,
            query_text:   it.query_text,
            assistant:    it.assistant,
            dm_stage:     it.dm_stage,
            tags:         it.tags,
            person:       it.person,
            score:        c.finalScore,
            breakdown:    { rrf: c.s, mul: c.mul },
        };
    });
    return top;
}

// ─── Public API ─────────────────────────────────────────────────────────────

async function retrievePostReply(args) {
    args = args || {};
    try {
        await init();
        var post = args.post || {};
        var query = [post.title, post.body].filter(Boolean).join("\n\n");
        if (!query.trim()) return [];
        return await hybridRetrieve("post", query, {
            k:       args.k || 3,
            intent:  args.intent  || null,
            stage:   args.stage   || null,
        });
    } catch (err) {
        console.warn("[retriever] retrievePostReply failed: " + err.message);
        return [];
    }
}

async function retrievePostComment(args) {
    args = args || {};
    try {
        await init();
        var commentText = (args.comment && args.comment.text) || args.commentText || "";
        if (!commentText.trim()) return [];
        return await hybridRetrieve("post_comment", commentText, {
            k:       args.k || 3,
            intent:  args.intent  || null,
            stage:   args.stage   || null,
        });
    } catch (err) {
        console.warn("[retriever] retrievePostComment failed: " + err.message);
        return [];
    }
}

async function retrieveDmTurn(args) {
    args = args || {};
    try {
        await init();
        // Build query from the last 1-3 turns of the conversation: heavily
        // weight the most recent partner message (that's the one Scott is
        // about to answer), but include 1-2 turns of context above.
        var turns = Array.isArray(args.recentTurns) ? args.recentTurns : [];
        if (turns.length === 0 && args.partnerLastMessage) {
            turns = [{ role: "partner", text: args.partnerLastMessage }];
        }
        if (turns.length === 0) return [];

        var query = turns.slice(-3).map(function(t) {
            var who = t.role === "partner" ? "Partner" : "Bot";
            return who + ": " + (t.text || "");
        }).join("\n");

        return await hybridRetrieve("dm", query, {
            k:       args.k || 4,
            stage:   args.stage   || null,
            intent:  args.intent  || null,
            dmStage: args.dmStage || null,
        });
    } catch (err) {
        console.warn("[retriever] retrieveDmTurn failed: " + err.message);
        return [];
    }
}

// ─── Format examples for injection into a system prompt ─────────────────────
// Mirrors the v13 user-prompt shape so the model sees retrieved examples in
// exactly the structure it was fine-tuned on.

function formatExamplesForPrompt(examples) {
    if (!examples || examples.length === 0) return "";
    var lines = ["--- EXAMPLES OF SCOTT/JACK IN THIS EXACT MOMENT ---", ""];
    for (var i = 0; i < examples.length; i++) {
        var ex = examples[i];
        lines.push("EXAMPLE " + (i + 1) + ":");
        lines.push(ex.query_text);
        lines.push("→ Reply: " + ex.assistant);
        lines.push("");
    }
    lines.push("--- END EXAMPLES ---");
    return lines.join("\n");
}

module.exports = {
    init:                  init,
    retrievePostReply:     retrievePostReply,
    retrievePostComment:   retrievePostComment,
    retrieveDmTurn:        retrieveDmTurn,
    formatExamplesForPrompt: formatExamplesForPrompt,
    // Exposed for debugging only:
    _internal:             { tokenize: tokenize, hybridRetrieve: hybridRetrieve },
};
