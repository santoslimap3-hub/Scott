const { chromium } = require("playwright");
const OpenAI = require("openai");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REPLIED_FILE = path.join(__dirname, "replied_posts.json");

const CONFIG = {
    email: process.env.SKOOL_EMAIL,
    password: process.env.SKOOL_PASSWORD,
    communities: [
        { name: "Self Improvement Nation", url: process.env.SKOOL_COMMUNITY_URL_1 || "https://www.skool.com/self-improvement-nation-3104" },
        { name: "Synthesizer", url: process.env.SKOOL_COMMUNITY_URL_2 || "https://www.skool.com/synthesizer" },
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
    await page.goto("https://www.skool.com/login", { waitUntil: "networkidle" });
    await sleep(800);
    await page.fill('input[name="email"], input[type="email"]', CONFIG.email);
    await page.fill('input[name="password"], input[type="password"]', CONFIG.password);
    await page.click('button[type="submit"]');
    await sleep(3000);
    if (page.url().includes("login")) throw new Error("Login failed — check credentials");
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
    await page.goto(communityUrl, { waitUntil: "networkidle" });
    await sleep(2000);

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
                posts.push({
                    author: rawAuthor,
                    title: titleLink.textContent.trim(),
                    category: categoryEl ? categoryEl.textContent.trim() : "General",
                    body: contentEl ? contentEl.textContent.trim() : "",
                    href: titleLink.href,
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
    console.log("🏷️  Classifying " + posts.length + " posts via LLM...");
    var postList = posts.map(function(p, i) {
        var preview = (p.title + " " + p.body).substring(0, 200);
        return i + ". [" + p.author + "] " + preview;
    }).join("\n");

    var completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        max_tokens: 1000,
        response_format: { type: "json_object" },
        messages: [{
            role: "system",
            content: "You are a post classifier. For each post, categorize as: \"icp\" (the author is a coach — life, business, fitness, self-improvement, or any other kind — who is looking for help, struggling, or seeking to grow their coaching business), \"advice\" (the author is asking for advice, tips, or guidance on a topic but is NOT identifiable as a coach), or \"other\" (everything else — wins, introductions, memes, general discussion). Return ONLY a JSON object with a \"results\" key containing an array of objects with \"index\" (number) and \"category\" (string)."
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
        if (posts[idx]) {
            posts[idx].category_class = cat;
            console.log("  [" + cat.toUpperCase() + "] " + posts[idx].title.substring(0, 60));
        }
    }
    // Tag any unmatched posts as "other"
    for (var j = 0; j < posts.length; j++) {
        if (!posts[j].category_class) posts[j].category_class = "other";
    }
    console.log("");
    return posts;
}

function selectPosts(classifiedPosts) {
    var count = CONFIG.minPosts + Math.floor(Math.random() * (CONFIG.maxPosts - CONFIG.minPosts + 1));
    console.log("🎯 Target: " + count + " posts (random " + CONFIG.minPosts + "-" + CONFIG.maxPosts + ")");

    var icpPosts = classifiedPosts.filter(function(p) { return p.category_class === "icp"; });
    var advicePosts = classifiedPosts.filter(function(p) { return p.category_class === "advice"; });
    var otherPosts = classifiedPosts.filter(function(p) { return p.category_class === "other"; });

    // Fill by priority: ICP → advice → other (shuffle within each tier)
    var pool = []
        .concat(icpPosts.sort(function() { return Math.random() - 0.5; }))
        .concat(advicePosts.sort(function() { return Math.random() - 0.5; }))
        .concat(otherPosts.sort(function() { return Math.random() - 0.5; }));

    var selected = pool.slice(0, count);

    var icpCount = selected.filter(function(p) { return p.category_class === "icp"; }).length;
    var adviceCount = selected.filter(function(p) { return p.category_class === "advice"; }).length;
    var otherCount = selected.filter(function(p) { return p.category_class === "other"; }).length;
    console.log("📊 Selected " + selected.length + " posts: " + icpCount + " ICP, " + adviceCount + " advice, " + otherCount + " other\n");
    return selected;
}

async function openPostAndGetBody(page, post) {
    console.log("📖 Opening post: " + post.title);
    await page.goto(post.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3000);

    var fullBody = await page.evaluate(function() {
        var selectors = [
            '[class*="PostContent"]',
            '[class*="post-body"]',
            '[class*="RichText"]',
            '.ql-editor',
            '[data-testid*="post-content"]',
            'article',
        ];
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent.trim().length > 20) return el.textContent.trim();
        }
        return "";
    });

    if (fullBody) post.body = fullBody;

    console.log("  Author:   " + post.author);
    console.log("  Category: " + post.category);
    console.log("  Body:     " + post.body.substring(0, 200) + (post.body.length > 200 ? "..." : ""));
    console.log("");
    return post;
}

async function alreadyCommented(page, botName) {
    if (!botName) return false;
    return await page.evaluate(function(name) {
        var commentAuthors = document.querySelectorAll('[class*="CommentItemContainer"] a[href*="/@"]');
        for (var i = 0; i < commentAuthors.length; i++) {
            if (commentAuthors[i].textContent.trim() === name) return true;
        }
        return false;
    }, botName);
}

async function generateReply(post) {
    console.log("🤖 Generating AI reply...\n");
    var completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        max_tokens: 300,
        messages: [{
            role: "system",
            content: "You are Jack Walford, community manager of Self-Improvement Nation. Your boss, Scott Northwolf, helps self-improvement coaches go from $0 to $10K/month in 42 days with the 'Reverse Engineered $10K Method' or they don't pay.\n\nYou speak like a legend of old. The wise old man of the mountain meets Alexander The Great rallying his soldiers to battle. Unshakable confidence without arrogance.\n\nWriting style:\nBe concise. No overexplaining. Focus on actionable steps, logical frameworks and motivational language with ancient sounding wording when appropriate.\nNever use dashes or bullet point formatting.\nCreate mystery with bold statements and loose 007 style comments.\nNever be needy or chase anyone. You are the SUN, always giving value, always in a good mood. Speaking to you is a privilege.\nUse '. . .' for ellipses and '! ! !' for emphasis. Never use generic AI patterns.\nSign off with variations of 'Duty, Honor and Pride! ! !"
        }, {
            role: "user",
            content: post.author + " posted in " + post.category + ":\n\n" + post.body + "\n\nWrite a short, natural reply."
        }],
    });
    return completion.choices[0].message.content;
}

async function typeReply(page, replyText) {
    // Skool uses an input with placeholder "Your comment"
    var replyBox = await page.$('input[placeholder="Your comment"]');

    // Fallback selectors
    if (!replyBox) {
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
        throw new Error("Could not find reply input box — saved debug_screenshot.png for inspection");
    }

    await replyBox.click();
    await sleep(500);
    await page.keyboard.type(replyText, { delay: 20 });
    await sleep(300);
    console.log("✏️  Reply typed into box\n");
}

async function submitReply(page) {
    // Click the COMMENT button to submit
    var commentBtn = await page.$('button:has-text("COMMENT"), button:has-text("Comment")');
    if (!commentBtn) {
        // Fallback: try finding by text content
        commentBtn = await page.$('button >> text=COMMENT');
    }
    if (!commentBtn) throw new Error("Could not find COMMENT button");
    await commentBtn.click();
    console.log("✅ Reply sent! Closing in 10 seconds...\n");
    await sleep(10000);
}

async function scrapeAllComments(page, posts, botName) {
    console.log("💬 Scraping comments from " + posts.length + " posts...\n");
    var allComments = [];

    var debugDone = false;
    for (var p = 0; p < posts.length; p++) {
        process.stdout.write("  📝 Scanning (" + (p + 1) + "/" + posts.length + "): " + posts[p].title.substring(0, 40) + "...      \r");
        try {
            await page.goto(posts[p].href, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch (e) {
            console.log("\n  \u26A0\uFE0F  Timeout on " + posts[p].title.substring(0, 40) + " \u2014 skipping");
            continue;
        }
        // Scroll down to trigger lazy-loaded comments
        await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
        await sleep(2000);
        await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
        await sleep(1500);

        var comments = await page.evaluate(function(args) {
            var postInfo = args.postInfo;
            var botDisplayName = args.botDisplayName;
            var debugFirst = args.debugFirst;

            // Try primary selector, fall back to alternatives
            var commentEls = document.querySelectorAll('[class*="CommentItemContainer"]');
            if (commentEls.length === 0) {
                commentEls = document.querySelectorAll('[class*="CommentOrReply"]');
            }

            var results = [];

            // Debug: on first post with >1 CommentOrReply elements (actual comments, not just wrapper)
            if (debugFirst && commentEls.length > 1) {
                var containerCount = document.querySelectorAll('[class*="CommentItemContainer"]').length;
                var orReplyCount = document.querySelectorAll('[class*="CommentOrReply"]').length;
                var bubbleCount = document.querySelectorAll('[class*="CommentItemBubble"]').length;
                // Also try some other common patterns
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
                // Dump innerHTML of first comment element (truncated)
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
                // Find author: iterate all /@-links, pick first with actual text
                // (the avatar link wraps an <img> and has no textContent)
                var authorLinks = el.querySelectorAll('a[href*="/@"]');
                var author = "";
                for (var j = 0; j < authorLinks.length; j++) {
                    var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                    if (t && t.length > 1) { author = t; break; }
                }
                if (author === botDisplayName || !author) continue;

                var textEl = el.querySelector('[class*="CommentItemBubble"]');
                var text = textEl ? textEl.textContent.trim() : "";
                // Fallback: grab text directly from element if no Bubble found
                if (!text) {
                    text = el.textContent.trim();
                }
                // Strip author name + timestamp prefix (e.g. "Jago Candy • 4d@Someone actual text...")
                // Pattern: AuthorName [optional emoji] • TimeAgo [optional (edited)] [optional @Someone]
                text = text.replace(/^[\s\S]*?\u2022\s*\d+[smhdw](?:\s*\(edited\))?\s*/i, "").trim();
                // Also strip leading @mention if reply starts with one
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
        }, { postInfo: posts[p], botDisplayName: botName, debugFirst: !debugDone });

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

        for (var c = 0; c < comments.length; c++) {
            comments[c].type = "comment";
            comments[c].commentId = posts[p].href + "|c|" + comments[c].author + "|" + comments[c].text.substring(0, 50);
        }
        allComments = allComments.concat(comments);
    }

    console.log("\n💬 Found " + allComments.length + " total comments across " + posts.length + " posts\n");
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
                max_tokens: 800,
                response_format: { type: "json_object" },
                messages: [{
                    role: "system",
                    content: 'Classify each comment as: "icp" (commenter is a coach seeking help/growth for their coaching business), "advice" (seeking advice/tips but NOT a coach), or "other" (everything else). Return JSON: {"results":[{"i":0,"c":"other"},...]}.'
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
                var realIdx = batchIndices[batchIdx];
                if (realIdx !== undefined && comments[realIdx]) {
                    comments[realIdx].category_class = cat;
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
    var counts = { icp: 0, advice: 0, other: 0 };
    for (var k = 0; k < comments.length; k++) {
        var cl = comments[k].category_class || "other";
        counts[cl] = (counts[cl] || 0) + 1;
        if (cl !== "other") {
            console.log("  " + (k + 1) + ". [" + cl.toUpperCase() + "] " + comments[k].author + ": " + comments[k].text.substring(0, 80));
        }
    }
    console.log("─".repeat(60));
    console.log("  Totals: " + counts.icp + " ICP, " + counts.advice + " advice, " + counts.other + " other");
    console.log("─".repeat(60) + "\n");

    return comments;
}

function selectComments(classifiedComments) {
    var count = randomBetween(CONFIG.minComments, CONFIG.maxComments);
    console.log("💬 Target: " + count + " comments (random " + CONFIG.minComments + "-" + CONFIG.maxComments + ")");

    var icpComments = classifiedComments.filter(function(c) { return c.category_class === "icp"; });
    var adviceComments = classifiedComments.filter(function(c) { return c.category_class === "advice"; });

    // Only ICP and advice — no "other" fallback for comments
    var pool = []
        .concat(icpComments.sort(function() { return Math.random() - 0.5; }))
        .concat(adviceComments.sort(function() { return Math.random() - 0.5; }));

    if (pool.length === 0) {
        console.log("💬 No ICP or advice comments found — skipping comments this cycle\n");
        return [];
    }

    var selected = pool.slice(0, count);
    var icpCount = selected.filter(function(c) { return c.category_class === "icp"; }).length;
    var adviceCount = selected.filter(function(c) { return c.category_class === "advice"; }).length;
    console.log("💬 Selected " + selected.length + " comments: " + icpCount + " ICP, " + adviceCount + " advice\n");
    return selected;
}

async function generateCommentReply(comment) {
    console.log("🤖 Generating reply to comment by " + comment.author + "...\n");
    var completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        max_tokens: 300,
        messages: [{
            role: "system",
            content: "You are Scott Northwolf, founder of Self-Improvement Nation. You help self-improvement coaches go from $0 to $10K/month in 42 days with the 'Reverse Engineered $10K Method' or they don't pay.\n\nYou speak like a legend of old. The wise old man of the mountain meets Alexander The Great rallying his soldiers to battle. Unshakable confidence without arrogance.\n\nWriting style:\nBe concise. No overexplaining. Focus on actionable steps, logical frameworks and motivational language with ancient sounding wording when appropriate.\nNever use dashes or bullet point formatting.\nCreate mystery with bold statements and loose 007 style comments.\nNever be needy or chase anyone. You are the SUN, always giving value, always in a good mood. Speaking to you is a privilege.\nUse '. . .' for ellipses and '! ! !' for emphasis. Never use generic AI patterns.\nSign off with variations of 'Duty, Honor and Pride! ! !'"
        }, {
            role: "user",
            content: comment.author + " commented on \"" + comment.postTitle + "\":\n\n" + comment.text.substring(0, 300) + "\n\nWrite a short, natural reply to this comment."
        }],
    });
    return completion.choices[0].message.content;
}

async function typeCommentReply(page, comment, replyText) {
    var commentTextStart = comment.text.substring(0, 30);
    var clicked = await page.evaluate(function(args) {
        var targetAuthor = args.author;
        var textStart = args.textStart;
        var comments = document.querySelectorAll('[class*="CommentItemContainer"]');
        for (var i = 0; i < comments.length; i++) {
            var el = comments[i];
            // Find author: iterate all /@-links, pick first with actual text
            var authorLinks = el.querySelectorAll('a[href*="/@"]');
            var author = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { author = t; break; }
            }
            if (author !== targetAuthor) continue;
            if (!el.textContent.includes(textStart)) continue;

            // Try the specific Reply button class first
            var replyBtn = el.querySelector('[class*="CommentItemReplyButton"]');
            if (replyBtn) { replyBtn.click(); return true; }
            // Fallback: scan for any element with text "reply"
            var links = el.querySelectorAll('a, button, span');
            for (var k = 0; k < links.length; k++) {
                if (links[k].textContent.trim().toLowerCase() === 'reply') {
                    links[k].click();
                    return true;
                }
            }
        }
        return false;
    }, { author: comment.author, textStart: commentTextStart });
    if (clicked) {
        console.log("  ↩️  Clicked Reply on " + comment.author + "'s comment");
        await sleep(800);
    } else {
        console.log("  ⚠️  Could not find Reply button — using main comment box");
    }

    await typeReply(page, replyText);
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

            // Phase 1: Collect all posts
            var allPosts = await getAllPosts(page, community.url);

            // Phase 1b: Scrape comments from all posts
            var allComments = await scrapeAllComments(page, allPosts, botName);

            // Filter out already-replied posts and comments
            var newPosts = allPosts.filter(function(p) { return !repliedPosts.has(p.href); });
            console.log("🚫 Posts: filtered out " + (allPosts.length - newPosts.length) + " already-replied, " + newPosts.length + " remaining");
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
                var classifiedPosts = await classifyPosts(newPosts);
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
            var summary = [];
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

                    var replyText = await generateReply(post);

                    console.log("─".repeat(50));
                    console.log("GENERATED REPLY:");
                    console.log("─".repeat(50));
                    console.log(replyText);
                    console.log("─".repeat(50));
                    console.log("");

                    await typeReply(page, replyText);

                    summary.push({ type: "post", title: post.title, author: post.author, category_class: post.category_class });
                    repliedPosts.add(post.href);
                    saveRepliedPosts(repliedPosts);

                } else if (item.type === "comment") {
                    console.log("💬 Comment by " + item.author + " on: " + item.postTitle);
                    console.log("  Text: " + item.text.substring(0, 200) + (item.text.length > 200 ? "..." : ""));
                    console.log("");

                    await page.goto(item.postHref, { waitUntil: "domcontentloaded", timeout: 30000 });
                    await sleep(2000);

                    var replyText = await generateCommentReply(item);

                    console.log("─".repeat(50));
                    console.log("GENERATED REPLY TO COMMENT:");
                    console.log("─".repeat(50));
                    console.log(replyText);
                    console.log("─".repeat(50));
                    console.log("");

                    await typeCommentReply(page, item, replyText);

                    summary.push({ type: "comment", title: item.author + "'s comment", author: item.author, category_class: item.category_class });
                    repliedPosts.add(item.commentId);
                    saveRepliedPosts(repliedPosts);
                }

                // Human-like delay between items
                // if (i < workItems.length - 1) {
                //     var delay = randomBetween(CONFIG.replyDelayMin, CONFIG.replyDelayMax);
                //     await countdown(delay, "⏸️  Next item in");
                // }
            }

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
            console.log("✅ Cycle " + cycle + " complete — no replies were submitted.\n");

            // Wait before next cycle
            // var cycleDelay = randomBetween(CONFIG.cycleDelayMin, CONFIG.cycleDelayMax);
            // await countdown(cycleDelay, "💤 Next cycle in");

        } // end while(true)

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await browser.close();
    }
}

main();