// =============================================================================
// agentic/anthropic_client.js
//
// Thin wrapper around @anthropic-ai/sdk with verbose terminal logging.
//
//   callPicker  -> forces a structured { chosen_ids: [...] } response via
//                  Anthropic tool-use, so we never have to parse free-text JSON
//   callWriter  -> returns the assistant's plain text reply
//
// Both functions print the FULL system prompt, FULL user prompt, and FULL
// response to stdout so you can see exactly what the model was given and what
// it returned.
// =============================================================================

"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const run_logger = require("./run_logger");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Defensive scrub for lone UTF-16 surrogates. Skool post/comment text often
// contains emojis, and any code path that truncates with .substring() can
// leave a lone high or low surrogate at the cut boundary. The Anthropic API
// rejects such bodies with: 400 invalid_request_error "no low surrogate in
// string". We strip orphans right before the request leaves the process so
// no upstream caller has to remember to do it.
function scrubSurrogates(s) {
    if (typeof s !== "string" || s.length === 0) return s == null ? "" : s;
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

// Light convenience: derive the phase from the picker/writer label so the
// dashboard can group calls without callers having to pass an explicit phase.
function derivePhase(label) {
    if (!label) return "?";
    var l = String(label).toLowerCase();
    if (l.indexOf("notif")          !== -1) return "A";
    if (l.indexOf("value_picker")   !== -1) return "B";
    if (l.indexOf("value_commenter")!== -1) return "B";
    if (l.indexOf("rag")            !== -1) return "RAG";
    return "?";
}

// ---- Logging ---------------------------------------------------------------

function bar(char, n) {
    return new Array((n || 78) + 1).join(char || "=");
}

function logCall(label, model, system, user) {
    console.log("\n" + bar("=") + "\n[ANTHROPIC CALL] " + label + "  (model: " + model + ")\n" + bar("="));
    console.log("[SYSTEM PROMPT]");
    console.log(system);
    console.log("\n" + bar("-"));
    console.log("[USER PROMPT]");
    console.log(user);
    console.log(bar("="));
}

function logResponse(label, payload) {
    console.log("\n" + bar("-"));
    console.log("[ANTHROPIC RESPONSE] " + label);
    console.log(bar("-"));
    if (typeof payload === "string") {
        console.log(payload);
    } else {
        console.log(JSON.stringify(payload, null, 2));
    }
    console.log(bar("=") + "\n");
}

// ---- Picker ----------------------------------------------------------------
//
// Returns a parsed { chosen_ids: string[] } object guaranteed to be a subset
// of `candidateIds`. Uses Anthropic tool-use to force the structured output;
// the model is required to call the `submit_chosen` tool.
//
// `candidateIds` MUST be the exact set of valid ids you want the model to pick
// from. We pass it as a string[] enum on the schema so any out-of-set id from
// the model is rejected client-side.

async function callPicker(opts) {
    var label    = opts.label || "picker";
    var model    = opts.model;
    var system   = scrubSurrogates(opts.system);
    var user     = scrubSurrogates(opts.user);
    var ids      = Array.isArray(opts.candidateIds) ? opts.candidateIds : [];

    logCall(label, model, system, user);

    if (ids.length === 0) {
        console.log("[picker] No candidates supplied -- skipping LLM call, returning empty pick.\n");
        try {
            run_logger.recordCall({
                label:    label,
                model:    model,
                kind:     "picker",
                phase:    derivePhase(label),
                system:   system,
                user:     user,
                response: { chosen_ids: [], note: "no candidates supplied" },
                durationMs: 0,
            });
        } catch (_) {}
        return { chosen_ids: [] };
    }
    var __startedAt = Date.now();

    var tool = {
        name: "submit_chosen",
        description: "Return the IDs of the items you chose to act on. Pass an empty array if none of them are worth acting on.",
        input_schema: {
            type: "object",
            properties: {
                chosen_ids: {
                    type:  "array",
                    items: { type: "string", enum: ids },
                    description: "Subset of candidate ids you chose. Empty array = pick nothing."
                }
            },
            required: ["chosen_ids"],
            additionalProperties: false
        }
    };

    var resp = await client.messages.create({
        model:       model,
        max_tokens:  1024,
        system:      system,
        tools:       [tool],
        tool_choice: { type: "tool", name: "submit_chosen" },
        messages:    [{ role: "user", content: user }],
    });

    var toolUse = (resp.content || []).find(function(b) { return b.type === "tool_use" && b.name === "submit_chosen"; });
    if (!toolUse) {
        logResponse(label, resp);
        throw new Error("Picker did not return a tool_use block");
    }

    var raw = toolUse.input || {};
    var chosen = Array.isArray(raw.chosen_ids) ? raw.chosen_ids : [];

    // Defence in depth: drop anything not in the original candidate set.
    var idSet = {};
    ids.forEach(function(id) { idSet[id] = true; });
    var validated = chosen.filter(function(id) { return idSet[id]; });
    var dropped   = chosen.filter(function(id) { return !idSet[id]; });

    logResponse(label, {
        raw_chosen:        chosen,
        validated_chosen:  validated,
        dropped_unknown:   dropped,
        stop_reason:       resp.stop_reason,
        usage:             resp.usage,
    });

    try {
        run_logger.recordCall({
            label:    label,
            model:    model,
            kind:     "picker",
            phase:    derivePhase(label),
            system:   system,
            user:     user,
            response: {
                raw_chosen:        chosen,
                validated_chosen:  validated,
                dropped_unknown:   dropped,
                stop_reason:       resp.stop_reason,
                usage:             resp.usage,
            },
            durationMs: Date.now() - __startedAt,
        });
    } catch (_) {}

    return { chosen_ids: validated };
}

// ---- Writer ----------------------------------------------------------------
//
// Returns the assistant's plain text content (concatenated text blocks).

async function callWriter(opts) {
    var label  = opts.label || "writer";
    var model  = opts.model;
    var system = scrubSurrogates(opts.system);
    var user   = scrubSurrogates(opts.user);
    var maxTok = opts.maxTokens || 400;

    logCall(label, model, system, user);
    var __wStartedAt = Date.now();

    var resp = await client.messages.create({
        model:      model,
        max_tokens: maxTok,
        system:     system,
        messages:   [{ role: "user", content: user }],
    });

    var text = (resp.content || [])
        .filter(function(b) { return b.type === "text"; })
        .map(function(b) { return b.text || ""; })
        .join("")
        .trim();

    logResponse(label, text);

    try {
        run_logger.recordCall({
            label:    label,
            model:    model,
            kind:     "writer",
            phase:    derivePhase(label),
            system:   system,
            user:     user,
            response: text,
            durationMs: Date.now() - __wStartedAt,
        });
    } catch (_) {}

    return text;
}

module.exports = { callPicker, callWriter };
