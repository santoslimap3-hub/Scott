// skool_browser.js
// ─────────────────────────────────────────────────────────────────────────────
// All Playwright browser mechanics for the Skool bot.
// Extracted from auto_reply_legacy.js — only the functions that work today.
//
// Exports:
//   login(page)                           → botName (string)
//   getAllPosts(page, communityUrl)        → [{author, title, category, body, href, commentCount}]
//   openPostAndGetBody(page, post)         → post (mutated with .body, .title, .author)
//   typeReply(page, replyText)             → void   (top-level comment box only)
//   submitReply(page)                      → void   (Path B: COMMENT button)
//   hasUnreadNotifications(page)           → bool
//   clickNotificationBell(page)            → bool
//   getNotificationItems(page)             → [{text, href, isUnread}]
//   markNotificationsRead(page)            → void   (closes the dropdown)
//   alreadyCommented(page, botName)        → bool
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// Bring a Playwright ElementHandle into the upper-third of the viewport so
// the human watching a non-headless run can SEE the bot type into it. Skool's
// reply inputs are usually at the bottom of the viewport (and inside nested
// scrollable containers, so plain window.scrollBy is useless) AND they grow
// downward as text is typed — so we aim for the top third, leaving ~60% of
// the screen below the box for downward expansion.
//
// Implementation notes:
//   - We don't trust a single scrollIntoView call. Skool wraps the feed in
//     an internal scrollable div; centering vs. that div may still leave the
//     element off-screen relative to the actual window.
//   - We walk UP the DOM finding every scrollable ancestor and adjust each
//     one's scrollTop so the element ends up at ~ vh/3 from the top of the
//     real viewport.
//   - Returns the bounding-rect info so callers can log / debug what happened.
async function scrollElementToViewportCenter(page, handle) {
    if (!handle) return null;
    var info = null;
    try {
        info = await handle.evaluate(function(el) {
            // 1. Native scrollIntoView first — covers the simple case.
            try {
                el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            } catch (_) {
                el.scrollIntoView({ block: "center", inline: "nearest" });
            }

            // 2. Walk ancestors, scrolling each scrollable container so the
            // element's vertical center sits near 1/3 of the visible window.
            var vh = window.innerHeight || document.documentElement.clientHeight;
            var targetY = Math.floor(vh / 3);  // box top should land here
            var SAFE_PASSES = 3;                // a couple of passes converge
            for (var pass = 0; pass < SAFE_PASSES; pass++) {
                var rect = el.getBoundingClientRect();
                var diff = rect.top - targetY;  // >0 → element below target → scroll DOWN containers
                if (Math.abs(diff) < 8) break;

                // Find the closest scrollable ancestor and shift it.
                var node = el.parentElement;
                var scrolledThisPass = false;
                while (node && node !== document.documentElement) {
                    var style = window.getComputedStyle(node);
                    var oy = style.overflowY;
                    var canScroll = (oy === "auto" || oy === "scroll" || oy === "overlay") &&
                                    node.scrollHeight > node.clientHeight + 2;
                    if (canScroll) {
                        var before = node.scrollTop;
                        node.scrollTop = Math.max(0, before + diff);
                        if (node.scrollTop !== before) {
                            scrolledThisPass = true;
                            break;  // restart the pass after this scroll
                        }
                    }
                    node = node.parentElement;
                }

                // If no inner container moved, fall back to scrolling the
                // window/document.
                if (!scrolledThisPass) {
                    var beforeY = window.scrollY;
                    window.scrollBy(0, diff);
                    if (window.scrollY === beforeY) break;  // can't scroll any further
                }
            }

            var finalRect = el.getBoundingClientRect();
            return {
                top: Math.round(finalRect.top),
                bottom: Math.round(finalRect.bottom),
                vh: vh,
                onscreen: finalRect.top >= 0 && finalRect.bottom <= vh,
            };
        });
    } catch (_) { /* element may have detached */ }

    // Settle (sticky bars animate in over ~150ms).
    await sleep(180);
    return info;
}

// Re-center every `intervalMs` until `keepAlive()` returns false. Used during
// long typing operations so the box doesn't drift off-screen as the textarea
// grows. Caller is responsible for setting and clearing the keep-alive flag.
function startScrollRecenterLoop(page, handle, intervalMs) {
    var stopped = false;
    var ms = intervalMs || 700;
    (async function loop() {
        while (!stopped) {
            try { await scrollElementToViewportCenter(page, handle); } catch (_) {}
            // Don't let sleep slip past stop().
            for (var t = 0; t < ms && !stopped; t += 100) {
                await sleep(100);
            }
        }
    })();
    return function stop() { stopped = true; };
}

const BOT_ALT_NAMES = (process.env.BOT_ALT_NAMES || "Daniel Carter")
    .split(",")
    .map(function(s) { return s.trim(); })
    .filter(Boolean);

function normalizeName(name) {
    if (!name || typeof name !== "string") return "";
    return name
        .replace(/\u00c2/g, "")
        .replace(/[\u00a0\u2007\u202f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getBotIdentityNames(botName) {
    var names = [];

    function addName(name) {
        var normalized = normalizeName(name);
        if (!normalized) return;
        if (names.indexOf(normalized) === -1) names.push(normalized);
    }

    addName(botName);
    addName(process.env.BOT_NAME);
    BOT_ALT_NAMES.forEach(addName);
    return names;
}

// ── Login ─────────────────────────────────────────────────────────────────────

async function login(page, email, password) {
    console.log("🔐 Logging in...");
    await page.goto("https://www.skool.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('input[name="email"], input[type="email"]', { timeout: 15000 });
    await sleep(800);
    await page.fill('input[name="email"], input[type="email"]', email);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('button[type="submit"]');

    try {
        await page.waitForURL(function(url) { return !url.toString().includes("/login"); }, { timeout: 15000 });
    } catch (e) {
        var errorMsg = await page.evaluate(function() {
            var err = document.querySelector('[class*="Error"], [class*="error"], [role="alert"], [class*="Alert"]');
            return err ? err.textContent.trim() : null;
        });
        if (errorMsg) throw new Error("Login failed — site says: " + errorMsg);
        if (page.url().includes("login")) throw new Error("Login failed — still on login page. URL: " + page.url());
    }
    console.log("✅ Logged in");

    if (process.env.BOT_NAME) {
        console.log("Bot account name: " + process.env.BOT_NAME + " (from BOT_NAME env)\n");
        return process.env.BOT_NAME;
    }

    // Grab the bot's display name for duplicate-comment detection
    await page.goto("https://www.skool.com", { waitUntil: "domcontentloaded" });
    await sleep(3000);
    var botName = await page.evaluate(function() {
        var navSelectors = [
            'nav a[href*="/@"]',
            'header a[href*="/@"]',
            '[class*="TopNav"] a[href*="/@"]',
            '[class*="NavBar"] a[href*="/@"]',
            '[class*="Navbar"] a[href*="/@"]',
            '[class*="Header"] a[href*="/@"]',
        ];
        for (var i = 0; i < navSelectors.length; i++) {
            var links = document.querySelectorAll(navSelectors[i]);
            for (var j = 0; j < links.length; j++) {
                var text = links[j].textContent.trim();
                if (text.length > 1 && !text.match(/^\d+$/)) return text;
            }
        }

        var navImgSelectors = [
            'nav img[alt]', 'header img[alt]',
            '[class*="TopNav"] img[alt]',
            '[class*="NavBar"] img[alt]',
        ];
        for (var ni = 0; ni < navImgSelectors.length; ni++) {
            var imgs = document.querySelectorAll(navImgSelectors[ni]);
            for (var ii = 0; ii < imgs.length; ii++) {
                var alt = (imgs[ii].getAttribute("alt") || "").trim();
                if (alt.length > 1 && !/logo|icon/i.test(alt) && !alt.match(/^\d+$/)) return alt;
            }
        }
        return "";
    });
    if (!botName) {
        var avatarBtn = await page.$('[class*="UserAvatar"], [class*="avatar"], img[class*="Avatar"]');
        if (avatarBtn) { await avatarBtn.click(); await sleep(800); }
        botName = await page.evaluate(function() {
            var dropSelectors = [
                '[class*="Dropdown"] a[href*="/@"]',
                '[class*="Popover"] a[href*="/@"]',
                '[class*="Menu"] a[href*="/@"]',
                '[class*="Panel"] a[href*="/@"]',
            ];
            for (var i = 0; i < dropSelectors.length; i++) {
                var links = document.querySelectorAll(dropSelectors[i]);
                for (var j = 0; j < links.length; j++) {
                    var text = links[j].textContent.trim();
                    if (text.length > 1 && !text.match(/^\d+$/)) return text;
                }
            }
            return "";
        });
        await page.keyboard.press("Escape");
        await sleep(300);
    }
    console.log("👤 Bot account name: " + (botName || "(unknown)") + "\n");
    return botName;
}

// ── Feed scraper ──────────────────────────────────────────────────────────────

// Scrape non-pinned posts from a Skool community feed across one or more
// pagination pages. Skool uses ?p=N for pages > 1.
//
//   getAllPosts(page, url)              → page 1 only (back-compat default)
//   getAllPosts(page, url, 3)           → pages 1, 2, 3 (deduped by href)
//   getAllPosts(page, url, { maxPages: 3 }) → same, options form
//
// If a later page returns 0 new posts, the loop breaks early — no error.
async function getAllPosts(page, communityUrl, opts) {
    var maxPages = 1;
    if (typeof opts === "number") maxPages = Math.max(1, opts);
    else if (opts && typeof opts === "object" && opts.maxPages) maxPages = Math.max(1, opts.maxPages);

    var seenHrefs = {};
    var aggregated = [];
    var pagesScraped = 0;

    for (var pageNum = 1; pageNum <= maxPages; pageNum++) {
        var url = pageNum === 1 ? communityUrl : appendQueryParam(communityUrl, "p", String(pageNum));
        console.log("📋 Navigating to community" + (pageNum > 1 ? " (page " + pageNum + ")" : "") + "...");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await sleep(4000);

        var pagePosts = await scrapeFeedCardsOnPage(page);
        pagesScraped++;

        // De-dupe across pages by href — pinned posts can re-appear on every
        // page, and posts may shift between pages between fetches.
        var newOnThisPage = 0;
        for (var ai = 0; ai < pagePosts.length; ai++) {
            var hrefKey = pagePosts[ai].href;
            if (!hrefKey || seenHrefs[hrefKey]) continue;
            seenHrefs[hrefKey] = true;
            aggregated.push(pagePosts[ai]);
            newOnThisPage++;
        }
        console.log("📋 Page " + pageNum + ": " + pagePosts.length + " posts (" + newOnThisPage + " new)");

        if (newOnThisPage === 0) {
            console.log("  no new posts on page " + pageNum + " — stopping pagination");
            break;
        }
    }

    if (aggregated.length === 0) throw new Error("No non-pinned posts found across " + pagesScraped + " page(s)");
    console.log("📋 Total: " + aggregated.length + " non-pinned posts across " + pagesScraped + " page(s)\n");
    return aggregated;
}

// Append/replace a query param on a URL (avoids string-concat edge cases).
function appendQueryParam(url, key, value) {
    try {
        var u = new URL(url);
        u.searchParams.set(key, value);
        return u.toString();
    } catch (_) {
        var sep = url.indexOf("?") === -1 ? "?" : "&";
        return url + sep + key + "=" + encodeURIComponent(value);
    }
}

// Per-page scrape — the original single-page extraction logic, factored out
// so the pagination loop above stays readable.
async function scrapeFeedCardsOnPage(page) {
    return await page.evaluate(function() {
        var wrappers = Array.from(document.querySelectorAll('[class*="PostItemWrapper"]'));
        var posts = [];
        for (var i = 0; i < wrappers.length; i++) {
            var w = wrappers[i];
            if (w.textContent.includes("Pinned") || w.querySelector('[class*="Pinned"], [class*="pinned"]')) continue;

            var authorEl    = w.querySelector(
                '[class*="PostAuthor"] a[href*="/@"], ' +
                '[class*="Author"] a[href*="/@"], ' +
                '[class*="postHeader"] a[href*="/@"], ' +
                'a[href*="/@"]'
            );
            var categoryEl  = w.querySelector('[class*="GroupFeedLinkLabel"]');
            var contentEl   = w.querySelector('[class*="PostItemCardContent"]');
            var postLinks   = Array.from(w.querySelectorAll("a")).filter(function(a) {
                var href = a.href || "";
                return href.includes("/post/") || (href.split("/").length > 4 && !href.includes("/@") && !href.includes("?c=") && !href.includes("?p="));
            });
            var titleLink = postLinks.find(function(a) { return a.textContent.trim().length > 3; });

            if (titleLink) {
                var rawAuthor = authorEl ? authorEl.textContent.trim() : "Unknown";
                rawAuthor = rawAuthor
                    .replace(/^\d+/, "")
                    .replace(/\u00c2/g, "")
                    .replace(/[\u00a0\u2007\u202f]/g, " ")
                    .replace(/\s+/g, " ")
                    .trim() || "Unknown";

                var commentCount = 0;
                var countEl = w.querySelector('[class*="CommentsCount"], [class*="commentCount"], [class*="CommentCount"]');
                if (countEl) {
                    var n = parseInt(countEl.textContent.trim(), 10);
                    if (!isNaN(n)) commentCount = n;
                }
                if (commentCount === 0) {
                    var spans = w.querySelectorAll("span, div");
                    for (var s = 0; s < spans.length; s++) {
                        var spanText  = spans[s].textContent.trim();
                        var spanClass = (spans[s].className || "").toString();
                        if (/comment/i.test(spanClass) && /^\d+$/.test(spanText)) {
                            commentCount = parseInt(spanText, 10);
                            break;
                        }
                    }
                }

                // Best-effort extraction of the post's relative-time string
                // ("2m", "14h", "3d") from the card. Skool doesn't expose an
                // ISO datetime in the feed DOM, so we lean on (a) a [datetime]
                // attribute when present and (b) regex match on visible text.
                // Returned as a raw string; auto_reply.js parses it to minutes.
                var ageText = "";
                var timeEl = w.querySelector("time[datetime]");
                if (timeEl) {
                    var dt = timeEl.getAttribute("datetime");
                    if (dt) ageText = dt; // ISO format; auto_reply will parse it
                }
                if (!ageText) {
                    var headerEls = w.querySelectorAll('[class*="PostHeader"] *, [class*="postHeader"] *, time, span, div');
                    for (var hi = 0; hi < headerEls.length; hi++) {
                        var t = (headerEls[hi].textContent || "").trim();
                        if (t.length > 12) continue; // age strings are short
                        var m = t.match(/^(?:just\s*now|now|\d+\s*[smhdw])$/i);
                        if (m) { ageText = m[0]; break; }
                    }
                }

                posts.push({
                    author:       rawAuthor,
                    title:        titleLink.textContent.trim(),
                    category:     categoryEl ? categoryEl.textContent.trim() : "General",
                    body:         contentEl  ? contentEl.textContent.trim()  : "",
                    href:         titleLink.href,
                    commentCount: commentCount,
                    ageText:      ageText,
                });
            }
        }
        return posts;
    });
}

// ── Post body extractor ───────────────────────────────────────────────────────
// Opens the post page and fills post.body / post.title / post.author.
// Comments pipeline is dropped in v1 — only the clean post body is needed.

async function openPostAndGetBody(page, post) {
    console.log("📖 Opening post: " + post.title);
    await page.goto(post.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3000);

    // Skool collapses long post bodies behind a "See more" toggle — the rest
    // of the text IS in the DOM but the visible-text extractor below stops at
    // the truncation point. Click any "See more" button(s) inside the post
    // body container BEFORE extracting so .textContent / .innerText return
    // the full thing. Comments-section "See more" toggles are skipped.
    try {
        var clicked = await expandPostBodySeeMore(page);
        if (clicked > 0) {
            await sleep(700);
        }
    } catch (expandErr) {
        // Non-fatal — extraction still happens, body may be truncated.
        console.log("  [warn] See-more expansion failed: " + expandErr.message);
    }

    var scraped = await page.evaluate(function() {
        var result = { body: "", title: "", author: "" };

        // Title
        var titleEl = document.querySelector('h1, [class*="PostTitle"], [class*="postTitle"]');
        if (titleEl) result.title = titleEl.textContent.trim();

        // Author — first /@-link before the comments section
        var postAuthorEl = document.querySelector('[class*="PostAuthor"] a[href*="/@"], [class*="postHeader"] a[href*="/@"]');
        if (postAuthorEl) {
            result.author = postAuthorEl.textContent.trim().replace(/^\d+/, "").trim();
        }
        if (!result.author) {
            var allAuthorLinks = document.querySelectorAll('a[href*="/@"]');
            for (var a = 0; a < allAuthorLinks.length; a++) {
                var aText = allAuthorLinks[a].textContent.trim().replace(/^\d+/, "").trim();
                if (aText && aText.length > 1) { result.author = aText; break; }
            }
        }

        // Clean post body
        var bodyEl = null;
        var bodySelectors = [
            ".ql-editor",
            '[class*="RichText"]',
            '[class*="PostBody"]',
            '[class*="PostContent"]',
            '[class*="post-body"]',
            "article",
        ];
        for (var i = 0; i < bodySelectors.length; i++) {
            var els = document.querySelectorAll(bodySelectors[i]);
            for (var j = 0; j < els.length; j++) {
                var el = els[j];
                if (el.closest('[class*="CommentsSection"], [class*="CommentsList"], [class*="CommentsListWrapper"], [class*="CommentInput"], [class*="CommentItemContainer"]')) continue;
                if (el.getAttribute("contenteditable") === "true" && el.textContent.trim().length < 20) continue;
                if (el.textContent.trim().length > 20) { bodyEl = el; break; }
            }
            if (bodyEl) break;
        }

        if (bodyEl) {
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
                } catch (_) {}
            });
            var rawText = (clone.innerText || clone.textContent || "").trim();
            rawText = rawText.split("\n").filter(function(line) {
                var l = line.trim();
                if (!l) return true;
                if (/^(See more|Like|Reply|Comment|Jump to latest|Drop files|Recently Used|Smileys|Animals|Food|Travel|Activities|Objects|Symbols|Flags)$/i.test(l)) return false;
                if (/^(To pick up a draggable|While dragging|Press space)/i.test(l)) return false;
                if (/^\d+\s*(comments?|likes?|replies?)$/i.test(l)) return false;
                if (l.length > 20 && /^[\p{Emoji}\p{Emoji_Presentation}\p{Emoji_Component}‍️\s]+$/u.test(l)) return false;
                return true;
            }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
            result.body = rawText;
        }

        return result;
    });

    if (scraped.body)                        post.body   = scraped.body;
    if (scraped.title)                       post.title  = scraped.title;
    if (scraped.author && scraped.author !== "Unknown") post.author = normalizeName(scraped.author);

    console.log("  Author: " + post.author);
    console.log("  Body:   " + post.body.substring(0, 200) + (post.body.length > 200 ? "..." : ""));
    console.log("");
    return post;
}

// ── Reply typing ──────────────────────────────────────────────────────────────
// Top-level comment box only (no inline thread targeting in v1).

async function findInlineReplyBox(page, target) {
    target = target || {};
    var modes = ["strict", "author-only"];
    for (var m = 0; m < modes.length; m++) {
        var matchMode = modes[m];
        var match = await page.evaluate(function(args) {
        function normalizeText(value) {
            return (value || "")
                .replace(/\u00c2/g, "")
                .replace(/[\u00a0\u2007\u202f]/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
        }

        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function firstVisibleInput(root) {
            if (!root) return null;
            var selectors = [
                'input[placeholder="Your comment"]',
                'textarea[placeholder*="comment" i]',
                '[placeholder*="comment" i]',
                '[class*="CommentInput"] input',
                '[class*="CommentInput"] textarea',
                '[class*="CommentInput"] [contenteditable="true"]',
                '[contenteditable="true"]',
                'input',
                'textarea',
            ];
            for (var s = 0; s < selectors.length; s++) {
                var nodes = root.querySelectorAll(selectors[s]);
                for (var n = 0; n < nodes.length; n++) {
                    if (isVisible(nodes[n])) return nodes[n];
                }
            }
            return null;
        }

        var targetAuthor = normalizeText(args.author);
        var targetTextStart = normalizeText(args.textStart);
        var strict = args.mode === "strict";
        var comments = document.querySelectorAll('[class*="CommentItemContainer"], [class*="CommentOrReply"]');
        for (var i = 0; i < comments.length; i++) {
            var el = comments[i];
            var authorLinks = el.querySelectorAll('a[href*="/@"]');
            var author = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { author = t; break; }
            }
            if (targetAuthor && normalizeText(author) !== targetAuthor) continue;
            if (strict && targetTextStart && normalizeText(el.textContent).indexOf(targetTextStart) === -1) continue;

            var roots = [el];
            if (el.parentElement) roots.push(el.parentElement);
            if (el.parentElement && el.parentElement.parentElement) roots.push(el.parentElement.parentElement);

            for (var r = 0; r < roots.length; r++) {
                var input = firstVisibleInput(roots[r]);
                if (!input) continue;
                input.setAttribute("data-codex-inline-reply-target", "true");
                return true;
            }
        }
        return false;
        }, {
            author: target.author || "",
            textStart: target.textStart || target.text || "",
            mode: matchMode,
        });

        if (match) return await page.$('[data-codex-inline-reply-target="true"]');
    }
    return null;
}

async function pageInReplyMode(page) {
    return await page.evaluate(function() {
        function textOf(el) { return (el.textContent || "").trim().toUpperCase(); }
        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        var controls = Array.from(document.querySelectorAll('button, [role="button"], [class*="Button"]')).filter(isVisible);
        return controls.some(function(el) { return textOf(el) === "CANCEL"; }) &&
            controls.some(function(el) { return textOf(el) === "REPLY"; });
    });
}

// Click any "View N replies" / "Show replies" / "View more" toggles so the
// reply we're trying to answer is actually in the DOM before we search.
// Returns the number of toggles clicked.
// Click any "See more" toggle inside the post body so the full text renders
// before we extract it. Skool truncates long posts in the feed AND on the
// post detail page — without this expansion the bot's prompt ends in
// "... low engagement, no real marketing s... See more". Comments-section
// "See more" toggles are intentionally skipped (we don't need full comment
// bodies for the post-reply prompt and clicking them inflates token cost).
// Returns the number of toggles clicked.
async function expandPostBodySeeMore(page) {
    return await page.evaluate(function() {
        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        function isInsideComments(el) {
            return !!(el.closest &&
                el.closest('[class*="CommentsSection"], [class*="CommentsList"], [class*="CommentsListWrapper"], [class*="CommentItem"], [class*="CommentInput"]'));
        }
        var clicked = 0;
        var nodes = document.querySelectorAll('a, button, span, div[role="button"]');
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (!isVisible(node)) continue;
            if (isInsideComments(node)) continue;
            var t = (node.textContent || "").trim().toLowerCase();
            // Match the exact toggle text Skool ships. Be strict so we don't
            // click random links that happen to contain "more".
            if (t === "see more" || t === "...see more" || t === "show more") {
                var target = node.closest('button, [role="button"], a') || node;
                try { target.click(); clicked++; } catch (_) {}
            }
        }
        return clicked;
    });
}

async function expandCollapsedReplies(page) {
    return await page.evaluate(function() {
        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        var clicked = 0;
        var nodes = document.querySelectorAll('a, button, span, div[role="button"]');
        for (var i = 0; i < nodes.length; i++) {
            if (!isVisible(nodes[i])) continue;
            var t = (nodes[i].textContent || "").trim().toLowerCase();
            // Match "view 3 replies", "show replies", "view more replies", "view 1 more reply"
            if (/^(view|show)\s+(\d+\s+)?(more\s+)?repl(y|ies)$/.test(t) ||
                /^view\s+\d+\s+more\s+repl(y|ies)$/.test(t) ||
                /^show\s+more\s+repl(y|ies)$/.test(t)) {
                var target = nodes[i].closest('button, [role="button"], a') || nodes[i];
                try { target.click(); clicked++; } catch (_) {}
            }
        }
        return clicked;
    });
}

// Find a comment authored by `partnerName` on the currently-loaded post page
// and return its visible text. Used when notification previews are empty —
// we navigate to the post, find the partner's actual reply, and feed its real
// content to the pre-classifier instead of guessing from the notification snippet.
async function readCommentTextByAuthor(page, partnerName) {
    try {
        var expanded = await expandCollapsedReplies(page);
        if (expanded > 0) await sleep(700);
    } catch (_) { /* non-fatal */ }

    return await page.evaluate(function(args) {
        function normalizeText(value) {
            return (value || "")
                .replace(/Â/g, "")
                .replace(/[   ]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }
        var target = normalizeText(args.author).toLowerCase();
        if (!target) return "";

        var comments = document.querySelectorAll('[class*="CommentItemContainer"], [class*="CommentOrReply"]');
        // Walk newest-last; we want the partner's most recent comment, so iterate
        // backwards and return the first match.
        for (var i = comments.length - 1; i >= 0; i--) {
            var el = comments[i];
            var authorLinks = el.querySelectorAll('a[href*="/@"]');
            var author = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { author = t; break; }
            }
            if (normalizeText(author).toLowerCase() !== target) continue;

            // Pull the comment body but strip away the author name & action chrome
            // (Like, Reply, timestamps) so the classifier sees just the message.
            var raw = normalizeText(el.textContent);
            // Remove leading "<Author>" repetition.
            if (raw.toLowerCase().indexOf(author.toLowerCase()) === 0) {
                raw = raw.substring(author.length).trim();
            }
            // Strip trailing UI chrome like "Like Reply 3h" / "Reply 5m".
            raw = raw.replace(/\s+(?:like|reply)\s+(?:like\s+|reply\s+)*(?:\d+\s*[smhdw]|just now)\s*$/i, "").trim();
            return raw.substring(0, 600);
        }
        return "";
    }, { author: partnerName || "" });
}

async function clickCommentReplyButton(page, comment) {
    // Step 1: expand any collapsed reply chains so nested comments render.
    try {
        var expanded = await expandCollapsedReplies(page);
        if (expanded > 0) await sleep(800);
    } catch (_) { /* non-fatal */ }

    // Step 2: try strict match (author + textStart), then loosen.
    // "author-prefix" handles notification-preview truncation
    // (e.g. preview says "Michelle De", DOM says "Michelle Deaver").
    //
    // Returns null OR an object: { mode: "<label>", mention: "@<Author> " | null }.
    // `mention` is non-null when the ancestor-fallback path was taken \u2014 Skool's
    // deeply-nested replies sometimes don't render their own Reply button, so
    // we click the parent top-level comment's Reply button and then prepend
    // "@<Author> " so the nested commenter still gets tagged.
    var modes = ["strict", "author-only", "author-prefix"];
    for (var m = 0; m < modes.length; m++) {
        var matchMode = modes[m];
        var result = await page.evaluate(function(args) {
            function normalizeText(value) {
                return (value || "")
                    .replace(/\u00c2/g, "")
                    .replace(/[\u00a0\u2007\u202f]/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .toLowerCase();
            }

            function isVisible(el) {
                if (!el) return false;
                var style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden") return false;
                var rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }

            function fakeHover(el) {
                if (!el) return;
                ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"].forEach(function(type) {
                    try {
                        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                    } catch (_) {}
                });
            }

            function clickLikeHuman(el) {
                var target = el.closest('button, [role="button"], a') || el;
                target.scrollIntoView({ block: "center", inline: "nearest" });
                fakeHover(target);
                ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function(type) {
                    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });
                return true;
            }

            function getAuthor(el) {
                var authorLinks = el.querySelectorAll('a[href*="/@"]');
                for (var j = 0; j < authorLinks.length; j++) {
                    var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                    if (t && t.length > 1) return t;
                }
                return "";
            }

            function findReplyBtnIn(el) {
                var classBtn = el.querySelector('[class*="CommentItemReplyButton"]');
                if (classBtn && isVisible(classBtn)) return classBtn;
                var links = el.querySelectorAll('a, button, span, div[role="button"]');
                for (var k = 0; k < links.length; k++) {
                    if (!isVisible(links[k])) continue;
                    if ((links[k].textContent || "").trim().toLowerCase() === "reply") return links[k];
                }
                return null;
            }

            var targetAuthor = normalizeText(args.author);
            var targetTextStart = normalizeText(args.textStart);
            var strict = args.mode === "strict";
            var prefixMode = args.mode === "author-prefix";
            // Guard against false positives in prefix mode: don't match
            // very short queries ("Sue" would also match "Susan").
            if (prefixMode && targetAuthor.length < 4) return null;

            var comments = document.querySelectorAll('[class*="CommentItemContainer"], [class*="CommentOrReply"]');
            for (var i = 0; i < comments.length; i++) {
                var el = comments[i];
                var rawAuthor = getAuthor(el);
                if (targetAuthor) {
                    var domAuthor = normalizeText(rawAuthor);
                    if (prefixMode) {
                        if (!domAuthor || domAuthor.indexOf(targetAuthor) !== 0) continue;
                    } else {
                        if (domAuthor !== targetAuthor) continue;
                    }
                }
                if (strict && targetTextStart && normalizeText(el.textContent).indexOf(targetTextStart) === -1) continue;

                // Hover the matched comment first \u2014 Skool sometimes only
                // mounts the Reply button on hover (especially for nested
                // replies). scrollIntoView + a synthetic mouseover gives
                // the UI a chance to render the action row before we look.
                el.scrollIntoView({ block: "center", inline: "nearest" });
                fakeHover(el);

                var modeLbl = strict ? "strict" : (prefixMode ? "prefix" : "loose");

                var directBtn = findReplyBtnIn(el);
                if (directBtn) {
                    clickLikeHuman(directBtn);
                    return { mode: "direct-" + modeLbl, mention: null };
                }

                // Ancestor fallback: walk up to the nearest top-level
                // CommentItemContainer and click ITS Reply button. Used when
                // Skool refuses to expose a Reply button on a deeply-nested
                // reply. Caller will prepend "@<Author> " so the recipient
                // still gets tagged.
                var ancestor = el.parentElement;
                while (ancestor && ancestor !== document.body) {
                    if (ancestor.matches && ancestor.matches('[class*="CommentItemContainer"]') && ancestor !== el) {
                        ancestor.scrollIntoView({ block: "center", inline: "nearest" });
                        fakeHover(ancestor);
                        var ancBtn = findReplyBtnIn(ancestor);
                        if (ancBtn) {
                            clickLikeHuman(ancBtn);
                            var mention = rawAuthor ? ("@" + rawAuthor + " ") : null;
                            return { mode: "ancestor-" + modeLbl, mention: mention };
                        }
                        break;
                    }
                    ancestor = ancestor.parentElement;
                }
            }
            return null;
        }, {
            author: comment.author || "",
            textStart: (comment.text || "").substring(0, 30),
            mode: matchMode,
        });
        if (result) {
            // Tolerate any legacy string returns just in case.
            if (typeof result === "string") return { mode: result, mention: null };
            return result;
        }
    }

    // Step 3: total failure \u2192 emit a diagnostic dump so we can see WHY.
    // Logs every comment that matched the author (depth, whether a Reply
    // button was visible, text preview), then saves a full-page screenshot.
    try {
        var diag = await page.evaluate(function(targetAuthor) {
            function lc(s) {
                return (s || "")
                    .replace(/\u00c2/g, "")
                    .replace(/[\u00a0\u2007\u202f]/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .toLowerCase();
            }
            var lcTarget = lc(targetAuthor);
            var comments = document.querySelectorAll('[class*="CommentItemContainer"], [class*="CommentOrReply"]');
            var found = [];
            for (var i = 0; i < comments.length; i++) {
                var el = comments[i];
                var authorLinks = el.querySelectorAll('a[href*="/@"]');
                var author = "";
                for (var j = 0; j < authorLinks.length; j++) {
                    var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                    if (t && t.length > 1) { author = t; break; }
                }
                var lcAuthor = lc(author);
                if (lcAuthor !== lcTarget && (!lcTarget || lcAuthor.indexOf(lcTarget) !== 0)) continue;

                var hasReplyClass = !!el.querySelector('[class*="CommentItemReplyButton"]');
                var nodes = Array.from(el.querySelectorAll('a, button, span, div[role="button"]'));
                var replyTextNodes = nodes.filter(function(n) {
                    return (n.textContent || "").trim().toLowerCase() === "reply";
                }).length;
                var depth = 0;
                var node = el.parentElement;
                while (node && node !== document.body) {
                    if (node.matches && node.matches('[class*="CommentOrReply"], [class*="CommentItemContainer"]')) depth++;
                    node = node.parentElement;
                }
                found.push({
                    idx: i,
                    depth: depth,
                    cls: (el.className || "").toString().substring(0, 160),
                    hasReplyClass: hasReplyClass,
                    replyTextNodes: replyTextNodes,
                    textPreview: (el.textContent || "").replace(/\s+/g, " ").substring(0, 140),
                    domAuthor: author,
                });
            }
            return { totalComments: comments.length, matchedByAuthor: found };
        }, comment.author || "");

        console.warn("    [diag] Reply-button hunt failed for \"" + (comment.author || "") + "\"" +
            " \u2014 " + diag.totalComments + " comments on page, " +
            diag.matchedByAuthor.length + " matched-by-author");
        diag.matchedByAuthor.forEach(function(d) {
            console.warn("      [match idx=" + d.idx + " depth=" + d.depth +
                " replyClass=" + d.hasReplyClass +
                " replyTextNodes=" + d.replyTextNodes +
                " author=\"" + d.domAuthor + "\"" +
                "]: " + (d.textPreview || "").substring(0, 90));
        });

        var stamp = new Date().toISOString().replace(/[:.]/g, "-");
        var safeName = (comment.author || "unknown").replace(/[^A-Za-z0-9]/g, "_");
        var screenshotPath = "reply_btn_missing_" + safeName + "_" + stamp + ".png";
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.warn("    [diag] screenshot saved: " + screenshotPath);
    } catch (diagErr) {
        console.warn("    [diag] dump failed: " + diagErr.message);
    }

    return null;
}

async function typeReply(page, replyText, options) {
    options = options || {};
    var replyBox = null;

    if (options.inlineTarget) {
        replyBox = await findInlineReplyBox(page, options.inlineTarget);
    }

    if (!replyBox && options.inlineTarget && await pageInReplyMode(page)) {
        replyBox = await page.$(":focus");
        if (!replyBox) {
            replyBox = await page.$('input[placeholder="Your comment"], textarea[placeholder*="comment" i], [class*="CommentInput"] input, [class*="CommentInput"] textarea, [class*="CommentInput"] [contenteditable="true"]');
        }
    }

    if (!replyBox && !options.inlineTarget) {
        var selectors = [
        'input[placeholder="Your comment"]',
        'textarea[placeholder*="comment" i]',
        '[placeholder*="comment" i]',
        '[class*="CommentInput"] input',
        '[class*="CommentInput"] textarea',
        '[class*="CommentInput"] [contenteditable="true"]',
        '[class*="comment"] input',
        '[class*="comment"] textarea',
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
            throw new Error("Could not find inline reply input box - saved debug_screenshot.png");
        }
        throw new Error("Could not find reply input box — saved debug_screenshot.png");
    }

    // Dismiss any stale overlay
    var staleOverlay = await page.$('[class*="DropdownBackground"]');
    if (staleOverlay) { try { await page.keyboard.press("Escape"); await sleep(300); } catch (_) {} }

    // Hoist the reply box into the upper-third of the viewport so the human
    // watching a non-headless run can see what gets typed. Skool's reply
    // inputs default to the bottom of the screen and live inside an internal
    // scrollable container; scrollElementToViewportCenter walks the ancestors
    // and scrolls each one until the box's top sits at ~vh/3, leaving room
    // for the textarea to grow downward as text is typed.
    var rectInfo = await scrollElementToViewportCenter(page, replyBox);
    if (rectInfo) {
        console.log("    [scroll] reply box at top=" + rectInfo.top + " bottom=" + rectInfo.bottom +
            " vh=" + rectInfo.vh + (rectInfo.onscreen ? " (onscreen)" : " (STILL OFFSCREEN)"));
    }
    try {
        await replyBox.click();
    } catch (_) {
        await replyBox.focus();
    }
    await sleep(500);
    // After click() Skool injects a sticky submit row that can shove the box
    // back down. Re-center, then keep re-centering throughout typing — Skool
    // also auto-grows the textarea, which can drift the cursor off-screen.
    await scrollElementToViewportCenter(page, replyBox);
    var stopRecenter = startScrollRecenterLoop(page, replyBox, 600);

    var isTextField = await replyBox.evaluate(function(el) {
        var tag = (el.tagName || "").toUpperCase();
        return tag === "INPUT" || tag === "TEXTAREA";
    });

    var existingText = "";
    if (options.inlineTarget) {
        existingText = await replyBox.evaluate(function(el) {
            if (typeof el.value === "string") return el.value;
            return el.innerText || el.textContent || "";
        });
    }

    if (options.inlineTarget) {
        await replyBox.evaluate(function(el) {
            if (typeof el.focus === "function") el.focus();
            if (typeof el.value === "string" && typeof el.setSelectionRange === "function") {
                var end = el.value.length;
                el.setSelectionRange(end, end);
                return;
            }
            if (el.getAttribute && el.getAttribute("contenteditable") === "true") {
                var selection = window.getSelection();
                var range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        });
        await sleep(100);
    }

    if (isTextField && !options.inlineTarget) {
        await replyBox.fill("");
    } else if (!options.inlineTarget) {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
    }

    var textToType = replyText;
    if (options.inlineTarget && existingText && !/\s$/.test(existingText)) {
        textToType = " " + textToType;
    }

    try {
        await replyBox.type(textToType, { delay: 20 });
        await sleep(300);

        var sample = replyText.substring(0, Math.min(24, replyText.length));
        var typedOk = await replyBox.evaluate(function(el, snippet) {
            var current = typeof el.value === "string"
                ? el.value
                : ((el.innerText || el.textContent || "").trim());
            return !snippet || current.indexOf(snippet) !== -1;
        }, sample);

        if (!typedOk) {
            try {
                await replyBox.click();
            } catch (_) {
                await replyBox.focus();
            }
            await sleep(200);
            await page.keyboard.type(textToType, { delay: 20 });
            await sleep(300);
        }

        typedOk = await replyBox.evaluate(function(el, snippet) {
            var current = typeof el.value === "string"
                ? el.value
                : ((el.innerText || el.textContent || "").trim());
            return !snippet || current.indexOf(snippet) !== -1;
        }, sample);

        if (!typedOk) {
            throw new Error("Reply text did not appear in the reply box after typing");
        }
    } finally {
        // Always shut down the recenter loop, even on error, so it doesn't
        // keep firing scroll commands against a dead page handle.
        try { stopRecenter(); } catch (_) {}
    }

    // One last centering after typing completes — gives the human a clear
    // view of the finished draft before submitReply clicks COMMENT.
    await scrollElementToViewportCenter(page, replyBox);

    console.log("Reply typed into box\n");
    if (options.inlineTarget) {
        await page.evaluate(function() {
            var tagged = document.querySelector('[data-codex-inline-reply-target="true"]');
            if (tagged) tagged.removeAttribute("data-codex-inline-reply-target");
        });
    }
}

async function typeCommentReply(page, comment, replyText) {
    var clickResult = await clickCommentReplyButton(page, comment);
    if (clickResult) {
        console.log("  Clicked Reply on " + comment.author + "'s comment (" + (clickResult.mode || "unknown") + ")");
        await sleep(500);
        if (!await pageInReplyMode(page)) {
            var retry = await clickCommentReplyButton(page, comment);
            if (retry) {
                clickResult = retry;
                console.log("  Retried Reply click for " + comment.author + " (" + (retry.mode || "unknown") + ")");
                await sleep(900);
            }
        }
    } else {
        throw new Error("Could not find Reply button for " + comment.author + "'s comment");
    }

    // Ancestor-fallback path: clickCommentReplyButton clicked a top-level
    // Reply button instead of one inside the nested reply, so the recipient
    // won't auto-tag. Prepend "@<Author> " ourselves, but only if the model
    // didn't already start the reply with that mention.
    var finalText = replyText;
    if (clickResult.mention) {
        var trimmedMention = clickResult.mention.trim();
        var alreadyMentions = (replyText || "").trim().toLowerCase().indexOf(trimmedMention.toLowerCase()) === 0;
        if (!alreadyMentions) {
            finalText = clickResult.mention + replyText;
            console.log("  [ancestor-fallback] prepended mention → " + trimmedMention);
        }
    }

    await typeReply(page, finalText, {
        inlineTarget: {
            author: comment.author,
            textStart: (comment.text || "").substring(0, 30),
        }
    });
}

// ── Reply submission ──────────────────────────────────────────────────────────
// Path B only: finds the COMMENT button and clicks it.

async function submitReply(page, options) {
    options = options || {};
    await sleep(600);

    var clickResult = await page.evaluate(function(args) {
        function textOf(el) {
            return (el.textContent || "").trim();
        }

        function upperText(el) {
            return textOf(el).toUpperCase();
        }

        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function clickIt(el) {
            if (!el) return false;
            var target = el.closest('button, [role="button"], a') || el;
            target.click();
            return true;
        }

        var candidates = Array.from(document.querySelectorAll(
            'button, [role="button"], [class*="Button"]'
        )).filter(isVisible);
        if (args.inlineTarget) {
            var active = document.activeElement;
            var startNode = active && active !== document.body ? active : document.querySelector('[data-codex-inline-reply-target="true"]');
            var node = startNode;
            for (var depth = 0; depth < 8 && node && node !== document.body; depth++) {
                var localCandidates = Array.from(node.querySelectorAll(
                    'button, [role="button"], [class*="Button"], a'
                )).filter(isVisible);
                var localReplyBtn = localCandidates.find(function(el) {
                    return upperText(el) === "REPLY";
                });
                if (localReplyBtn && clickIt(localReplyBtn)) return "inline-reply-local";
                var localCommentBtn = localCandidates.find(function(el) {
                    return upperText(el) === "COMMENT";
                });
                if (localCommentBtn && clickIt(localCommentBtn)) return "comment-btn-local";
                node = node.parentElement;
            }
        }

        // Path A: CANCEL landmark → sibling REPLY button (inline thread)
        var cancelEl = candidates.find(function(el) {
            return upperText(el) === "CANCEL";
        });
        if (cancelEl) {
            var node = cancelEl.parentElement;
            for (var d = 0; d < 8 && node && node !== document.body; d++) {
                var all = Array.from(node.querySelectorAll('button, [role="button"], [class*="Button"]'));
                var replyBtn = all.find(function(el) { return upperText(el) === "REPLY"; });
                if (replyBtn && clickIt(replyBtn)) return "inline-reply";
                var commentBtnInForm = all.find(function(el) {
                    return upperText(el) === "COMMENT";
                });
                if (commentBtnInForm && clickIt(commentBtnInForm)) return "comment-btn-form";
                node = node.parentElement;
            }
        }

        // Path B: top-level COMMENT button
        var commentBtn = candidates.find(function(el) {
            return upperText(el) === "COMMENT";
        });
        if (commentBtn && clickIt(commentBtn)) return "comment-btn";

        return null;
    }, options);

    if (clickResult) {
        console.log("✅ Reply submitted (" + clickResult + ") — waiting 10s\n");
        await sleep(1500);
        return;
    }

    // Last resort: Enter key
    console.log("  ⚠️  Submit button not found — pressing Enter");
    await page.keyboard.press("Enter");
    console.log("✅ Reply submitted (Enter) — waiting 10s\n");
    await sleep(1500);
}

// ── Duplicate-comment guard ───────────────────────────────────────────────────

async function alreadyCommented(page, botName) {
    var botNames = getBotIdentityNames(botName);
    if (botNames.length === 0) return false;
    return await page.evaluate(function(names) {
        var authors = document.querySelectorAll('[class*="CommentItemContainer"] a[href*="/@"]');
        for (var i = 0; i < authors.length; i++) {
            var t = authors[i].textContent
                .trim()
                .replace(/^\d+/, "")
                .replace(/\u00c2/g, "")
                .replace(/[\u00a0\u2007\u202f]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
            if (names.indexOf(t) !== -1) return true;
        }
        return false;
    }, botNames);
}

// ── Notification helpers ──────────────────────────────────────────────────────

async function hasUnreadNotifications(page) {
    return await page.evaluate(function() {
        var bellWrappers = document.querySelectorAll(
            '[class*="Notification"], [class*="notification"], [class*="Bell"], [class*="bell"]'
        );
        for (var i = 0; i < bellWrappers.length; i++) {
            var w = bellWrappers[i];
            if (/Chat/i.test((w.className || "").toString())) continue;
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
    // First: dismiss any leftover overlay from a previous open. Skool's
    // dropdown leaves a `DropdownBackground` overlay that can intercept
    // pointer events on the next bell click, making elementHandle.click()
    // hang for the 30s default timeout. Press Escape twice (once to clear
    // any open menu, once to clear the overlay) before trying again.
    try { await page.keyboard.press("Escape"); } catch (_) {}
    await sleep(150);
    try { await page.keyboard.press("Escape"); } catch (_) {}
    await sleep(150);
    try {
        // ONLY click DropdownBackground — broader selectors like "Overlay"
        // or "Backdrop" match images, modals, and lightboxes, which can
        // navigate the page away from the community feed when clicked.
        await page.evaluate(function() {
            var overlays = document.querySelectorAll('[class*="DropdownBackground"]');
            for (var i = 0; i < overlays.length; i++) {
                try { overlays[i].click(); } catch (_) {}
            }
        });
    } catch (_) {}
    await sleep(200);

    var bellEl = await page.$('[class*="NotificationsIconButton"]:not([class*="Chat"])');
    if (!bellEl) {
        var candidates = await page.$$('button[class*="Notification"], [class*="NotificationButtonWrapper"]');
        for (var nb = 0; nb < candidates.length; nb++) {
            var cls = await candidates[nb].getAttribute("class") || "";
            if (/Chat/i.test(cls)) continue;
            var btn = await candidates[nb].$("button");
            bellEl = btn || candidates[nb];
            break;
        }
    }
    if (!bellEl) bellEl = await page.$('[aria-label*="notification" i]:not([class*="Chat"])');
    if (!bellEl) return false;

    // Try Playwright click with a SHORT timeout. If the overlay still blocks,
    // fall back to a DOM-level dispatch via page.evaluate which bypasses
    // Playwright's pointer-event interception check entirely.
    try {
        await bellEl.click({ timeout: 4000 });
    } catch (clickErr) {
        console.log("    [bell] Playwright click intercepted — trying DOM dispatch");
        var domClicked = false;
        try {
            domClicked = await bellEl.evaluate(function(el) {
                var target = el.closest('button, [role="button"]') || el;
                ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function(type) {
                    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                });
                return true;
            });
        } catch (_) {}
        if (!domClicked) return false;
    }
    await sleep(1500);
    return true;
}

// Returns an array of notification items currently visible in the dropdown.
// Each item: { text, href, isUnread }


// Returns an array of notification items currently visible in the dropdown.
// Each item: { text, href, isUnread }
async function getNotificationItems(page) {
    // Skool's notifications dropdown is virtualized — items that scroll out
    // of the rendered window get unmounted from the DOM. Reading the DOM
    // once at the bottom only returns the last few items.
    //
    // Strategy: scroll the dropdown incrementally (one viewport-height at a
    // time), reading whatever items are currently rendered after each step
    // and merging them into a deduped list (keyed by href + first 80 chars
    // of text — same shape an item would have on disk). Stop when the
    // scrollTop stops advancing for several passes in a row AND the scroll
    // height has stopped growing (server has no more items to deliver), or
    // after a hard safety cap on iterations.
    //
    // If a "LOAD MORE" button shows up at the very bottom we click it once
    // and keep going. The user reports the dropdown is mostly long-scroll,
    // so the click path is a fallback, not the main mechanism.
    //
    // Tuning history: the original 60-pass / 180ms / 2-stable defaults were
    // bailing early on long lists (30+ items spanning 15h+ of history)
    // because Skool's virtualized scroller takes >300ms to stream new chunks
    // in. Bumped the safety cap, the per-step wait, and require more stable
    // passes before declaring done.
    var MAX_PASSES = parseInt(process.env.MAX_NOTIF_SCROLL_PASSES || "200", 10);
    var STEP_DELAY_MS = parseInt(process.env.NOTIF_SCROLL_STEP_DELAY || "350", 10);
    var STABLE_PASSES_REQUIRED = parseInt(process.env.NOTIF_STABLE_PASSES || "4", 10);
    var BOTTOM_WAIT_MS = parseInt(process.env.NOTIF_BOTTOM_WAIT_MS || "1500", 10);

    // Pin down the dropdown scroll container ONCE; it's stable across the
    // life of the dropdown. Re-scoring it on every pass risks switching to a
    // different scrollable element after the first scroll changes the layout.
    var containerHandle = await page.evaluateHandle(function() {
        function isVisible(el) {
            if (!el) return null;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return null;
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return null;
            return el;
        }
        var candidates = Array.from(document.querySelectorAll("div, section, aside, ul")).filter(isVisible);
        var best = null, bestScore = -1;
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            // STRICT: require at least one notification-specific item.
            // The previous version counted any a[href] which let the page's
            // main feed (or a post's comments section) win the score when the
            // dropdown failed to open — leading the bot to "scroll through
            // notifications" inside whatever happened to be on screen.
            var notifItems = el.querySelectorAll(
                '[class*="NotificationItem"], [class*="notificationItem"], ' +
                '[class*="NotificationRow"], [class*="notificationRow"]'
            ).length;
            if (notifItems === 0) continue;
            var scrollable = el.scrollHeight > el.clientHeight + 20;
            var classBonus = /Notification|Dropdown|Popover/i.test((el.className || "").toString()) ? 5000 : 0;
            // notifItems weighted heavily; scrollable is a tiebreaker;
            // class-name match is a strong reinforcement.
            var s = (notifItems * 100) + (scrollable ? 500 : 0) + classBonus;
            if (s > bestScore) { bestScore = s; best = el; }
        }
        return best || null;
    });

    var collected = {};   // href||text-prefix → item
    var pickedAny = false;

    function readVisibleBatch(handle) {
        return page.evaluate(function(scope) {
            var root = scope || document;
            var listItems = root.querySelectorAll(
                '[class*="NotificationItem"], [class*="notificationItem"], ' +
                '[class*="NotificationRow"], [class*="notificationRow"]'
            );
            // No anchor-tag fallback. If the container doesn't have
            // notification-class items, we DON'T want to mistake whatever
            // links are nearby (post links, profile links, comment threads)
            // for notifications. Return empty so the caller bails cleanly.
            var batch = [];
            for (var i = 0; i < listItems.length; i++) {
                var el = listItems[i];
                var elClass = (el.className || "").toString();
                if (/NotificationItemLink/.test(elClass)) continue;
                var href = "";
                if (el.href) href = el.href;
                if (!href) { var a = el.querySelector("a[href]"); if (a) href = a.href; }
                if (!href && typeof el.closest === "function" && el.closest("a[href]")) {
                    href = el.closest("a[href]").href;
                }
                var text = (el.textContent || "").trim().replace(/\s+/g, " ").substring(0, 240);
                var isUnread = !!(
                    (el.querySelector && el.querySelector('[class*="Unread"], [class*="unread"], [class*="New"], [class*="new"], [class*="NotificationBubble"], [class*="notificationBubble"], [class*="Dot"], [class*="dot"]')) ||
                    /unread|new/i.test(elClass)
                );
                if (!href || !text) continue;
                batch.push({ href: href, text: text, isUnread: isUnread });
            }
            return batch;
        }, handle);
    }

    function mergeBatch(batch) {
        var added = 0;
        for (var i = 0; i < batch.length; i++) {
            var b = batch[i];
            var key = b.href + "||" + b.text.substring(0, 80);
            if (!collected[key]) {
                collected[key] = b;
                added++;
            }
        }
        return added;
    }

    // Sanity: did we actually find a notifications dropdown? If
    // containerHandle resolved to nothing OR to a container with zero
    // notification-class items, bail immediately. The previous loose scoring
    // would happily scroll the page's main feed (or a post's comments
    // section) when the dropdown failed to open and treat all the
    // miscellaneous a[href] elements as notifications.
    var hasContainer = false;
    if (containerHandle) {
        try {
            hasContainer = await containerHandle.evaluate(function(el) {
                if (!el) return false;
                return el.querySelectorAll(
                    '[class*="NotificationItem"], [class*="notificationItem"], ' +
                    '[class*="NotificationRow"], [class*="notificationRow"]'
                ).length > 0;
            });
        } catch (_) { hasContainer = false; }
    }
    if (!hasContainer) {
        console.log("    [notif] no notification dropdown detected — bailing (bell may not have opened, or page isn't on the community feed)");
        if (containerHandle) { try { await containerHandle.dispose(); } catch (_) {} }
        return [];
    }

    // First read at the very top.
    if (containerHandle) {
        try {
            await containerHandle.evaluate(function(el) { el.scrollTop = 0; });
        } catch (_) {}
        await sleep(STEP_DELAY_MS);
        var firstBatch = await readVisibleBatch(containerHandle);
        var addedFirst = mergeBatch(firstBatch);
        if (addedFirst > 0) pickedAny = true;
    }

    var lastScrollTop = -1;
    var lastScrollHeight = -1;
    var stableCount = 0;
    var totalPasses = 0;
    for (var pass = 0; pass < MAX_PASSES; pass++) {
        if (!containerHandle) break;
        totalPasses = pass + 1;
        // Step the scroll forward by ~80% of the visible height — overlap
        // ensures items straddling the edge get rendered into both windows.
        // We also try scrollIntoView on the last anchor child as a fallback,
        // which works even when scrollTop manipulation is intercepted by a
        // virtualized list controller.
        var info;
        try {
            info = await containerHandle.evaluate(function(el) {
                var step = Math.max(80, Math.floor(el.clientHeight * 0.8));
                var prevTop = el.scrollTop;
                el.scrollTop = el.scrollTop + step;
                // Fallback: if scrollTop didn't actually change (some
                // virtualized lists ignore direct scrollTop writes), try
                // scrolling the last visible anchor into view.
                if (el.scrollTop === prevTop) {
                    var anchors = el.querySelectorAll('a[href]');
                    if (anchors.length > 0) {
                        var last = anchors[anchors.length - 1];
                        if (last && typeof last.scrollIntoView === "function") {
                            last.scrollIntoView({ block: "end", behavior: "auto" });
                        }
                    }
                }
                return {
                    scrollTop: el.scrollTop,
                    scrollHeight: el.scrollHeight,
                    clientHeight: el.clientHeight,
                };
            });
        } catch (_) { break; }
        await sleep(STEP_DELAY_MS);

        // Read whatever's now mounted.
        var batch = await readVisibleBatch(containerHandle);
        var added = mergeBatch(batch);
        if (added > 0) pickedAny = true;

        // If we appear to be at the very bottom, look for a LOAD MORE button
        // — Skool sometimes parks one there. Click ONCE and continue scrolling.
        // We also wait LONGER here than mid-list because the server fetch for
        // older notifications can take noticeably longer than rendering items
        // already in the cache.
        var atBottom = info.scrollTop + info.clientHeight >= info.scrollHeight - 4;
        var heightGrew = info.scrollHeight > lastScrollHeight;
        if (atBottom) {
            // STOP at the first LOAD MORE button.
            //
            // Per user 2026-04-30: notifications past the LOAD MORE divider
            // are older history that has already been processed in prior
            // cycles. Clicking through and scrolling past wastes time on
            // already-handled items. If the button is here, treat it as the
            // logical end of the unread list and break out.
            var hasLoadMoreBtn = false;
            try {
                hasLoadMoreBtn = await containerHandle.evaluate(function(el) {
                    function isVis(n) {
                        if (!n) return false;
                        var s = window.getComputedStyle(n);
                        if (s.display === "none" || s.visibility === "hidden") return false;
                        var r = n.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    }
                    var btns = Array.from((el || document).querySelectorAll(
                        'button, [role="button"], a, [class*="LoadMore"], [class*="loadMore"], [class*="ShowMore"], [class*="showMore"]'
                    )).filter(isVis);
                    return btns.some(function(b) {
                        var t = (b.textContent || "").trim().toUpperCase();
                        return t === "LOAD MORE" || t === "SHOW MORE" || t === "VIEW MORE" ||
                               t === "VIEW OLDER" || t === "LOAD OLDER" || t === "MORE" ||
                               t === "OLDER" || t === "NEXT";
                    });
                });
            } catch (_) {}
            if (hasLoadMoreBtn) {
                console.log("    [notif] LOAD MORE divider detected — stopping (older items already handled)");
                break;
            }

            // No button — but the server may still be streaming items in.
            // Wait the bottom-grace window; if scrollHeight grows we'll loop
            // again and pick up the new chunk.
            await sleep(BOTTOM_WAIT_MS);
            try {
                var post = await containerHandle.evaluate(function(el) { return { sh: el.scrollHeight, st: el.scrollTop, ch: el.clientHeight }; });
                if (post.sh > info.scrollHeight) {
                    info.scrollHeight = post.sh;
                    heightGrew = true;
                }
            } catch (_) {}
        }

        // Stability check: scrollTop hasn't advanced, no new items mounted,
        // AND scrollHeight didn't grow (server has nothing more to stream).
        // Require N consecutive stable passes before declaring done.
        var stalled = (info.scrollTop === lastScrollTop) && (added === 0) && !heightGrew;
        if (stalled) {
            stableCount++;
            if (stableCount >= STABLE_PASSES_REQUIRED) break;
        } else {
            stableCount = 0;
        }
        lastScrollTop = info.scrollTop;
        lastScrollHeight = info.scrollHeight;
    }

    // Reset the dropdown scroll position so subsequent operations (e.g.
    // closing via Escape) don't act on a half-scrolled list.
    if (containerHandle) {
        try { await containerHandle.evaluate(function(el) { el.scrollTop = 0; }); } catch (_) {}
        try { await containerHandle.dispose(); } catch (_) {}
    }

    var items = Object.keys(collected).map(function(k) { return collected[k]; });
    console.log("    [notif] collected " + items.length + " unique notification(s) across " +
        "incremental scroll" + (pickedAny ? "" : " (no items rendered — selectors may need tuning)"));
    return items;
}

// Dismisses the notification dropdown (press Escape)
async function markNotificationsRead(page) {
    await page.keyboard.press("Escape");
    await sleep(300);
}

// Open the notification bell and click the SPECIFIC notification card that
// matches the given href (and, if supplied, leading text prefix). Skool marks
// a notification as read on its server when the user clicks it — pressing
// Escape only dismisses the dropdown, it does NOT mark anything read. So when
// we want a notification flagged as handled (so the bell badge clears), we
// have to physically click the card.
//
// Returns true when a matching item was found AND clicked (page navigates).
// Returns false when nothing matched — caller should fall back to page.goto.
async function clickNotificationByMatch(page, href, textPrefix) {
    if (!href) return false;
    // Capture URL BEFORE the click. We compare against this after the click
    // to verify the SPA actually navigated. Skool's notification card sometimes
    // dismisses the dropdown without routing — previously we'd return true
    // anyway and then `clickCommentReplyButton` would scan an empty page.
    var urlBefore = "";
    try { urlBefore = page.url(); } catch (_) {}
    var hrefSegment = (href || "").split("?")[0].split("/").filter(Boolean).pop() || "";

    var opened = await clickNotificationBell(page);
    if (!opened) {
        console.log("    [notif-click] bell didn't open — caller should page.goto");
        return false;
    }
    await sleep(800);

    var containerHandle = await page.evaluateHandle(function() {
        function isVisible(el) {
            if (!el) return null;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return null;
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return null;
            return el;
        }
        var candidates = Array.from(document.querySelectorAll("div, section, aside, ul")).filter(isVisible);
        var best = null, bestScore = -1;
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var n = el.querySelectorAll('[class*="NotificationItem"], [class*="notificationItem"], [class*="NotificationRow"], a[href]').length;
            if (n === 0) continue;
            var scrollable = el.scrollHeight > el.clientHeight + 20;
            var s = n + (scrollable ? 1000 : 0);
            if (s > bestScore) { bestScore = s; best = el; }
        }
        return best || null;
    });

    var hrefMatch = (href || "").split("?")[0].toLowerCase();
    var textMatch = (textPrefix || "").substring(0, 60).toLowerCase().replace(/\s+/g, " ").trim();

    var MAX_FIND_PASSES = 40;
    var clicked = false;
    for (var pass = 0; pass < MAX_FIND_PASSES; pass++) {
        clicked = await page.evaluate(function(args) {
            function norm(s) { return (s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
            var rows = document.querySelectorAll(
                '[class*="NotificationItem"], [class*="notificationItem"], ' +
                '[class*="NotificationRow"], [class*="notificationRow"], a[href]'
            );
            for (var i = 0; i < rows.length; i++) {
                var el = rows[i];
                var elClass = (el.className || "").toString();
                if (/NotificationItemLink/.test(elClass)) continue;
                var rowHref = "";
                if (el.href) rowHref = el.href;
                if (!rowHref) { var a = el.querySelector("a[href]"); if (a) rowHref = a.href; }
                if (!rowHref && typeof el.closest === "function" && el.closest("a[href]")) {
                    rowHref = el.closest("a[href]").href;
                }
                if (!rowHref) continue;
                if (rowHref.split("?")[0].toLowerCase() !== args.hrefMatch) continue;
                if (args.textMatch && args.textMatch.length > 0) {
                    var rowText = norm(el.textContent || "").substring(0, 200);
                    if (rowText.indexOf(args.textMatch) === -1) continue;
                }
                var clickTarget = el.closest('a[href]') || el;
                clickTarget.scrollIntoView({ block: "center", inline: "nearest" });
                clickTarget.click();
                return true;
            }
            return false;
        }, { hrefMatch: hrefMatch, textMatch: textMatch });

        if (clicked) break;

        if (!containerHandle) break;
        var stopHere = false;
        try {
            stopHere = await containerHandle.evaluate(function(el) {
                var step = Math.max(80, Math.floor(el.clientHeight * 0.8));
                var prev = el.scrollTop;
                el.scrollTop = prev + step;
                if (el.scrollTop === prev) return true;
                return false;
            });
        } catch (_) { break; }
        if (stopHere) break;
        await sleep(250);
    }

    if (containerHandle) {
        try { await containerHandle.dispose(); } catch (_) {}
    }

    if (clicked) {
        try { await page.waitForLoadState("domcontentloaded", { timeout: 15000 }); } catch (_) {}
        await sleep(1500);

        // Verify the SPA actually routed to the target post. Skool occasionally
        // swallows the click (closes dropdown, no navigation) — in that case
        // urlAfter still equals urlBefore (or has no trace of the post slug),
        // and we should fall back to page.goto so the caller doesn't end up
        // scanning the previous post for comments that don't exist there.
        var urlAfter = "";
        try { urlAfter = page.url(); } catch (_) {}
        var navigated = false;
        if (urlAfter && urlBefore && urlAfter !== urlBefore) navigated = true;
        if (!navigated && hrefSegment && urlAfter && urlAfter.toLowerCase().indexOf(hrefSegment.toLowerCase()) !== -1) {
            // URL didn't change but already contained the slug — caller is
            // already on the right post (e.g. clicked their own notification).
            navigated = true;
        }
        if (!navigated) {
            console.log("    [notif-click] click registered but URL didn't change (urlBefore=" + urlBefore +
                ", urlAfter=" + urlAfter + ") — caller should page.goto");
            try { await page.keyboard.press("Escape"); } catch (_) {}
            await sleep(200);
            return false;
        }

        console.log("    [notif-click] clicked matching notification → marked read + navigated");
        return true;
    }

    console.log("    [notif-click] no matching notification found — caller should page.goto");
    try { await page.keyboard.press("Escape"); } catch (_) {}
    await sleep(200);
    return false;
}

// Returns true if the bot has already posted a comment on the current page
// that is addressed to commentAuthor (i.e. starts with "@CommentAuthor"
// after normalizing whitespace). Catches the duplicate-reply scenario where
// the engagement-ledger signature shifted between cycles (e.g. the comment
// preview was scaffold-only on cycle N and full text on cycle N+1, producing
// different SHA1s for "the same engagement").
//
// This is a safety net, not the primary dedup mechanism — it runs AFTER we've
// already navigated to the post page, so it costs no extra round-trip.
async function botHasReplyToComment(page, botName, commentAuthor) {
    if (!botName || !commentAuthor) return false;
    var botNames = getBotIdentityNames(botName);
    var targetName = (commentAuthor || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!targetName) return false;

    try {
        var expanded = await expandCollapsedReplies(page);
        if (expanded > 0) await sleep(600);
    } catch (_) { /* non-fatal */ }

    return await page.evaluate(function(args) {
        function norm(s) {
            return (s || "")
                .replace(/Â/g, "")
                .replace(/[   ]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }
        var botSet = {};
        for (var b = 0; b < args.botNames.length; b++) {
            botSet[args.botNames[b].toLowerCase()] = true;
        }
        var target = (args.targetName || "").toLowerCase();

        var comments = document.querySelectorAll('[class*="CommentItemContainer"], [class*="CommentOrReply"]');
        for (var i = 0; i < comments.length; i++) {
            var el = comments[i];
            var authorLinks = el.querySelectorAll('a[href*="/@"]');
            var author = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = authorLinks[j].textContent.trim().replace(/^\d+/, "").trim();
                if (t && t.length > 1) { author = t; break; }
            }
            if (!author) continue;
            if (!botSet[norm(author).toLowerCase()]) continue;

            var raw = norm(el.textContent);
            if (raw.toLowerCase().indexOf(author.toLowerCase()) === 0) {
                raw = raw.substring(author.length).trim();
            }
            raw = raw.replace(/^[·•\-–—\s]*(?:just\s*now|\d+\s*[smhdw])[·•\-–—\s]*/i, "").trim();
            var mentionMatch = raw.match(/^@([\w][\w'\-À-ſ]*(?:\s+[\w][\w'\-À-ſ]*){0,3})/);
            if (!mentionMatch) continue;
            var mentioned = mentionMatch[1].toLowerCase().replace(/\s+/g, " ").trim();
            if (mentioned === target || target.indexOf(mentioned) === 0 || mentioned.indexOf(target) === 0) {
                return true;
            }
        }
        return false;
    }, { botNames: botNames, targetName: targetName });
}

module.exports = {
    sleep:                 sleep,
    login:                 login,
    getAllPosts:           getAllPosts,
    openPostAndGetBody:    openPostAndGetBody,
    typeReply:             typeReply,
    typeCommentReply:      typeCommentReply,
    submitReply:           submitReply,
    alreadyCommented:      alreadyCommented,
    hasUnreadNotifications: hasUnreadNotifications,
    clickNotificationBell: clickNotificationBell,
    getNotificationItems:  getNotificationItems,
    markNotificationsRead: markNotificationsRead,
    clickNotificationByMatch: clickNotificationByMatch,
    botHasReplyToComment:  botHasReplyToComment,
    readCommentTextByAuthor: readCommentTextByAuthor,
    scrollElementToViewportCenter: scrollElementToViewportCenter,
    startScrollRecenterLoop: startScrollRecenterLoop,
};
