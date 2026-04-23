/**
 * classify/dm_classifier.js
 *
 * Classifies a DM conversation to determine what Scott should do NEXT.
 * Returns dm_stage, tone_tags, intent, sales_stage, and reasoning.
 *
 * This is the DM equivalent of tag_classifier.js — same MOTHER AI system
 * but extended with the 8-step appointment setting workflow stage.
 *
 * Input:  { partnerName, messages: [ { role: 'bot'|'partner', text } ] }
 * Output: { dm_stage, tone_tags, intent, sales_stage, reasoning }
 */

const OpenAI = require("openai");
require("dotenv").config();

const FALLBACK_TAGS = {
    dm_stage:    "gather-intel",
    tone_tags:   ["brotherhood", "curiosity"],
    intent:      "info-gathering",
    sales_stage: "engagement",
    gender:      "unknown",
    reasoning:   "fallback defaults",
};

// ── Build system prompt once at startup ───────────────────────────────────────

const SYSTEM_PROMPT = buildSystemPrompt();

function buildSystemPrompt() {
    var lines = [];

    lines.push("You classify DM conversations for Scott Northwolf's 8-step appointment setting workflow.");
    lines.push("Output the NEXT step Scott should take + the best tone, intent, and sales stage for his reply.");
    lines.push("Return JSON only.");
    lines.push("");

    // ── DM Workflow Stage ──
    lines.push("DM_STAGE (pick one — what Scott should do NEXT):");
    var stages = {
        "null":             "not a sales DM — WhatsApp, personal chat, or unrelated to coaching",
        "connect":          "first contact — open with specific hook: shared interest, their post, a reference",
        "gather-intel":     "soft qualify — learn their business, pain, current situation with 1-2 questions",
        "share-authority":  "build trust — share personal story, vulnerability, expertise, or future vision",
        "frame-outcome":    "probe dream goal — steer conversation toward their business/life outcome",
        "offer-call":       "invite to diagnostic call — position as exploratory, not a sales pitch",
        "pre-qualify":      "check readiness — are they committed? Can they invest $1K–$5K?",
        "send-calendly":    "qualified + committed — send Calendly link, ask them to confirm",
        "nurture-free":     "not ready / no budget — point to Skool / free resources, keep door open",
    };
    lines.push(Object.keys(stages).map(function(k) { return k + "=" + stages[k]; }).join(" | "));
    lines.push("");

    // ── Tone Tags ──
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
    lines.push("TONE (pick 1-4): " + Object.keys(toneShort).map(function(k) { return k + "=" + toneShort[k]; }).join(" | "));
    lines.push("");

    // ── Intent ──
    var intentShort = {
        "engagement-nurture": "keep conversation alive, feel seen",
        "value-delivery":     "one actionable insight or framework",
        "info-gathering":     "question to learn their situation",
        "lead-qualification": "probe budget, commitment, fit",
        "authority-proofing": "demonstrate expertise passively",
        "pain-agitation":     "surface or amplify their problem",
        "objection-handling": "flip doubt into reason to move forward",
        "close-to-call":      "push toward booking a sales call",
        "funneling":          "point toward Skool community or resources",
        "social-proof":       "share results, wins, transformations",
        "acknowledgement":    "short reaction, no agenda",
        "community-building": "make them feel part of something",
        "redirect":           "steer conversation or set boundary",
    };
    lines.push("INTENT (pick 1): " + Object.keys(intentShort).map(function(k) { return k + "=" + intentShort[k]; }).join(" | "));
    lines.push("");

    // ── Sales Stage ──
    var stageShort = {
        "awareness":  "new — first impression, no selling",
        "engagement": "active but not warm — deepen relationship",
        "nurture":    "warm, trusts Scott — stay top of mind",
        "ask":        "buying signal — move toward call",
    };
    lines.push("SALES_STAGE (pick 1): " + Object.keys(stageShort).map(function(k) { return k + "=" + stageShort[k]; }).join(" | "));
    lines.push("");

    lines.push("GENDER: infer from the partner's first name. Use \"male\", \"female\", or \"unknown\".");
    lines.push("");
    lines.push('Output: {"dm_stage":"..."or null,"tone_tags":[...],"intent":"...","sales_stage":"...","gender":"male|female|unknown","reasoning":"one sentence"}');

    return lines.join("\n");
}

// ── Build user prompt from conversation messages ───────────────────────────────

function buildUserPrompt(partnerName, messages) {
    var lines = [];
    lines.push("DM conversation with " + partnerName + ":");
    lines.push("");

    // Last 6 messages max — enough context, keeps tokens low
    var recent = messages.slice(-6);
    recent.forEach(function(m) {
        var speaker = m.role === "bot" ? "Scott" : partnerName;
        lines.push(speaker + ": " + m.text.substring(0, 200));
    });

    lines.push("");
    lines.push("What should Scott do NEXT in his reply? Output JSON only.");
    return lines.join("\n");
}

// ── Valid values for sanitization ────────────────────────────────────────────

const VALID_STAGES  = ["connect","gather-intel","share-authority","frame-outcome","offer-call","pre-qualify","send-calendly","nurture-free"];
const VALID_TONES   = ["hype","brotherhood","motivational","authority","direct","casual","self-aggrandization","teasing-future-value","praise","humor","empathy","storytelling","vulnerability","tough-love","mystery-teasing","chit-chat","bonding-rapport","gratitude","curiosity"];
const VALID_INTENTS = ["engagement-nurture","value-delivery","info-gathering","lead-qualification","authority-proofing","pain-agitation","objection-handling","close-to-call","funneling","social-proof","acknowledgement","community-building","redirect"];
const VALID_SALES   = ["awareness","engagement","nurture","ask"];

// ── Main export ───────────────────────────────────────────────────────────────

async function classifyDM(partnerName, messages) {
    var openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    try {
        var model = process.env.CLASSIFIER_MODEL || "gpt-4o-mini";

        var completion = await openai.chat.completions.create({
            model:       model,
            max_tokens:  200,
            temperature: 0.1,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user",   content: buildUserPrompt(partnerName, messages) },
            ],
        });

        var raw = completion.choices[0].message.content.trim();
        var fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) raw = fenceMatch[1].trim();
        var parsed = JSON.parse(raw);

        // Sanitize
        var dmStage    = VALID_STAGES.includes(parsed.dm_stage) ? parsed.dm_stage : null;
        var nonsales   = !dmStage;
        var toneTags   = (parsed.tone_tags || []).filter(function(t) { return VALID_TONES.includes(t); });
        if (toneTags.length === 0) toneTags = FALLBACK_TAGS.tone_tags;
        var intent     = VALID_INTENTS.includes(parsed.intent)      ? parsed.intent      : FALLBACK_TAGS.intent;
        var salesStage = VALID_SALES.includes(parsed.sales_stage)   ? parsed.sales_stage : FALLBACK_TAGS.sales_stage;
        var reasoning  = parsed.reasoning || "";
        var gender     = ["male","female","unknown"].includes(parsed.gender) ? parsed.gender : "unknown";

        return { dm_stage: dmStage, nonsales: nonsales, tone_tags: toneTags, intent: intent, sales_stage: salesStage, gender: gender, reasoning: reasoning };

    } catch (err) {
        console.error("\n⚠️  DM CLASSIFIER ERROR — falling back to defaults");
        console.error("   message : " + err.message);
        if (err.status) console.error("   status  : " + err.status);
        console.error("");
        return FALLBACK_TAGS;
    }
}

module.exports = classifyDM;
module.exports.SYSTEM_PROMPT  = SYSTEM_PROMPT;
module.exports.buildUserPrompt = buildUserPrompt;
