/**
 * tool_scripts/autotag_person_streams.js
 *
 * Auto-tags the 486 untagged post/comment reply events in person_streams.json
 * using Claude, with Scott's own 513 hand-labeled events as few-shot examples.
 *
 * What it does:
 *   1. Reads person_streams.json
 *   2. Finds all untagged events: channel="comment", direction="from_scott", no tags object
 *   3. Enriches each with post body + thread context from posts_with_scott_reply_threads.json
 *   4. Pulls 2 examples per intent (26 total) from Scott's 513 labeled events as few-shot
 *   5. Calls Claude claude-sonnet-4-6 to classify each event
 *   6. Writes tags back to person_streams.json (with backup first)
 *   7. Saves an audit log for Scott's spot-check
 *
 * Resume-safe: re-running will skip already-tagged events automatically.
 * Progress is saved every 25 events so a crash loses at most 25 events of work.
 *
 * Usage (from project root):
 *   node tool_scripts/autotag_person_streams.js
 *   node tool_scripts/autotag_person_streams.js --dry-run          (no file writes)
 *   node tool_scripts/autotag_person_streams.js --limit 10         (test first 10)
 *
 * Requires:
 *   - rag/.env with ANTHROPIC_API_KEY
 *   - rag/node_modules/@anthropic-ai/sdk + dotenv already installed
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Load from rag/node_modules (avoids needing a separate install) ───────────
const RAG_MODULES = path.join(__dirname, "../rag/node_modules");
const Anthropic   = require(path.join(RAG_MODULES, "@anthropic-ai/sdk"));

// Manual .env parser — dotenv.config() can silently fail in some environments
(function loadEnv(envPath) {
    try {
        var lines = fs.readFileSync(envPath, "utf8").split("\n");
        for (var line of lines) {
            line = line.trim();
            if (!line || line.startsWith("#")) continue;
            var eqIdx = line.indexOf("=");
            if (eqIdx < 0) continue;
            var key = line.substring(0, eqIdx).trim();
            var val = line.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
            if (key && !process.env[key]) process.env[key] = val;
        }
    } catch (e) { /* .env not found — rely on actual env vars */ }
})(path.join(__dirname, "../rag/.env"));

// ─── Paths ────────────────────────────────────────────────────────────────────
const PERSON_STREAMS_PATH = path.join(__dirname, "../data/person_streams.json");
const POSTS_PATH          = path.join(__dirname, "../data/posts_with_scott_reply_threads.json");
const BACKUP_PATH         = path.join(__dirname, "../data/person_streams_backup_pre_autotag.json");
const AUDIT_PATH          = path.join(__dirname, "autotag_person_streams_audit.json");

// ─── Config ───────────────────────────────────────────────────────────────────
const MODEL             = "claude-sonnet-4-6";
const TEMPERATURE       = 0.2;
const CONCURRENCY       = 4;    // parallel API calls per batch
const EXAMPLES_PER_INTENT = 2;  // 13 intents × 2 = 26 few-shot examples
const SAVE_EVERY        = 25;   // write progress every N events

// ─── CLI args ─────────────────────────────────────────────────────────────────
const ARGS    = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const LIMIT   = (() => {
    var i = ARGS.indexOf("--limit");
    return i >= 0 ? parseInt(ARGS[i + 1], 10) : Infinity;
})();

// ─── Valid tags ───────────────────────────────────────────────────────────────
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

// ─── File helpers ─────────────────────────────────────────────────────────────

function loadJson(filepath) {
    // Strip trailing null bytes (known quirk in person_streams.json)
    var raw = fs.readFileSync(filepath, "utf8").replace(/\0+$/, "");
    return JSON.parse(raw);
}

function saveJson(filepath, data) {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeUrl(url) {
    if (!url) return "";
    return url.trim().replace(/\/$/, "").toLowerCase();
}

function normalizeText(txt) {
    if (!txt) return "";
    // Normalize non-breaking spaces (\u00a0) and other whitespace variants
    return txt.replace(/\u00a0/g, " ").trim().replace(/\s+/g, " ");
}

// posts_with_scott_reply_threads.json uses \u00a0 between "Scott" and "Northwolf"
function isScott(author) {
    return normalizeText(author || "") === "Scott Northwolf";
}

// ─── Build post lookup: normalized URL → post entry ───────────────────────────
function buildPostLookup(posts) {
    var map = new Map();
    for (var post of posts) {
        var url = normalizeUrl(post.original_post && post.original_post.url);
        if (url) map.set(url, post);
    }
    return map;
}

// ─── Find thread context for Scott's reply ────────────────────────────────────
// Returns { rootComment, repliesBeforeScott, replyTo, scottIsRootCommenter } or null
function findThreadContext(postEntry, scottReplyText) {
    if (!postEntry || !postEntry.threads) return null;
    var targetNorm = normalizeText(scottReplyText).substring(0, 120).toLowerCase();

    for (var thread of postEntry.threads) {
        // Case 1: Scott is the ROOT COMMENTER on the post (thread.comment is Scott's)
        if (thread.comment && isScott(thread.comment.author)) {
            var commentNorm = normalizeText(thread.comment.content || "").substring(0, 120).toLowerCase();
            if (commentNorm === targetNorm) {
                return {
                    rootComment:        null,   // no parent comment — Scott is responding to the post
                    repliesBeforeScott: [],
                    replyTo:            null,   // replying to the post itself
                    scottIsRootCommenter: true,
                };
            }
        }

        // Case 2: Scott replied to someone's comment (thread.replies contains Scott's reply)
        if (!thread.replies) continue;
        for (var i = 0; i < thread.replies.length; i++) {
            var reply = thread.replies[i];
            if (!isScott(reply.author)) continue;
            var replyNorm = normalizeText(reply.content || "").substring(0, 120).toLowerCase();
            if (replyNorm === targetNorm) {
                return {
                    rootComment:        thread.comment,
                    repliesBeforeScott: thread.replies.slice(0, i),
                    replyTo:            i > 0 ? thread.replies[i - 1] : thread.comment,
                    scottIsRootCommenter: false,
                };
            }
        }
    }
    return null;
}

// ─── Format event as v5-style prompt block ────────────────────────────────────
function formatEventPrompt(event, postEntry) {
    var lines = [];
    var post  = postEntry && postEntry.original_post;
    var ctx   = postEntry ? findThreadContext(postEntry, event.text) : null;

    // --- POST ---
    lines.push("--- POST ---");
    lines.push("Author: " + (post ? post.author : "Unknown"));
    lines.push("Title: " + (event.postTitle || (post && post.title) || "Unknown"));
    if (post && post.body) {
        var body = post.body.length > 500 ? post.body.substring(0, 500) + "..." : post.body;
        lines.push("");
        lines.push(body);
    }
    lines.push("");

    if (ctx && ctx.scottIsRootCommenter) {
        // Scott commented directly on the post — no prior thread context
        lines.push("--- REPLY TO ---");
        lines.push("[Post]: " + (event.postTitle || "Community post"));
    } else if (ctx) {
        // --- THREAD --- (Scott replied within a comment thread)
        lines.push("--- THREAD ---");
        var root = ctx.rootComment;
        lines.push("[" + ((root && root.author) || "Member") + "]: " + ((root && root.content) || ""));
        for (var r of ctx.repliesBeforeScott) {
            var rText = (r.content || "").substring(0, 200);
            lines.push("  [" + (r.author || "Member") + "]: " + rText);
        }
        lines.push("");

        // --- REPLY TO ---
        lines.push("--- REPLY TO ---");
        var rt = ctx.replyTo;
        lines.push("[" + ((rt && rt.author) || "Member") + "]: " + ((rt && rt.content) || "").substring(0, 300));
    } else {
        // Fallback: no thread match found — use post title as minimal context
        lines.push("--- REPLY TO ---");
        lines.push("[Post]: " + (event.postTitle || "Community post"));
    }

    return lines.join("\n");
}

// ─── Build few-shot examples from Scott's 513 labeled events ─────────────────
function buildFewShotExamples(data, postLookup) {
    var byIntent = {};
    for (var intent of VALID_INTENTS) byIntent[intent] = [];

    for (var pid of Object.keys(data.streams)) {
        var stream = data.streams[pid];
        for (var ev of stream.events) {
            if (ev.channel !== "comment" || ev.direction !== "from_scott" || !ev.tags) continue;
            var intentTag = ev.tags.intent;
            if (!VALID_INTENTS.includes(intentTag)) continue;
            if (byIntent[intentTag].length >= EXAMPLES_PER_INTENT) continue;

            var postEntry = postLookup.get(normalizeUrl(ev.postUrl));
            byIntent[intentTag].push({
                prompt: formatEventPrompt(ev, postEntry),
                reply:  ev.text,
                tags:   ev.tags,
            });
        }
    }

    var examples = [];
    for (var intent of VALID_INTENTS) examples = examples.concat(byIntent[intent]);
    return examples;
}

// ─── Build classifier system prompt ──────────────────────────────────────────
function buildSystemPrompt(fewShotExamples) {
    var exBlocks = fewShotExamples.map(function(ex, i) {
        return [
            "--- EXAMPLE " + (i + 1) + " [" + ex.tags.intent.toUpperCase() + "] ---",
            ex.prompt,
            "",
            "SCOTT'S REPLY: " + ex.reply.substring(0, 300),
            "TAGS: " + JSON.stringify({
                tone_tags:   ex.tags.tone_tags,
                intent:      ex.tags.intent,
                sales_stage: ex.tags.sales_stage,
            }),
            "",
        ].join("\n");
    }).join("\n");

    return [
        "You are a classifier for Scott Northwolf's Skool community replies.",
        "Scott is the founder of Self-Improvement Nation and Answer 42.",
        "He helps self-improvement coaches go from $0 to $10K/month in 42 days using the Reverse Engineered $10K Method.",
        "His tone: raw, high-energy brotherhood language, philosophy references, no corporate polish.",
        "",
        "Given: post context + optional thread + Scott's reply.",
        "Task: Output the correct JSON classification.",
        "Key rule: Scott's reply text is the STRONGEST signal. Read it first, then consider context.",
        "",
        "═══ TONE TAGS — pick 1 to 4 ═══",
        "hype                = Maximum energy, ALL CAPS peaks. 'LETS FUCKIN GOOO'. Peak Scott mode.",
        "brotherhood         = Raw male loyalty. 'brother/bro/king'. Street-level, not corporate.",
        "motivational        = Pushing someone forward with conviction and belief.",
        "authority           = Expert certainty. Drops credentials naturally. No arrogance.",
        "direct              = No fluff. Point first. Short punchy sentences.",
        "casual              = Low-key, friend-texting. 'yeah bro', 'lol'. Not trying to impress.",
        "self-aggrandization = References own wins or lifestyle — creates aspiration.",
        "teasing-future-value= Hints at something big coming without revealing it. Creates FOMO.",
        "praise              = Specific genuine recognition of effort or insight.",
        "humor               = Light joke or sarcasm. Never mean.",
        "empathy             = Brief acknowledgement of struggle, then pivots forward.",
        "storytelling        = Short personal anecdote to make a point.",
        "vulnerability       = Briefly reveals a personal challenge — builds trust, rare.",
        "tough-love          = Honest feedback that might sting, said with care.",
        "mystery-teasing     = Creates intrigue around Scott's methods or lifestyle.",
        "chit-chat           = Pure social conversation. No agenda, no value delivery.",
        "bonding-rapport     = Building personal connection through shared references.",
        "gratitude           = Genuine thanks. Rare and real.",
        "curiosity           = Asking because he genuinely wants to know.",
        "",
        "═══ INTENT — pick exactly 1 ═══",
        "acknowledgement    = Short reaction, emoji, 'fire'. No sales agenda. Just being present.",
        "engagement-nurture = Keeps conversation alive and builds warmth. Makes person feel seen.",
        "community-building = Reinforces SIN identity, culture, and belonging.",
        "authority-proofing = Demonstrates expertise passively without being asked.",
        "value-delivery     = Gives a specific actionable insight or framework.",
        "close-to-call      = Invites person to book a call or DM — ONLY with clear buying signal.",
        "social-proof       = Highlights wins or transformations to attract others.",
        "redirect           = Moves conversation toward Scott's offer. Smooth, not abrupt.",
        "info-gathering     = Asks a question to learn about their situation or goals.",
        "lead-qualification = Probes to determine if this person is a coach who could buy.",
        "pain-agitation     = Amplifies someone's problem to make the solution feel urgent.",
        "objection-handling = Addresses a doubt or pushback and flips it into reason to move forward.",
        "funneling          = Directs person toward Scott's community, program, or resources.",
        "",
        "═══ SALES STAGE — pick exactly 1 ═══",
        "awareness  = Person just discovered Scott. Make a good first impression. No selling.",
        "engagement = Person is active but not warm yet. Deepen the relationship.",
        "nurture    = Person is warm and trusts Scott. Stay top of mind, deliver value.",
        "ask        = Person has shown buying signals. Move them toward a call.",
        "",
        "═══ OUTPUT FORMAT ═══",
        "Respond ONLY with valid JSON. No markdown. No text outside the JSON object.",
        '{"tone_tags":["tag1","tag2"],"intent":"one-intent","sales_stage":"one-stage","reasoning":"one sentence","confidence":"high|medium|low"}',
        "",
        "═══ SCOTT'S REAL LABELED EXAMPLES — calibrate against these ═══",
        "",
        exBlocks,
    ].join("\n");
}

// ─── Call Claude to classify a single event ───────────────────────────────────
async function classifyEvent(client, systemPrompt, event, postEntry) {
    var contextBlock = formatEventPrompt(event, postEntry);
    var userPrompt = [
        contextBlock,
        "",
        "SCOTT'S REPLY: " + event.text.substring(0, 500),
        "",
        "Classify this reply. Output JSON only.",
    ].join("\n");

    var response = await client.messages.create({
        model:       MODEL,
        max_tokens:  250,
        temperature: TEMPERATURE,
        system:      systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
    });

    var raw = response.content[0].text.trim();

    // Strip markdown fences if present
    var fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) raw = fenceMatch[1].trim();

    // Extract JSON object if there's surrounding text
    var jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) raw = jsonMatch[0];

    var parsed = JSON.parse(raw);

    // Validate and sanitize
    var tone_tags   = (parsed.tone_tags || []).filter(function(t) { return VALID_TONES.includes(t); });
    var intent      = VALID_INTENTS.includes(parsed.intent)      ? parsed.intent      : FALLBACK.intent;
    var sales_stage = VALID_STAGES.includes(parsed.sales_stage)  ? parsed.sales_stage : FALLBACK.sales_stage;
    var reasoning   = (parsed.reasoning  || "").substring(0, 250);
    var confidence  = ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium";

    if (tone_tags.length === 0) tone_tags = FALLBACK.tone_tags;

    return { tone_tags, intent, sales_stage, reasoning, confidence };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    if (!process.env.ANTHROPIC_API_KEY) {
        console.error("❌  ANTHROPIC_API_KEY not found. Check rag/.env");
        process.exit(1);
    }

    console.log("╔══════════════════════════════════════════════╗");
    console.log("║   OutreachAI — person_streams.json Tagger   ║");
    console.log("╚══════════════════════════════════════════════╝");
    if (DRY_RUN) console.log("🧪  DRY RUN — no files will be modified\n");
    else         console.log("⚡  LIVE RUN — will write to person_streams.json\n");

    // ── 1. Load data ──────────────────────────────────────────────────────────
    console.log("📂  Loading data files...");
    var data  = loadJson(PERSON_STREAMS_PATH);
    var posts = loadJson(POSTS_PATH);
    console.log("    person_streams.json → " + data.counts.totalEvents + " total events");
    console.log("    posts_with_threads  → " + posts.length + " posts");

    // ── 2. Build post lookup ──────────────────────────────────────────────────
    var postLookup = buildPostLookup(posts);
    console.log("    Post URL index      → " + postLookup.size + " entries\n");

    // ── 3. Backup (once only — skip if backup already exists) ─────────────────
    if (!DRY_RUN) {
        if (!fs.existsSync(BACKUP_PATH)) {
            console.log("💾  Creating backup → " + path.basename(BACKUP_PATH));
            fs.copyFileSync(PERSON_STREAMS_PATH, BACKUP_PATH);
        } else {
            console.log("💾  Backup already exists — skipping (resume mode)");
        }
    }

    // ── 4. Build few-shot examples from Scott's 513 labeled events ────────────
    console.log("\n📚  Building few-shot examples from Scott's labeled replies...");
    var fewShot = buildFewShotExamples(data, postLookup);
    var intentCoverage = {};
    for (var ex of fewShot) intentCoverage[ex.tags.intent] = (intentCoverage[ex.tags.intent] || 0) + 1;
    console.log("    " + fewShot.length + " examples across " + Object.keys(intentCoverage).length + " intents:");
    for (var [intent, count] of Object.entries(intentCoverage)) {
        console.log("      " + intent.padEnd(22) + " × " + count);
    }

    // ── 5. Build system prompt ────────────────────────────────────────────────
    var systemPrompt = buildSystemPrompt(fewShot);
    console.log("\n    System prompt: " + systemPrompt.length + " chars");

    // ── 6. Collect untagged events ────────────────────────────────────────────
    console.log("\n🔍  Collecting untagged comment events from Scott...");
    var untaggedQueue = [];
    for (var pid of Object.keys(data.streams)) {
        var stream = data.streams[pid];
        for (var i = 0; i < stream.events.length; i++) {
            var ev = stream.events[i];
            if (ev.channel === "comment" && ev.direction === "from_scott" && !ev.tags) {
                untaggedQueue.push({ pid: pid, eventIdx: i, event: ev });
            }
        }
    }
    console.log("    Found " + untaggedQueue.length + " untagged events");

    // Apply limit
    if (LIMIT !== Infinity) {
        untaggedQueue = untaggedQueue.slice(0, LIMIT);
        console.log("    Limited to first " + untaggedQueue.length + " (--limit flag)");
    }

    if (untaggedQueue.length === 0) {
        console.log("\n✅  Nothing to tag — all comment events already have tags!");
        return;
    }

    // ── 7. Initialize Anthropic client ────────────────────────────────────────
    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── 8. Classify in batches ────────────────────────────────────────────────
    console.log("\n🤖  Classifying with " + MODEL + " (concurrency=" + CONCURRENCY + ")...\n");

    var auditLog       = [];
    var totalTagged    = 0;
    var totalErrors    = 0;
    var totalProcessed = 0;

    for (var batchStart = 0; batchStart < untaggedQueue.length; batchStart += CONCURRENCY) {
        var batch = untaggedQueue.slice(batchStart, batchStart + CONCURRENCY);

        var promises = batch.map(function(item) {
            var postEntry = postLookup.get(normalizeUrl(item.event.postUrl));
            return classifyEvent(client, systemPrompt, item.event, postEntry)
                .then(function(tags) { return { item: item, tags: tags, error: null }; })
                .catch(function(err) { return { item: item, tags: FALLBACK, error: err.message }; });
        });

        var results = await Promise.all(promises);

        for (var result of results) {
            totalProcessed++;
            var item  = result.item;
            var tags  = result.tags;
            var error = result.error;
            var flag  = error ? " ❌" : (tags.confidence === "low" ? " ⚠️ LOW" : "");

            console.log(
                "  [" + String(totalProcessed).padStart(3) + "/" + untaggedQueue.length + "] " +
                tags.sales_stage.toUpperCase().padEnd(10) + " | " +
                tags.intent.padEnd(22) + " | [" + tags.tone_tags.join(", ") + "]" + flag
            );
            if (error) console.log("       ERROR: " + error);

            // Apply tags to in-memory data
            if (!DRY_RUN) {
                data.streams[item.pid].events[item.eventIdx].tags = {
                    tone_tags:   tags.tone_tags,
                    intent:      tags.intent,
                    sales_stage: tags.sales_stage,
                };
            }

            // Build audit log entry
            auditLog.push({
                pid:         item.pid,
                event_idx:   item.eventIdx,
                post_title:  item.event.postTitle || "",
                post_url:    item.event.postUrl   || "",
                scott_reply: item.event.text.substring(0, 300),
                auto_tags: {
                    stage:     tags.sales_stage,
                    intent:    tags.intent,
                    tone_tags: tags.tone_tags,
                },
                reasoning:   tags.reasoning,
                confidence:  tags.confidence,
                error:       error || null,
                review_flag: tags.confidence !== "high" || !!error,
            });

            if (error) totalErrors++;
            else       totalTagged++;
        }

        // Save progress every SAVE_EVERY events
        if (!DRY_RUN && totalProcessed % SAVE_EVERY === 0 && totalProcessed < untaggedQueue.length) {
            saveJson(PERSON_STREAMS_PATH, data);
            console.log("  💾  Progress saved (" + totalProcessed + "/" + untaggedQueue.length + ")");
        }
    }

    // ── 9. Final write ────────────────────────────────────────────────────────
    if (!DRY_RUN) {
        console.log("\n✍️   Writing final person_streams.json...");
        saveJson(PERSON_STREAMS_PATH, data);
        console.log("    Done!");
    }

    // ── 10. Save audit log ────────────────────────────────────────────────────
    saveJson(AUDIT_PATH, auditLog);
    console.log("📋  Audit log saved → " + path.basename(AUDIT_PATH));

    // ── 11. Summary ───────────────────────────────────────────────────────────
    var highCount   = auditLog.filter(function(e) { return e.confidence === "high";   }).length;
    var medCount    = auditLog.filter(function(e) { return e.confidence === "medium"; }).length;
    var lowCount    = auditLog.filter(function(e) { return e.confidence === "low";    }).length;
    var reviewCount = auditLog.filter(function(e) { return e.review_flag;             }).length;

    console.log("\n══════════════════════════════════════════");
    console.log("✅  DONE");
    console.log("══════════════════════════════════════════");
    console.log("  Total processed : " + totalProcessed);
    console.log("  Tagged OK       : " + totalTagged);
    console.log("  Errors          : " + totalErrors);
    console.log("");
    console.log("  Confidence breakdown:");
    console.log("    🟢 High   : " + highCount);
    console.log("    🟡 Medium : " + medCount);
    console.log("    🔴 Low    : " + lowCount);
    if (reviewCount > 0) {
        console.log("\n  ⚠️  " + reviewCount + " events flagged for review");
        console.log("      → Open " + path.basename(AUDIT_PATH) + " and filter review_flag=true");
    }
    if (DRY_RUN) {
        console.log("\n🧪  DRY RUN — no files modified. Sample output:");
        console.log(JSON.stringify(auditLog.slice(0, 3), null, 2));
    }
}

main().catch(function(err) {
    console.error("\n💥  Fatal error:", err.message);
    process.exit(1);
});
