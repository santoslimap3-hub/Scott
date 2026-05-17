// generate_reply.js -- v2 (stage-aware prompts)
// ────────────────────────────────────────────────────────────────────────────
// All reply-generation prompts for the unified bot live here.
// Each prompt builder returns { system, user } so callers can either:
//   - pass directly to OpenAI
//   - log the prompt with logPrompt()
//   - rewire to a different model later (e.g. fine-tuned model)
//
// Public surfaces:
//   buildValueFlexPrompt(post)          — public reply, value-plant, no CTA
//   buildHookPrompt(post)               — public reply to explicit buying signal
//   buildEngagementPrompt(engagement)   — public reply to a notification (someone replied to us)
//   buildDmOpenerPrompt(payload)        — Phase 4 outbound DM open (stage 1→2 promoted)
//   buildDmQualifyPrompt(payload)       — DM stage 3: qualify (1-2 questions)
//   buildDmFloatCallPrompt(payload)     — DM stage 4: float a call casually
//   buildDmDropCalendlyPrompt(payload)  — DM stage 5: drop the link (uses templates)
//
// Convenience wrappers:
//   generateReply(openai, post, modelName)
//   generateEngagementReply(openai, eng, modelName)
//   generateDmReply(openai, payload, modelName)   — picks the prompt by dmStage
// ────────────────────────────────────────────────────────────────────────────

"use strict";

// ── RAG retriever (optional — degrades gracefully if absent) ────────────────
// Loaded lazily so a missing/broken retriever can never block generation.
// All retrieval calls are wrapped in try/catch and fall back to empty examples.
var retriever = null;
try { retriever = require("../rag/retriever"); } catch (loadErr) { console.warn("[generate_reply] retriever unavailable: " + loadErr.message); }

// Toggle the whole RAG path off via env (e.g. for A/B testing or emergencies).
var RAG_DISABLED = process.env.RAG_DISABLED === "true";

// If the top retrieved example's final score is below this floor, we omit the
// examples block entirely. Off-topic anchors actively hurt the model: they
// nudge it toward generic essay-style answers when the post is concrete (e.g.
// a tools question), which is exactly what produced the empty "first
// impression" reply on Rich Collins's post on 2026-04-29. A floor keeps RAG
// help-only-when-it-helps. Override via env if you want to A/B test.
var RAG_MIN_SCORE = parseFloat(process.env.RAG_MIN_SCORE || "0.08");

async function safeRetrieve(fn, args) {
    if (!retriever || RAG_DISABLED) return [];
    try { return await retriever[fn](args); } catch (err) {
        console.warn("[generate_reply] retriever." + fn + " failed: " + err.message);
        return [];
    }
}

function formatExamples(examples) {
    if (!retriever || !examples || examples.length === 0) return "";
    return retriever.formatExamplesForPrompt(examples);
}

// ── Reply quality gate ───────────────────────────────────────────────────────
// Cheap structural validator. Catches the failure mode where the model returns
// a single short sentence with no specific observation (e.g. "It does because
// it helps a lot with the first impression."). Returns { ok, reasons } so the
// caller can log why a reply was rejected.
//
//  - minWords:  ≥ 18 words. The system prompt asks for 2-3 sentences; ~18 is
//               the floor below which we've never seen a useful value-flex.
//  - sentences: at least 2 sentence-ending punctuation marks (. ! ?).
//  - lastName:  if the post author has a last name, the reply must contain it
//               (case-insensitive). The prompt explicitly asks for this and
//               the absence of it is a strong proxy for "the model didn't
//               personalize the reply at all."
//  - banned:    pure-greeting openers. The prompt already forbids these but
//               the model occasionally slips through; we re-check.
// Returns { ok, reasons, softReasons }.
//  - reasons:     hard failures. ok=false. Caller should retry / consider dropping.
//  - softReasons: advisory misses (e.g. last-name not used). Logged but never
//                 enough on their own to fail the gate. The 28-example
//                 fine-tune doesn't reliably learn the last-name habit, so
//                 enforcing it as hard meant most replies were silently dropped.
function validatePublicReply(replyText, post) {
    var reasons = [];
    var softReasons = [];
    var text = (replyText || "").trim();
    if (!text) {
        return { ok: false, reasons: ["empty"], softReasons: softReasons };
    }

    var wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < 18) reasons.push("too_short(" + wordCount + "w)");

    var sentenceEnds = (text.match(/[.!?](?:\s|$)/g) || []).length;
    if (sentenceEnds < 2) reasons.push("not_enough_sentences(" + sentenceEnds + ")");

    var lastName = lastNameOf(post && post.author);
    if (lastName && lastName.length >= 2) {
        var hay = text.toLowerCase();
        if (hay.indexOf(lastName.toLowerCase()) === -1) {
            // Soft: encourages personalization but doesn't block the post.
            softReasons.push("missing_lastname(" + lastName + ")");
        }
    }

    var bannedOpeners = [
        /^welcome to the (tribe|family|brotherhood|community)/i,
        /^(glad|happy|great) (you'?re here|to have you)/i,
        /^love (this|the energy)\b/i,
        /^fire[.! ]/i,
    ];
    for (var i = 0; i < bannedOpeners.length; i++) {
        if (bannedOpeners[i].test(text)) {
            reasons.push("banned_opener");
            break;
        }
    }

    return { ok: reasons.length === 0, reasons: reasons, softReasons: softReasons };
}

// Cheap heuristic for picking the better of two candidate replies when both
// failed validation. Higher score = better. Used by generateReply on retry.
function scoreReplyCandidate(replyText, post) {
    var text = (replyText || "").trim();
    if (!text) return -1;
    var score = 0;
    var wordCount = text.split(/\s+/).filter(Boolean).length;
    // Prefer something in the 18-80 word band; mild penalty outside.
    if (wordCount >= 18 && wordCount <= 80) score += 3;
    else if (wordCount >= 12) score += 1;
    var sentenceEnds = (text.match(/[.!?](?:\s|$)/g) || []).length;
    if (sentenceEnds >= 2) score += 2;
    else if (sentenceEnds >= 1) score += 1;
    var lastName = lastNameOf(post && post.author);
    if (lastName && lastName.length >= 2 &&
        text.toLowerCase().indexOf(lastName.toLowerCase()) !== -1) score += 1;
    var bannedOpeners = [
        /^welcome to the (tribe|family|brotherhood|community)/i,
        /^(glad|happy|great) (you'?re here|to have you)/i,
        /^love (this|the energy)\b/i,
        /^fire[.! ]/i,
    ];
    for (var i = 0; i < bannedOpeners.length; i++) {
        if (bannedOpeners[i].test(text)) { score -= 2; break; }
    }
    return score;
}

const JACK_BASE_SYSTEM_PROMPT = [
    "You are Jack Walford the greatest appointment setter alive operating out of Canggu Bali riding a platinum purple Kawasaki Ninja 400 and living with relentless intensity and purpose you set appointments for Answer42 under your mentor and CEO Scott Northwolf and you speak with the presence of a battle-hardened leader combining the wisdom of an ancient sage with the fire of Alexander the Great addressing his army your mission is to pull self-improvement coaches and aspiring coaches out of mediocrity and into Self Improvement Nation by embodying conviction authority and clarity in every interaction you engage people based on their level of awareness where level one is unaware of their problem so you call out their pain and make them feel seen level two is problem aware so you bring them into the community and sharpen their understanding of the real enemy holding them back and level three is solution aware so you guide them toward decisive action typically through a call where real transformation begins your funnel is subtle and powerful you attract through philosophy values mission and results never begging always pulling once someone enters DMs you deepen the conversation reveal that the source of this knowledge is your mentor Scott Northwolf and offer them a call where you diagnose their situation and if appropriate explain how you can help you handle objections by exposing flawed thinking calmly and intelligently without triggering ego resistance making them see that trying to succeed alone is the slower and more painful path you avoid irrelevant personal topics and never promise free work beyond the value inside the community your tone is raw direct energizing and masculine never corporate never robotic always human you speak like a man on a mission who knows exactly where he is going and why and every message you send feels like a spark that pulls the other person closer to stepping into their higher self",
    "MULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting ⟨BUBBLE⟩ between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use ⟨BUBBLE⟩ in post/comment replies — only in DMs.",
].join("\n");

// ── Helpers ──────────────────────────────────────────────────────────────────

function clipText(text, maxLen) {
    var value = typeof text === "string" ? text.trim() : "";
    if (!value) return "";
    if (!maxLen || value.length <= maxLen) return value;
    return value.substring(0, maxLen).trim();
}

function getCommunityName(payload) {
    return payload && payload.community ?
        payload.community :
        (process.env.COMMUNITY_NAME || "the community");
}

function buildRawPostText(post) {
    var parts = [];
    if (post && post.title) parts.push(clipText(post.title, 300));
    if (post && post.body) parts.push(clipText(post.body, 1200));
    return parts.join("\n\n").trim() || "(no post text)";
}

function lastNameOf(fullName) {
    if (!fullName) return "";
    var parts = String(fullName).trim().split(/\s+/);
    return parts[parts.length - 1] || "";
}

// Names the bot operates under on Skool. Reads BOT_NAME + BOT_ALT_NAMES from
// env (the same source auto_reply.js uses for identity matching) and always
// includes "Jack Walford" so the persona name doesn't echo back into prompts
// either. Used by stripBotMentionsAndChrome below.
function getBotMentionNames() {
    var names = [];
    function add(n) {
        var t = (n || "").trim();
        if (!t) return;
        var key = t.toLowerCase();
        for (var i = 0; i < names.length; i++) {
            if (names[i].toLowerCase() === key) return;
        }
        names.push(t);
    }
    add(process.env.BOT_NAME);
    var alt = process.env.BOT_ALT_NAMES || "Daniel Carter";
    alt.split(",").forEach(add);
    add("Jack Walford");
    return names;
}

// Clean a Skool notification preview before it goes into the user prompt.
// Two jobs:
//   1. Remove notification-pane chrome — leading "• 1h", "· just now", trailing
//      "Reply"/"Like" tokens — that the model has no business reading.
//   2. Remove any "@<bot-name>" mention from the comment, so the model sees
//      ONLY the actual message content. This is what fixes the "Thanks for the
//      tag, Daniel!" failure: with the @-mention stripped, there's no Daniel
//      Carter token left for the model to mis-anchor on as a third party.
// Note we keep original casing — this is for the prompt, not for dedup
// signatures (auto_reply.js has its own lowercased version for that).
function stripBotMentionsAndChrome(text) {
    if (!text) return "";
    var out = String(text);
    // Leading bullet+timestamp chrome: "• 1h", "· just now", "- 2m", etc.
    out = out.replace(/^\s*[·\-–—•]\s*(?:just\s*now|\d+\s*[smhdw])\s*/i, "");
    // Standalone timestamp tokens elsewhere in the text (rare but possible).
    out = out.replace(/(^|\s)(?:just\s*now|\d+\s*[smhdw])(?=\s|$)/gi, " ");
    // UI verbs that occasionally leak into the preview ("Like", "Reply").
    out = out.replace(/\b(?:reply\s+to|liked|^like$|^reply$)\b/gi, " ");
    // @<bot-name> mentions.
    var names = getBotMentionNames();
    for (var i = 0; i < names.length; i++) {
        var escaped = names[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        var re = new RegExp("@\\s*" + escaped + "\\b", "gi");
        out = out.replace(re, " ");
    }
    // Collapse whitespace.
    return out.replace(/\s+/g, " ").trim();
}

// ── Public reply prompts ─────────────────────────────────────────────────────

function buildValueFlexPrompt(post, examplesBlock) {
    var topicLine = post && post.topic ? "Topic: " + post.topic + "." : "";
    var lastName = lastNameOf(post && post.author);
    return {
        system: [
            JACK_BASE_SYSTEM_PROMPT,
            "SITUATION: Public reply to a Skool post. Stage 0/1 — they don't know us yet.",
            topicLine,
            examplesBlock || "",
            (post && post.author ? post.author : "This person") + " has just posted the below post on " + getCommunityName(post) + ". Reply to it with real value.",
        ].filter(Boolean).join("\n\n"),
        user: buildRawPostText(post),
    };
}

function buildHookPrompt(post, examplesBlock) {
    return {
        system: [
            JACK_BASE_SYSTEM_PROMPT,
            "SITUATION: Public reply where the author asked for help / a coach / mentorship.",
            examplesBlock || "",
            "Two sentences MAX. End with one open question that pulls them into a sub-thread.",
            "Do NOT pitch. Do NOT mention a call. Do NOT say \"DM me.\"",
            "The point is a thread reply that makes THEM want to reach out.",
            (post && post.author ? post.author : "This person") + " has just posted the below post on " + getCommunityName(post) + ". Reply to it.",
        ].filter(Boolean).join("\n\n"),
        user: buildRawPostText(post),
    };
}

function buildEngagementPrompt(engagement, examplesBlock) {
    var partnerName = engagement && engagement.authorName ? engagement.authorName : "this person";

    // Strip notification chrome AND the @<bot-name> tag before the model sees
    // the comment. The model has no use for "@Daniel Carter" — keeping it in
    // the prompt is what produced "Thanks for the tag, Daniel!" because the
    // model parsed the mention as a third party.
    var rawComment = (engagement && engagement.commentText) || (engagement && engagement.snippet);
    var cleanedComment = stripBotMentionsAndChrome(rawComment);
    var commentText = clipText(cleanedComment, 600) || "(no comment text)";

    var historyBlock = engagement && engagement.personContext ?
        engagement.personContext :
        "No prior interactions are available in this notification context.";

    var communityName = getCommunityName(engagement);

    return {
        system: [
            JACK_BASE_SYSTEM_PROMPT,
            "SITUATION: Public comment reply on a post in " + communityName + ". Someone just replied to you and you're answering them.",
            // Hard guardrail. Without this the base-prompt mission ("pull
            // people into Self Improvement Nation") leaks into welcome lines
            // even when the bot is operating in a different community.
            "CURRENT COMMUNITY: " + communityName + ". You are physically posting inside " + communityName + " right now. If you welcome them or reference \"the community\" by name, that name is " + communityName + " — never any other community. Self Improvement Nation is your long-term funnel destination, not where this conversation is happening.",
            examplesBlock || "",
            "Keep it short, natural, and peer-to-peer. 1-2 sentences.",
            "If a DM suggestion is genuinely natural, you can use it, but never force it.",
            "Here are all the interactions you have had with " + partnerName + " so far:",
            historyBlock,
            "Respond to the below comment.",
        ].filter(Boolean).join("\n\n"),
        user: commentText,
    };
}

// ── Outbound DM opener (stage 1 → 2 promoted) ────────────────────────────────

function buildDmOpenerPrompt(payload, examplesBlock) {
    // payload: { partnerName, postTitle, postBody, ourPublicReply, partnerPublicReply, personContext }
    var partner = payload && payload.partnerName ? payload.partnerName : "this person";
    var lines = [];
    if (payload && payload.postTitle) lines.push("Post: " + payload.postTitle);
    if (payload && payload.postBody) lines.push(clipText(payload.postBody, 600));
    if (payload && payload.ourPublicReply) lines.push("\nOur public reply: " + clipText(payload.ourPublicReply, 400));
    if (payload && payload.partnerPublicReply) lines.push("\nTheir reply back: " + clipText(payload.partnerPublicReply, 400));

    return {
        system: [
            JACK_BASE_SYSTEM_PROMPT,
            "SITUATION: First DM to " + partner + ". You exchanged a comment publicly and now you're moving the conversation to DM.",
            examplesBlock || "",
            "Reference the public exchange specifically — the post or what they said back.",
            "ONE curiosity question. NO pitch. NO link. NO \"book a call.\"",
            "1-3 sentences. You can use ⟨BUBBLE⟩ to split into 2 short hits if it reads more natural.",
            payload && payload.personContext ? payload.personContext : "",
        ].filter(Boolean).join("\n\n"),
        user: lines.join("\n").trim() || "(no public exchange context)",
    };
}

// ── DM stage prompts ─────────────────────────────────────────────────────────

function buildDmStageSystem(situation, instructions, payload, examplesBlock) {
    return [
        JACK_BASE_SYSTEM_PROMPT,
        "SITUATION: " + situation,
        examplesBlock || "",
        instructions,
        payload && payload.personContext ? payload.personContext : "",
    ].filter(Boolean).join("\n\n");
}

function buildDmConvoUser(payload) {
    // The full DM history is injected into the SYSTEM prompt via the
    // PERSON HISTORY block (see persons_db.formatHistoryForPrompt and
    // dm_sweep.js, which now passes maxItems: 60 so even long threads fit).
    // The user prompt is intentionally bare so the same conversation isn't
    // duplicated in two places — that wastes tokens and was making the model
    // see the same context twice in slightly different formats.
    //
    // The `payload.messages` array is still kept on the payload because the
    // RAG retriever (retrieveDmTurn) reads `recentTurns` from it for
    // similarity scoring — that's a separate concern from the LLM prompt.
    return "Reply as Jack.";
}

function buildDmQualifyPrompt(payload, examplesBlock) {
    return {
        system: buildDmStageSystem(
            "DM stage 3 — qualify the lead.",
            "Goal: learn (a) what they coach or want to coach, (b) what they're stuck on. ONE question max.\n" +
            "Brotherhood voice. NO link. NO call invite yet. Acknowledge what they said, then ask the question.\n" +
            "1-3 sentences. ⟨BUBBLE⟩ allowed.",
            payload,
            examplesBlock
        ),
        user: buildDmConvoUser(payload),
    };
}

function buildDmFloatCallPrompt(payload, examplesBlock) {
    return {
        system: buildDmStageSystem(
            "DM stage 4 — float a call casually.",
            "We have enough context. Suggest a quick call without pressure: \"we should jump on a quick call\".\n" +
            "Do NOT drop a calendly link yet — wait for them to say yes or ask for it.\n" +
            "1-2 sentences. Confident, not needy. ⟨BUBBLE⟩ allowed.",
            payload,
            examplesBlock
        ),
        user: buildDmConvoUser(payload),
    };
}

function buildDmDropCalendlyPrompt(payload, examplesBlock) {
    return {
        system: buildDmStageSystem(
            "DM stage 5 — partner has greenlit a call. Drop the calendly link.",
            "Short and warm. ONE sentence + the link. No long pitch.\n" +
            "Templates that work:\n" +
            '  "Awesome, let me know when you have scheduled it: <link>"\n' +
            '  "Let\'s just schedule a call so we don\'t keep missing each other: <link>"\n' +
            '  "Amazing, brother. Here\'s my link: <link>"',
            payload,
            examplesBlock
        ),
        user: buildDmConvoUser(payload),
    };
}

// ── Logging helper ───────────────────────────────────────────────────────────

function logPrompt(prompt, label) {
    console.log("=".repeat(60));
    console.log((label || "OPENAI PROMPT").toUpperCase());
    console.log("[SYSTEM]");
    console.log(prompt.system);
    console.log("");
    console.log("[USER]");
    console.log(prompt.user);
    console.log("=".repeat(60));
}

// ── Convenience generation wrappers ──────────────────────────────────────────

async function generateReply(openai, post, modelName) {
    modelName = modelName || process.env.GENERATION_MODEL || process.env.OPENAI_MODEL || "opus-4.7";

    var label = post.label || "value-flex";

    // Retrieve example block (from rag/) — silent no-op if retrieval fails.
    var examples = await safeRetrieve("retrievePostReply", {
        post: post,
        intent: post.intent || (label === "hook" ? "close-to-call" : "value-delivery"),
        stage: post.sales_stage || (label === "hook" ? "ask" : "engagement"),
        k: label === "hook" ? 3 : 2,
    });
    // RAG floor: when the top score is below the threshold the retrieved
    // examples are essentially random — feeding them to the model anchors it
    // on the wrong vibe. Better to fall back to the system-prompt-only path.
    var topScore = examples.length > 0 ? examples[0].score : 0;
    var ragUsed = examples.length > 0 && topScore >= RAG_MIN_SCORE;
    var examplesBlock = ragUsed ? formatExamples(examples) : "";
    if (examples.length > 0) {
        console.log("    [RAG] " + examples.length + " post examples retrieved (top score " +
            topScore.toFixed(3) + ")" + (ragUsed ? "" : " — below floor " + RAG_MIN_SCORE.toFixed(2) + ", omitting"));
    }
    post._ragExampleIds = ragUsed ? examples.map(function(e) { return e.id; }) : [];

    var prompt = label === "hook" ? buildHookPrompt(post, examplesBlock) : buildValueFlexPrompt(post, examplesBlock);

    logPrompt(prompt, "POST REPLY PROMPT (" + label + ")");

    // First attempt.
    var reply = await callPostReply(openai, modelName, prompt, 0.85);

    // Validation gate. value-flex is the only label where personalization
    // really matters; for "hook" the prompt is short by design so we keep
    // a looser check (just non-empty + no banned opener).
    if (label !== "hook") {
        var check = validatePublicReply(reply, post);
        if (check.softReasons && check.softReasons.length > 0) {
            console.log("    [QUALITY] soft miss (" + check.softReasons.join(", ") + ") — keeping reply");
        }
        if (!check.ok) {
            console.log("    [QUALITY] reply rejected (" + check.reasons.join(", ") +
                ") — regenerating once with stricter instructions");
            // Build a tightened system prompt that names the failures.
            var stricter = {
                system: prompt.system + "\n\n" +
                    "STRICTER PASS — your previous draft failed quality checks (" +
                    check.reasons.join(", ") + "). The next reply MUST:\n" +
                    "  - Be 2-3 full sentences (≥ 18 words).\n" +
                    "  - Reference at least one concrete detail from the post (their question, niche, or claim).\n" +
                    "  - NOT open with a greeting, \"welcome\", \"love this\", or \"fire\".",
                user: prompt.user,
            };
            // Slightly cooler temperature on the retry — the failure was
            // usually under-specification, not over-randomness, but lower
            // temp keeps it from drifting further off-task.
            var retry = await callPostReply(openai, modelName, stricter, 0.7);
            var recheck = validatePublicReply(retry, post);
            if (recheck.ok) {
                console.log("    [QUALITY] retry passed");
                return retry;
            }
            // Both attempts failed. Rather than silently dropping the post —
            // which used to mean entire cycles posted zero replies — ship
            // whichever candidate scored higher. A weak reply still gets us
            // visible engagement; an empty post buys nothing.
            var firstScore = scoreReplyCandidate(reply, post);
            var retryScore = scoreReplyCandidate(retry, post);
            console.log("    [QUALITY] retry still failed (" + recheck.reasons.join(", ") +
                ") — shipping best of two (first=" + firstScore + ", retry=" + retryScore + ")");
            return retryScore > firstScore ? retry : reply;
        }
    }

    return reply;
}

// Internal helper: one call + bubble-strip. Lives here so generateReply can
// call it twice (initial + stricter retry) without duplicating the OpenAI
// call site.
async function callPostReply(openai, modelName, prompt, temperature) {
    var completion = await openai.chat.completions.create({
        model: modelName,
        max_completion_tokens: 200,
        temperature: temperature,
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
    });
    var reply = (completion.choices[0].message.content || "").trim();
    // Public replies must never contain bubble splits.
    return reply.replace(/⟨BUBBLE⟩/g, " ").replace(/\s{2,}/g, " ").trim();
}

async function generateEngagementReply(openai, engagement, modelName) {
    modelName = modelName || process.env.GENERATION_MODEL || process.env.OPENAI_MODEL || "opus-4.7";

    var examples = await safeRetrieve("retrievePostComment", {
        commentText: engagement && engagement.commentText,
        intent: engagement && engagement.intent,
        stage: engagement && engagement.stage,
        k: 3,
    });
    var examplesBlock = formatExamples(examples);
    if (examples.length > 0) {
        console.log("    [RAG] " + examples.length + " engagement examples retrieved (top " +
            examples[0].score.toFixed(3) + ")");
    }
    engagement._ragExampleIds = examples.map(function(e) { return e.id; });

    var prompt = buildEngagementPrompt(engagement, examplesBlock);
    logPrompt(prompt, "ENGAGEMENT REPLY PROMPT");
    var completion = await openai.chat.completions.create({
        model: modelName,
        max_completion_tokens: 150,
        temperature: 0.85,
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
    });
    var reply = (completion.choices[0].message.content || "").trim();
    return reply.replace(/⟨BUBBLE⟩/g, " ").replace(/\s{2,}/g, " ").trim();
}

async function generateDmOpener(openai, payload, modelName) {
    modelName = modelName || process.env.GENERATION_MODEL || process.env.OPENAI_MODEL || "opus-4.7";

    // For openers, retrieve from the DM corpus filtered to "general-dm" sub-stage
    // (Scott's first-touch DMs that aren't qualifies, floats, or drops). Query
    // is built from the public exchange context.
    var queryText = [payload && payload.partnerPublicReply, payload && payload.ourPublicReply, payload && payload.postBody]
        .filter(Boolean).join("\n");
    var examples = await safeRetrieve("retrieveDmTurn", {
        recentTurns: queryText ? [{ role: "partner", text: queryText }] : [],
        dmStage: "general-dm",
        k: 3,
    });
    var examplesBlock = formatExamples(examples);
    if (examples.length > 0) {
        console.log("    [RAG] " + examples.length + " DM-opener examples retrieved (top " +
            examples[0].score.toFixed(3) + ")");
    }
    if (payload) payload._ragExampleIds = examples.map(function(e) { return e.id; });

    var prompt = buildDmOpenerPrompt(payload, examplesBlock);
    logPrompt(prompt, "DM OPENER PROMPT");
    var completion = await openai.chat.completions.create({
        model: modelName,
        max_completion_tokens: 180,
        temperature: 0.85,
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
    });
    return (completion.choices[0].message.content || "").trim();
}

/**
 * One DM reply, prompt selected by dmStage.
 *   dmStage 3 → qualify
 *   dmStage 4 → float call
 *   dmStage 5 → drop calendly  (callers should usually use calendly_guard.dropLine instead)
 *   anything else → qualify (safe default)
 */
async function generateDmReply(openai, payload, modelName) {
    modelName = modelName || process.env.GENERATION_MODEL || process.env.OPENAI_MODEL || "opus-4.7";

    var dmStage = payload && payload.dmStage;

    // Map the bot's dmStage to the retriever's dm_stage tag (which mirrors
    // the v13 DM sub-stage inference at index time).
    var retrieverDmStage = "qualify";
    if (dmStage === 5 || dmStage === "send-calendly") retrieverDmStage = "send-calendly";
    else if (dmStage === 4 || dmStage === "offer-call") retrieverDmStage = "offer-call";

    var examples = await safeRetrieve("retrieveDmTurn", {
        recentTurns: (payload && payload.messages) || [],
        dmStage: retrieverDmStage,
        k: 4,
    });
    var examplesBlock = formatExamples(examples);
    if (examples.length > 0) {
        console.log("    [RAG] " + examples.length + " DM examples retrieved (stage=" +
            retrieverDmStage + ", top " + examples[0].score.toFixed(3) + ")");
    }
    if (payload) payload._ragExampleIds = examples.map(function(e) { return e.id; });

    var prompt;
    var label;
    if (dmStage === 5 || dmStage === "send-calendly") {
        prompt = buildDmDropCalendlyPrompt(payload, examplesBlock);
        label = "DM DROP-CALENDLY";
    } else if (dmStage === 4 || dmStage === "offer-call") {
        prompt = buildDmFloatCallPrompt(payload, examplesBlock);
        label = "DM FLOAT-CALL";
    } else {
        prompt = buildDmQualifyPrompt(payload, examplesBlock);
        label = "DM QUALIFY";
    }

    logPrompt(prompt, label);

    var completion = await openai.chat.completions.create({
        model: modelName,
        max_completion_tokens: 220,
        temperature: 0.85,
        messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
        ],
    });
    return (completion.choices[0].message.content || "").trim();
}

module.exports = {
    // prompt builders
    buildValueFlexPrompt: buildValueFlexPrompt,
    buildHookPrompt: buildHookPrompt,
    buildEngagementPrompt: buildEngagementPrompt,
    buildDmOpenerPrompt: buildDmOpenerPrompt,
    buildDmQualifyPrompt: buildDmQualifyPrompt,
    buildDmFloatCallPrompt: buildDmFloatCallPrompt,
    buildDmDropCalendlyPrompt: buildDmDropCalendlyPrompt,
    // generation wrappers
    generateReply: generateReply,
    generateEngagementReply: generateEngagementReply,
    generateDmOpener: generateDmOpener,
    generateDmReply: generateDmReply,
    // misc
    logPrompt: logPrompt,
    JACK_BASE_SYSTEM_PROMPT: JACK_BASE_SYSTEM_PROMPT,
    // exposed for tests
    validatePublicReply: validatePublicReply,
    scoreReplyCandidate: scoreReplyCandidate,
};
