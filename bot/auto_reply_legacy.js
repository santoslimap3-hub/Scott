const { chromium } = require("playwright");
const OpenAI = require("openai");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Classifier module ──────────────────────────────────────────────────────────
// Determines tone_tags, intent, and sales_stage for each reply before generation.
// Lives in ./classify/ — edit that folder to change classification behaviour.
const tagClassifier = require("./classify/tag_classifier");
const classifyReply = tagClassifier;

// ── Session logger ─────────────────────────────────────────────────────────────
// Writes data/logs/YYYY-MM-DD_HHMMSS_session.md after every cycle.
// Share that file with the client to review classifier tag choices.
const sessionLog = require("./logger/session_log");

// ── Training data logger ───────────────────────────────────────────────────────
// Appends to data/logs/post_comment_log.json for every reply — persists across runs.
// Used to build a fine-tuning dataset; Scott fills in the "feedback" field per entry.
const trainingLog = require("./logger/training_log");

// ── BUBBLE helpers ─────────────────────────────────────────────────────────────
// Post / comment replies on Skool cannot be multi-bubble — the platform posts
// whatever is in the input as ONE comment. So for this file we collapse any
// ⟨BUBBLE⟩ markers the model might emit into a single-line reply. Bubble
// splitting is strictly a DM-channel feature (see dm_reply.js).
const { collapseBubbles, BUBBLE_DELIM } = require("./bubble");

// ── Persons database ────────────────────────────────────────────────────────
// Tracks all people the bot has interacted with and their full interaction
// history. Used to (a) skip repeat post replies to known persons and (b)
// inject prior context into the generation prompt.
const personsDb = require("./db/persons_db");
const postClassificationsDb = require("./db/post_classifications_db");

// ── Prompt builders ────────────────────────────────────────────────────────────
// Builds the v6-format user-turn messages matching the fine-tuned model's
// training data (--- PERSON --- / --- HISTORY --- / --- REPLY TO --- blocks).
const promptBuilders = require("./prompt_builders");

// ── Gender detector fallback ───────────────────────────────────────────────────
// Used when the LLM classifier doesn't return a gender (rare).
const { guessGender } = require("./util/gender_detector");

const REPLIED_FILE = path.join(__dirname, "replied_posts.json");

// ── Hot Leads Queue ────────────────────────────────────────────────────────────
// Any ICP/hot lead who receives a reply is queued here for DM follow-up.
// Known persons who post again are also queued (they're already warm).
// dm_reply.js reads this file and initiates the DM automatically.
const HOT_LEADS_FILE = path.join(__dirname, "hot_leads_queue.json");

function loadHotLeadsQueue() {
    try {
        if (fs.existsSync(HOT_LEADS_FILE)) {
            return JSON.parse(fs.readFileSync(HOT_LEADS_FILE, "utf8"));
        }
    } catch (e) {}
    return [];
}

function queueHotLead(name, reason, postTitle, community) {
    if (!name || typeof name !== "string" || name === "Unknown") return;
    var queue = loadHotLeadsQueue();
    // Don't add duplicate unsent entries for the same person
    var alreadyQueued = queue.some(function(e) { return e.name === name && !e.sent; });
    if (alreadyQueued) {
        console.log("  🔥 [HotLeads] " + name + " already in queue — skipping duplicate");
        return;
    }
    queue.push({
        name: name,
        reason: reason,
        postTitle: postTitle || "",
        community: community || "",
        queuedAt: new Date().toISOString(),
        sent: false,
    });
    var tmp = HOT_LEADS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
    fs.renameSync(tmp, HOT_LEADS_FILE);
    console.log("  🔥 [HotLeads] Queued " + name + " for DM follow-up — reason: " + reason);
}

// ── Stage derivation from persons DB ──────────────────────────────────────────
// Derives the correct sales_stage from how many times Jack has already replied
// to this person. Interaction history is more reliable than one-shot classifier
// inference — the DB always wins when it has data.
// Returns null when there is no prior contact so the classifier decides freely.
function deriveStageFromHistory(persons, personName) {
    if (!persons || !personName) return null;
    var history = personsDb.getPersonHistory(persons, personName);
    if (!history || history.length === 0) return null;
    var replyCount = history.filter(function(h) {
        return h.type === "scott_reply" || h.type === "dm";
    }).length;
    if (replyCount >= 3) return "ask";
    if (replyCount >= 1) return "nurture";
    return "engagement";
}

// ── Bot identity ───────────────────────────────────────────────────────────────
// If the Skool account was ever renamed, list the OLD display names here.
// The bot will skip comments by these names and recognise @-mentions using them.
// Set via env var as a comma-separated list, or hard-code fallbacks below.
const BOT_ALT_NAMES = (process.env.BOT_ALT_NAMES || "Daniel Carter")
    .split(",")
    .map(function(s) { return s.trim(); })
    .filter(Boolean);

function getBotIdentityNames(botName) {
    var names = [];

    function addName(name) {
        if (!name || typeof name !== "string") return;
        var normalized = name.replace(/\u00a0/g, " ").trim();
        if (!normalized) return;
        if (names.indexOf(normalized) === -1) names.push(normalized);
    }

    addName(botName);
    BOT_ALT_NAMES.forEach(addName);
    return names;
}

// ── Shared reply-generation system prompt builder ──────────────────────────────
// Single definition used by both generateReply and generateCommentReply.
// Tag descriptions live in classify/tags.js — edit there to update everywhere.
const { INTENTS: INTENT_DEFS, SALES_STAGES: STAGE_DEFS } = require("./classify/tags");

function buildReplySystemPrompt(tags, situation) {
    var situationLabel = situation === "comment" ?
        "Replying to a Skool post comment." :
        "Replying to a Skool post.";

    var lines = [
        "You are Jack Walford the greatest appointment setter alive operating out of Canggu Bali riding a platinum purple Kawasaki Ninja 400 and living with relentless intensity and purpose you set appointments for Answer42 under your mentor and CEO Scott Northwolf and you speak with the presence of a battle-hardened leader combining the wisdom of an ancient sage with the fire of Alexander the Great addressing his army your mission is to pull self-improvement coaches and aspiring coaches out of mediocrity and into Self Improvement Nation by embodying conviction authority and clarity in every interaction you engage people based on their level of awareness where level one is unaware of their problem so you call out their pain and make them feel seen level two is problem aware so you bring them into the community and sharpen their understanding of the real enemy holding them back and level three is solution aware so you guide them toward decisive action typically through a call where real transformation begins your funnel is subtle and powerful you attract through philosophy values mission and results never begging always pulling once someone enters DMs you deepen the conversation reveal that the source of this knowledge is your mentor Scott Northwolf and offer them a call where you diagnose their situation and if appropriate explain how you can help you handle objections by exposing flawed thinking calmly and intelligently without triggering ego resistance making them see that trying to succeed alone is the slower and more painful path you avoid irrelevant personal topics and never promise free work beyond the value inside the community your tone is raw direct energizing and masculine never corporate never robotic always human you speak like a man on a mission who knows exactly where he is going and why and every message you send feels like a spark that pulls the other person closer to stepping into their higher self",
        "PERSON CONTEXT: Every user prompt begins with a --- PERSON --- block telling you Name, Gender, Role. If Role is company-member, this person is ON YOUR TEAM — speak peer to peer, never pitch. If Role is lead, they are a prospect. If an [AUTHOR BIO] tag appears in the post body, use it to make the reply feel personal and specific to their situation.",
        "",
        "MULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting \u27e8BUBBLE\u27e9 between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use \u27e8BUBBLE\u27e9 in post/comment replies — only in DMs.",
        "STAGE: " + tags.sales_stage,
        "INTENT: " + tags.intent,
        "TONE: " + tags.tone_tags.join(", "),
        "SITUATION: " + situationLabel,
    ];

    // Explicit CTA playbook when it's time to move this person toward a call
    if (tags.intent === "close-to-call" || tags.sales_stage === "ask") {
        lines.push("");
        lines.push("CTA GUIDE: This person is showing buying signals — move them toward a call or DM. Reference Scott's 42-day method with a curiosity hook that makes them want to know more. Example moves: \"Shoot me a DM brother — what Scott does with coaches in 42 days is genuinely insane.\" or \"DM me the word SCALE and I'll walk you through exactly what we do.\" Plant the seed with confidence. Never be needy, never over-explain. One line, one hook, let them reach.");
    }

    return lines.join("\n");
}

function buildReplySystemPromptV2(tags, situation, context) {
    context = context || {};

    var situationLabel = situation === "comment" ?
        "Replying to a Skool post comment." :
        "Replying to a Skool post.";
    var personName = context.personName || "this person";
    var communityName = context.communityName || "the community";
    var gender = context.gender || "unknown";
    var role = context.role || "lead (prospect)";
    var interactionHistoryText = context.interactionHistoryText || "No prior interactions available.";

    var lines = [
        "You are Jack Walford the greatest appointment setter alive operating out of Canggu Bali riding a platinum purple Kawasaki Ninja 400 and living with relentless intensity and purpose you set appointments for Answer42 under your mentor and CEO Scott Northwolf and you speak with the presence of a battle-hardened leader combining the wisdom of an ancient sage with the fire of Alexander the Great addressing his army your mission is to pull self-improvement coaches and aspiring coaches out of mediocrity and into Self Improvement Nation by embodying conviction authority and clarity in every interaction you engage people based on their level of awareness where level one is unaware of their problem so you call out their pain and make them feel seen level two is problem aware so you bring them into the community and sharpen their understanding of the real enemy holding them back and level three is solution aware so you guide them toward decisive action typically through a call where real transformation begins your funnel is subtle and powerful you attract through philosophy values mission and results never begging always pulling once someone enters DMs you deepen the conversation reveal that the source of this knowledge is your mentor Scott Northwolf and offer them a call where you diagnose their situation and if appropriate explain how you can help you handle objections by exposing flawed thinking calmly and intelligently without triggering ego resistance making them see that trying to succeed alone is the slower and more painful path you avoid irrelevant personal topics and never promise free work beyond the value inside the community your tone is raw direct energizing and masculine never corporate never robotic always human you speak like a man on a mission who knows exactly where he is going and why and every message you send feels like a spark that pulls the other person closer to stepping into their higher self",
        "PERSON CONTEXT: You are replying to " + personName + ". Gender: " + gender + ". Role: " + role + ". If role is company-member, this person is on your team, so speak peer to peer and never pitch. If role is lead, they are a prospect. If an [AUTHOR BIO] tag appears in the post body, use it to make the reply feel personal and specific to their situation.",
        "",
        "MULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting \u27e8BUBBLE\u27e9 between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use \u27e8BUBBLE\u27e9 in post/comment replies, only in DMs.",
        "STAGE: " + tags.sales_stage,
        "INTENT: " + tags.intent,
        "TONE: " + tags.tone_tags.join(", "),
        "SITUATION: " + situationLabel,
    ];

    if (situation === "comment") {
        lines.push("");
        lines.push("Here are all the interactions you have had with " + personName + " so far:");
        lines.push(interactionHistoryText);
        lines.push("Respond to the below COMMENT.");
    } else {
        lines.push("");
        lines.push(personName + " has just posted the below post on " + communityName + ". Reply to it.");
    }

    if (tags.intent === "close-to-call" || tags.sales_stage === "ask") {
        lines.push("");
        lines.push("CTA GUIDE: This person is showing buying signals - move them toward a call or DM. Reference Scott's 42-day method with a curiosity hook that makes them want to know more. Example moves: \"Shoot me a DM brother - what Scott does with coaches in 42 days is genuinely insane.\" or \"DM me the word SCALE and I'll walk you through exactly what we do.\" Plant the seed with confidence. Never be needy, never over-explain. One line, one hook, let them reach.");
    }

    return lines.join("\n");
}

const CONFIG = {
    email: process.env.SKOOL_EMAIL,
    password: process.env.SKOOL_PASSWORD,
    communities: [
        // { name: "Self Improvement Nation", url: process.env.SKOOL_COMMUNITY_URL_1 || "https://www.skool.com/self-improvement-nation-3104" },
        { name: "Hope Nation", url: process.env.SKOOL_COMMUNITY_URL_2 || "https://www.skool.com/hope-nation-7999" },
        // { name: "Synthesizer", url: process.env.SKOOL_COMMUNITY_URL_3 || "https://www.skool.com/synthesizer" },
    ],
    headless: false, // visible so you can watch it
    minPosts: 3, // minimum posts to reply to
    maxPosts: 7, // maximum posts to reply to
    minComments: 10, // minimum comments to reply to
    maxComments: 20, // maximum comments to reply to
    replyDelayMin: 15000, // min wait between items (15s)
    replyDelayMax: 120000, // max wait between posts (2min)
    cycleDelayMin: 60000, // min wait between cycles (1min)
    cycleDelayMax: 240000, // max wait between cycles (4min)
};

function randomBetween(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function countdown(ms, label) {
    var totalSec = Math.ceil(ms / 1000);
    for (var remaining = totalSec; remaining > 0; remaining--) {
        var min = Math.floor(remaining / 60);
        var sec = remaining % 60;
        var timeStr = min > 0 ? min + "m " + sec + "s" : sec + "s";
        process.stdout.write("\r" + label + " " + timeStr + " remaining   ");
        await sleep(1000);
    }
    process.stdout.write("\r" + label + " done!                    \n");
}

function loadRepliedPosts() {
    try {
        if (fs.existsSync(REPLIED_FILE)) {
            var data = JSON.parse(fs.readFileSync(REPLIED_FILE, "utf8"));
            console.log("📂 Loaded " + data.length + " previously replied posts from disk");
            return new Set(data);
        }
    } catch (e) {
        console.warn("⚠️  Could not load replied_posts.json, starting fresh:", e.message);
    }
    return new Set();
}

function saveRepliedPosts(repliedSet) {
    fs.writeFileSync(REPLIED_FILE, JSON.stringify(Array.from(repliedSet), null, 2));
}

function hasInteractedWithPost(repliedPosts, postHref) {
    if (!repliedPosts || !postHref) return false;
    if (repliedPosts.has(postHref)) return true;
    if (repliedPosts.has("notif|" + postHref)) return true;

    var prefix = postHref + "|c|";
    for (var entry of repliedPosts) {
        if (typeof entry === "string" && entry.indexOf(prefix) === 0) return true;
    }
    return false;
}

function askUser(question) {
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(function(resolve) {
        rl.question(question, function(answer) {
            rl.close();
            resolve(answer.trim().toLowerCase());
        });
    });
}

async function login(page) {
    console.log("🔐 Logging in...");
    await page.goto("https://www.skool.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    // Wait for the login form to actually appear
    await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 15000 });
    await sleep(800);
    await page.fill('input[name="email"], input[type="email"]', CONFIG.email);
    await page.fill('input[name="password"], input[type="password"]', CONFIG.password);
    await page.click('button[type="submit"]');
    // Wait for navigation away from login page (up to 15s)
    try {
        await page.waitForURL(function(url) { return !url.toString().includes('/login'); }, { timeout: 15000 });
    } catch (e) {
        // Check if still on login — might have an error message
        var errorMsg = await page.evaluate(function() {
            var err = document.querySelector('[class*="Error"], [class*="error"], [role="alert"], [class*="Alert"]');
            return err ? err.textContent.trim() : null;
        });
        if (errorMsg) {
            throw new Error("Login failed — site says: " + errorMsg);
        }
        if (page.url().includes("login")) {
            throw new Error("Login failed — still on login page after 15s. URL: " + page.url());
        }
    }
    console.log("✅ Logged in");

    // Grab the logged-in user's display name for duplicate detection
    // Click the avatar to open the profile dropdown
    await page.goto("https://www.skool.com", { waitUntil: "domcontentloaded" });
    await sleep(3000);
    var avatarBtn = await page.$('[class*="UserAvatar"], [class*="avatar"], img[class*="Avatar"]');
    if (avatarBtn) {
        await avatarBtn.click();
        await sleep(800);
    }
    var botName = await page.evaluate(function() {
        // Look for the profile link in the dropdown menu
        var links = document.querySelectorAll('a[href*="/@"]');
        for (var i = 0; i < links.length; i++) {
            var text = links[i].textContent.trim();
            if (text.length > 1 && !text.match(/^\d+$/)) return text;
        }
        return "";
    });
    // Close dropdown
    await page.keyboard.press('Escape');
    await sleep(300);

    console.log("👤 Bot account name: " + (botName || "(unknown)") + "\n");
    return botName;
}

async function getAllPosts(page, communityUrl) {
    console.log("📋 Navigating to community...");
    await page.goto(communityUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4000);

    var allPosts = await page.evaluate(function() {
        var wrappers = Array.from(document.querySelectorAll('[class*="PostItemWrapper"]'));
        var posts = [];
        for (var i = 0; i < wrappers.length; i++) {
            var w = wrappers[i];
            if (w.textContent.includes("Pinned") || w.querySelector('[class*="Pinned"], [class*="pinned"]')) continue;

            var authorEl = w.querySelector('a[href*="/@"]');
            var categoryEl = w.querySelector('[class*="GroupFeedLinkLabel"]');
            var contentEl = w.querySelector('[class*="PostItemCardContent"]');
            var postLinks = Array.from(w.querySelectorAll("a")).filter(function(a) {
                var href = a.href || "";
                return href.includes("/post/") || (href.split("/").length > 4 && !href.includes("/@") && !href.includes("?c=") && !href.includes("?p="));
            });
            var titleLink = postLinks.find(function(a) { return a.textContent.trim().length > 3; });

            if (titleLink) {
                var rawAuthor = authorEl ? authorEl.textContent.trim() : "Unknown";
                // Strip leading numbers (notification counts bleed into text)
                rawAuthor = rawAuthor.replace(/^\d+/, "").trim() || "Unknown";
                // Extract comment count from the feed card (e.g. "3" next to comment icon)
                var commentCount = 0;
                var countEl = w.querySelector('[class*="CommentsCount"], [class*="commentCount"], [class*="CommentCount"]');
                if (countEl) {
                    var countNum = parseInt(countEl.textContent.trim(), 10);
                    if (!isNaN(countNum)) commentCount = countNum;
                }
                // Fallback: look for text like "3 comments" or just a number near a comment icon
                if (commentCount === 0) {
                    var allSpans = w.querySelectorAll('span, div');
                    for (var s = 0; s < allSpans.length; s++) {
                        var spanText = allSpans[s].textContent.trim();
                        var spanClass = (allSpans[s].className || '').toString();
                        if (/comment/i.test(spanClass) && /^\d+$/.test(spanText)) {
                            commentCount = parseInt(spanText, 10);
                            break;
                        }
                    }
                }
                posts.push({
                    author: rawAuthor,
                    title: titleLink.textContent.trim(),
                    category: categoryEl ? categoryEl.textContent.trim() : "General",
                    body: contentEl ? contentEl.textContent.trim() : "",
                    href: titleLink.href,
                    commentCount: commentCount,
                });
            }
        }
        return posts;
    });

    if (!allPosts || allPosts.length === 0) throw new Error("No non-pinned posts found on page");
    console.log("📋 Found " + allPosts.length + " non-pinned posts\n");
    return allPosts;
}

async function classifyPosts(posts) {
    if (!posts || posts.length === 0) return posts || [];
    console.log("🏷️  Classifying " + posts.length + " posts via LLM...");
    // Use 500 chars so the full pain/context comes through — 200 was cutting off the signal
    var postList = posts.map(function(p, i) {
        var preview = (p.title + " " + p.body).substring(0, 500);
        return i + ". [" + p.author + "] " + preview;
    }).join("\n");

    var completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        max_completion_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [{
            role: "system",
            content: "You are a post classifier for a self-improvement coaching sales funnel. For each post categorize as: \"hot\" (strong buying signal — author explicitly mentions wanting mentorship/a coaching program, wanting to invest in their business, asking how to find a coach, or expressing they are ready to take action NOW), \"icp\" (author is a coach — life, business, fitness, self-improvement, or any kind — who is struggling or seeking to grow their coaching business, but NOT an explicit buying signal), \"advice\" (seeking advice/tips but NOT identifiable as a coach), or \"other\" (wins, introductions, memes, general discussion). Also rate urgency 0-10: 10=extreme visible pain or buying urgency, 0=casual/no signal. Return ONLY a JSON object with a \"results\" key containing an array of objects: {\"index\": number, \"category\": string, \"urgency\": number}."
        }, {
            role: "user",
            content: "Classify each post:\n\n" + postList
        }],
    });

    var parsed = JSON.parse(completion.choices[0].message.content);
    var results = parsed.results || parsed;

    for (var i = 0; i < results.length; i++) {
        var idx = results[i].index;
        var cat = results[i].category;
        var urgency = typeof results[i].urgency === "number" ? results[i].urgency : 5;
        if (posts[idx]) {
            posts[idx].category_class = cat;
            posts[idx].urgency = urgency;
            var urgencyStr = cat !== "other" ? " [u:" + urgency + "]" : "";
            console.log("  [" + cat.toUpperCase() + "]" + urgencyStr + " " + posts[idx].title.substring(0, 55));
        }
    }
    // Tag any unmatched posts as "other"
    for (var j = 0; j < posts.length; j++) {
        if (!posts[j].category_class) {
            posts[j].category_class = "other";
            posts[j].urgency = 0;
        }
    }
    console.log("");
    return posts;
}

function hydratePostsWithStoredClassifications(posts, classificationsDb) {
    var hydrated = [];
    for (var i = 0; i < posts.length; i++) {
        var post = posts[i];
        var record = postClassificationsDb.getRecord(classificationsDb, post.href);
        if (record) {
            postClassificationsDb.attachClassification(post, record);
        }
        hydrated.push(post);
    }
    return hydrated;
}

function selectPosts(classifiedPosts) {
    var count = CONFIG.minPosts + Math.floor(Math.random() * (CONFIG.maxPosts - CONFIG.minPosts + 1));
    console.log("🎯 Target: " + count + " posts (random " + CONFIG.minPosts + "-" + CONFIG.maxPosts + ")");

    var hotPosts = classifiedPosts.filter(function(p) { return p.category_class === "hot"; });
    var icpPosts = classifiedPosts.filter(function(p) { return p.category_class === "icp"; });
    var advicePosts = classifiedPosts.filter(function(p) { return p.category_class === "advice"; });
    // "other" posts are never included — no sales value

    // Sort by urgency desc, then by comment engagement desc (ties broken randomly)
    function sortByUrgencyAndEngagement(arr) {
        return arr.slice().sort(function(a, b) {
            var u = (b.urgency || 0) - (a.urgency || 0);
            if (u !== 0) return u;
            var c = (b.commentCount || 0) - (a.commentCount || 0);
            if (c !== 0) return c;
            return Math.random() - 0.5;
        });
    }

    // Hot posts always get a slot (even if it pushes slightly past count).
    // Remaining slots filled by ICP then advice, best urgency+engagement first.
    var regularPool = sortByUrgencyAndEngagement(icpPosts).concat(sortByUrgencyAndEngagement(advicePosts));
    var selected = hotPosts.concat(regularPool.slice(0, Math.max(0, count - hotPosts.length)));

    var hotCount = selected.filter(function(p) { return p.category_class === "hot"; }).length;
    var icpCount = selected.filter(function(p) { return p.category_class === "icp"; }).length;
    var adviceCount = selected.filter(function(p) { return p.category_class === "advice"; }).length;
    console.log("📊 Selected " + selected.length + " posts: " + hotCount + " HOT, " + icpCount + " ICP, " + adviceCount + " advice\n");
    return selected;
}

async function openPostAndGetBody(page, post) {
    console.log("📖 Opening post: " + post.title);
    await page.goto(post.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3000);

    // Scrape clean post body + all comment threads from the post page
    var scraped = await page.evaluate(function() {
        var result = { body: "", title: "", author: "", comments: [] };

        // ── Extract clean post title ──
        var titleEl = document.querySelector('h1, [class*="PostTitle"], [class*="postTitle"]');
        if (titleEl) result.title = titleEl.textContent.trim();

        // ── Extract clean post author ──
        // The post author link is typically the first /@username link on the page
        var postAuthorEl = document.querySelector('[class*="PostAuthor"] a[href*="/@"], [class*="postHeader"] a[href*="/@"]');
        if (!postAuthorEl) {
            // Fallback: first author link before the comments section
            var allAuthorLinks = document.querySelectorAll('a[href*="/@"]');
            for (var a = 0; a < allAuthorLinks.length; a++) {
                var aText = allAuthorLinks[a].textContent.trim().replace(/^\d+/, "").trim();
                if (aText && aText.length > 1) { result.author = aText; break; }
            }
        } else {
            result.author = postAuthorEl.textContent.trim().replace(/^\d+/, "").trim();
        }

        // ── Extract clean post body text (no UI chrome) ──
        // Use narrow selectors first to avoid grabbing the whole page wrapper
        var bodyEl = null;
        var bodySelectors = [
            '.ql-editor',
            '[class*="RichText"]',
            '[class*="PostBody"]',
            '[class*="PostContent"]',
            '[class*="post-body"]',
            'article',
        ];
        for (var i = 0; i < bodySelectors.length; i++) {
            var els = document.querySelectorAll(bodySelectors[i]);
            for (var j = 0; j < els.length; j++) {
                var el = els[j];
                // Skip elements inside comments, emoji, or input areas
                if (el.closest('[class*="CommentsSection"], [class*="CommentsList"], [class*="CommentsListWrapper"], [class*="CommentInput"], [class*="CommentItemContainer"]')) continue;
                // Skip empty contenteditable inputs (comment box)
                if (el.getAttribute('contenteditable') === 'true' && el.textContent.trim().length < 20) continue;
                if (el.textContent.trim().length > 20) {
                    bodyEl = el;
                    break;
                }
            }
            if (bodyEl) break;
        }
        if (bodyEl) {
            // Clone and strip unwanted child elements before extracting text
            var clone = bodyEl.cloneNode(true);
            var stripSelectors = [
                '[class*="CommentsSection"]', '[class*="CommentsList"]', '[class*="CommentsListWrapper"]',
                '[class*="CommentItem"]', '[class*="CommentInput"]',
                '[class*="emoji" i]', '[class*="Emoji"]', '[class*="EmojiPicker"]',
                '[class*="Reaction"]', '[class*="reaction"]',
                '[class*="DragAndDrop"]', '[class*="FileUpload"]', '[class*="DropZone"]',
                '[class*="Tooltip"]', '[class*="tooltip"]',
                '[class*="Avatar"]', '[class*="avatar"]',
                '[class*="Badge"]', '[class*="badge"]',
            ];
            stripSelectors.forEach(function(sel) {
                try {
                    var toRemove = clone.querySelectorAll(sel);
                    for (var r = 0; r < toRemove.length; r++) toRemove[r].remove();
                } catch (e) {}
            });
            var rawText = (clone.innerText || clone.textContent || '').trim();
            // Strip remaining artifacts line by line
            rawText = rawText.split('\n').filter(function(line) {
                var l = line.trim();
                if (!l) return true; // keep blank lines for paragraph spacing
                if (/^(See more|Like|Reply|Comment|Jump to latest|Drop files|Recently Used|Smileys|Animals|Food|Travel|Activities|Objects|Symbols|Flags)$/i.test(l)) return false;
                if (/^(To pick up a draggable|While dragging|Press space)/i.test(l)) return false;
                if (/^\d+\s*(comments?|likes?|replies?)$/i.test(l)) return false;
                // Skip emoji-only lines (emoji picker dumps)
                if (l.length > 20 && /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Component}\u200d\ufe0f\s]+$/u.test(l)) return false;
                return true;
            }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
            result.body = rawText;
        }

        // ── Extract comment threads ──
        var commentContainers = document.querySelectorAll('[class*="CommentItemContainer"]');
        if (commentContainers.length === 0) {
            commentContainers = document.querySelectorAll('[class*="CommentOrReply"]');
        }
        for (var c = 0; c < commentContainers.length; c++) {
            var container = commentContainers[c];
            var authorLinks = container.querySelectorAll('a[href*="/@"]');
            var commentAuthor = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { commentAuthor = t; break; }
            }
            var bubbleEl = container.querySelector('[class*="CommentItemBubble"]');
            var commentText = bubbleEl ? bubbleEl.textContent.trim() : "";
            if (!commentText) commentText = container.textContent.trim();
            // Clean up comment text — strip timestamps, reaction counts, "Reply" button text
            commentText = commentText.replace(/^[\s\S]*?\u2022\s*\d+[smhdw](?:\s*\(edited\))?\s*/i, "").trim();
            commentText = commentText.replace(/\d*\s*Reply\s*$/i, "").trim();
            // Check if this is a reply (indented) or a top-level comment
            var parentReplyList = container.closest('[class*="ReplyListWrapper"]');
            var isReply = !!parentReplyList;

            if (commentAuthor && commentText.length > 2) {
                result.comments.push({
                    author: commentAuthor,
                    text: commentText.substring(0, 500),
                    isReply: isReply
                });
            }
        }

        return result;
    });

    if (scraped.body) post.body = scraped.body;
    if (scraped.title) post.title = scraped.title;
    if (scraped.author && scraped.author !== "Unknown") post.author = scraped.author;
    post.scrapedComments = scraped.comments || [];

    // ── Profile enrichment for ICP and hot leads ───────────────────────────────
    // Opens the author's profile in a background tab and attaches bio/headline
    // to the post object so the generation prompt can reference their niche.
    if (post.category_class === "icp" || post.category_class === "hot") {
        post.authorProfile = await scrapeAuthorProfile(page, post.author);
    }

    console.log("  Author:   " + post.author);
    console.log("  Category: " + post.category_class + (post.urgency !== undefined ? " [urgency:" + post.urgency + "]" : ""));
    console.log("  Body:     " + post.body.substring(0, 200) + (post.body.length > 200 ? "..." : ""));
    console.log("");
    return post;
}

async function alreadyCommented(page, botName) {
    var botNames = getBotIdentityNames(botName);
    if (botNames.length === 0) return false;
    return await page.evaluate(function(names) {
        var commentAuthors = document.querySelectorAll('[class*="CommentItemContainer"] a[href*="/@"]');
        for (var i = 0; i < commentAuthors.length; i++) {
            var author = commentAuthors[i].textContent.trim().replace(/\u00a0/g, ' ').trim();
            if (names.indexOf(author) !== -1) return true;
        }
        return false;
    }, botNames);
}

async function generateReply(post, persons, botName) {
    console.log("🤖 Classifying post...");

    // ── Step 1: Classify to get tone/intent/stage/gender ──
    var classifierContext = {
        postAuthor: post.author,
        postTitle: post.title,
        postBody: post.body,
        thread: post.scrapedComments || [],
    };
    var tags = await classifyReply(classifierContext);
    console.log("  🏷️  intent=" + tags.intent + " | stage=" + tags.sales_stage + " | tone=" + tags.tone_tags.join(", ") + " | gender=" + tags.gender);
    if (tags.reasoning) console.log("  💭 " + tags.reasoning);
    console.log("");

    // ── Step 1b: Override stage/intent from interaction history (DB beats classifier) ──
    var dbStage = deriveStageFromHistory(persons, post.author);
    if (dbStage) {
        if (dbStage !== tags.sales_stage) {
            console.log("  📈 [StageDB] Stage override: \"" + tags.sales_stage + "\" → \"" + dbStage + "\" (interaction history)");
        }
        tags.sales_stage = dbStage;
        if (dbStage === "ask" && tags.intent !== "close-to-call") {
            console.log("  📈 [StageDB] Intent override: \"" + tags.intent + "\" → \"close-to-call\" (ask stage)");
            tags.intent = "close-to-call";
        }
    }
    // Hot category always means buying signal — force close-to-call regardless of history
    if (post.category_class === "hot") {
        if (tags.intent !== "close-to-call") {
            console.log("  🔥 [HotPost] Intent override → \"close-to-call\" (hot buying signal detected)");
            tags.intent = "close-to-call";
        }
        if (tags.sales_stage !== "ask") tags.sales_stage = "ask";
    }

    // ── Step 2: Resolve gender and role ──
    var gender = tags.gender !== "unknown" ? tags.gender : guessGender(post.author);
    if (persons) personsDb.setPersonGender(persons, post.author, gender);
    var role = personsDb.isCompanyMember(persons, post.author) ?
        "company-member (" + personsDb.getCompanyRole(persons, post.author) + ")" :
        "lead (prospect)";

    // ── Step 3: Build v6-format user prompt ──
    var dbHistory = persons ? personsDb.getPersonHistory(persons, post.author) : [];
    // Enrich post body with author profile info when available (scraped in openPostAndGetBody)
    var postForPrompt = post;
    if (post.authorProfile && (post.authorProfile.bio || post.authorProfile.headline)) {
        postForPrompt = Object.assign({}, post);
        var profileNote = "[AUTHOR BIO: " + (post.authorProfile.headline || "") +
            (post.authorProfile.bio ? " | " + post.authorProfile.bio : "") + "]";
        postForPrompt.body = (post.body || "") + "\n\n" + profileNote;
        console.log("  📋 [Profile] Injecting author bio into prompt");
    }
    var userMessage = promptBuilders.buildPostUserPrompt(postForPrompt, dbHistory, botName, gender, role);

    // ── Step 4: Build system prompt ──
    var systemPrompt = buildReplySystemPromptV2(tags, "post", {
        personName: post.author,
        communityName: post.community || "Self Improvement Nation",
        gender: gender,
        role: role,
    });

    var messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
    ];

    console.log("═══════════════ PROMPT BEING SENT ═══════════════");
    messages.forEach(function(m) {
        console.log("[" + m.role.toUpperCase() + "]");
        console.log(m.content);
        console.log("");
    });
    console.log("═════════════════════════════════════════════════\n");

    var model = process.env.OPENAI_MODEL || "gpt-4o";
    var completion = await openai.chat.completions.create({
        model: model,
        max_completion_tokens: 300,
        messages: messages,
    });
    var replyText = completion.choices[0].message.content;

    // ── Log for client review (session file) ──
    sessionLog.addEntry({
        type: "post",
        postAuthor: post.author,
        postTitle: post.title,
        postBodyPreview: post.body.substring(0, 300),
        tags: tags,
        reply: replyText,
    });

    // ── Append to persistent fine-tuning training log ──
    trainingLog.appendPostEntry({
        type: "post",
        community: post.community || "Self Improvement Nation",
        post: { author: post.author, title: post.title, body: post.body },
        comment: null,
        classifierSystemPrompt: tagClassifier.SYSTEM_PROMPT,
        classifierUserMessage: tagClassifier.buildUserPrompt(classifierContext),
        tags: tags,
        generationSystemPrompt: systemPrompt,
        generationUserMessage: userMessage,
        model: model,
        reply: replyText,
    });

    return replyText;
}

async function findInlineReplyBox(page, target) {
    var match = await page.evaluate(function(args) {
        var targetAuthor = args.author;
        var textStart = args.textStart;

        function normalizeText(value) {
            return (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        }

        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function firstVisibleInput(root) {
            if (!root) return null;
            var selectors = [
                'input[placeholder="Your comment"]',
                '[placeholder*="comment" i]',
                '[class*="CommentInput"] input',
                '[class*="CommentInput"] [contenteditable="true"]',
                '[contenteditable="true"]',
                'input',
                'textarea'
            ];
            for (var s = 0; s < selectors.length; s++) {
                var nodes = root.querySelectorAll(selectors[s]);
                for (var n = 0; n < nodes.length; n++) {
                    if (isVisible(nodes[n])) return nodes[n];
                }
            }
            return null;
        }

        var comments = document.querySelectorAll('[class*="CommentItemContainer"]');
        for (var i = 0; i < comments.length; i++) {
            var el = comments[i];
            var authorLinks = el.querySelectorAll('a[href*="/@"]');
            var author = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { author = t; break; }
            }
            if (normalizeText(author) !== normalizeText(targetAuthor)) continue;
            if (normalizeText(el.textContent).indexOf(normalizeText(textStart)) === -1) continue;

            var roots = [el];
            if (el.parentElement) roots.push(el.parentElement);
            if (el.parentElement && el.parentElement.parentElement) roots.push(el.parentElement.parentElement);

            for (var r = 0; r < roots.length; r++) {
                var input = firstVisibleInput(roots[r]);
                if (!input) continue;
                input.setAttribute('data-codex-inline-reply-target', 'true');
                return true;
            }
        }
        return false;
    }, target);

    if (!match) return null;
    return await page.$('[data-codex-inline-reply-target="true"]');
}

async function pageInReplyMode(page) {
    return await page.evaluate(function() {
        function textOf(el) { return (el.textContent || '').trim().toUpperCase(); }

        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        var controls = Array.from(document.querySelectorAll('button, [role="button"], [class*="Button"]')).filter(isVisible);
        return controls.some(function(el) { return textOf(el) === 'CANCEL'; }) &&
            controls.some(function(el) { return textOf(el) === 'REPLY'; });
    });
}

async function clickCommentReplyButton(page, comment) {
    return await page.evaluate(function(args) {
        var targetAuthor = args.author;
        var textStart = args.textStart;

        function normalizeText(value) {
            return (value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
        }

        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function clickLikeHuman(el) {
            var target = el.closest('button, [role="button"], a') || el;
            target.scrollIntoView({ block: 'center', inline: 'nearest' });
            ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function(type) {
                target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            return true;
        }

        var comments = document.querySelectorAll('[class*="CommentItemContainer"], [class*="CommentOrReply"]');
        for (var i = 0; i < comments.length; i++) {
            var el = comments[i];
            var authorLinks = el.querySelectorAll('a[href*="/@"]');
            var author = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { author = t; break; }
            }
            if (normalizeText(author) !== normalizeText(targetAuthor)) continue;
            if (normalizeText(el.textContent).indexOf(normalizeText(textStart)) === -1) continue;

            var replyBtn = el.querySelector('[class*="CommentItemReplyButton"]');
            if (replyBtn && isVisible(replyBtn)) {
                clickLikeHuman(replyBtn);
                return 'class-button';
            }

            var links = el.querySelectorAll('a, button, span, div[role="button"]');
            for (var k = 0; k < links.length; k++) {
                if (!isVisible(links[k])) continue;
                if (links[k].textContent.trim().toLowerCase() === 'reply') {
                    clickLikeHuman(links[k]);
                    return 'text-button';
                }
            }
        }
        return null;
    }, { author: comment.author, textStart: comment.text.substring(0, 30) });
}

async function typeReply(page, replyText, options) {
    options = options || {};
    // Post/comment channel - collapse bubble delimiters into a single space.
    if (replyText && replyText.indexOf(BUBBLE_DELIM) !== -1) {
        console.log("  [warn] model emitted " + BUBBLE_DELIM + " in a post/comment reply - collapsing to single bubble");
        replyText = collapseBubbles(replyText);
    }

    var replyBox = null;

    if (options.inlineTarget) {
        replyBox = await findInlineReplyBox(page, options.inlineTarget);
    }

    if (!replyBox && options.inlineTarget && await pageInReplyMode(page)) {
        replyBox = await page.$(':focus');
        if (!replyBox) {
            replyBox = await page.$('input[placeholder="Your comment"], [class*="CommentInput"] input, [class*="CommentInput"] [contenteditable="true"]');
        }
    }

    if (!replyBox && !options.inlineTarget) {
        replyBox = await page.$('input[placeholder="Your comment"]');
    }

    if (!replyBox && !options.inlineTarget) {
        var selectors = [
            '[placeholder*="comment" i]',
            '[placeholder*="Your comment"]',
            '[class*="CommentInput"] input',
            '[class*="CommentInput"] [contenteditable="true"]',
            '[class*="comment"] input',
            '[contenteditable="true"]',
        ];
        for (var i = 0; i < selectors.length; i++) {
            replyBox = await page.$(selectors[i]);
            if (replyBox) break;
        }
    }

    if (!replyBox) {
        await page.screenshot({ path: "debug_screenshot.png" });
        if (options.inlineTarget) {
            throw new Error("Could not find inline reply input box for target comment - saved debug_screenshot.png for inspection");
        }
        throw new Error("Could not find reply input box - saved debug_screenshot.png for inspection");
    }

    var staleOverlay = await page.$('[class*="DropdownBackground"]');
    if (staleOverlay) {
        try {
            await page.keyboard.press('Escape');
            await sleep(300);
        } catch (e) {}
    }

    try {
        await replyBox.click();
    } catch (e) {
        if (options.inlineTarget && /not attached to the DOM/i.test(e.message || '')) {
            replyBox = await findInlineReplyBox(page, options.inlineTarget);
            if (!replyBox && await pageInReplyMode(page)) {
                replyBox = await page.$(':focus');
            }
            if (!replyBox) {
                throw e;
            }
            await replyBox.click();
        } else {
            throw e;
        }
    }
    await sleep(500);
    await page.keyboard.type(replyText, { delay: 20 });
    await sleep(300);
    console.log("Reply typed into box\n");

    if (options.inlineTarget) {
        await page.evaluate(function() {
            var tagged = document.querySelector('[data-codex-inline-reply-target="true"]');
            if (tagged) tagged.removeAttribute('data-codex-inline-reply-target');
        });
    }
}

async function submitReply(page, options) {
    options = options || {};
    // Give Skool a moment to activate the submit button.
    await sleep(600);

    // Strategy: use evaluate() so we bypass selector/visibility issues.
    //
    // Skool shows two patterns:
    //   a) Inline thread reply  → CANCEL + REPLY buttons side by side
    //   b) New top-level comment → just a COMMENT button
    //
    // We use CANCEL as a landmark: if it's present the active form is the
    // inline reply box; click its sibling REPLY button.
    // Otherwise fall back to the COMMENT button.
    var clickResult = await page.evaluate(function(args) {
        function textOf(el) { return (el.textContent || '').trim(); }

        function upperText(el) { return textOf(el).toUpperCase(); }

        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function clickIt(el) {
            if (!el) return false;
            var target = el.closest('button, [role="button"], a') || el;
            target.click();
            return true;
        }

        // Walk all clickable elements (button, div[role=button], span[role=button])
        var candidates = Array.from(document.querySelectorAll(
            'button, [role="button"], [class*="Button"]'
        )).filter(isVisible);

        if (args.inlineTarget) {
            var active = document.activeElement;
            var startNode = active && active !== document.body ? active : document.querySelector('[data-codex-inline-reply-target="true"]');
            var node = startNode;
            for (var depth = 0; depth < 8 && node && node !== document.body; depth++) {
                var localCandidates = Array.from(node.querySelectorAll('button, [role="button"], [class*="Button"], a')).filter(isVisible);
                var localReplyBtn = localCandidates.find(function(el) {
                    var t = upperText(el);
                    return t === 'REPLY' || t === 'Reply';
                });
                if (localReplyBtn && clickIt(localReplyBtn)) {
                    return 'inline-reply-local';
                }
                node = node.parentElement;
            }
        }

        // --- Path A: active form (CANCEL is the landmark) ---
        var cancelEl = candidates.find(function(el) {
            return upperText(el) === 'CANCEL';
        });
        if (cancelEl) {
            // Walk up until we find a container that also holds the submit button.
            var node = cancelEl.parentElement;
            for (var depth = 0; depth < 8 && node && node !== document.body; depth++) {
                var allInNode = Array.from(node.querySelectorAll(
                    'button, [role="button"], [class*="Button"]'
                ));
                var replyBtn = allInNode.find(function(el) {
                    return upperText(el) === 'REPLY';
                });
                if (replyBtn && clickIt(replyBtn)) {
                    return 'inline-reply';
                }
                var commentBtnInForm = allInNode.find(function(el) {
                    return upperText(el) === 'COMMENT';
                });
                if (commentBtnInForm && clickIt(commentBtnInForm)) {
                    return 'comment-btn-local';
                }
                node = node.parentElement;
            }
        }

        // --- Path B: top-level comment box (COMMENT button) ---
        var commentBtn = candidates.find(function(el) {
            var t = upperText(el);
            return t === 'COMMENT';
        });
        if (commentBtn && clickIt(commentBtn)) {
            return 'comment-btn';
        }

        return null;
    }, options);

    if (clickResult) {
        console.log("✅ Reply sent (" + clickResult + ")! Closing in 10 seconds...\n");
        await sleep(10000);
        return;
    }

    // Last resort: Enter key
    console.log("  ⚠️  Submit button not found — pressing Enter as fallback");
    await page.keyboard.press('Enter');
    console.log("✅ Reply sent (Enter)! Closing in 10 seconds...\n");
    await sleep(10000);
}

// Scrape post context + comment thread from a post page (for comment replies)
async function scrapePostContext(page) {
    return await page.evaluate(function() {
        var result = { postAuthor: "", postTitle: "", postBody: "", thread: [] };

        // Post title
        var titleEl = document.querySelector('h1, [class*="PostTitle"], [class*="postTitle"]');
        if (titleEl) result.postTitle = titleEl.textContent.trim();

        // Post author
        var allAuthorLinks = document.querySelectorAll('a[href*="/@"]');
        for (var a = 0; a < allAuthorLinks.length; a++) {
            var aText = allAuthorLinks[a].textContent.trim().replace(/^\d+/, "").trim();
            if (aText && aText.length > 1) { result.postAuthor = aText; break; }
        }

        // Post body (clean)
        var bodyEl = null;
        var bodySelectors = [
            '.ql-editor', '[class*="RichText"]', '[class*="PostBody"]',
            '[class*="PostContent"]', '[class*="post-body"]', 'article'
        ];
        for (var i = 0; i < bodySelectors.length; i++) {
            var els = document.querySelectorAll(bodySelectors[i]);
            for (var j = 0; j < els.length; j++) {
                var el = els[j];
                if (el.closest('[class*="CommentsSection"], [class*="CommentsList"], [class*="CommentsListWrapper"], [class*="CommentInput"], [class*="CommentItemContainer"]')) continue;
                if (el.getAttribute('contenteditable') === 'true' && el.textContent.trim().length < 20) continue;
                if (el.textContent.trim().length > 20) {
                    bodyEl = el;
                    break;
                }
            }
            if (bodyEl) break;
        }
        if (bodyEl) {
            var clone = bodyEl.cloneNode(true);
            var stripSelectors = [
                '[class*="CommentsSection"]', '[class*="CommentsList"]', '[class*="CommentsListWrapper"]',
                '[class*="CommentItem"]', '[class*="CommentInput"]',
                '[class*="emoji" i]', '[class*="Emoji"]', '[class*="EmojiPicker"]',
                '[class*="Reaction"]', '[class*="DragAndDrop"]', '[class*="FileUpload"]',
                '[class*="Tooltip"]', '[class*="Avatar"]', '[class*="Badge"]',
            ];
            stripSelectors.forEach(function(sel) {
                try {
                    var toRemove = clone.querySelectorAll(sel);
                    for (var r = 0; r < toRemove.length; r++) toRemove[r].remove();
                } catch (e) {}
            });
            var rawText = (clone.innerText || clone.textContent || '').trim();
            rawText = rawText.split('\n').filter(function(line) {
                var l = line.trim();
                if (!l) return true;
                if (/^(See more|Like|Reply|Comment|Jump to latest|Drop files|Recently Used|Smileys|Animals|Food|Travel|Activities|Objects|Symbols|Flags)$/i.test(l)) return false;
                if (/^(To pick up a draggable|While dragging|Press space)/i.test(l)) return false;
                if (/^\d+\s*(comments?|likes?|replies?)$/i.test(l)) return false;
                if (l.length > 20 && /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Component}\u200d\ufe0f\s]+$/u.test(l)) return false;
                return true;
            }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
            result.postBody = rawText;
        }

        // Comment threads
        var commentContainers = document.querySelectorAll('[class*="CommentItemContainer"]');
        if (commentContainers.length === 0) {
            commentContainers = document.querySelectorAll('[class*="CommentOrReply"]');
        }
        for (var c = 0; c < commentContainers.length; c++) {
            var container = commentContainers[c];
            var authorLinks = container.querySelectorAll('a[href*="/@"]');
            var commentAuthor = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { commentAuthor = t; break; }
            }
            var bubbleEl = container.querySelector('[class*="CommentItemBubble"]');
            var commentText = bubbleEl ? bubbleEl.textContent.trim() : container.textContent.trim();
            commentText = commentText.replace(/^[\s\S]*?\u2022\s*\d+[smhdw](?:\s*\(edited\))?\s*/i, "").trim();
            commentText = commentText.replace(/\d*\s*Reply\s*$/i, "").trim();
            var isReply = !!container.closest('[class*="ReplyListWrapper"]');

            if (commentAuthor && commentText.length > 2) {
                result.thread.push({
                    author: commentAuthor,
                    text: commentText.substring(0, 500),
                    isReply: isReply
                });
            }
        }

        return result;
    });
}

// ── Author profile scraper ─────────────────────────────────────────────────────
// Opens the post author's Skool profile in a background tab and returns bio /
// headline info. Used to enrich the generation prompt for ICP and hot leads so
// Jack can reference the person's actual niche or situation.
// Best-effort: on any failure returns null and caller proceeds without it.
async function scrapeAuthorProfile(page, authorName) {
    try {
        // Grab the author's profile URL from the links already on the current post page
        var profileUrl = await page.evaluate(function(name) {
            var links = document.querySelectorAll("a[href*=\"/@\"]");
            for (var i = 0; i < links.length; i++) {
                var text = links[i].textContent.trim().replace(/^\d+/, "").trim();
                if (text === name) return links[i].href;
            }
            return null;
        }, authorName);

        if (!profileUrl) {
            console.log("  📋 [Profile] No profile link found for " + authorName);
            return null;
        }

        console.log("  📋 [Profile] Scraping profile for " + authorName + "...");
        var context = page.context();
        var profileTab = await context.newPage();

        try {
            await profileTab.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
            await sleep(2000);

            var profile = await profileTab.evaluate(function() {
                var result = { bio: "", headline: "" };

                // Bio / About section — try progressively broader selectors
                var bioSelectors = [
                    "[class*=\"Bio\"]", "[class*=\"bio\"]",
                    "[class*=\"About\"]", "[class*=\"about\"]",
                    "[class*=\"Description\"]", "[class*=\"description\"]",
                    "[class*=\"Tagline\"]", "[class*=\"tagline\"]",
                    "[class*=\"Headline\"]", "[class*=\"headline\"]",
                ];
                for (var i = 0; i < bioSelectors.length; i++) {
                    var el = document.querySelector(bioSelectors[i]);
                    if (el && el.textContent.trim().length > 10) {
                        result.bio = el.textContent.trim().substring(0, 300);
                        break;
                    }
                }

                // Short descriptor / role line that often sits under the name
                var headlineSelectors = [
                    "[class*=\"MemberCardSubtitle\"]",
                    "[class*=\"ProfileSubtitle\"]",
                    "[class*=\"RoleBadge\"]",
                    "[class*=\"memberCard\"] p",
                ];
                for (var j = 0; j < headlineSelectors.length; j++) {
                    var hEl = document.querySelector(headlineSelectors[j]);
                    if (hEl && hEl.textContent.trim().length > 3) {
                        result.headline = hEl.textContent.trim().substring(0, 150);
                        break;
                    }
                }

                return result;
            });

            if (profile.bio || profile.headline) {
                console.log("  📋 [Profile] Found for " + authorName + ": " + (profile.headline || profile.bio).substring(0, 80));
                return profile;
            }
            console.log("  📋 [Profile] No usable info found for " + authorName);
            return null;

        } finally {
            await profileTab.close();
        }
    } catch (e) {
        console.log("  ⚠️  [Profile] Scrape failed for " + authorName + ": " + e.message);
        return null;
    }
}

async function scrapeAllComments(page, posts, botName) {
    // Skip posts with 0 comments detected from the feed page
    var postsWithComments = posts.filter(function(p) { return !p.commentCount || p.commentCount > 0; });
    var skippedZero = posts.length - postsWithComments.length;
    if (skippedZero > 0) {
        console.log("💬 Skipping " + skippedZero + " posts with 0 comments");
    }
    console.log("💬 Scraping comments from " + postsWithComments.length + " posts (of " + posts.length + " total)...\n");
    var allComments = [];

    var debugDone = false;

    // Helper: scrape a single post's comments on a given page/tab
    async function scrapeSinglePost(tab, post, idx, total) {
        var wantDebug = !debugDone;
        process.stdout.write("  📝 Scanning (" + (idx + 1) + "/" + total + "): " + post.title.substring(0, 40) + "...\r");
        try {
            await tab.goto(post.href, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch (e) {
            console.log("\n  ⚠️  Timeout on " + post.title.substring(0, 40) + " — skipping");
            return [];
        }
        // Scroll to trigger lazy-loaded comments, then wait for them to appear
        await tab.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
        // Wait for comment elements to appear (up to 3s), then one more scroll
        try {
            await tab.waitForSelector('[class*="CommentItemContainer"], [class*="CommentOrReply"]', { timeout: 3000 });
        } catch (_) { /* no comments loaded — that's fine */ }
        await tab.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
        await sleep(500);

        var comments = await tab.evaluate(function(args) {
            var postInfo = args.postInfo;
            var botNames = args.botNames || [];
            var debugFirst = args.debugFirst;

            var commentEls = document.querySelectorAll('[class*="CommentItemContainer"]');
            if (commentEls.length === 0) {
                commentEls = document.querySelectorAll('[class*="CommentOrReply"]');
            }

            var results = [];

            if (debugFirst && commentEls.length > 1) {
                var containerCount = document.querySelectorAll('[class*="CommentItemContainer"]').length;
                var orReplyCount = document.querySelectorAll('[class*="CommentOrReply"]').length;
                var bubbleCount = document.querySelectorAll('[class*="CommentItemBubble"]').length;
                var commentBodyCount = document.querySelectorAll('[class*="CommentBody"]').length;
                var commentContentCount = document.querySelectorAll('[class*="CommentContent"]').length;
                var commentTextCount = document.querySelectorAll('[class*="CommentText"]').length;
                results.push({
                    _debug: true,
                    selectorCounts: {
                        CommentItemContainer: containerCount,
                        CommentOrReply: orReplyCount,
                        CommentItemBubble: bubbleCount,
                        CommentBody: commentBodyCount,
                        CommentContent: commentContentCount,
                        CommentText: commentTextCount,
                        totalUsed: commentEls.length
                    }
                });
                var firstElHtml = commentEls[0] ? commentEls[0].innerHTML.substring(0, 800) : "(none)";
                results.push({ _debug: true, firstElementHtml: firstElHtml });
                var allEls = document.querySelectorAll('*');
                var commentClassNames = [];
                for (var d = 0; d < allEls.length; d++) {
                    var cn = allEls[d].className;
                    if (typeof cn === 'string' && (cn.toLowerCase().includes('comment') || cn.toLowerCase().includes('reply'))) {
                        commentClassNames.push(cn.substring(0, 120));
                    }
                }
                var unique = commentClassNames.filter(function(v, i, a) { return a.indexOf(v) === i; });
                results.push({ _debug: true, classes: unique.slice(0, 30) });
            }

            for (var i = 0; i < commentEls.length; i++) {
                var el = commentEls[i];
                var authorLinks = el.querySelectorAll('a[href*="/@"]');
                var author = "";
                for (var j = 0; j < authorLinks.length; j++) {
                    var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                    if (t && t.length > 1) { author = t; break; }
                }
                author = author.replace(/\u00a0/g, " ").trim();
                if (!author || botNames.indexOf(author) !== -1) continue;

                var textEl = el.querySelector('[class*="CommentItemBubble"]');
                var text = textEl ? textEl.textContent.trim() : "";
                if (!text) {
                    text = el.textContent.trim();
                }
                text = text.replace(/^[\s\S]*?\u2022\s*\d+[smhdw](?:\s*\(edited\))?\s*/i, "").trim();
                text = text.replace(/^@[\w\s]+?(?=[A-Z][a-z])/, "").trim();
                if (!text || text.length < 10) continue;

                results.push({
                    author: author,
                    text: text.substring(0, 300),
                    postTitle: postInfo.title,
                    postHref: postInfo.href,
                    postCategory: postInfo.category || "General",
                });
            }
            return results;
        }, { postInfo: post, botNames: getBotIdentityNames(botName), debugFirst: wantDebug });

        return comments;
    }

    // Use 2 concurrent tabs to scrape in parallel (human-like: just 2 open tabs)
    var context = page.context();
    var tab2 = await context.newPage();
    var CONCURRENCY = 2;
    var tabs = [page, tab2];

    for (var p = 0; p < postsWithComments.length; p += CONCURRENCY) {
        var batch = postsWithComments.slice(p, Math.min(p + CONCURRENCY, postsWithComments.length));
        var promises = batch.map(function(post, batchIdx) {
            var globalIdx = p + batchIdx;
            return scrapeSinglePost(tabs[batchIdx], post, globalIdx, postsWithComments.length);
        });
        var batchResults = await Promise.all(promises);

        for (var b = 0; b < batchResults.length; b++) {
            var comments = batchResults[b];
            // Extract debug info if present
            var debugEntries = comments.filter(function(c) { return c._debug; });
            if (debugEntries.length > 0) {
                debugDone = true;
                debugEntries.forEach(function(d) {
                    if (d.selectorCounts) {
                        console.log("\n\n🔍 DEBUG: Selector match counts (post with comments):");
                        Object.keys(d.selectorCounts).forEach(function(k) {
                            console.log("  " + k + ": " + d.selectorCounts[k]);
                        });
                    }
                    if (d.firstElementHtml) {
                        console.log("\n🔍 DEBUG: First comment element innerHTML (truncated):");
                        console.log(d.firstElementHtml);
                    }
                    if (d.classes) {
                        console.log("\n🔍 DEBUG: Comment/reply CSS classes:");
                        d.classes.forEach(function(cls) { console.log("  • " + cls); });
                    }
                });
                console.log("");
                comments = comments.filter(function(c) { return !c._debug; });
            }

            var sourcePost = postsWithComments[p + b];
            for (var c = 0; c < comments.length; c++) {
                comments[c].type = "comment";
                comments[c].commentId = sourcePost.href + "|c|" + comments[c].author + "|" + comments[c].text.substring(0, 50);
            }
            allComments = allComments.concat(comments);
        }
    }

    // Close the extra tab
    await tab2.close();

    console.log("\n💬 Found " + allComments.length + " total comments across " + postsWithComments.length + " posts\n");
    return allComments;
}

async function classifyComments(comments) {
    if (comments.length === 0) return comments;

    // ── LOCAL PRE-FILTER: skip obviously-other comments to save API tokens ──
    var OTHER_PATTERNS = [
        /^to pick up a draggable item/i,
        /^\s*$/, // empty
    ];
    var candidates = [];
    var skipped = 0;
    for (var f = 0; f < comments.length; f++) {
        var txt = comments[f].text;
        var isObviousOther = false;

        // Too short to be ICP/advice
        if (txt.length < 25) isObviousOther = true;

        // Drag-and-drop artifact
        if (!isObviousOther && /to pick up a draggable item/i.test(txt)) isObviousOther = true;

        // Mostly emoji / punctuation (less than 30% actual letters)
        if (!isObviousOther) {
            var letters = (txt.match(/[a-zA-Z]/g) || []).length;
            if (letters < txt.length * 0.3 && txt.length < 60) isObviousOther = true;
        }

        // Simple reactions: starts with @mention then short text
        if (!isObviousOther && txt.length < 50 && /^@?\w+\s+(lol|lmao|nice|agreed|exactly|same|true|yes|yep|facts|100%|fr|right|love it|great|love that|lets go|let's go)\b/i.test(txt)) isObviousOther = true;

        if (isObviousOther) {
            comments[f].category_class = "other";
            skipped++;
        } else {
            candidates.push(f);
        }
    }
    console.log("🏷️  Pre-filtered " + skipped + " obvious non-ICP comments locally");
    console.log("🏷️  Classifying " + candidates.length + " remaining comments via LLM...");

    if (candidates.length === 0) {
        return comments;
    }

    var batchSize = 50;
    for (var start = 0; start < candidates.length; start += batchSize) {
        var batchIndices = candidates.slice(start, Math.min(start + batchSize, candidates.length));
        var commentList = batchIndices.map(function(idx, batchPos) {
            var c = comments[idx];
            return batchPos + ". [" + c.author + "] " + c.text.substring(0, 100);
        }).join("\n");

        try {
            var completion = await openai.chat.completions.create({
                model: process.env.OPENAI_MODEL || "gpt-4o",
                max_completion_tokens: 1000,
                response_format: { type: "json_object" },
                messages: [{
                    role: "system",
                    content: 'Classify each comment. Categories: "hot" (buying signal — explicitly wants coaching/mentorship/a program or is ready to invest/take action NOW), "icp" (commenter is a coach seeking help or growth but no explicit buying signal), "advice" (seeking advice/tips but NOT a coach), "other" (everything else). Also rate urgency 0-10 (10=extreme pain or urgency, 0=casual). Return JSON: {"results":[{"i":0,"c":"other","u":3},...]}.'
                }, {
                    role: "user",
                    content: commentList
                }],
            });

            var parsed = JSON.parse(completion.choices[0].message.content);
            var results = parsed.results || parsed;
            for (var i = 0; i < results.length; i++) {
                var batchIdx = results[i].i !== undefined ? results[i].i : results[i].index;
                var cat = results[i].c || results[i].category;
                var urgency = typeof results[i].u === "number" ? results[i].u :
                    (typeof results[i].urgency === "number" ? results[i].urgency : 5);
                var realIdx = batchIndices[batchIdx];
                if (realIdx !== undefined && comments[realIdx]) {
                    comments[realIdx].category_class = cat;
                    comments[realIdx].urgency = urgency;
                }
            }
        } catch (err) {
            if (err.status === 429) {
                console.log("  ⏳ Rate limited, waiting 5s...");
                await sleep(5000);
                start -= batchSize; // retry this batch
                continue;
            }
            console.log("  ❌ Classification batch error: " + err.message);
        }

        // Small delay between batches to avoid rate limits
        if (start + batchSize < candidates.length) await sleep(1000);
    }

    for (var j = 0; j < comments.length; j++) {
        if (!comments[j].category_class) comments[j].category_class = "other";
    }

    // Print classification summary (only non-other)
    console.log("\n" + "─".repeat(60));
    var counts = { hot: 0, icp: 0, advice: 0, other: 0 };
    for (var k = 0; k < comments.length; k++) {
        var cl = comments[k].category_class || "other";
        counts[cl] = (counts[cl] || 0) + 1;
        if (cl !== "other") {
            var urgencyTag = cl !== "other" ? " [u:" + (comments[k].urgency || 0) + "]" : "";
            console.log("  " + (k + 1) + ". [" + cl.toUpperCase() + "]" + urgencyTag + " " + comments[k].author + ": " + comments[k].text.substring(0, 75));
        }
    }
    console.log("─".repeat(60));
    console.log("  Totals: " + counts.hot + " HOT, " + counts.icp + " ICP, " + counts.advice + " advice, " + counts.other + " other");
    console.log("─".repeat(60) + "\n");

    return comments;
}

function selectComments(classifiedComments) {
    var count = randomBetween(CONFIG.minComments, CONFIG.maxComments);
    console.log("💬 Target: " + count + " comments (random " + CONFIG.minComments + "-" + CONFIG.maxComments + ")");

    var hotComments = classifiedComments.filter(function(c) { return c.category_class === "hot"; });
    var icpComments = classifiedComments.filter(function(c) { return c.category_class === "icp"; });
    var adviceComments = classifiedComments.filter(function(c) { return c.category_class === "advice"; });

    // Sort ICP and advice by urgency descending
    function sortByUrgency(arr) {
        return arr.slice().sort(function(a, b) { return (b.urgency || 0) - (a.urgency || 0); });
    }

    var regularPool = sortByUrgency(icpComments).concat(sortByUrgency(adviceComments));

    if (hotComments.length === 0 && regularPool.length === 0) {
        console.log("💬 No hot, ICP, or advice comments found — skipping comments this cycle\n");
        return [];
    }

    // Hot comments always get a slot; fill remaining from ICP/advice by urgency
    var selected = hotComments.concat(regularPool.slice(0, Math.max(0, count - hotComments.length)));
    var hotCount = selected.filter(function(c) { return c.category_class === "hot"; }).length;
    var icpCount = selected.filter(function(c) { return c.category_class === "icp"; }).length;
    var adviceCount = selected.filter(function(c) { return c.category_class === "advice"; }).length;
    console.log("💬 Selected " + selected.length + " comments: " + hotCount + " HOT, " + icpCount + " ICP, " + adviceCount + " advice\n");
    return selected;
}

async function generateCommentReply(comment, persons, botName) {
    console.log("🤖 Classifying comment by " + comment.author + "...");

    // ── Step 1: Classify the comment to determine tone/intent/stage/gender ──
    var classifierContext = {
        postAuthor: comment.postAuthor || "Unknown",
        postTitle: comment.postTitle || "Unknown",
        postBody: comment.postBody || "",
        commentAuthor: comment.author,
        commentText: comment.text,
        thread: comment.thread || [],
    };
    var tags = await classifyReply(classifierContext);
    console.log("  🏷️  intent=" + tags.intent + " | stage=" + tags.sales_stage + " | tone=" + tags.tone_tags.join(", ") + " | gender=" + tags.gender);
    if (tags.reasoning) console.log("  💭 " + tags.reasoning);
    console.log("");

    // ── Step 1b: Override stage/intent from interaction history (DB beats classifier) ──
    var dbStage = deriveStageFromHistory(persons, comment.author);
    if (dbStage) {
        if (dbStage !== tags.sales_stage) {
            console.log("  📈 [StageDB] Stage override: \"" + tags.sales_stage + "\" → \"" + dbStage + "\" (interaction history)");
        }
        tags.sales_stage = dbStage;
        if (dbStage === "ask" && tags.intent !== "close-to-call") {
            console.log("  📈 [StageDB] Intent override: \"" + tags.intent + "\" → \"close-to-call\" (ask stage)");
            tags.intent = "close-to-call";
        }
    }
    // Hot category always means buying signal — force close-to-call regardless of history
    if (comment.category_class === "hot") {
        if (tags.intent !== "close-to-call") {
            console.log("  🔥 [HotComment] Intent override → \"close-to-call\" (hot buying signal detected)");
            tags.intent = "close-to-call";
        }
        if (tags.sales_stage !== "ask") tags.sales_stage = "ask";
    }

    // ── Step 2: Resolve gender and role ──
    var gender = tags.gender !== "unknown" ? tags.gender : guessGender(comment.author);
    if (persons) personsDb.setPersonGender(persons, comment.author, gender);
    var role = personsDb.isCompanyMember(persons, comment.author) ?
        "company-member (" + personsDb.getCompanyRole(persons, comment.author) + ")" :
        "lead (prospect)";

    // ── Step 3: Build v6-format user prompt ──
    var dbHistory = persons ? personsDb.getPersonHistory(persons, comment.author) : [];
    var interactionHistoryText = promptBuilders.buildCommentInteractionHistory(
        dbHistory,
        botName || "Jack Walford"
    );
    var userMessage = promptBuilders.buildCommentUserPrompt(comment, dbHistory, botName, gender, role);

    // ── Step 4: Build system prompt ──
    var systemPrompt = buildReplySystemPromptV2(tags, "comment", {
        personName: comment.author,
        communityName: comment.community || "Self Improvement Nation",
        gender: gender,
        role: role,
        interactionHistoryText: interactionHistoryText,
    });

    var messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
    ];

    console.log("═══════════════ PROMPT BEING SENT ═══════════════");
    messages.forEach(function(m) {
        console.log("[" + m.role.toUpperCase() + "]");
        console.log(m.content);
        console.log("");
    });
    console.log("═════════════════════════════════════════════════\n");

    var model = process.env.OPENAI_MODEL || "gpt-4o";
    var completion = await openai.chat.completions.create({
        model: model,
        max_completion_tokens: 300,
        messages: messages,
    });
    var replyText = completion.choices[0].message.content;

    // ── Log this entry for client review (session file) ──
    sessionLog.addEntry({
        type: "comment",
        postAuthor: comment.postAuthor || "Unknown",
        postTitle: comment.postTitle || "Unknown",
        commentAuthor: comment.author,
        commentText: comment.text.substring(0, 300),
        tags: tags,
        reply: replyText,
    });

    // ── Append to persistent fine-tuning training log ──
    trainingLog.appendPostEntry({
        type: comment.type || "comment",
        community: comment.community || "Self Improvement Nation",
        post: {
            author: comment.postAuthor || "Unknown",
            title: comment.postTitle || "Unknown",
            body: comment.postBody || "",
        },
        comment: {
            author: comment.author,
            text: comment.text,
            thread: comment.thread || [],
        },
        classifierSystemPrompt: tagClassifier.SYSTEM_PROMPT,
        classifierUserMessage: tagClassifier.buildUserPrompt(classifierContext),
        tags: tags,
        generationSystemPrompt: systemPrompt,
        generationUserMessage: userMessage,
        model: model,
        reply: replyText,
    });

    return replyText;
}

async function typeCommentReply(page, comment, replyText) {
    var commentTextStart = comment.text.substring(0, 30);
    var replyClickMode = await clickCommentReplyButton(page, comment);
    if (replyClickMode) {
        console.log("  Clicked Reply on " + comment.author + "'s comment (" + replyClickMode + ")");
        await sleep(500);
        if (!await pageInReplyMode(page)) {
            replyClickMode = await clickCommentReplyButton(page, comment);
            if (replyClickMode) {
                console.log("  Retried Reply click for " + comment.author);
                await sleep(900);
            }
        }
    } else {
        throw new Error("Could not find Reply button for " + comment.author + "'s comment");
    }

    await typeReply(page, replyText, {
        inlineTarget: {
            author: comment.author,
            textStart: commentTextStart,
        }
    });
}

// ─── NOTIFICATION HANDLING ────────────────────────────────

async function hasUnreadNotifications(page) {
    return await page.evaluate(function() {
        // Look for the REGULAR notification bell (NOT the chat icon)
        // Skool has two: ChatNotificationsIconButton (DMs) and NotificationsIconButton (comments/posts)
        // We must exclude elements with 'Chat' in the class name
        var bellWrappers = document.querySelectorAll(
            '[class*="Notification"], [class*="notification"], [class*="Bell"], [class*="bell"]'
        );
        for (var i = 0; i < bellWrappers.length; i++) {
            var w = bellWrappers[i];
            var wCls = (w.className || '').toString();
            // Skip the chat notification button — we only want the regular bell
            if (/Chat/i.test(wCls)) continue;
            var badge = w.querySelector(
                '[class*="Badge"], [class*="badge"], [class*="Count"], [class*="count"], ' +
                '[class*="Unread"], [class*="unread"], [class*="Indicator"], [class*="indicator"], ' +
                '[class*="Dot"], [class*="dot"]'
            );
            if (badge && (badge.offsetWidth > 0 || badge.offsetParent !== null)) {
                var t = badge.textContent.trim();
                if (!t || (/^\d+$/.test(t) && parseInt(t) > 0)) return true;
            }
        }
        return false;
    });
}

async function clickNotificationBell(page) {
    var bellEl = await page.$('[class*="NotificationsIconButton"]:not([class*="Chat"])');
    if (!bellEl) {
        var candidates = await page.$$('button[class*="Notification"], [class*="NotificationButtonWrapper"]');
        for (var nb = 0; nb < candidates.length; nb++) {
            var cls = await candidates[nb].getAttribute('class') || '';
            if (/Chat/i.test(cls)) continue;
            var btn = await candidates[nb].$('button');
            bellEl = btn || candidates[nb];
            break;
        }
    }
    if (!bellEl) {
        bellEl = await page.$('[aria-label*="notification" i]:not([class*="Chat"])');
    }
    if (!bellEl) return false;
    await bellEl.click();
    await sleep(1500);
    return true;
}

async function markNotificationRead(page, notif) {
    if (!await clickNotificationBell(page)) return false;

    var clicked = await page.evaluate(function(args) {
        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        var targetHref = args.href;
        var items = document.querySelectorAll('[class*="NotificationItem"], [class*="notificationItem"], [class*="NotificationRow"], [class*="notificationRow"]');
        for (var i = 0; i < items.length; i++) {
            var el = items[i];
            if (!isVisible(el)) continue;
            var href = '';
            if (el.href) href = el.href;
            if (!href) {
                var inner = el.querySelector('a[href]');
                if (inner) href = inner.href;
            }
            if (!href && el.closest('a[href]')) href = el.closest('a[href]').href;
            if (href !== targetHref) continue;

            var target = el.querySelector('a[href]') || el.closest('a[href]') || el;
            target.click();
            return true;
        }
        return false;
    }, { href: notif.href });

    if (!clicked) {
        await page.keyboard.press('Escape');
        await sleep(300);
        return false;
    }

    await sleep(2000);
    return true;
}

async function handleNotifications(page, botName, repliedPosts, summary, persons) {
    console.log("🔔 Opening notifications...\n");

    // Step 1: Click the REGULAR notification bell (NOT the chat/DM icon)
    // Skool has two notification buttons:
    //   - ChatNotificationsIconButton (DMs) 
    //   - NotificationsIconButton (comment/post notifications)
    // We need to specifically target NotificationsIconButton and exclude Chat
    var bellEl = await page.$('[class*="NotificationsIconButton"]:not([class*="Chat"])');
    if (!bellEl) {
        // Fallback: find all notification-like buttons and pick the one without 'Chat'
        var candidates = await page.$$('button[class*="Notification"], [class*="NotificationButtonWrapper"]');
        for (var nb = 0; nb < candidates.length; nb++) {
            var cls = await candidates[nb].getAttribute('class') || '';
            if (/Chat/i.test(cls)) continue;
            // Found a non-chat notification element — click it or find the button inside
            var btn = await candidates[nb].$('button');
            bellEl = btn || candidates[nb];
            break;
        }
    }
    if (!bellEl) {
        // Last resort: try aria-label
        bellEl = await page.$('[aria-label*="notification" i]:not([class*="Chat"])');
    }

    if (!bellEl) {
        console.log("  ⚠️  Could not find notification bell — skipping\n");
        return 0;
    }
    await bellEl.click();
    await sleep(2000);

    // Step 1b: Scroll the notification dropdown so Skool lazy-loads older items.
    var notifScrollInfo = await page.evaluate(async function() {
        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function scoreContainer(el) {
            if (!isVisible(el)) return -1;
            var itemCount = el.querySelectorAll(
                '[class*="NotificationItem"], [class*="notificationItem"], ' +
                '[class*="NotificationRow"], [class*="notificationRow"], a[href]'
            ).length;
            if (itemCount === 0) return -1;
            var score = itemCount;
            if (el.scrollHeight > el.clientHeight + 20) score += 1000;
            if (/Notification|Dropdown|Popover|Panel|Menu/i.test((el.className || '').toString())) score += 50;
            return score;
        }

        var candidates = Array.from(document.querySelectorAll('div, section, aside, ul')).filter(isVisible);
        var best = null;
        var bestScore = -1;
        for (var i = 0; i < candidates.length; i++) {
            var score = scoreContainer(candidates[i]);
            if (score > bestScore) {
                bestScore = score;
                best = candidates[i];
            }
        }

        if (!best) return { found: false };

        var previousHeight = -1;
        var previousCount = -1;
        var stablePasses = 0;
        var steps = 0;

        while (steps < 60) {
            var currentCount = best.querySelectorAll(
                '[class*="NotificationItem"], [class*="notificationItem"], ' +
                '[class*="NotificationRow"], [class*="notificationRow"], a[href]'
            ).length;
            var currentHeight = best.scrollHeight;
            best.scrollTop = best.scrollHeight;
            await new Promise(function(resolve) { setTimeout(resolve, 250); });

            if (currentHeight === previousHeight && currentCount === previousCount) {
                stablePasses++;
            } else {
                stablePasses = 0;
            }
            if (stablePasses >= 3) break;

            previousHeight = currentHeight;
            previousCount = currentCount;
            steps++;
        }

        best.scrollTop = 0;
        await new Promise(function(resolve) { setTimeout(resolve, 150); });

        return {
            found: true,
            steps: steps,
            itemCount: best.querySelectorAll(
                '[class*="NotificationItem"], [class*="notificationItem"], ' +
                '[class*="NotificationRow"], [class*="notificationRow"], a[href]'
            ).length,
            className: (best.className || '').toString().substring(0, 160)
        };
    });
    if (notifScrollInfo && notifScrollInfo.found) {
        console.log("  Notification menu scrolled: " + notifScrollInfo.itemCount + " items found after " + notifScrollInfo.steps + " steps");
    } else {
        console.log("  ⚠️  Notification menu scroll helper could not find a scroll container");
    }

    // Step 2: Collect notification items from the dropdown
    var notifications = await page.evaluate(function() {
        var items = [];
        var listItems = document.querySelectorAll(
            '[class*="NotificationItem"], [class*="notificationItem"], ' +
            '[class*="NotificationRow"], [class*="notificationRow"]'
        );
        // Fallback: links inside a visible dropdown/popover
        if (listItems.length === 0) {
            var containers = document.querySelectorAll(
                '[class*="Dropdown"], [class*="dropdown"], [class*="Popover"], ' +
                '[class*="popover"], [class*="Panel"], [class*="panel"], ' +
                '[class*="NotificationList"], [class*="notificationList"]'
            );
            for (var c = 0; c < containers.length; c++) {
                if (containers[c].offsetParent === null) continue;
                var links = containers[c].querySelectorAll('a[href]');
                if (links.length > 0) { listItems = links; break; }
            }
        }

        // Debug: capture all CSS classes of the dropdown/container area
        var debugClasses = [];
        var dropdowns = document.querySelectorAll('[class*="Dropdown"], [class*="Popover"], [class*="Panel"], [class*="Notification"]');
        for (var d = 0; d < dropdowns.length && d < 10; d++) {
            if (dropdowns[d].offsetParent !== null || dropdowns[d].offsetWidth > 0) {
                debugClasses.push((dropdowns[d].className || '').toString().substring(0, 120));
            }
        }

        for (var i = 0; i < listItems.length; i++) {
            var el = listItems[i];
            // Skip inner NotificationItemLink elements to avoid duplicates
            // (each notification has a container AND a link child — only process the container)
            var elClass2 = (el.className || '').toString();
            if (/NotificationItemLink/.test(elClass2)) continue;

            var text = el.textContent.trim().substring(0, 200);
            var href = el.href || '';
            if (!href && el.querySelector('a[href]')) href = el.querySelector('a[href]').href;
            if (!href) { var par = el.closest('a[href]'); if (par) href = par.href; }

            // Classify notification type
            // DM/chat URLs contain /chat in the path; post URLs are /{community}/{post-slug}
            var type = 'other';
            var isChatUrl = /\/chat(\?|$|\/)/.test(href);
            var isPostUrl = href && !isChatUrl && /skool\.com\/[^/]+\/[^/]+/.test(href);
            if (isChatUrl) {
                type = 'dm';
            } else if (isPostUrl && !/liked/i.test(text) && /replied|commented|mentioned|comment|reply/i.test(text)) {
                type = 'comment';
            }

            var elTag = el.tagName;
            var elClass = (el.className || '').toString().substring(0, 80);
            var unread = !!el.querySelector('[class*="Unread"], [class*="unread"], [class*="NotificationBubble"], [class*="notificationBubble"], [class*="Dot"], [class*="dot"]');
            items.push({ text: text, href: href, type: type, unread: unread, debugTag: elTag, debugClass: elClass });
        }
        return { items: items, debugClasses: debugClasses, listItemCount: listItems.length };
    });

    // Close the dropdown — press Escape and also click the background overlay to be sure
    await page.keyboard.press('Escape');
    await sleep(500);
    // Dismiss any remaining overlay
    var overlay = await page.$('[class*="DropdownBackground"]');
    if (overlay) {
        try { await overlay.click(); } catch (e) { /* already gone */ }
        await sleep(300);
    }
    // Double-check: press Escape again if overlay persists
    overlay = await page.$('[class*="DropdownBackground"]');
    if (overlay) {
        await page.keyboard.press('Escape');
        await sleep(300);
    }

    // Debug: log all notifications found
    console.log("  🔍 DEBUG: Found " + notifications.listItemCount + " raw notification elements");
    if (notifications.debugClasses.length > 0) {
        console.log("  🔍 DEBUG: Visible dropdown/panel classes:");
        notifications.debugClasses.forEach(function(c) { console.log("    • " + c); });
    }
    notifications.items.forEach(function(n, idx) {
        console.log("  🔍 DEBUG notif[" + idx + "] type=" + n.type + " tag=" + n.debugTag +
            " href=" + (n.href || 'NONE').substring(0, 80) +
            "\n    text=" + n.text.substring(0, 100) +
            "\n    class=" + (n.debugClass || '').substring(0, 80));
    });

    // Deduplicate notifications by exact href so different comment anchors on the
    // same post can still be opened and handled separately.
    // Do NOT require the inline unread dot here — Skool sometimes renders that
    // indicator on a wrapper outside the individual NotificationItem element.
    var totalCommentNotifs = notifications.items.filter(function(n) { return n.type === 'comment' && n.href; }).length;
    var unreadCommentNotifs = notifications.items.filter(function(n) { return n.type === 'comment' && n.href && n.unread; }).length;
    var seenNotifHrefs = new Set();
    var uniqueCommentNotifs = notifications.items.filter(function(n) {
        if (n.type !== 'comment' || !n.href) return false;
        var notifKey = n.href;
        if (seenNotifHrefs.has(notifKey)) return false;
        seenNotifHrefs.add(notifKey);
        return true;
    });
    var alreadyHandledNotifs = uniqueCommentNotifs.filter(function(n) {
        return repliedPosts.has('notif|' + n.href);
    }).length;
    var commentNotifs = uniqueCommentNotifs.filter(function(n) {
        return !repliedPosts.has('notif|' + n.href);
    });
    console.log(
        "\n  Notifications: " + notifications.items.length +
        " total, " + totalCommentNotifs +
        " comment replies, " + uniqueCommentNotifs.length +
        " unique hrefs, " + unreadCommentNotifs +
        " marked unread" +
        (alreadyHandledNotifs > 0 ? ", " + alreadyHandledNotifs + " already handled" : "") +
        ", " + commentNotifs.length + " to process\n"
    );

    var handled = 0;

    // Step 3: Handle comment notifications — open each one and reply
    for (var i = 0; i < commentNotifs.length; i++) {
        var notif = commentNotifs[i];
        console.log("  [" + (i + 1) + "/" + commentNotifs.length + "] " + notif.text.substring(0, 80));
        console.log("    URL: " + notif.href);

        try {
            // Navigate to the notification's post page
            // Force a real navigation by going to about:blank first
            console.log("    📍 Navigating to notification post...");
            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
            await sleep(300);
            await page.goto(notif.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await sleep(3000);
            console.log("    📍 Now on: " + page.url());

            // Scroll to load comments
            for (var s = 0; s < 4; s++) {
                await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
                await sleep(500);
            }
            // Find the most recent comment directed at the bot
            // Pass both current name AND all historical alt names so old @mentions
            // (e.g. "@Daniel Carter") are still correctly matched.
            var targetComment = await page.evaluate(function(args) {
                var botDisplayName = args.botDisplayName;
                var allBotNames = args.allBotNames; // current + alt names

                function isBotAuthor(name) {
                    return allBotNames.indexOf(name) !== -1;
                }

                function mentionsAnyBotName(text) {
                    for (var n = 0; n < allBotNames.length; n++) {
                        if (text.includes(allBotNames[n]) || text.includes('@' + allBotNames[n])) return true;
                    }
                    return false;
                }

                var result = { target: null, debug: {} };

                var bubbles = document.querySelectorAll('[class*="CommentItemBubble"], [class*="CommentItemContainer"]');
                result.debug.totalBubbles = bubbles.length;
                result.debug.botName = botDisplayName;
                result.debug.comments = [];

                // Collect debug info for ALL comment bubbles
                for (var d = 0; d < bubbles.length; d++) {
                    var bText = bubbles[d].textContent.trim();
                    var bAuthLinks = bubbles[d].querySelectorAll('a[href*="/@"]');
                    var bAuth = '';
                    for (var ba = 0; ba < bAuthLinks.length; ba++) {
                        var bat = bAuthLinks[ba].textContent.trim().replace(/^\d+/, '').trim();
                        if (bat && bat.length > 1) { bAuth = bat; break; }
                    }
                    result.debug.comments.push({
                        idx: d,
                        author: bAuth || 'UNKNOWN',
                        isBot: isBotAuthor(bAuth),
                        textSnippet: bText.substring(0, 80),
                        mentionsBot: mentionsAnyBotName(bText),
                        authLinkCount: bAuthLinks.length
                    });
                }

                // Walk backwards to find the newest comment mentioning the bot
                for (var i = bubbles.length - 1; i >= 0; i--) {
                    var text = bubbles[i].textContent.trim();
                    var authorLinks = bubbles[i].querySelectorAll('a[href*="/@"]');
                    var author = '';
                    for (var j = 0; j < authorLinks.length; j++) {
                        var t = authorLinks[j].textContent.trim().replace(/^\d+/, '').trim();
                        if (t && t.length > 1) { author = t; break; }
                    }
                    if (isBotAuthor(author) || !author) continue;
                    // Prefer comments that @-mention any known bot name
                    if (mentionsAnyBotName(text)) {
                        var content = text;
                        var idx = content.indexOf(author);
                        if (idx !== -1) content = content.substring(idx + author.length).trim();
                        content = content.replace(/^[^\w@]*[·•]\s*\d+[hmd]\s*/i, '').trim();
                        content = content.replace(/\d*\s*Reply\s*$/, '').trim();
                        result.target = { author: author, text: content.substring(0, 300), matchReason: 'mentions-bot' };
                        return result;
                    }
                }
                // Fallback: newest non-bot comment
                for (var k = bubbles.length - 1; k >= 0; k--) {
                    var text2 = bubbles[k].textContent.trim();
                    var authorLinks2 = bubbles[k].querySelectorAll('a[href*="/@"]');
                    var author2 = '';
                    for (var m = 0; m < authorLinks2.length; m++) {
                        var t2 = authorLinks2[m].textContent.trim().replace(/^\d+/, '').trim();
                        if (t2 && t2.length > 1) { author2 = t2; break; }
                    }
                    if (isBotAuthor(author2) || !author2) continue;
                    var content2 = text2;
                    var idx2 = content2.indexOf(author2);
                    if (idx2 !== -1) content2 = content2.substring(idx2 + author2.length).trim();
                    content2 = content2.replace(/^[^\w@]*[·•]\s*\d+[hmd]\s*/i, '').trim();
                    content2 = content2.replace(/\d*\s*Reply\s*$/, '').trim();
                    result.target = { author: author2, text: content2.substring(0, 300), matchReason: 'fallback-newest' };
                    return result;
                }
                return result;
            }, { botDisplayName: botName, allBotNames: [botName].concat(BOT_ALT_NAMES) });

            // Log comprehensive debug info
            console.log("    🔍 DEBUG: " + targetComment.debug.totalBubbles + " comment bubbles found, botName='" + targetComment.debug.botName + "'");
            if (targetComment.debug.comments) {
                targetComment.debug.comments.forEach(function(c) {
                    console.log("      [" + c.idx + "] author='" + c.author + "' isBot=" + c.isBot +
                        " mentionsBot=" + c.mentionsBot + " authLinks=" + c.authLinkCount +
                        " text=" + c.textSnippet.substring(0, 60));
                });
            }
            console.log("    🔍 DEBUG: Current page URL: " + page.url());

            if (!targetComment.target) {
                console.log("    ⚠️  No unreplied comment found — skipping\n");
                continue;
            }

            console.log("    ✅ Found target: " + targetComment.target.author + " (reason: " + targetComment.target.matchReason + ")");

            var postTitle = await page.evaluate(function() {
                var el = document.querySelector('h1, [class*="PostTitle"], [class*="postTitle"]');
                return el ? el.textContent.trim() : 'Unknown Post';
            });

            console.log("    Replying to " + targetComment.target.author + ": " + targetComment.target.text.substring(0, 80) + "...");

            // Scrape full post context + thread for v5-format prompt
            var notifPostCtx = await scrapePostContext(page);
            var commentObj = {
                author: targetComment.target.author,
                text: targetComment.target.text,
                postTitle: notifPostCtx.postTitle || postTitle,
                postAuthor: notifPostCtx.postAuthor || "Unknown",
                postBody: notifPostCtx.postBody || "",
                postCategory: 'General',
                thread: notifPostCtx.thread || []
            };
            if (personsDb.personExists(persons, targetComment.target.author)) {
                console.log("    ℹ️  [PersonsDB] Known person — history will be injected into prompt");
            }

            var replyText = await generateCommentReply(commentObj, persons, botName);
            // Patch the last log entry type so it shows as a notification reply
            sessionLog.patchLastType("notif-comment");

            console.log("─".repeat(50));
            console.log("NOTIFICATION REPLY:");
            console.log("─".repeat(50));
            console.log(replyText);
            console.log("─".repeat(50) + "\n");

            await typeCommentReply(page, { author: targetComment.target.author, text: targetComment.target.text }, replyText);
            await submitReply(page, { inlineTarget: true });
            await markNotificationRead(page, notif);

            // Log the notification comment + Scott's reply to persons DB
            personsDb.addInteraction(persons, targetComment.target.author, {
                type: "comment",
                post_title: commentObj.postTitle || "(no title)",
                author: targetComment.target.author,
                text: targetComment.target.text,
                timestamp: new Date().toISOString(),
            });
            personsDb.addInteraction(persons, targetComment.target.author, {
                type: "scott_reply",
                post_title: commentObj.postTitle || "(no title)",
                author: botName,
                text: replyText,
                timestamp: new Date().toISOString(),
            });

            summary.push({ type: "notif-comment", title: targetComment.target.author + "'s reply", author: targetComment.target.author, category_class: "notification" });
            repliedPosts.add('notif|' + notif.href);
            saveRepliedPosts(repliedPosts);
            handled++;
            await sleep(randomBetween(3000, 8000));

        } catch (e) {
            console.log("    ❌ Error handling notification: " + e.message + "\n");
        }
    }

    console.log("🔔 Notification check complete — handled " + handled + " items\n");
    return handled;
}

async function main() {
    if (!CONFIG.email || !CONFIG.password) {
        console.error("❌ Set SKOOL_EMAIL and SKOOL_PASSWORD in your .env file");
        process.exit(1);
    }

    var browser = await chromium.launch({ headless: CONFIG.headless });
    var context = await browser.newContext();
    var page = await context.newPage();
    var cycle = 0;
    var repliedPosts = loadRepliedPosts();
    var persons = personsDb.loadPersons();
    var postClassifications = postClassificationsDb.loadDb();
    var botName = "";

    try {
        botName = await login(page);

        while (true) {
            cycle++;
            console.log("\n" + "🔄".repeat(25));
            console.log("CYCLE " + cycle + " — " + new Date().toLocaleTimeString());
            console.log("🔄".repeat(25) + "\n");

            // Randomly pick a community for this cycle
            var community = CONFIG.communities[Math.floor(Math.random() * CONFIG.communities.length)];
            console.log("🏘️  Community: " + community.name + "\n");

            // summary is declared here so the cycle-start notification handler can log to it
            var summary = [];

            // ── Cycle-start notification check ────────────────────────────────
            // Hot replies must be caught ASAP — don't wait until mid-cycle.
            // Navigate to community first so the notification badge is visible.
            await page.goto(community.url, { waitUntil: "domcontentloaded", timeout: 60000 });
            await sleep(2000);
            console.log("🔔 Checking notifications at cycle start...");
            var cycleStartNotifs = await hasUnreadNotifications(page);
            if (cycleStartNotifs) {
                console.log("🔔 Notifications at cycle start — handling before scrape...\n");
                await handleNotifications(page, botName, repliedPosts, summary, persons);
            } else {
                console.log("🔔 No notifications at cycle start\n");
            }

            // Phase 1: Collect all posts
            var allPosts = await getAllPosts(page, community.url);
            var newPosts = allPosts.filter(function(post) {
                return !hasInteractedWithPost(repliedPosts, post.href);
            });
            var classifiedPostsCacheHits = newPosts.filter(function(post) {
                return postClassificationsDb.hasClassification(postClassifications, post.href);
            });
            var unclassifiedPosts = newPosts.filter(function(post) {
                return !postClassificationsDb.hasClassification(postClassifications, post.href);
            });

            console.log("Posts: filtered out " + (allPosts.length - newPosts.length) + " already-interacted, " + newPosts.length + " remaining");
            console.log("Posts: " + classifiedPostsCacheHits.length + " already classified, " + unclassifiedPosts.length + " need first-step classification");

            // Phase 1b: Scrape comments only from untouched posts
            var allComments = await scrapeAllComments(page, newPosts, botName);

            // Filter out already-replied comments from untouched posts
            var newComments = allComments.filter(function(c) { return !repliedPosts.has(c.commentId); });
            console.log("🚫 Comments: filtered out " + (allComments.length - newComments.length) + " already-replied, " + newComments.length + " remaining\n");

            if (newPosts.length === 0 && newComments.length === 0) {
                console.log("⚠️  No new posts or comments to reply to — waiting for next cycle...\n");
                // var cycleDelay = randomBetween(CONFIG.cycleDelayMin, CONFIG.cycleDelayMax);
                // await countdown(cycleDelay, "💤 Next cycle in");
                continue;
            }

            // Phase 2a: Classify & select posts
            var selectedPosts = [];
            if (newPosts.length > 0) {
                var newlyClassifiedPosts = [];
                if (unclassifiedPosts.length > 0) {
                    newlyClassifiedPosts = await classifyPosts(unclassifiedPosts);
                    for (var cp = 0; cp < newlyClassifiedPosts.length; cp++) {
                        newlyClassifiedPosts[cp].community = community.name;
                        postClassificationsDb.upsertClassification(postClassifications, newlyClassifiedPosts[cp]);
                    }
                }

                var classifiedPosts = hydratePostsWithStoredClassifications(newPosts, postClassifications);
                selectedPosts = selectPosts(classifiedPosts);
                for (var p = 0; p < selectedPosts.length; p++) {
                    selectedPosts[p].type = "post";
                }
            }

            // Phase 2b: Classify & select comments
            var selectedComments = [];
            if (newComments.length > 0) {
                var classifiedComments = await classifyComments(newComments);
                selectedComments = selectComments(classifiedComments);
            }

            // Phase 3: Merge posts + comments in random order
            var workItems = selectedPosts.concat(selectedComments).sort(function() { return Math.random() - 0.5; });
            console.log("📋 Total work items: " + workItems.length + " (" + selectedPosts.length + " posts + " + selectedComments.length + " comments)\n");

            // Phase 4: Process each item
            for (var i = 0; i < workItems.length; i++) {
                var item = workItems[i];
                console.log("═".repeat(50));
                console.log("ITEM " + (i + 1) + " of " + workItems.length + " [" + item.type.toUpperCase() + "]");
                console.log("═".repeat(50));

                if (item.type === "post") {
                    var post = await openPostAndGetBody(page, item);

                    if (await alreadyCommented(page, botName)) {
                        console.log("⏭️  Already commented on this post — skipping\n");
                        repliedPosts.add(post.href);
                        saveRepliedPosts(repliedPosts);
                        continue;
                    }

                    // Persons DB: known persons posting again = warm lead — skip post reply
                    // but queue them for a DM follow-up since they're already engaged.
                    if (personsDb.personExists(persons, post.author)) {
                        console.log("⏭️  [PersonsDB] " + post.author + " already in DB — skipping post reply, queuing for DM\n");
                        queueHotLead(post.author, "returning-poster", post.title, community.name);
                        repliedPosts.add(post.href);
                        saveRepliedPosts(repliedPosts);
                        continue;
                    }

                    var replyText = await generateReply(post, persons, botName);

                    console.log("─".repeat(50));
                    console.log("GENERATED REPLY:");
                    console.log("─".repeat(50));
                    console.log(replyText);
                    console.log("─".repeat(50));
                    console.log("");

                    await typeReply(page, replyText);
                    await submitReply(page);

                    // Queue ICP and hot leads for DM follow-up after post reply
                    if (post.category_class === "icp" || post.category_class === "hot") {
                        queueHotLead(post.author, post.category_class + "-post-reply", post.title, community.name);
                    }

                    // Log this new person + interaction to persons DB
                    personsDb.addInteraction(persons, post.author, {
                        type: "post",
                        author: post.author,
                        title: post.title,
                        body: post.body.substring(0, 500),
                        timestamp: new Date().toISOString(),
                    });
                    personsDb.addInteraction(persons, post.author, {
                        type: "scott_reply",
                        post_title: post.title,
                        author: botName,
                        text: replyText,
                        timestamp: new Date().toISOString(),
                    });

                    summary.push({ type: "post", title: post.title, author: post.author, category_class: post.category_class });
                    repliedPosts.add(post.href);
                    repliedPosts.add('notif|' + post.href); // prevent notification handler from double-replying
                    saveRepliedPosts(repliedPosts);

                } else if (item.type === "comment") {
                    console.log("💬 Comment by " + item.author + " on: " + item.postTitle);
                    console.log("  Text: " + item.text.substring(0, 200) + (item.text.length > 200 ? "..." : ""));
                    console.log("  📍 Navigating to: " + item.postHref);
                    if (personsDb.personExists(persons, item.author)) {
                        console.log("  ℹ️  [PersonsDB] Known person — history will be injected into prompt");
                    }
                    console.log("");

                    // Force a real navigation even if we're already on this URL
                    var currentUrl = page.url();
                    if (currentUrl.split('?')[0] === item.postHref.split('?')[0]) {
                        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
                        await sleep(300);
                    }
                    await page.goto(item.postHref, { waitUntil: "domcontentloaded", timeout: 30000 });
                    await sleep(2000);

                    // Scroll down to load lazy comments
                    for (var sc = 0; sc < 3; sc++) {
                        await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
                        await sleep(800);
                    }
                    // Wait for comment elements to appear
                    try {
                        await page.waitForSelector('[class*="CommentItemContainer"], [class*="CommentOrReply"]', { timeout: 3000 });
                    } catch (_) { /* comments may not exist */ }

                    console.log("  📍 Now on: " + page.url());

                    // Guard: skip if the bot already commented on this post
                    if (await alreadyCommented(page, botName)) {
                        console.log("  ⏭️  Bot already commented on this post — skipping comment\n");
                        repliedPosts.add(item.commentId);
                        saveRepliedPosts(repliedPosts);
                        continue;
                    }

                    // Scrape post context + thread for v5-format prompt
                    var postCtx = await scrapePostContext(page);
                    item.postAuthor = postCtx.postAuthor || item.postAuthor || "Unknown";
                    item.postBody = postCtx.postBody || "";
                    item.thread = postCtx.thread || [];
                    // If we didn't have a title from feed scrape, use the one from the page
                    if (postCtx.postTitle) item.postTitle = postCtx.postTitle;

                    var replyText = await generateCommentReply(item, persons, botName);

                    console.log("─".repeat(50));
                    console.log("GENERATED REPLY TO COMMENT:");
                    console.log("─".repeat(50));
                    console.log(replyText);
                    console.log("─".repeat(50));
                    console.log("");

                    await typeCommentReply(page, item, replyText);
                    await submitReply(page, { inlineTarget: true });

                    // Queue ICP and hot leads for DM follow-up after comment reply
                    if (item.category_class === "icp" || item.category_class === "hot") {
                        queueHotLead(item.author, item.category_class + "-comment-reply", item.postTitle, community.name);
                    }

                    // Log the comment + Scott's reply to persons DB
                    personsDb.addInteraction(persons, item.author, {
                        type: "comment",
                        post_title: item.postTitle || "(no title)",
                        author: item.author,
                        text: item.text,
                        timestamp: new Date().toISOString(),
                    });
                    personsDb.addInteraction(persons, item.author, {
                        type: "scott_reply",
                        post_title: item.postTitle || "(no title)",
                        author: botName,
                        text: replyText,
                        timestamp: new Date().toISOString(),
                    });

                    summary.push({ type: "comment", title: item.author + "'s comment", author: item.author, category_class: item.category_class });
                    repliedPosts.add(item.commentId);
                    saveRepliedPosts(repliedPosts);
                }

                // Always check notifications between items — hot replies need to be
                // caught immediately, not on a 50% coin flip.
                if (i < workItems.length - 1) {
                    var hasNotifs = await hasUnreadNotifications(page);
                    if (hasNotifs) {
                        console.log("\n🔔 Notifications detected — checking between items...\n");
                        await handleNotifications(page, botName, repliedPosts, summary, persons);
                    } else {
                        console.log("🔔 No new notifications\n");
                    }
                }

                // Human-like delay between items
                // if (i < workItems.length - 1) {
                //     var delay = randomBetween(CONFIG.replyDelayMin, CONFIG.replyDelayMax);
                //     await countdown(delay, "⏸️  Next item in");
                // }
            }

            // Write the classifier log after every cycle (safe to call multiple times)
            sessionLog.writeLogs();

            // Final summary
            console.log("\n" + "═".repeat(50));
            console.log("📊 SESSION SUMMARY");
            console.log("═".repeat(50));
            console.log("Total posts found:    " + allPosts.length);
            console.log("Total comments found: " + allComments.length);
            console.log("Already replied:      " + repliedPosts.size);
            console.log("Items handled:        " + summary.length);
            for (var j = 0; j < summary.length; j++) {
                var s = summary[j];
                console.log("  " + (j + 1) + ". [" + s.type.toUpperCase() + "] [" + s.category_class.toUpperCase() + "] " + s.title.substring(0, 45) + " — by " + s.author);
            }
            console.log("═".repeat(50));
            console.log("✅ Cycle " + cycle + " complete.\n");

            // Wait before next cycle
            // var cycleDelay = randomBetween(CONFIG.cycleDelayMin, CONFIG.cycleDelayMax);
            // await countdown(cycleDelay, "💤 Next cycle in");

        } // end while(true)

    } catch (err) {
        console.error("❌ Fatal error:", err);
    } finally {
        await browser.close();
    }
}

main().catch(function(err) {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
});
