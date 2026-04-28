"use strict";

const JACK_BASE_SYSTEM_PROMPT = [
    "You are Jack Walford, appointment setter for Answer42 and Scott Northwolf's coaching program.",
    "You operate in Skool communities to help self-improvement coaches break through to $10K/month.",
    "",
    "Your voice is raw, direct, and high-energy. Brotherhood language, no corporate polish.",
    "You reference philosophy and ancient wisdom naturally. You write like a man on a mission, not a marketer.",
    "",
    "Every reply is short. One or two short paragraphs at most.",
    "Never list bullet points. Never use hashtags. Never be desperate or salesy in public.",
].join("\n");

function clipText(text, maxLen) {
    var value = typeof text === "string" ? text.trim() : "";
    if (!value) return "";
    if (!maxLen || value.length <= maxLen) return value;
    return value.substring(0, maxLen).trim();
}

function getCommunityName(payload) {
    return payload && payload.community
        ? payload.community
        : (process.env.COMMUNITY_NAME || "the community");
}

function buildRawPostText(post) {
    var parts = [];
    if (post && post.title) parts.push(clipText(post.title, 300));
    if (post && post.body) parts.push(clipText(post.body, 1200));
    return parts.join("\n\n").trim() || "(no post text)";
}

function buildValuePrompt(post) {
    return {
        system: [
            JACK_BASE_SYSTEM_PROMPT,
            "This is a public post reply.",
            "Give a short, genuinely useful insight in Jack's voice.",
            "Keep it to 2 or 3 sentences. No call to action, no DM hook, no questions.",
            (post.author || "This person") + " has just posted the below post on " + getCommunityName(post) + ". Reply to it.",
        ].join("\n\n"),
        user: buildRawPostText(post),
    };
}

function buildHookPrompt(post) {
    return {
        system: [
            JACK_BASE_SYSTEM_PROMPT,
            "This is a public post reply to someone showing an explicit buying signal.",
            "Keep it to 2 sentences max and end with one open question or one short DM invite.",
            "Never be needy. One hook, let them reach.",
            (post.author || "This person") + " has just posted the below post on " + getCommunityName(post) + ". Reply to it.",
        ].join("\n\n"),
        user: buildRawPostText(post),
    };
}

function buildEngagementPrompt(engagement) {
    var partnerName = engagement && engagement.authorName ? engagement.authorName : "this person";
    var commentText = clipText(
        (engagement && engagement.commentText) || (engagement && engagement.snippet),
        600
    ) || "(no comment text)";

    return {
        system: [
            JACK_BASE_SYSTEM_PROMPT,
            "This is a public comment reply.",
            "Keep it short, natural, and peer-to-peer.",
            "If a DM suggestion is natural, you can use it, but never force it.",
            "Here are all the interactions you have had with " + partnerName + " so far:",
            "No prior interactions are available in this notification context.",
            "Respond to the below comment.",
        ].join("\n\n"),
        user: commentText,
    };
}

async function generateReply(openai, post, modelName) {
    modelName = modelName || process.env.OPENAI_MODEL || "gpt-4o";

    var label = post.label || "value";
    var prompt = label === "hook"
        ? buildHookPrompt(post)
        : buildValuePrompt(post);

    var completion = await openai.chat.completions.create({
        model: modelName,
        max_completion_tokens: 200,
        temperature: 0.85,
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
    });

    var reply = (completion.choices[0].message.content || "").trim();
    reply = reply.replace(/⟨BUBBLE⟩/g, " ").replace(/\s{2,}/g, " ").trim();
    return reply;
}

async function generateEngagementReply(openai, engagement, modelName) {
    modelName = modelName || process.env.OPENAI_MODEL || "gpt-4o";

    var prompt = buildEngagementPrompt(engagement);
    var completion = await openai.chat.completions.create({
        model: modelName,
        max_completion_tokens: 150,
        temperature: 0.85,
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
    });

    return (completion.choices[0].message.content || "").trim();
}

module.exports = { generateReply, generateEngagementReply };
