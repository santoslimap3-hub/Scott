/**
 * tool_scripts/autotag_untagged.js
 *
 * Auto-tags the 121 untagged post/comment examples in finetune_data_v10.jsonl.
 *
 * What it does:
 *   1. Reads finetune_data_v10.jsonl line by line
 *   2. Passes through all DM examples and already-tagged post/comment examples unchanged
 *   3. For each untagged post/comment example (SITUATION: Replying to a Skool post, no STAGE:):
 *      - Extracts post title, reply-to text, history context, and Scott's actual reply
 *      - Calls opus-4.7 to classify STAGE / INTENT / TONE
 *      - Injects the tags into the system prompt before the SITUATION: line
 *   4. Writes finetune_data_v11.jsonl (full dataset, 3130 examples)
 *   5. Writes autotag_audit_log.json (121 entries for human spot-check)
 *
 * HOW TO RUN (from your machine, not Claude's sandbox):
 *
 *   1. Delete the bad finetune_data_v11.jsonl if it already exists:
 *        del data\fine_tune\finetune_data_v11.jsonl
 *
 *   2. Run from the project root (where bot/ and data/ live):
 *        node tool_scripts/autotag_untagged.js
 *
 *      Or if openai module isn't found, run it from bot/:
 *        cd bot && node ../tool_scripts/autotag_untagged.js
 *
 * Requires:
 *   - bot/.env with OPENAI_API_KEY (loaded automatically)
 *   - openai npm package (already installed in bot/node_modules/)
 *
 * Output:
 *   - data/fine_tune/finetune_data_v11.jsonl   (3130 examples, all tagged)
 *   - tool_scripts/autotag_audit_log.json      (121 entries for spot-check)
 */

const fs    = require("fs");
const path  = require("path");
const readline = require("readline");

// Load modules directly from bot/node_modules — works regardless of Node version
const BOT_MODULES = path.join(__dirname, "../bot/node_modules");
const OpenAI = require(path.join(BOT_MODULES, "openai"));
require(path.join(BOT_MODULES, "dotenv")).config({ path: path.join(__dirname, "../bot/.env") });

// ─── Paths ────────────────────────────────────────────────────────────────────

const INPUT_PATH  = path.join(__dirname, "../data/fine_tune/finetune_data_v10.jsonl");
const OUTPUT_PATH = path.join(__dirname, "../data/fine_tune/finetune_data_v11.jsonl");
const AUDIT_PATH  = path.join(__dirname, "autotag_audit_log.json");

// ─── Tag definitions (mirrors bot/classify/tags.js) ─────────────────────────
// Kept inline so this script has zero dependencies on bot/classify/

const VALID_TONES = [
    "hype", "brotherhood", "motivational", "authority", "direct", "casual",
    "self-aggrandization", "teasing-future-value", "praise", "humor",
    "empathy", "storytelling", "vulnerability", "tough-love", "mystery-teasing",
    "chit-chat", "bonding-rapport", "gratitude", "curiosity",
];
const VALID_INTENTS = [
    "acknowledgement", "engagement-nurture", "community-building",
    "authority-proofing", "value-delivery", "close-to-call", "social-proof",
    "redirect", "info-gathering", "lead-qualification", "pain-agitation",
    "objection-handling", "funneling",
];
const VALID_STAGES = ["awareness", "engagement", "nurture", "ask"];

const FALLBACK = {
    tone_tags:   ["brotherhood", "motivational"],
    intent:      "engagement-nurture",
    sales_stage: "nurture",
    reasoning:   "fallback — classifier error",
    confidence:  "low",
};

// ─── Classifier system prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `Classify a Skool post/comment reply by Scott Northwolf (appointment setter persona Jack Walford).

Given:
  - The post/community context (history with comments)
  - The specific message being replied to
  - Scott's ACTUAL reply (most important signal — infer tone/intent from what he wrote)

Return JSON only. No markdown.

TONE (pick 1-4):
hype=max energy ALL CAPS peaks | brotherhood=raw male loyalty bro/king | motivational=push them forward | authority=expert certainty | direct=no fluff point first | casual=friend-texting low key | self-aggrandization=reference own wins | teasing-future-value=hint at something big FOMO | praise=specific recognition | humor=light joke never mean | empathy=brief acknowledgement then pivot | storytelling=short personal anecdote | vulnerability=briefly reveal own struggle | tough-love=honest even if it stings | mystery-teasing=intrigue around Scott's methods | chit-chat=pure social no agenda | bonding-rapport=shared experience | gratitude=genuine thanks | curiosity=ask because you want to know

INTENT (pick 1):
acknowledgement=short reaction no agenda | engagement-nurture=keep conversation alive feel seen | community-building=reinforce SIN identity/culture | authority-proofing=demonstrate expertise passively | value-delivery=one actionable insight or framework | close-to-call=invite call/DM only if buying signal | social-proof=highlight win or transformation | redirect=steer toward Scott's offer smoothly | info-gathering=question to learn their situation | lead-qualification=probe if they're a coach who could buy | pain-agitation=amplify their problem make solution urgent | objection-handling=flip doubt into reason to move forward | funneling=point to Scott's community/program

STAGE (pick 1):
awareness=new first impression no selling | engagement=active but not warm deepen relationship | nurture=warm trusts Scott stay top of mind | ask=buying signal move toward call

EXAMPLES:
"We have our very own website now!" → comment: "BROOO LETS FUCKIN GOOOO!!" → reply: "@Kai Cerar 🔥" → {"tone_tags":["brotherhood","hype"],"intent":"acknowledgement","sales_stage":"nurture","reasoning":"fire emoji reaction to hype","confidence":"high"}
"Say hello to the gang" → comment: "I'm trying to get into self improvement after my divorce..." → reply: "@Joyce Fortuna that's wonderful, Joyce, this is a very brave step..." → {"tone_tags":["empathy","vulnerability","motivational"],"intent":"engagement-nurture","sales_stage":"nurture","reasoning":"empathetic welcome to new vulnerable member","confidence":"high"}
"Brotherhood and connection" → comment: "The things that get me most energized: God and spirituality, real brotherhood, becoming financially free." → reply: "@Sajjad Bablu amazing, brother! I love the topics. Let's jump on a call to talk about it." → {"tone_tags":["hype","brotherhood","teasing-future-value"],"intent":"close-to-call","sales_stage":"ask","reasoning":"clear buying signal — spirituality and financial freedom align with offer","confidence":"high"}
"Does anyone know how to become ambitious?" → reply: "@Brandon Maloney the actionable steps are broken down in a lot more detail in my community, you might want to check that out later, bro." → {"tone_tags":["casual"],"intent":"funneling","sales_stage":"engagement","reasoning":"casual redirect to community resources","confidence":"high"}

Output format:
{"tone_tags":[...],"intent":"...","sales_stage":"...","reasoning":"one sentence","confidence":"high"|"medium"|"low"}`;

// ─── Parser helpers ───────────────────────────────────────────────────────────

/**
 * Extract the post title from the HISTORY block.
 * Looks for: [COMMENT ... on "TITLE"] or [COMMENT ... on "TITLE"]
 */
function extractPostTitle(historyText) {
    var match = historyText.match(/\[COMMENT[^\]]*on\s+"([^"]+)"\]/);
    return match ? match[1] : null;
}

/**
 * Extract the REPLY TO block content from the user message.
 */
function extractReplyTo(userContent) {
    var match = userContent.match(/---\s*REPLY TO\s*---\s*([\s\S]*?)(?:$|---)/);
    if (!match) return null;
    // Clean the [COMMENT] or [DM] prefix if present
    var text = match[1].trim();
    // Remove the source tag: "[COMMENT] Author: " or "[DM] Author: "
    text = text.replace(/^\[(?:COMMENT|DM)\][^\n]*:\s*/m, "").trim();
    return text;
}

/**
 * Extract HISTORY context — last 3-4 comment/DM messages for context.
 * Returns a condensed string.
 */
function extractHistoryContext(userContent) {
    var histMatch = userContent.match(/---\s*HISTORY\s*---\s*([\s\S]*?)(?:---\s*REPLY TO|$)/);
    if (!histMatch) return "";
    var history = histMatch[1].trim();
    // Take last 600 chars of history (enough context, keeps tokens low)
    if (history.length > 600) {
        history = "..." + history.slice(-600);
    }
    return history;
}

/**
 * Extract the PERSON block (Name, Gender, Role).
 */
function extractPerson(userContent) {
    var nameMatch   = userContent.match(/Name:\s*(.+)/);
    var genderMatch = userContent.match(/Gender:\s*(.+)/);
    var roleMatch   = userContent.match(/Role:\s*(.+)/);
    return {
        name:   nameMatch   ? nameMatch[1].trim()   : "Unknown",
        gender: genderMatch ? genderMatch[1].trim() : "unknown",
        role:   roleMatch   ? roleMatch[1].trim()   : "unknown",
    };
}

// ─── Classifier call ──────────────────────────────────────────────────────────

async function classifyExample(userContent, scottReply, openai) {
    var person       = extractPerson(userContent);
    var postTitle    = extractPostTitle(userContent) || "(unknown post)";
    var replyToText  = extractReplyTo(userContent) || "(no reply-to block)";
    var historyCtx   = extractHistoryContext(userContent);

    var userPrompt = [
        "POST TITLE: \"" + postTitle + "\"",
        "",
        "HISTORY CONTEXT (recent messages):",
        historyCtx,
        "",
        "--- REPLY TO ---",
        replyToText.substring(0, 400),
        "",
        "--- SCOTT'S REPLY (classify THIS) ---",
        scottReply.substring(0, 400),
        "",
        "Output JSON only.",
    ].join("\n");

    try {
        var model = process.env.CLASSIFIER_MODEL || "opus-4.7";
        var completion = await openai.chat.completions.create({
            model:       model,
            max_tokens:  200,
            temperature: 0.2,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user",   content: userPrompt },
            ],
        });

        var raw = completion.choices[0].message.content.trim();
        // Strip markdown fences if present
        var fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) raw = fenceMatch[1].trim();

        var parsed = JSON.parse(raw);

        // Validate and sanitize
        var toneTags = (parsed.tone_tags || []).filter(function(t) { return VALID_TONES.includes(t); });
        if (toneTags.length === 0) toneTags = FALLBACK.tone_tags;

        var intent     = VALID_INTENTS.includes(parsed.intent)      ? parsed.intent      : FALLBACK.intent;
        var salesStage = VALID_STAGES.includes(parsed.sales_stage)  ? parsed.sales_stage : FALLBACK.sales_stage;
        var reasoning  = (parsed.reasoning  || "").substring(0, 200);
        var confidence = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium";

        return { tone_tags: toneTags, intent: intent, sales_stage: salesStage, reasoning: reasoning, confidence: confidence };

    } catch (err) {
        console.error("  ⚠️  Classifier error: " + err.message);
        return FALLBACK;
    }
}

// ─── System prompt tag injection ─────────────────────────────────────────────

/**
 * Injects STAGE / INTENT / TONE lines before the SITUATION: line.
 * Input:  "...previous content...\nSITUATION: Replying to a Skool post comment."
 * Output: "...previous content...\nSTAGE: nurture\nINTENT: engagement-nurture\nTONE: hype, brotherhood\nSITUATION: ..."
 */
function injectTags(systemContent, tags) {
    var tagBlock = [
        "STAGE: "  + tags.sales_stage,
        "INTENT: " + tags.intent,
        "TONE: "   + tags.tone_tags.join(", "),
    ].join("\n");

    // Insert right before SITUATION:
    return systemContent.replace(/(SITUATION:)/, tagBlock + "\n$1");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!process.env.OPENAI_API_KEY) {
        console.error("❌  OPENAI_API_KEY not found. Make sure bot/.env is present.");
        process.exit(1);
    }

    // Guard: refuse to overwrite an existing v11 that already has STAGE tags
    // (i.e. a good run). Delete the file manually if you want to re-run.
    if (fs.existsSync(OUTPUT_PATH)) {
        // Peek at first line — if it has a real STAGE tag (not from fallback), warn.
        var firstLine = fs.readFileSync(OUTPUT_PATH, "utf8").split("\n")[0];
        try {
            var firstObj = JSON.parse(firstLine);
            var firstSys = firstObj.messages[0].content;
            if (firstSys.includes("STAGE:")) {
                console.error("⚠️   " + OUTPUT_PATH + " already exists and appears to have valid tags.");
                console.error("     Delete it first if you want to re-run:");
                console.error("       del data\\fine_tune\\finetune_data_v11.jsonl");
                process.exit(1);
            }
        } catch(e) { /* non-fatal — continue */ }
        console.warn("⚠️   Overwriting existing v11 (no STAGE tags found in it — looks like a bad run).");
        console.warn("");
    }

    var openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    console.log("📂  Input:  " + INPUT_PATH);
    console.log("📝  Output: " + OUTPUT_PATH);
    console.log("🔍  Audit:  " + AUDIT_PATH);
    console.log("");

    var inputStream = fs.createReadStream(INPUT_PATH, { encoding: "utf8" });
    var rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

    var outputLines = [];
    var auditLog    = [];

    var totalLines   = 0;
    var taggedCount  = 0;
    var skippedCount = 0;
    var errorCount   = 0;

    // Concurrency: process 5 examples at a time to stay under rate limits
    var CONCURRENCY = 5;
    var pendingUntagged = [];   // { lineIndex, obj } — buffer of untagged examples
    var lineBuffer = [];        // all lines buffered first

    console.log("⏳  Reading input file...");

    // Buffer all lines first so we can process them in batches
    for await (var line of rl) {
        line = line.trim();
        if (!line) continue;
        lineBuffer.push(line);
        totalLines++;
    }

    console.log("✅  Loaded " + totalLines + " lines.");
    console.log("");

    // Count untagged first
    var untaggedTotal = 0;
    for (var i = 0; i < lineBuffer.length; i++) {
        var obj = JSON.parse(lineBuffer[i]);
        var sysContent = obj.messages[0].content;
        var isPost  = sysContent.includes("Replying to a Skool post");
        var hasStage = sysContent.includes("STAGE:");
        if (isPost && !hasStage) untaggedTotal++;
    }
    console.log("🎯  Found " + untaggedTotal + " untagged post/comment examples to classify.");
    console.log("");

    // Process all lines — classify untagged in batches of CONCURRENCY
    var untaggedQueue = [];

    // First pass: separate pass-through vs needs-classification
    for (var i = 0; i < lineBuffer.length; i++) {
        var obj = JSON.parse(lineBuffer[i]);
        var sysContent = obj.messages[0].content;
        var isPost   = sysContent.includes("Replying to a Skool post");
        var hasStage = sysContent.includes("STAGE:");

        if (isPost && !hasStage) {
            untaggedQueue.push({ index: i, obj: obj });
        }
    }

    // Process untagged in batches
    var tagResults = {};   // index -> tags
    var processed = 0;

    for (var batchStart = 0; batchStart < untaggedQueue.length; batchStart += CONCURRENCY) {
        var batch = untaggedQueue.slice(batchStart, batchStart + CONCURRENCY);

        var promises = batch.map(function(item) {
            var userContent = item.obj.messages[1] ? item.obj.messages[1].content : "";
            var scottReply  = item.obj.messages[2] ? item.obj.messages[2].content : "";
            return classifyExample(userContent, scottReply, openai).then(function(tags) {
                return { index: item.index, obj: item.obj, tags: tags };
            });
        });

        var results = await Promise.all(promises);

        results.forEach(function(result) {
            tagResults[result.index] = result.tags;
            processed++;

            var tags = result.tags;
            var flag = tags.confidence === "low" ? " ⚠️ LOW CONFIDENCE" : "";
            console.log(
                "  [" + processed + "/" + untaggedTotal + "] " +
                tags.sales_stage.toUpperCase() + " | " + tags.intent + " | " +
                tags.tone_tags.join(", ") + flag
            );
        });
    }

    console.log("");
    console.log("⚙️   Injecting tags and writing output...");
    console.log("");

    // Second pass: write output
    for (var i = 0; i < lineBuffer.length; i++) {
        var obj = JSON.parse(lineBuffer[i]);
        var sysContent = obj.messages[0].content;
        var isPost   = sysContent.includes("Replying to a Skool post");
        var hasStage = sysContent.includes("STAGE:");

        if (isPost && !hasStage && tagResults[i]) {
            var tags = tagResults[i];

            // Inject tags into system prompt
            var newSys = injectTags(sysContent, tags);
            var newObj = JSON.parse(JSON.stringify(obj));   // deep clone
            newObj.messages[0].content = newSys;
            outputLines.push(JSON.stringify(newObj));

            // Build audit log entry
            var userContent = obj.messages[1] ? obj.messages[1].content : "";
            var scottReply  = obj.messages[2] ? obj.messages[2].content : "";
            var person      = extractPerson(userContent);
            var postTitle   = extractPostTitle(userContent) || "(unknown post)";
            var replyTo     = extractReplyTo(userContent)   || "(no reply-to)";

            auditLog.push({
                line_index:   i,
                person_name:  person.name,
                person_role:  person.role,
                post_title:   postTitle,
                reply_to:     replyTo.substring(0, 200),
                scott_reply:  scottReply.substring(0, 200),
                auto_tags: {
                    stage:      tags.sales_stage,
                    intent:     tags.intent,
                    tone_tags:  tags.tone_tags,
                },
                reasoning:    tags.reasoning,
                confidence:   tags.confidence,
                review_flag:  tags.confidence !== "high",
            });

            if (tags.confidence === "low") errorCount++;
            taggedCount++;
        } else {
            outputLines.push(lineBuffer[i]);
            skippedCount++;
        }
    }

    // Write output files
    fs.writeFileSync(OUTPUT_PATH, outputLines.join("\n") + "\n", "utf8");
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(auditLog, null, 2), "utf8");

    // ── Summary ──
    console.log("══════════════════════════════════════════");
    console.log("✅  DONE");
    console.log("══════════════════════════════════════════");
    console.log("  Total examples    : " + totalLines);
    console.log("  Auto-tagged       : " + taggedCount);
    console.log("  Passed through    : " + skippedCount);
    console.log("  Low confidence    : " + errorCount + "  ← review these in audit log");
    console.log("");
    console.log("  Output JSONL      : " + OUTPUT_PATH);
    console.log("  Audit log         : " + AUDIT_PATH);
    console.log("");

    // Confidence breakdown
    var highCount   = auditLog.filter(function(e) { return e.confidence === "high";   }).length;
    var medCount    = auditLog.filter(function(e) { return e.confidence === "medium"; }).length;
    var lowCount    = auditLog.filter(function(e) { return e.confidence === "low";    }).length;
    console.log("  Confidence breakdown:");
    console.log("    High   : " + highCount);
    console.log("    Medium : " + medCount);
    console.log("    Low    : " + lowCount);

    if (lowCount > 0) {
        console.log("");
        console.log("⚠️   " + lowCount + " low-confidence examples — spot check audit log before uploading.");
    }
}

main().catch(function(err) {
    console.error("Fatal error:", err);
    process.exit(1);
});
