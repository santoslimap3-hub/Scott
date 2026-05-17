// =============================================================================
// agentic/rag_picker.js
//
// Inner LLM call that picks 3-5 of Scott's actual past replies as few-shot
// examples for the value-commenter writer. Workflow:
//
//   1. Load data/scott_threads.json once (lazy + cached). Flatten it into a
//      pool of { id, context, scott_reply, tags } examples (one per actual
//      Scott reply).
//   2. Pre-filter the pool to ~POOL_SIZE candidates by cheap token-overlap
//      ranking against the current post/comment we are about to reply to.
//      This keeps the LLM picker prompt small.
//   3. Call a small "rag_picker" LLM (Haiku by default) with the candidates
//      and the current target. Use Anthropic tool-use to force the model to
//      return { chosen_ids: [...] }.
//   4. Format the chosen examples into a block of few-shot prompt text that
//      the writer prepends to its user message.
//
// The picker call is wrapped so a failure NEVER blocks the writer -- on any
// error we just return an empty examples block and the writer behaves as
// before.
// =============================================================================

"use strict";

const fs   = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const DATA_FILE  = path.join(__dirname, "..", "..", "data", "scott_threads.json");
const POOL_SIZE  = parseInt(process.env.RAG_POOL_SIZE  || "15", 10);  // pre-filter size
const PICK_TARGET = parseInt(process.env.RAG_PICK_K     || "4",  10); // final picks (3-5 range)
const PICKER_MODEL = process.env.RAG_PICKER_MODEL || "claude-haiku-4-5";

var anthropic = null;
function getClient() {
    if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropic;
}

// Stop words ripped from the existing /rag retriever; same list keeps behaviour
// consistent across the codebase.
const STOP_WORDS = new Set("the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us are was has had been did got too very much really thing".split(/\s+/));

function tokenize(text) {
    return (text || "").toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(function(w) { return w.length > 2 && !STOP_WORDS.has(w); });
}

// Truncate a string without ever splitting a UTF-16 surrogate pair.
// JS String.prototype.substring() operates on UTF-16 code units, so cutting at
// a fixed length can leave a lone high surrogate when the boundary sits inside
// an emoji's surrogate pair. That produces a malformed UTF-16 string which
// JSON.stringify will then serialize into something the Anthropic API rejects
// with "no low surrogate in string". Also strips any pre-existing orphan
// surrogates anywhere in the result, for belt-and-braces.
function safeTruncate(s, n) {
    if (typeof s !== "string") return "";
    var out = s.length > n ? s.substring(0, n) : s;
    var lastCode = out.length > 0 ? out.charCodeAt(out.length - 1) : 0;
    if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
        out = out.substring(0, out.length - 1);
    }
    return scrubOrphanSurrogates(out);
}

function scrubOrphanSurrogates(s) {
    if (typeof s !== "string" || s.length === 0) return s || "";
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) {
            var next = (i + 1 < s.length) ? s.charCodeAt(i + 1) : 0;
            if (next >= 0xDC00 && next <= 0xDFFF) {
                out += s.charAt(i) + s.charAt(i + 1);
                i++;
            }
            // else: orphan high surrogate -- drop it
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
            // orphan low surrogate -- drop it
        } else {
            out += s.charAt(i);
        }
    }
    return out;
}

function normalizeAuthor(s) {
    return (s || "")
        .replace(/ /g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isScott(authorRaw) {
    var a = normalizeAuthor(authorRaw).toLowerCase();
    return a.indexOf("scott") === 0;   // covers "Scott Northwolf"
}

// ---- Build example pool (cached) --------------------------------------------

var POOL = null;          // [{ id, context, scott_reply, tags, tokens, from_sin }]
var POOL_LOAD_ERR = null;

function loadPool() {
    if (POOL || POOL_LOAD_ERR) return;
    try {
        var raw = fs.readFileSync(DATA_FILE, "utf8");
        var threads = JSON.parse(raw);
        var examples = [];
        var counter = 0;
        var sinCount = 0;
        var extCount = 0;
        for (var i = 0; i < threads.length; i++) {
            var thread = threads[i];
            if (!Array.isArray(thread) || thread.length === 0) continue;

            // The first item is the parent post; subsequent items alternate
            // between non-Scott comments/replies and Scott replies.
            var post = thread[0] && thread[0].type === "post" ? thread[0] : null;
            var postAuthor = (post && post.author) || "";
            var postTitle  = (post && post.title)  || "";
            var postText   = (post && post.text)   || "";

            // Community detection: if Scott himself authored the parent post,
            // the thread lives inside his own community (Self-Improvement
            // Nation). Threads where someone else owns the post are from
            // external Skool communities. We tag each Scott reply with which
            // side it came from so the caller can filter examples to match
            // the community the bot is currently engaging in.
            var fromSin = isScott(postAuthor);

            // Walk the thread, pairing each Scott reply with the immediately
            // preceding non-Scott message (the comment Scott is replying to).
            var lastNonScott = null;
            for (var j = 0; j < thread.length; j++) {
                var item = thread[j];
                if (!item || item.type === "post") continue;
                if (isScott(item.author)) {
                    if (!lastNonScott) continue; // no inbound message to anchor on -- skip
                    counter += 1;
                    var ctx =
                        "Post title: " + safeTruncate(postTitle, 200) + "\n" +
                        "Post author: " + normalizeAuthor(postAuthor) + "\n" +
                        "Post body:  " + safeTruncate(postText, 400) + "\n" +
                        "Comment by " + normalizeAuthor(lastNonScott.author) + ":\n" +
                        safeTruncate(lastNonScott.text || "", 600);
                    var reply = scrubOrphanSurrogates((item.text || "").trim());
                    if (!reply) continue;
                    examples.push({
                        id:          "rag_" + counter,
                        context:     scrubOrphanSurrogates(ctx),
                        scott_reply: reply,
                        tags:        item.tags || null,
                        from_sin:    fromSin,
                        tokens:      tokenize(ctx + " " + reply),
                    });
                    if (fromSin) sinCount++; else extCount++;
                } else {
                    lastNonScott = item;
                }
            }
        }
        POOL = examples;
        console.log("[rag_picker] loaded " + POOL.length + " Scott-reply examples from " + DATA_FILE +
            "  (SIN: " + sinCount + ", external: " + extCount + ")");
    } catch (e) {
        POOL_LOAD_ERR = e;
        console.warn("[rag_picker] failed to load " + DATA_FILE + ": " + e.message + " (RAG disabled)");
    }
}

// ---- Pre-filter --------------------------------------------------------------
// Score = number of distinct query tokens that occur in the example's tokens.
// Cheap, deterministic, plenty good for ~300 examples.

function preFilter(queryText, n, opts) {
    opts = opts || {};
    if (!POOL || POOL.length === 0) return [];
    var qSet = new Set(tokenize(queryText));
    if (qSet.size === 0) return [];

    // Community filter: examples must come from the SAME side as where the
    // bot is currently engaging. Outside SIN -> only external examples;
    // inside SIN -> only SIN examples. If `inSin` is undefined we fall back
    // to "outside SIN" since the bot's current deployment runs in external
    // communities (Imperium Academy / Synthesizer).
    var inSin = (opts.inSin === true);

    var scored = [];
    var matchedCommunity = 0;
    for (var i = 0; i < POOL.length; i++) {
        var ex = POOL[i];
        if (ex.from_sin !== inSin) continue;  // strict community match
        matchedCommunity++;

        var hits = 0;
        var seen = new Set();
        for (var j = 0; j < ex.tokens.length; j++) {
            var t = ex.tokens[j];
            if (seen.has(t)) continue;
            seen.add(t);
            if (qSet.has(t)) hits++;
        }
        if (hits === 0) continue;
        scored.push({ ex: ex, s: hits });
    }
    if (matchedCommunity === 0) {
        console.warn("[rag_picker] no examples available for community side inSin=" + inSin + " -- skipping few-shots.");
    }
    scored.sort(function(a, b) { return b.s - a.s; });
    return scored.slice(0, n).map(function(o) { return o.ex; });
}

// ---- Inner LLM picker call --------------------------------------------------

async function llmPickBest(queryText, candidates, k) {
    if (!candidates || candidates.length === 0) return [];
    if (!process.env.ANTHROPIC_API_KEY) return candidates.slice(0, k);

    var ids = candidates.map(function(c) { return c.id; });
    var tool = {
        name: "submit_chosen",
        description: "Return the ids of the 3-5 Scott reply examples that best match the current target. The chosen examples will be used as few-shots to teach the writer Scott's voice for THIS specific situation.",
        input_schema: {
            type: "object",
            properties: {
                chosen_ids: {
                    type:  "array",
                    items: { type: "string", enum: ids },
                    minItems: 1,
                    maxItems: 5,
                },
            },
            required: ["chosen_ids"],
            additionalProperties: false,
        },
    };

    var system =
        "You select few-shot examples for an AI that writes replies in the voice of Scott Northwolf. " +
        "You will be given (a) the situation we need a reply for, and (b) a numbered list of Scott's actual past replies " +
        "and the contexts they were given in. " +
        "Pick the 3-5 examples whose CONTEXT most resembles the current situation (same topic, similar awareness level, " +
        "similar sentiment from the commenter, similar length expectation). Diverse picks beat near-duplicates. " +
        "Always pick at least 3 unless the candidate pool has fewer than 3 good fits.";

    var lines = [];
    lines.push("=== CURRENT SITUATION (we need to reply to this) ===");
    lines.push(queryText);
    lines.push("");
    lines.push("=== CANDIDATE SCOTT REPLY EXAMPLES (pick 3-5) ===");
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        lines.push("");
        lines.push("[" + c.id + "]");
        lines.push("CONTEXT:");
        lines.push(c.context);
        lines.push("SCOTT REPLIED:");
        lines.push(c.scott_reply);
    }

    var labelMeta = "rag_picker (" + candidates.length + " candidates -> " + k + " picks)";

    try {
        // Manually log via run_logger -- we can't use callPicker here without
        // creating a circular dep with anthropic_client.js.
        var run_logger = require("./run_logger");
        var startedAt = Date.now();

        var system_log = scrubOrphanSurrogates(system);
        var user_log   = scrubOrphanSurrogates(lines.join("\n"));

        var safeSystem = scrubOrphanSurrogates(system);
        var safeUser   = scrubOrphanSurrogates(lines.join("\n"));
        var resp = await getClient().messages.create({
            model:       PICKER_MODEL,
            max_tokens:  512,
            system:      safeSystem,
            tools:       [tool],
            tool_choice: { type: "tool", name: "submit_chosen" },
            messages:    [{ role: "user", content: safeUser }],
        });

        var toolUse = (resp.content || []).find(function(b) { return b.type === "tool_use" && b.name === "submit_chosen"; });
        var chosen  = (toolUse && Array.isArray(toolUse.input && toolUse.input.chosen_ids))
            ? toolUse.input.chosen_ids : [];

        try {
            run_logger.recordCall({
                label:     labelMeta,
                model:     PICKER_MODEL,
                kind:      "picker",
                phase:     "RAG",
                system:    system_log,
                user:      user_log,
                response:  { chosen_ids: chosen, stop_reason: resp.stop_reason, usage: resp.usage },
                durationMs: Date.now() - startedAt,
            });
        } catch (_) {}

        // Map back to example objects (preserve picker order, validate ids).
        var byId = {};
        candidates.forEach(function(c) { byId[c.id] = c; });
        var out = chosen.map(function(id) { return byId[id]; }).filter(Boolean);
        if (out.length === 0) out = candidates.slice(0, k);  // fallback: take top pre-filtered
        return out.slice(0, k);
    } catch (e) {
        console.warn("[rag_picker] LLM pick failed -- falling back to top-" + k + " pre-filtered: " + e.message);
        return candidates.slice(0, k);
    }
}

// ---- Public: get examples block for a given target --------------------------

async function getExamplesBlock(targetText, opts) {
    opts = opts || {};
    var k = opts.k || PICK_TARGET;
    if (k < 1) return "";

    loadPool();
    if (!POOL || POOL.length === 0) return "";

    var inSin = (opts.inSin === true);
    var pool  = preFilter(targetText, POOL_SIZE, { inSin: inSin });
    if (pool.length === 0) {
        console.log("[rag_picker] no token-overlap candidates for inSin=" + inSin + " -- skipping few-shots.");
        return "";
    }

    var picks = await llmPickBest(targetText, pool, k);
    if (!picks || picks.length === 0) return "";

    var communityNote = inSin
        ? "(These examples are all from Scott's OWN community, Self-Improvement Nation, the same context this reply is for.)"
        : "(These examples are all from Scott replying in OTHER people's communities, the same context this reply is for.)";

    var lines = [
        "--- EXAMPLES OF SCOTT'S ACTUAL REPLIES IN SIMILAR SITUATIONS ---",
        "(Use these to match Scott's voice, length, and tempo. Do NOT copy them verbatim.)",
        communityNote,
        "",
    ];
    for (var i = 0; i < picks.length; i++) {
        var p = picks[i];
        lines.push("EXAMPLE " + (i + 1) + ":");
        lines.push(p.context);
        lines.push("Scott's actual reply:");
        lines.push(p.scott_reply);
        lines.push("");
    }
    lines.push("--- END EXAMPLES ---");
    return lines.join("\n");
}

module.exports = {
    getExamplesBlock,
    // Shared util -- callers building prompts that may include emoji-bearing
    // user text should run their truncations through these to avoid the
    // "no low surrogate in string" 400 from the Anthropic API.
    safeTruncate:          safeTruncate,
    scrubOrphanSurrogates: scrubOrphanSurrogates,
    // For tests / debugging:
    _internal: { loadPool, preFilter, llmPickBest, tokenize },
};
