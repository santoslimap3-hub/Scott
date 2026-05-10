/**
 * scrape_all_communities.js
 *
 * Scrapes all posts AND threads (comments + nested replies) from both
 * Skool communities the project targets:
 *   - Synthesizer
 *   - Self-Improvement Nation
 *
 * Walks pagination up to MAX_PAGES (default 20) per community.
 * Resume-safe: re-running merges with the existing output file and skips
 *              posts (by URL) already in the dataset.
 *
 * Output: ./output/all_communities_posts.json
 *
 * Modeled on scraper.js but generalised to both communities and to scrape
 * EVERY post (not only ones Scott replied to). Threading logic is preserved
 * verbatim so the format stays compatible with downstream tooling.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const CONFIG = {
    email: process.env.SKOOL_EMAIL,
    password: process.env.SKOOL_PASSWORD,
    targetMember: process.env.TARGET_MEMBER || "Scott Northwolf",
    outputFile: process.env.OUTPUT_FILE_ALL || "all_communities_posts.json",
    headless: true,
    outputDir: "./output",
    parallel: 3,
    maxPages: parseInt(process.env.MAX_PAGES || "20", 10),
    communities: [
        {
            name: "synthesizer",
            url: "https://www.skool.com/synthesizer",
        },
        {
            name: "self-improvement-nation",
            url: "https://www.skool.com/self-improvement-nation-3104",
        },
    ],
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureOutputDir() {
    if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });
}

function saveJSON(filename, data) {
    const fp = path.join(CONFIG.outputDir, filename);
    fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function loadExistingDataset() {
    const fp = path.join(CONFIG.outputDir, CONFIG.outputFile);
    if (!fs.existsSync(fp)) return null;
    try {
        return JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) {
        console.log("⚠️  Could not parse existing " + fp + " — starting fresh");
        return null;
    }
}

function formatTime(ms) {
    var secs = Math.floor(ms / 1000);
    var mins = Math.floor(secs / 60);
    secs = secs % 60;
    if (mins > 0) return mins + "m " + secs + "s";
    return secs + "s";
}

async function login(page) {
    console.log("🔐 Logging in...");
    await page.goto("https://www.skool.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);
    await page.fill('input[name="email"], input[type="email"]', CONFIG.email);
    await page.fill('input[name="password"], input[type="password"]', CONFIG.password);
    await page.click('button[type="submit"]');
    await sleep(3500);
    if (page.url().includes("login")) throw new Error("Login failed");
    console.log("✅ Logged in");
}

async function collectPostsForCommunity(page, communityUrl, communityName) {
    console.log("\n📋 [" + communityName + "] Collecting posts (max " + CONFIG.maxPages + " pages)...");
    var phaseStart = Date.now();
    var allPosts = [];
    var pageNum = 1;

    await page.goto(communityUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4000);

    while (true) {
        var posts = null;
        for (var retries = 0; retries < 3; retries++) {
            try {
                await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
                posts = await page.evaluate(function() {
                    var cards = [];
                    var wrappers = document.querySelectorAll('[class*="PostItemWrapper"]');
                    var base = window.location.origin + "/" + window.location.pathname.split("/")[1];
                    wrappers.forEach(function(el) {
                        var links = Array.from(el.querySelectorAll("a")).map(function(a) {
                            return { href: a.href, text: a.textContent.trim() };
                        });
                        var profileLinks = links.filter(function(l) { return l.href.includes("/@"); });
                        var author = "Unknown";
                        for (var i = 0; i < profileLinks.length; i++) {
                            if (!/^\d+$/.test(profileLinks[i].text)) { author = profileLinks[i].text; break; }
                        }
                        var postLink = links.find(function(l) {
                            return l.href.startsWith(base + "/") && !l.href.includes("/@") && !l.href.includes("?c=") && !l.href.includes("?p=") && l.href.split("/").length > 4;
                        });
                        var categoryEl = el.querySelector('[class*="GroupFeedLinkLabel"]');
                        var timeEl = el.querySelector('[class*="PostTimeContent"]');
                        var contentEl = el.querySelector('[class*="PostItemCardContent"]');
                        // Skip pinned posts so pagination ordering is reliable
                        var isPinned = !!el.querySelector('[class*="Pin"], [class*="pin"]');
                        cards.push({
                            author: author,
                            title: postLink ? postLink.text : "",
                            category: categoryEl ? categoryEl.textContent.trim() : "",
                            timestamp: timeEl ? timeEl.textContent.trim().replace(".", "").trim() : "",
                            postUrl: postLink ? postLink.href : null,
                            body: contentEl ? contentEl.textContent.trim() : "",
                            pinned: isPinned,
                        });
                    });
                    return cards;
                });
                break;
            } catch (e) {
                console.log("  Page " + pageNum + " attempt " + (retries + 1) + " failed: " + e.message);
                await sleep(2000);
                if (retries === 2) {
                    console.log("  Skipping page " + pageNum + " after 3 failures");
                }
            }
        }

        if (posts && posts.length > 0) {
            // Filter pinned (they repeat across pages) on pages > 1
            var fresh = posts.filter(function(p) { return pageNum === 1 || !p.pinned; });
            console.log("  Page " + pageNum + ": " + posts.length + " cards (" + fresh.length + " kept)");
            allPosts = allPosts.concat(fresh);
        } else if (posts && posts.length === 0) {
            break;
        }

        if (pageNum >= CONFIG.maxPages) {
            console.log("  Reached max pages cap (" + CONFIG.maxPages + ")");
            break;
        }

        var wentNext = false;
        try {
            wentNext = await page.evaluate(function() {
                var btns = document.querySelectorAll("button, a");
                for (var i = 0; i < btns.length; i++) {
                    var txt = btns[i].textContent.trim();
                    if (txt === ">" || txt === "Next" || txt === "›") {
                        if (!btns[i].disabled) { btns[i].click(); return true; }
                    }
                }
                return false;
            });
        } catch (e) {
            console.log("  Pagination click failed: " + e.message);
            break;
        }
        if (!wentNext) {
            console.log("  No next-page button found — end of feed");
            break;
        }
        try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch (_) {}
        await sleep(1500);
        pageNum++;
    }

    // De-dup within the community by post URL
    var seen = new Set();
    var deduped = [];
    allPosts.forEach(function(p) {
        if (!p.postUrl) return;
        if (seen.has(p.postUrl)) return;
        seen.add(p.postUrl);
        deduped.push(p);
    });

    var phaseTime = Date.now() - phaseStart;
    console.log("✅ [" + communityName + "] " + deduped.length + " unique posts in " + formatTime(phaseTime));
    return deduped;
}

async function extractThreadedComments(page, postUrl, targetName) {
    await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);

    // Scroll to load all comments
    for (var i = 0; i < 6; i++) {
        await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
        await sleep(500);
    }

    // Expand collapsed reply threads — multiple rounds
    for (var attempt = 0; attempt < 5; attempt++) {
        var clicked = await page.evaluate(function() {
            var count = 0;
            var expandBtns = document.querySelectorAll('[class*="ViewRepl"], [class*="viewRepl"], [class*="ShowRepl"], [class*="showRepl"], [class*="ExpandRepl"], [class*="expandRepl"], [class*="view-repl"], [class*="show-repl"]');
            expandBtns.forEach(function(el) { try { el.click(); count++; } catch (e) {} });
            if (count === 0) {
                var allEls = document.querySelectorAll('button, a, span[role="button"], div[role="button"], [class*="Repl"] span, [class*="repl"] span');
                for (var i = 0; i < allEls.length; i++) {
                    var txt = allEls[i].textContent.trim();
                    if (txt.length > 50) continue;
                    if (/\d+\s*repl/i.test(txt) || /view.*repl/i.test(txt) || /show.*repl/i.test(txt)) {
                        try { allEls[i].click(); count++; } catch (e) {}
                    }
                }
            }
            return count;
        });
        if (clicked === 0) break;
        await sleep(800);
    }

    // Click "See more" / "Read more" to expand truncated content
    for (var seeMoreAttempt = 0; seeMoreAttempt < 5; seeMoreAttempt++) {
        var expandedCount = await page.evaluate(function() {
            var count = 0;
            var allClickable = document.querySelectorAll("button, a, span, div[role=button]");
            for (var i = 0; i < allClickable.length; i++) {
                var txt = allClickable[i].textContent.trim();
                if (txt.length > 30) continue;
                if (/^see\s*more$/i.test(txt) || /^\.\.\.\s*see\s*more$/i.test(txt) || /^read\s*more$/i.test(txt) || /^show\s*more$/i.test(txt) || txt === "See more" || txt === "... See more") {
                    try { allClickable[i].click(); count++; } catch (e) {}
                }
            }
            var classTargets = document.querySelectorAll('[class*="SeeMore"], [class*="see-more"], [class*="seeMore"], [class*="ReadMore"], [class*="readMore"], [class*="read-more"], [class*="ShowMore"], [class*="showMore"], [class*="Truncat"], [class*="truncat"], [class*="Expand"], [class*="expand"]');
            classTargets.forEach(function(el) {
                var t = el.textContent.trim();
                if (t.length < 30) { try { el.click(); count++; } catch (e) {} }
            });
            return count;
        });
        if (expandedCount === 0) break;
        await sleep(500);
    }

    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await sleep(300);

    // Pull the post body cleanly so the dataset has the full text (the
    // feed-card preview can be truncated). Scope to non-comment containers.
    var fullBody = await page.evaluate(function() {
        var blacklist = /emoji|picker|draggable|tooltip|avatar|badge|comment|reply|reaction/i;
        var blockedAncestor = /CommentsSection|CommentsList|CommentsListWrapper/;
        function inComments(el) {
            var p = el;
            for (var i = 0; i < 12 && p; i++) {
                var cls = p.className || "";
                if (typeof cls === "string" && blockedAncestor.test(cls)) return true;
                p = p.parentElement;
            }
            return false;
        }
        var bodyContainers = document.querySelectorAll('[class*="PostBody"], [class*="PostContent"], [class*="PostItemContent"]');
        for (var i = 0; i < bodyContainers.length; i++) {
            var c = bodyContainers[i];
            if (inComments(c)) continue;
            var paragraphs = c.querySelectorAll("p, div, span");
            var parts = [];
            for (var j = 0; j < paragraphs.length; j++) {
                var p = paragraphs[j];
                if (inComments(p)) continue;
                var cls = p.className || "";
                if (typeof cls === "string" && blacklist.test(cls)) continue;
                var t = (p.innerText || "").trim();
                if (!t) continue;
                if (t.length < 2) continue;
                if (parts.indexOf(t) === -1) parts.push(t);
            }
            var joined = parts.join("\n").trim();
            if (joined.length > 20) return joined;
        }
        return "";
    });

    var threads = await page.evaluate(function(targetName) {
        var conversations = [];
        var allBubbles = document.querySelectorAll('[class*="CommentItemBubble"]');
        var seen = new Set();

        function getAuthor(bubble) {
            var links = Array.from(bubble.querySelectorAll('a[href*="/@"]'));
            for (var i = 0; i < links.length; i++) {
                var txt = links[i].textContent.trim();
                if (/^\d+$/.test(txt) || txt.startsWith("@")) continue;
                return txt;
            }
            return "Unknown";
        }

        function getContent(bubble) {
            var text = bubble.innerText.trim();
            var author = getAuthor(bubble);
            var idx = text.indexOf(author);
            if (idx !== -1) text = text.substring(idx + author.length).trim();
            text = text.replace(/^[^\w@]*[·•]\s*\d+[hmd]\s*/i, "").trim();
            text = text.replace(/^[^\w@]*[·•]\s*\w+\s+\d+\s*/i, "").trim();
            text = text.replace(/\n?\s*To pick up a draggable item[\s\S]*?press escape to cancel\.\s*/gm, '');
            text = text.replace(/\s*Drop files here to upload[\s\S]*$/m, '');
            text = text.replace(/\s*Recently UsedSmileys & People[\s\S]*$/m, '');
            text = text.replace(/\d*\s*Reply\s*$/, '');
            return text.trim();
        }

        function isTarget(author) { return author.trim() === targetName; }

        var replyClassPattern = /Reply|reply|Replies|replies|Nested|nested|Child|child/;

        function isReplyBubble(bubble) {
            var el = bubble.parentElement;
            for (var i = 0; i < 10; i++) {
                if (!el) break;
                var cls = el.className || "";
                if (replyClassPattern.test(cls)) return true;
                el = el.parentElement;
            }
            return false;
        }

        function findReplies(bubble) {
            var replies = [];
            var node = bubble;
            for (var i = 0; i < 10; i++) {
                if (!node || !node.parentElement) break;
                node = node.parentElement;
                var sibling = node.nextElementSibling;
                if (sibling) {
                    var cls = sibling.className || "";
                    if (replyClassPattern.test(cls)) {
                        var replyBubbles = sibling.querySelectorAll('[class*="CommentItemBubble"]');
                        replyBubbles.forEach(function(rb) {
                            var rAuthor = getAuthor(rb);
                            if (rAuthor === "Unknown") return;
                            var rContent = getContent(rb);
                            var rKey = rAuthor + "|" + rContent.substring(0, 50);
                            if (!seen.has(rKey)) {
                                seen.add(rKey);
                                replies.push({ author: rAuthor, content: rContent, isTargetMember: isTarget(rAuthor) });
                            }
                        });
                        if (replies.length > 0) return replies;
                    }
                }
                var nextSib = node.nextElementSibling;
                while (nextSib) {
                    var nCls = nextSib.className || "";
                    if (nCls && replyClassPattern.test(nCls)) {
                        var rbs = nextSib.querySelectorAll('[class*="CommentItemBubble"]');
                        rbs.forEach(function(rb) {
                            var rAuthor = getAuthor(rb);
                            if (rAuthor === "Unknown") return;
                            var rContent = getContent(rb);
                            var rKey = rAuthor + "|" + rContent.substring(0, 50);
                            if (!seen.has(rKey)) {
                                seen.add(rKey);
                                replies.push({ author: rAuthor, content: rContent, isTargetMember: isTarget(rAuthor) });
                            }
                        });
                        if (replies.length > 0) return replies;
                    }
                    nextSib = nextSib.nextElementSibling;
                }
            }
            return replies;
        }

        allBubbles.forEach(function(bubble) {
            if (isReplyBubble(bubble)) return;
            var author = getAuthor(bubble);
            if (author === "Unknown") return;
            var content = getContent(bubble);
            var key = author + "|" + content.substring(0, 50);
            if (seen.has(key)) return;
            seen.add(key);
            var thread = {
                comment: { author: author, content: content, isTargetMember: isTarget(author) },
                replies: findReplies(bubble),
            };
            conversations.push(thread);
        });
        return conversations;
    }, targetName);

    return { threads: threads, fullBody: fullBody };
}

async function main() {
    var totalStart = Date.now();
    console.log("🚀 ALL-COMMUNITIES SCRAPER");
    console.log("===========================");
    console.log("Communities: " + CONFIG.communities.map(function(c) { return c.name; }).join(", "));
    console.log("Max pages per community: " + CONFIG.maxPages);
    console.log("Parallel comment tabs:   " + CONFIG.parallel);
    console.log("Output:                  " + path.join(CONFIG.outputDir, CONFIG.outputFile));
    console.log("");

    if (!CONFIG.email || !CONFIG.password) {
        console.error("Missing SKOOL_EMAIL / SKOOL_PASSWORD in .env");
        process.exit(1);
    }
    ensureOutputDir();

    // Resume support: load existing dataset (if any) and build a set of URLs
    // we've already scraped so we can skip them.
    var existing = loadExistingDataset();
    var alreadyScraped = new Set();
    var dataset;
    if (existing && Array.isArray(existing.interactions)) {
        existing.interactions.forEach(function(it) {
            if (it && it.original_post && it.original_post.url) alreadyScraped.add(it.original_post.url);
        });
        dataset = existing;
        console.log("📦 Resuming: " + alreadyScraped.size + " posts already in " + CONFIG.outputFile);
    } else {
        dataset = {
            metadata: {
                communities: CONFIG.communities.map(function(c) { return c.name; }),
                targetMember: CONFIG.targetMember,
                scrapedAt: new Date().toISOString(),
                maxPagesPerCommunity: CONFIG.maxPages,
                totalPosts: 0,
                totalThreads: 0,
            },
            interactions: [],
        };
    }

    var browser = await chromium.launch({ headless: CONFIG.headless, slowMo: 0 });
    var context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    var mainPage = await context.newPage();

    try {
        await login(mainPage);

        // Phase 1: collect posts from all communities up front
        var collected = []; // [{ community, post }]
        for (var ci = 0; ci < CONFIG.communities.length; ci++) {
            var c = CONFIG.communities[ci];
            var posts = await collectPostsForCommunity(mainPage, c.url, c.name);
            posts.forEach(function(p) { collected.push({ community: c.name, post: p }); });
        }

        // Skip posts already scraped (resume)
        var todo = collected.filter(function(item) {
            return item.post.postUrl && !alreadyScraped.has(item.post.postUrl);
        });
        var skipped = collected.length - todo.length;
        console.log("\n📊 Total candidates: " + collected.length + " (" + skipped + " already scraped, " + todo.length + " to fetch)");

        if (todo.length === 0) {
            console.log("Nothing new to scrape. Exiting.");
            await browser.close();
            return;
        }

        // Phase 2: extract threaded comments in parallel batches
        console.log("\n💬 Phase 2: Extracting threads...");
        console.log("  " + todo.length + " posts / " + CONFIG.parallel + " parallel = " + Math.ceil(todo.length / CONFIG.parallel) + " batches\n");

        var phase2Start = Date.now();
        var batchTimes = [];
        var totalBatches = Math.ceil(todo.length / CONFIG.parallel);
        var idCounter = dataset.interactions.length;

        for (var batch = 0; batch < todo.length; batch += CONFIG.parallel) {
            var batchStart = Date.now();
            var batchNum = Math.floor(batch / CONFIG.parallel) + 1;
            var batchEnd = Math.min(batch + CONFIG.parallel, todo.length);
            var batchItems = todo.slice(batch, batchEnd);

            var elapsed = Date.now() - phase2Start;
            var eta = "calculating...";
            if (batchTimes.length > 0) {
                var avgBatchTime = batchTimes.reduce(function(a, b) { return a + b; }, 0) / batchTimes.length;
                eta = formatTime(avgBatchTime * (totalBatches - batchNum + 1));
            }
            var titles = batchItems.map(function(it) { return (it.post.title || "?").substring(0, 18); }).join(" | ");
            console.log("  Batch " + batchNum + "/" + totalBatches + "  [" + formatTime(elapsed) + " elapsed | ETA: " + eta + "]");
            console.log("    → " + titles);

            var promises = batchItems.map(async function(item) {
                var post = item.post;
                var threads = [];
                var fullBody = "";
                if (post.postUrl) {
                    var pg = await context.newPage();
                    try {
                        var res = await extractThreadedComments(pg, post.postUrl, CONFIG.targetMember);
                        threads = res.threads;
                        fullBody = res.fullBody;
                    } catch (e) {
                        try {
                            var res2 = await extractThreadedComments(pg, post.postUrl, CONFIG.targetMember);
                            threads = res2.threads;
                            fullBody = res2.fullBody;
                        } catch (e2) {
                            console.log("    ⚠ failed: " + post.postUrl + " — " + e2.message);
                        }
                    }
                    await pg.close();
                }
                var scottInvolved = false;
                threads.forEach(function(t) {
                    if (t.comment.isTargetMember) scottInvolved = true;
                    t.replies.forEach(function(r) { if (r.isTargetMember) scottInvolved = true; });
                });
                return {
                    community: item.community,
                    interaction: {
                        id: String(++idCounter).padStart(4, "0"),
                        community: item.community,
                        original_post: {
                            author: post.author,
                            title: post.title,
                            body: fullBody || post.body,
                            preview_body: post.body,
                            category: post.category,
                            timestamp: post.timestamp,
                            url: post.postUrl,
                        },
                        threads: threads,
                        scott_involved: scottInvolved,
                    },
                    threadCount: threads.length,
                };
            });

            var results = await Promise.all(promises);

            var batchThreads = 0;
            results.forEach(function(r) {
                dataset.interactions.push(r.interaction);
                dataset.metadata.totalThreads = (dataset.metadata.totalThreads || 0) + r.threadCount;
                batchThreads += r.threadCount;
                alreadyScraped.add(r.interaction.original_post.url);
            });
            dataset.metadata.totalPosts = dataset.interactions.length;
            dataset.metadata.lastUpdatedAt = new Date().toISOString();

            var batchTime = Date.now() - batchStart;
            batchTimes.push(batchTime);
            console.log("    ✓ " + formatTime(batchTime) + " — " + batchThreads + " threads");

            // Save after every batch so a crash never costs more than one batch
            saveJSON(CONFIG.outputFile, dataset);
        }

        var totalTime = Date.now() - totalStart;
        console.log("\n===========================");
        console.log("🎉 DONE in " + formatTime(totalTime));
        console.log("");
        console.log("  Total interactions: " + dataset.interactions.length);
        console.log("  Total threads:      " + dataset.metadata.totalThreads);
        console.log("  Output:             " + path.join(CONFIG.outputDir, CONFIG.outputFile));
        // Per-community stats
        var perCom = {};
        dataset.interactions.forEach(function(it) {
            var c = it.community || "unknown";
            perCom[c] = (perCom[c] || 0) + 1;
        });
        Object.keys(perCom).forEach(function(k) {
            console.log("    " + k + ": " + perCom[k]);
        });
        console.log("===========================");
    } catch (e) {
        console.error("Error: " + e.message);
        try { await mainPage.screenshot({ path: path.join(CONFIG.outputDir, "error_all_communities.png") }); } catch (_) {}
    } finally {
        await browser.close();
    }
}

main();
