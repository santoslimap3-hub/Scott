/**
 * classify/tag_classifier.js
 *
 * Calls gpt-4o-mini to determine the tone, intent, and sales_stage
 * that the reply-generation model should aim for.
 *
 * Input:  { postAuthor, postTitle, postBody, commentAuthor, commentText, thread }
 * Output: { tone_tags: [...], intent: "...", sales_stage: "...", reasoning: "..." }
 *
 * Falls back to safe defaults if the API call fails.
 */

const OpenAI = require("openai");
require("dotenv").config();

const { TONE_TAGS, INTENTS, SALES_STAGES } = require("./tags");
const EXAMPLES = require("./examples");

// ── Module-scope OpenAI client (created once, not per-call) ───────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Build prompts once at startup (not on every call) ─────────────────────────

const SYSTEM_PROMPT = buildSystemPrompt();
const FALLBACK_TAGS = {
    tone_tags:   ["brotherhood", "motivational"],
    intent:      "engagement-nurture",
    sales_stage: "nurture",
    gender:      "unknown",
    reasoning:   "fallback defaults",
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the classifier system prompt in compact format.
 * Verbose descriptions live in tags.js for human reference — this prompt
 * uses short phrases to keep token count low on every API call.
 */
function buildSystemPrompt() {
    var lines = [];

    // ── Role ──
    lines.push("Classify Skool posts/comments for Jack Walford, appointment setter for Scott Northwolf's coaching community. Output the best tone, intent, and sales_stage for his reply. Return JSON only.");
    lines.push("");

    // ── Compact tag lists (short phrases, no verbose paragraphs) ──
    var toneShort = {
        "hype":                 "max energy, ALL CAPS peaks",
        "brotherhood":          "raw male loyalty, 'bro/king'",
        "motivational":         "push them forward with conviction",
        "authority":            "expert certainty, drops credentials",
        "direct":               "no fluff, point first",
        "casual":               "friend-texting, low key",
        "self-aggrandization":  "reference own wins to inspire",
        "teasing-future-value": "hint at something big, create FOMO",
        "praise":               "specific recognition of effort",
        "humor":                "light joke, never mean",
        "empathy":              "brief acknowledgement then pivot",
        "storytelling":         "short personal anecdote",
        "vulnerability":        "briefly reveal own struggle",
        "tough-love":           "honest even if it stings",
        "mystery-teasing":      "intrigue around Scott's methods",
        "chit-chat":            "pure social, no agenda",
        "bonding-rapport":      "shared experience, personal connection",
        "gratitude":            "genuine thanks",
        "curiosity":            "ask because you want to know",
    };
    var intentShort = {
        "acknowledgement":    "short reaction, no agenda",
        "engagement-nurture": "keep conversation alive, feel seen",
        "community-building": "reinforce SIN identity/culture",
        "authority-proofing": "demonstrate expertise passively",
        "value-delivery":     "one actionable insight or framework",
        "close-to-call":      "invite call/DM, only if buying signal",
        "social-proof":       "highlight win or transformation",
        "redirect":           "steer toward Scott's offer smoothly",
        "info-gathering":     "question to learn their situation",
        "lead-qualification": "probe if they're a coach who could buy",
        "pain-agitation":     "amplify their problem, make solution urgent",
        "objection-handling": "flip doubt into reason to move forward",
        "funneling":          "point to Scott's community/program",
    };
    var stageShort = {
        "awareness":  "new — first impression, no selling",
        "engagement": "active but not warm — deepen relationship",
        "nurture":    "warm, trusts Scott — stay top of mind",
        "ask":        "buying signal — move toward call",
    };

    lines.push("TONE (pick 1-4): " + Object.keys(toneShort).map(function(k) { return k + "=" + toneShort[k]; }).join(" | "));
    lines.push("");
    lines.push("INTENT (pick 1): " + Object.keys(intentShort).map(function(k) { return k + "=" + intentShort[k]; }).join(" | "));
    lines.push("");
    lines.push("STAGE (pick 1): " + Object.keys(stageShort).map(function(k) { return k + "=" + stageShort[k]; }).join(" | "));
    lines.push("");

    // ── 5 representative examples (down from 13 — covers the key decisions) ──
    // To add/edit examples, update classify/examples.js — indices picked here are:
    // 0=acknowledgement, 5=close-to-call, 3=value-delivery, 1=engagement-nurture, 9=objection-handling
    var PICK = [0, 5, 3, 1, 9];
    lines.push("EXAMPLES:");
    PICK.forEach(function(idx) {
        var ex = EXAMPLES[idx];
        if (!ex) return;
        var ctx = "\"" + ex.post.title + "\"";
        if (ex.comment) ctx += " → comment: \"" + ex.comment.text.substring(0, 80) + "\"";
        lines.push(ctx + " → " + JSON.stringify(ex.tags));
    });
    lines.push("");

    // ── Gender detection ──
    lines.push('GENDER: infer from the author\'s first name. Use "male", "female", or "unknown".');
    lines.push("");

    // ── Output format ──
    lines.push('Output: {"tone_tags":[...],"intent":"...","sales_stage":"...","gender":"male|female|unknown","reasoning":"one sentence"}');

    return lines.join("\n");
}

/**
 * Builds the user message for a specific post/comment/thread.
 */
function buildUserPrompt(context) {
    var lines = [];

    lines.push("--- POST ---");
    lines.push("Author: " + (context.postAuthor || "Unknown"));
    lines.push("Title: " + (context.postTitle || "(no title)"));
    if (context.postBody) {
        lines.push(context.postBody.substring(0, 200));
    }

    // Last 3 comments for context (enough signal, keeps tokens low)
    if (context.thread && context.thread.length > 0) {
        lines.push("");
        lines.push("THREAD:");
        context.thread.slice(-3).forEach(function(c) {
            var prefix = c.isReply ? "  " : "";
            lines.push(prefix + "[" + c.author + "]: " + c.text.substring(0, 120));
        });
    }

    // If there's a specific comment we're replying to, highlight it
    if (context.commentAuthor && context.commentText) {
        lines.push("");
        lines.push("--- REPLY TO ---");
        lines.push("[" + context.commentAuthor + "]: " + context.commentText.substring(0, 300));
    }

    lines.push("");
    lines.push("Respond with a JSON object only.");

    return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main export: classifies a post/comment context and returns tags.
 *
 * @param {Object} context
 *   @param {string} context.postAuthor
 *   @param {string} context.postTitle
 *   @param {string} context.postBody
 *   @param {string} [context.commentAuthor]   — the specific comment we're replying to
 *   @param {string} [context.commentText]     — the specific comment we're replying to
 *   @param {Array}  [context.thread]          — full thread [ { author, text, isReply } ]
 *
 * @returns {Promise<{ tone_tags: string[], intent: string, sales_stage: string, reasoning: string }>}
 */
async function classifyReply(context) {
    try {
        // Use gpt-4o-mini for cheaper classification; falls back to OPENAI_MODEL if not set
        // Change CLASSIFIER_MODEL in your .env to override (e.g. CLASSIFIER_MODEL=gpt-4o)
        var model = process.env.CLASSIFIER_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

        var completion = await openai.chat.completions.create({
            model:       model,
            max_tokens:  300,
            temperature: 0.2,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user",   content: buildUserPrompt(context) },
            ],
        });

        // Parse JSON from response — handle models that wrap it in markdown code fences
        var raw = completion.choices[0].message.content.trim();
        var jsonStr = raw;
        var fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();
        var parsed = JSON.parse(jsonStr);

        // ── Validate and sanitize the response ──────────────────────────────
        var validTones   = Object.keys(TONE_TAGS);
        var validIntents = Object.keys(INTENTS);
        var validStages  = Object.keys(SALES_STAGES);

        var toneTags = (parsed.tone_tags || []).filter(function(t) { return validTones.includes(t); });
        if (toneTags.length === 0) toneTags = FALLBACK_TAGS.tone_tags;

        var intent = validIntents.includes(parsed.intent) ? parsed.intent : FALLBACK_TAGS.intent;
        var salesStage = validStages.includes(parsed.sales_stage) ? parsed.sales_stage : FALLBACK_TAGS.sales_stage;
        var reasoning = parsed.reasoning || "";
        var gender = ["male","female","unknown"].includes(parsed.gender) ? parsed.gender : "unknown";

        return { tone_tags: toneTags, intent: intent, sales_stage: salesStage, gender: gender, reasoning: reasoning };

    } catch (err) {
        // Print the full error so it's easy to diagnose
        console.error("\n⚠️  CLASSIFIER ERROR — falling back to defaults");
        console.error("   message : " + err.message);
        if (err.status)  console.error("   status  : " + err.status);
        if (err.code)    console.error("   code    : " + err.code);
        if (err.type)    console.error("   type    : " + err.type);
        // Print first 300 chars of full error for SDK-specific details
        console.error("   raw     : " + String(err).substring(0, 300));
        console.error("");
        return FALLBACK_TAGS;
    }
}

module.exports = classifyReply;
module.exports.SYSTEM_PROMPT  = SYSTEM_PROMPT;
module.exports.buildUserPrompt = buildUserPrompt;
