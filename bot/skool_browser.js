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

                posts.push({
                    author:       rawAuthor,
                    title:        titleLink.textContent.trim(),
                    category:     categoryEl ? categoryEl.textContent.trim() : "General",
                    body:         contentEl  ? contentEl.textContent.trim()  : "",
                    href:         titleLink.href,
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

// ── Post body extractor ───────────────────────────────────────────────────────
// Opens the post page and fills post.body / post.title / post.author.
// Comments pipeline is dropped in v1 — only the clean post body is needed.

async function openPostAndGetBody(page, post) {
    console.log("📖 Opening post: " + post.title);
    await page.goto(post.href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(3000);

    // ── EXPAND TRUNCATED POST BODY ────────────────────────────────────────────
    // Skool collapses long post bodies behind a "See more" toggle. Without a
    // click, our scraper picks up the truncated body PLUS the literal string
    // "See more" trailing it (e.g. "...and I did... See more"). We click any
    // such toggle that is NOT inside a comment (we only want the post body
    // expanded, not every comment).
    //
    // Looped: we sometimes have to click multiple times if the post body is
    // also wrapped in nested truncations. We cap at 4 attempts to prevent any
    // theoretical loop (e.g. clicking a Show less toggle).
    for (var attempt = 0; attempt < 4; attempt++) {
        var clickedAny = await page.evaluate(function() {
            function isVisible(el) {
                if (!el) return false;
                var style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden") return false;
                var rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }
            // Skool renders the toggle as a clickable span/button with the
            // exact text "See more" (sometimes with a leading space/ellipsis).
            // Match conservatively — exact-text match, length cap to avoid
            // hitting buttons whose label happens to *contain* "see more".
            var nodes = Array.from(document.querySelectorAll(
                'button, a, span, div[role="button"], [class*="SeeMore"], [class*="seeMore"], [class*="ReadMore"], [class*="readMore"]'
            ));
            var clicked = false;
            for (var i = 0; i < nodes.length; i++) {
                var el = nodes[i];
                if (!isVisible(el)) continue;
                var t = (el.textContent || "").trim().toLowerCase();
                if (t !== "see more" && t !== "...see more" && t !== "… see more" && t !== "...show more" && t !== "show more") continue;
                // Skip if this toggle lives inside a comment — we only want
                // to expand the post body itself.
                if (el.closest('[class*="CommentsSection"], [class*="CommentsList"], [class*="CommentsListWrapper"], [class*="CommentItemContainer"], [class*="CommentOrReply"], [class*="CommentItem"], [class*="CommentBody"]')) continue;
                try {
                    el.scrollIntoView({ block: "center" });
                    el.click();
                    clicked = true;
                } catch (_) {}
            }
            return clicked;
        });
        if (!clickedAny) break;
        await sleep(500);
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
            if (targetTextStart && normalizeText(el.textContent).indexOf(targetTextStart) === -1) continue;

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
    });

    if (!match) return null;
    return await page.$('[data-codex-inline-reply-target="true"]');
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

async function clickCommentReplyButton(page, comment) {
    return await page.evaluate(function(args) {
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

        function clickLikeHuman(el) {
            var target = el.closest('button, [role="button"], a') || el;
            target.scrollIntoView({ block: "center", inline: "nearest" });
            ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function(type) {
                target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
            return true;
        }

        var targetAuthor = normalizeText(args.author);
        var targetTextStart = normalizeText(args.textStart);
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
            if (targetTextStart && normalizeText(el.textContent).indexOf(targetTextStart) === -1) continue;

            var replyBtn = el.querySelector('[class*="CommentItemReplyButton"]');
            if (replyBtn && isVisible(replyBtn)) {
                clickLikeHuman(replyBtn);
                return "class-button";
            }

            var links = el.querySelectorAll('a, button, span, div[role="button"]');
            for (var k = 0; k < links.length; k++) {
                if (!isVisible(links[k])) continue;
                if ((links[k].textContent || "").trim().toLowerCase() === "reply") {
                    clickLikeHuman(links[k]);
                    return "text-button";
                }
            }
        }
        return null;
    }, {
        author: comment.author || "",
        textStart: (comment.text || "").substring(0, 30),
    });
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

    await replyBox.scrollIntoViewIfNeeded();
    try {
        await replyBox.click();
    } catch (_) {
        await replyBox.focus();
    }
    await sleep(500);

    var isTextField = await replyBox.evaluate(function(el) {
        var tag = (el.tagName || "").toUpperCase();
        return tag === "INPUT" || tag === "TEXTAREA";
    });

    if (isTextField) {
        await replyBox.fill("");
    } else {
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
    }

    await replyBox.type(replyText, { delay: 20 });
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
        await page.keyboard.type(replyText, { delay: 20 });
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

    console.log("Reply typed into box\n");
    if (options.inlineTarget) {
        await page.evaluate(function() {
            var tagged = document.querySelector('[data-codex-inline-reply-target="true"]');
            if (tagged) tagged.removeAttribute("data-codex-inline-reply-target");
        });
    }
}

async function typeCommentReply(page, comment, replyText) {
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
    await bellEl.click();
    await sleep(1500);
    return true;
}

// Returns an array of notification items currently visible in the dropdown.
// Each item: { text, href, isUnread }
async function getNotificationItems(page) {
    // Scroll the dropdown to load all items
    await page.evaluate(async function() {
        function isVisible(el) {
            if (!el) return false;
            var style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }
        var candidates = Array.from(document.querySelectorAll("div, section, aside, ul")).filter(isVisible);
        var best = null, bestScore = -1;
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            var count = el.querySelectorAll('[class*="NotificationItem"], [class*="notificationItem"], [class*="NotificationRow"], a[href]').length;
            if (count === 0) continue;
            var score = count + (el.scrollHeight > el.clientHeight + 20 ? 1000 : 0) +
                (/Notification|Dropdown|Popover|Panel|Menu/i.test((el.className || "").toString()) ? 50 : 0);
            if (score > bestScore) { bestScore = score; best = el; }
        }
        if (!best) return;
        for (var step = 0; step < 20; step++) {
            best.scrollTop = best.scrollHeight;
            await new Promise(function(r) { setTimeout(r, 200); });
        }
        best.scrollTop = 0;
        await new Promise(function(r) { setTimeout(r, 150); });
    });

    return await page.evaluate(function() {
        var items = [];
        var listItems = document.querySelectorAll(
            '[class*="NotificationItem"], [class*="notificationItem"], ' +
            '[class*="NotificationRow"], [class*="notificationRow"]'
        );
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

        var seenKeys = {};
        for (var i = 0; i < listItems.length; i++) {
            var el = listItems[i];
            var elClass = (el.className || "").toString();
            if (/NotificationItemLink/.test(elClass)) continue;

            var href = "";
            if (el.href) href = el.href;
            if (!href) { var a = el.querySelector("a[href]"); if (a) href = a.href; }
            if (!href && el.closest("a[href]")) href = el.closest("a[href]").href;
            var text = el.textContent.trim().replace(/\s+/g, " ").substring(0, 240);
            var isUnread = !!(
                el.querySelector('[class*="Unread"], [class*="unread"], [class*="New"], [class*="new"], [class*="NotificationBubble"], [class*="notificationBubble"], [class*="Dot"], [class*="dot"]') ||
                /unread|new/i.test(elClass)
            );
            if (!href || !text) continue;

            var key = href + "||" + text;
            if (seenKeys[key]) continue;
            seenKeys[key] = true;
            items.push({ text: text, href: href, isUnread: isUnread });
        }
        return items;
    });
}

// Dismisses the notification dropdown (press Escape)
async function markNotificationsRead(page) {
    await page.keyboard.press("Escape");
    await sleep(300);
}

// ── Agentic-rework primitives ────────────────────────────────────────────────
// Added for the agentic auto_reply rework. See agentic/notif_phase.js +
// agentic/value_phase.js for usage.

// Click a notification item from the OPEN dropdown. The dropdown must already
// be open (call clickNotificationBell first). The item argument is one of the
// objects returned by getNotificationItems -- we match by href + leading text.
//
// Returns the URL we navigated to, or null on failure.
async function clickNotificationItem(page, item) {
    if (!item || !item.href) return null;

    var matchedHref = await page.evaluate(function(want) {
        function norm(s) { return (s || "").replace(/\s+/g, " ").trim(); }
        var anchors = Array.from(document.querySelectorAll('a[href]'));
        var wantHref = (want.href || "").split("?")[0];
        var wantTextHead = norm(want.text || "").substring(0, 60);
        for (var i = 0; i < anchors.length; i++) {
            var a = anchors[i];
            if (!a.href) continue;
            if (a.href.split("?")[0] !== wantHref) continue;
            // Confirm the visible text overlaps the notification snippet
            var aText = norm(a.textContent).substring(0, 60);
            if (wantTextHead && aText && aText !== wantTextHead && aText.indexOf(wantTextHead.substring(0, 30)) === -1 && wantTextHead.indexOf(aText.substring(0, 30)) === -1) {
                continue;
            }
            a.scrollIntoView({ block: "center" });
            a.click();
            return a.href;
        }
        return null;
    }, { href: item.href, text: item.text || "" });

    if (!matchedHref) {
        // Fallback: navigate directly via page.goto
        try {
            await page.goto(item.href, { waitUntil: "domcontentloaded", timeout: 30000 });
            await sleep(1500);
            return item.href;
        } catch (_) {
            return null;
        }
    }

    try {
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
    } catch (_) {}
    await sleep(1500);
    return matchedHref;
}

// Scrape the comment thread on the currently-loaded post page and return only
// the comments authored by either the bot (any of botNames) or `partnerName`.
//
// Result: [{ author, text, isBot, isPartner, idx }, ...] in DOM order.
//
// Robust to Skool's status-emoji decorations (🔥, 💎, 👑, ⭐) that get glued
// directly onto the author name in the comment header (e.g. "Jeremiah Bergeron🔥"),
// to leading level-badge digits ("3Pedro Lima"), and to nested-reply wrappers
// that use class "CommentOrReply" instead of "CommentItemContainer".
async function scrapeThreadHistoryWith(page, partnerName, botNames) {
    var allBotNames = (Array.isArray(botNames) ? botNames : [botNames]).filter(Boolean);
    var partner = partnerName || "";

    var result = await page.evaluate(function(args) {
        function stripDecorations(s) {
            // Strip emoji blocks Skool uses for status flair (🔥 💎 👑 ⭐ etc.)
            // plus zero-width joiner / variation selector codepoints.
            return (s || "")
                .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, "")
                .replace(/[‍️]/g, "");
        }
        function norm(s) {
            return (s || "")
                .replace(/Â/g, "")
                .replace(/[   ]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }
        function cleanAuthor(s) {
            // The author link's textContent on Skool can look like
            //   "3Pedro Lima"           (leading level-badge digit)
            //   "Jeremiah Bergeron🔥"   (trailing status emoji)
            //   "Andrew Kirby⭐"
            // Strip the leading digits AND the decorative emojis before
            // comparing names.
            var s2 = stripDecorations(s || "").replace(/^\d+/, "");
            return norm(s2);
        }
        function eqName(a, b) {
            var na = cleanAuthor(a).toLowerCase();
            var nb = cleanAuthor(b).toLowerCase();
            if (!na || !nb) return false;
            if (na === nb) return true;
            // Tolerate trailing decorations that survived stripping
            if (na.indexOf(nb) === 0 || nb.indexOf(na) === 0) return true;
            return false;
        }

        // Multi-strategy author-link finder.
        // Skool has used several URL patterns for user profile links over
        // time: /@username (legacy + still-current), /-/users/<id>,
        // /users/<id>, /u/<id>, /profile/<id>.
        //
        // CRITICAL: each comment renders TWO <a> tags pointing at the same
        // profile -- one wrapping the level-badge digit ("7"), one wrapping
        // the visible name ("Billy Harcourt"). querySelector returns the
        // badge anchor first; its textContent is just digits, which
        // cleanAuthor reduces to empty. We must scan ALL matches and pick
        // the first whose text is actually a name (has letters).
        function hasNameText(el) {
            if (!el) return false;
            var t = (el.textContent || "").trim();
            if (!t) return false;
            // Strip leading level-badge digits + status-flair emojis
            var c = t.replace(/^\d+/, "")
                     .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, "")
                     .trim();
            return c.length >= 2 && /[A-Za-z]/.test(c);
        }
        function findAuthorLink(container) {
            var hrefSelectors = [
                'a[href*="/@"]',
                'a[href*="/-/users/"]',
                'a[href*="/users/"]',
                'a[href*="/u/"]',
                'a[href*="/profile/"]',
            ];
            for (var hi = 0; hi < hrefSelectors.length; hi++) {
                var hits = container.querySelectorAll(hrefSelectors[hi]);
                for (var hj = 0; hj < hits.length; hj++) {
                    if (hasNameText(hits[hj])) return hits[hj];
                }
            }
            // Class-hint fallback for styled author elements
            var classCandidates = container.querySelectorAll(
                'a[class*="UserName"], a[class*="UserLink"], a[class*="userLink"], ' +
                'a[class*="UserHandle"], a[class*="Author"], ' +
                '[class*="UserName"], [class*="UserHandle"], [class*="AuthorName"]'
            );
            for (var ck = 0; ck < classCandidates.length; ck++) {
                if (hasNameText(classCandidates[ck])) return classCandidates[ck];
            }
            // Last resort: first anchor with text that looks like a person's name
            var anchors = container.querySelectorAll("a");
            for (var aj = 0; aj < anchors.length; aj++) {
                var t = (anchors[aj].textContent || "").trim().replace(/^\d+/, "").trim();
                if (!t || t.length < 2) continue;
                if (/^(Like|Reply|Edit|Delete|Report|Share|See more|Comment)$/i.test(t)) continue;
                if (/^[A-Z]/.test(t) && hasNameText(anchors[aj])) return anchors[aj];
            }
            return null;
        }

        var bots    = (args.botNames || []).filter(Boolean);
        var partner = args.partner || "";

        // Skool uses two distinct wrapper classes in the comment tree:
        //   * CommentItemContainer  -- top-level comments
        //   * CommentOrReply        -- nested replies
        // Either may host the author header + the reply text we want.
        var containers = Array.from(document.querySelectorAll(
            '[class*="CommentItemContainer"], [class*="CommentOrReply"]'
        ));

        // Dedupe -- if a CommentItemContainer transitively contains a
        // CommentOrReply for the same comment, we'd otherwise visit it twice.
        var seen = [];
        containers = containers.filter(function(el) {
            if (seen.indexOf(el) !== -1) return false;
            seen.push(el);
            return true;
        });

        var history = [];
        var seenAuthors = [];   // for debug output

        for (var i = 0; i < containers.length; i++) {
            var c = containers[i];
            var authorLink = findAuthorLink(c);
            if (!authorLink) continue;
            var rawAuthor = (authorLink.textContent || "").trim();
            var author = cleanAuthor(rawAuthor);
            if (!author) continue;
            if (seenAuthors.indexOf(author) === -1) seenAuthors.push(author);

            var isBot     = bots.some(function(b) { return eqName(author, b); });
            var isPartner = partner && eqName(author, partner);
            if (!isBot && !isPartner) continue;

            // Find the comment text node -- usually a sibling RichText / ql-editor
            var textEl = c.querySelector(
                '.ql-editor, [class*="RichText"], [class*="CommentBody"], ' +
                '[class*="commentBody"], [class*="CommentContent"], ' +
                '[class*="CommentText"], [class*="commentText"]'
            );
            var text = "";
            if (textEl) {
                text = (textEl.innerText || textEl.textContent || "").trim();
            } else {
                // Fallback: container's text minus the author name
                var raw = (c.innerText || c.textContent || "").trim();
                text = raw.replace(rawAuthor, "").trim();
            }

            // Strip the comment-header noise that prefixes the actual message
            // when we read .innerText off the wrapper:
            //   "5 • 4h "  ==> level badge + bullet + relative timestamp
            // Skool timestamps are short-form (4h, 2d, 1w, 3mo, 5y).
            text = text.replace(/^\s*\d+\s*[•·]\s*\d+\s*(?:mo|[smhdwy])\b\s*/i, "").trim();
            // Strip a trailing standalone reaction-count digit ("...new product! 0")
            text = text.replace(/\s+\d+\s*$/, "").trim();
            // Drop trailing "Like Reply" UI affordances
            text = text.replace(/\b(Like|Reply|Edit|Delete|Report)\b\s*$/i, "").trim();
            text = text.replace(/\s+/g, " ");

            history.push({
                author:    author,
                isBot:     isBot,
                isPartner: !!isPartner,
                text:      text,
                idx:       i,
            });
        }

        // Diagnostic snapshot: if we found containers but couldn't extract any
        // authors, sample the first container's anchor inventory + class names
        // so the operator can see what selectors need to be updated for the
        // current Skool DOM.
        var snapshot = null;
        if (containers.length > 0 && seenAuthors.length === 0) {
            var first = containers[0];
            var sampleAnchors = Array.from(first.querySelectorAll("a")).slice(0, 8).map(function(a) {
                return {
                    href: (a.getAttribute("href") || "").substring(0, 100),
                    text: (a.textContent || "").trim().substring(0, 50),
                    cls:  (a.className || "").toString().substring(0, 80),
                };
            });
            snapshot = {
                firstContainerClass: (first.className || "").toString().substring(0, 120),
                anchorCount:         first.querySelectorAll("a").length,
                anchors:             sampleAnchors,
            };
        }

        return {
            history: history,
            debug: {
                containerCount: containers.length,
                seenAuthors:    seenAuthors,
                snapshot:       snapshot,
            },
        };
    }, { partner: partner, botNames: allBotNames });

    if (result && result.debug) {
        var d = result.debug;
        var matched = (result.history || []).length;
        if (matched === 0 && d.containerCount > 0) {
            console.log(
                "    [thread-scrape] no match for partner=\"" + partner + "\". " +
                "Saw " + d.containerCount + " comment container(s) with authors: " +
                JSON.stringify(d.seenAuthors)
            );
            if (d.snapshot) {
                console.log("    [thread-scrape] No authors extracted from any container. First container inventory:");
                console.log("      class      : " + d.snapshot.firstContainerClass);
                console.log("      anchorCount: " + d.snapshot.anchorCount);
                d.snapshot.anchors.forEach(function(a, ai) {
                    console.log("      a[" + ai + "] href=" + JSON.stringify(a.href) + " text=" + JSON.stringify(a.text) + " cls=" + JSON.stringify(a.cls));
                });
            }
        } else {
            console.log(
                "    [thread-scrape] containers=" + d.containerCount +
                " matched=" + matched +
                " partner=\"" + partner + "\""
            );
        }
    }
    return (result && result.history) || [];
}

// Scrape the first N paginated pages of the community feed. Skool uses
// classic numbered pagination at the bottom of the feed (Previous / 1 2 3 ...
// 630 / Next, "1-30 of 18,890"), NOT infinite scroll, so we navigate page by
// page and accumulate posts.
//
// We click the "Next" button rather than mutating ?p= directly because Skool
// re-renders the feed via SPA navigation and the URL scheme has changed
// before. To detect that the new page has loaded we watch for the post
// wrappers to be replaced (their hrefs change) -- we capture the current set
// of href keys before clicking, then poll until at least one new href has
// appeared.
// ── Scrape every visible comment on the currently-open post page ───────────
//
// Returns an array of { author, text } objects. Filters out the bot's own
// comments and (optionally) the post author's self-replies. Picks up BOTH
// top-level comments and nested replies, because both render with
// CommentOrReply / CommentItemContainer wrappers on Skool.
//
// Caller must have already navigated to the post page (e.g. via
// openPostAndGetBody). This helper does not navigate.
async function scrapeCommentsOnCurrentPage(page, options) {
    options = options || {};
    var botName     = options.botName    || "";
    var postAuthor  = options.postAuthor || "";
    var maxComments = options.maxComments || 80;

    return await page.evaluate(function(args) {
        function cleanName(s) {
            return (s || "")
                .replace(/^\d+/, "")
                .replace(/Â/g, "")
                .replace(/[   ]/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }
        function cleanText(s) {
            return (s || "")
                .replace(/\s+/g, " ")
                .trim();
        }
        var bot        = (args.botName    || "").trim().toLowerCase();
        var postAuthor = (args.postAuthor || "").trim().toLowerCase();
        var max        = args.maxComments;

        var nodes = Array.from(document.querySelectorAll(
            '[class*="CommentItemContainer"], [class*="CommentOrReply"]'
        ));
        var seen = {};
        var out  = [];
        for (var i = 0; i < nodes.length && out.length < max; i++) {
            var el = nodes[i];

            // Author — first /@-link inside this comment block
            var authorLinks = el.querySelectorAll('a[href*="/@"]');
            var author = "";
            for (var j = 0; j < authorLinks.length; j++) {
                var t = cleanName(authorLinks[j].textContent);
                if (t && t.length > 1) { author = t; break; }
            }
            if (!author) continue;
            var aLower = author.toLowerCase();
            if (bot        && aLower === bot)        continue;  // skip bot's own
            if (postAuthor && aLower === postAuthor) continue;  // skip post author's self-replies

            // Body
            var bodyEl = el.querySelector(
                '[class*="CommentBody"], [class*="commentBody"], ' +
                '[class*="RichText"], .ql-editor'
            );
            var raw  = bodyEl ? bodyEl.textContent : el.textContent;
            var text = cleanText(raw);

            // Strip the author prefix that often leaks into el.textContent
            if (text.toLowerCase().indexOf(aLower) === 0) {
                text = text.substring(author.length).replace(/^[\s•·•\-:|]+/, "").trim();
            }
            if (!text || text.length < 5) continue;

            // De-dupe near-duplicates (same author + same text head)
            var key = aLower + "::" + text.substring(0, 60).toLowerCase();
            if (seen[key]) continue;
            seen[key] = true;

            out.push({ author: author, text: text });
        }
        return out;
    }, { botName: botName, postAuthor: postAuthor, maxComments: maxComments });
}

async function scrapeFeedNPages(page, communityUrl, n) {
    var pages = (typeof n === "number" && n > 0) ? n : 3;
    console.log("📋 Scraping last " + pages + " 'pages' of " + communityUrl + " ...");
    await page.goto(communityUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(4000);

    // ── Helper: scrape every PostItemWrapper currently in DOM ─────────────────
    async function extractCurrentPosts() {
        return await page.evaluate(function() {
            var wrappers = Array.from(document.querySelectorAll('[class*="PostItemWrapper"]'));
            var posts = [];
            for (var i = 0; i < wrappers.length; i++) {
                var w = wrappers[i];
                if (w.textContent.includes("Pinned") || w.querySelector('[class*="Pinned"], [class*="pinned"]')) continue;

                var authorEl   = w.querySelector(
                    '[class*="PostAuthor"] a[href*="/@"], ' +
                    '[class*="Author"] a[href*="/@"], ' +
                    '[class*="postHeader"] a[href*="/@"], ' +
                    'a[href*="/@"]'
                );
                var categoryEl = w.querySelector('[class*="GroupFeedLinkLabel"]');
                var contentEl  = w.querySelector('[class*="PostItemCardContent"]');
                var postLinks  = Array.from(w.querySelectorAll("a")).filter(function(a) {
                    var href = a.href || "";
                    return href.includes("/post/") || (href.split("/").length > 4 && !href.includes("/@") && !href.includes("?c=") && !href.includes("?p="));
                });
                var titleLink = postLinks.find(function(a) { return a.textContent.trim().length > 3; });
                if (!titleLink) continue;

                var rawAuthor = authorEl ? authorEl.textContent.trim() : "";
                rawAuthor = rawAuthor
                    .replace(/^\d+/, "")
                    .replace(/Â/g, "")
                    .replace(/[   ]/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();

                var rawTitle = titleLink.textContent.trim();
                var rawBody  = contentEl ? contentEl.textContent.trim() : "";

                // Fallback: when the author selector misses (common after the
                // infinite-scroll re-renders feed items), the author name is
                // still embedded in the post-card body text in the form
                //   "<like-count><Author Name><timestamp like '5d'/'8h'/'51m'> • <category>..."
                if (!rawAuthor && rawBody) {
                    var m = rawBody.match(/^\d+(.+?)(?:\d+\s*[smhdwy]\b|[A-Z][a-z]{2,}\s+'?\d{2,4})/);
                    if (m && m[1]) {
                        rawAuthor = m[1]
                            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}⭐🔥💎🤑]/gu, "")
                            .replace(/\s+/g, " ")
                            .trim();
                    }
                }
                if (!rawAuthor) rawAuthor = "Unknown";

                var commentCount = 0;
                var countEl = w.querySelector('[class*="CommentsCount"], [class*="commentCount"], [class*="CommentCount"]');
                if (countEl) {
                    var nn = parseInt(countEl.textContent.trim(), 10);
                    if (!isNaN(nn)) commentCount = nn;
                }

                posts.push({
                    author:       rawAuthor,
                    title:        rawTitle,
                    category:     categoryEl ? categoryEl.textContent.trim() : "General",
                    body:         rawBody,
                    href:         titleLink.href,
                    commentCount: commentCount,
                });
            }
            return posts;
        });
    }

    // ── Helper: capture the set of href keys currently in the feed ─────────
    // We use this both for accumulating posts across pages AND as the
    // "navigation completed" signal: once the wrapper hrefs differ from the
    // pre-click set, we know Skool has rendered the next page.
    async function getCurrentHrefSet() {
        return await page.evaluate(function() {
            var wrappers = document.querySelectorAll('[class*="PostItemWrapper"]');
            var keys = [];
            for (var i = 0; i < wrappers.length; i++) {
                var links = wrappers[i].querySelectorAll("a");
                for (var j = 0; j < links.length; j++) {
                    var h = links[j].href || "";
                    if (h.indexOf("/post/") !== -1 || (h.split("/").length > 4 && h.indexOf("/@") === -1 && h.indexOf("?c=") === -1 && h.indexOf("?p=") === -1)) {
                        keys.push(h.split("?")[0]);
                        break;
                    }
                }
            }
            return keys;
        });
    }

    // ── Helper: click the "Next" button in the paginator ────────────────────
    // Returns true if the click landed, false if no Next button is present
    // (i.e. we're on the last page).
    async function clickNextPage() {
        return await page.evaluate(function() {
            function isVisible(el) {
                if (!el) return false;
                var style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden") return false;
                var rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }
            // Look at every clickable element near the bottom of the page.
            // Skool's paginator renders Previous / 1 2 3 ... / Next as
            // separate buttons or anchors. Match by exact text "Next" --
            // case-insensitive, but only standalone (length cap to avoid
            // hitting "Next steps" buttons elsewhere on the page).
            var candidates = Array.from(document.querySelectorAll(
                'button, a, [role="button"], [class*="Pagination"] *, [class*="pagination"] *'
            )).filter(isVisible);
            for (var i = 0; i < candidates.length; i++) {
                var el = candidates[i];
                var t  = (el.textContent || "").trim();
                if (t.length > 8) continue;            // "Next" not "Next steps"
                if (!/^next$/i.test(t)) continue;
                // Skip disabled state -- Skool greys out Next on the last page
                if (el.getAttribute("aria-disabled") === "true") continue;
                if (el.disabled) continue;
                var cls = (el.className || "").toString();
                if (/disabled/i.test(cls)) continue;
                // Click the closest anchor/button so we don't click an inner span
                var clickTarget = el.closest("button, a, [role=\"button\"]") || el;
                try {
                    clickTarget.scrollIntoView({ block: "center" });
                    clickTarget.click();
                    return true;
                } catch (_) {}
            }
            return false;
        });
    }

    // ── Helper: wait until the visible href set differs from the pre-click set
    async function waitForFeedChange(prevKeys, timeoutMs) {
        var start    = Date.now();
        var prevSet  = {};
        for (var i = 0; i < prevKeys.length; i++) prevSet[prevKeys[i]] = true;

        while (Date.now() - start < timeoutMs) {
            var nowKeys = await getCurrentHrefSet();
            if (nowKeys.length > 0) {
                // Consider the feed "changed" once at least one href is new.
                for (var k = 0; k < nowKeys.length; k++) {
                    if (!prevSet[nowKeys[k]]) return true;
                }
            }
            await sleep(400);
        }
        return false;
    }

    // ── Accumulator + initial scrape ─────────────────────────────────────────
    var collectedByHref = {};
    function mergePosts(batch) {
        for (var i = 0; i < batch.length; i++) {
            var p = batch[i];
            var key = (p.href || "").split("?")[0];
            if (!key || collectedByHref[key]) continue;
            collectedByHref[key] = p;
        }
    }
    mergePosts(await extractCurrentPosts());
    console.log("  [scrape] page 1 posts: " + Object.keys(collectedByHref).length);

    // ── Pagination loop ─────────────────────────────────────────────────────
    // We've already scraped page 1. Click Next (pages-1) more times to walk
    // through pages 2..N. Stop early if Next is missing or disabled.
    var pagesCompleted = 1;
    for (var s = 1; s < pages; s++) {
        var prevKeys = await getCurrentHrefSet();

        var clicked = await clickNextPage();
        if (!clicked) {
            console.log("  [paginate] No 'Next' button found / disabled -- assuming last page reached. Stopping.");
            break;
        }

        // Wait for Skool to render the new page. SPA navigation usually
        // settles in 1-3s; we give it up to 10s to be safe.
        var changed = await waitForFeedChange(prevKeys, 10000);
        if (!changed) {
            console.log("  [paginate] Page " + (s + 1) + ": Next clicked but the feed never changed within 10s. Stopping.");
            break;
        }

        // Let lazy elements (avatars, comment counts) finish so the scrape
        // captures the full card.
        await sleep(800);

        var beforeCount = Object.keys(collectedByHref).length;
        mergePosts(await extractCurrentPosts());
        var afterCount  = Object.keys(collectedByHref).length;
        console.log("  [paginate] page " + (s + 1) + " posts: " + beforeCount + " -> " + afterCount + " (added " + (afterCount - beforeCount) + ")");
        pagesCompleted++;
    }

    var allPosts = Object.keys(collectedByHref).map(function(k) { return collectedByHref[k]; });
    console.log("📋 Scraped " + allPosts.length + " unique non-pinned posts across " + pagesCompleted + " paginator pages (target=" + pages + ")\n");
    return allPosts;
}

module.exports = {
    sleep,
    login,
    getAllPosts,
    openPostAndGetBody,
    typeReply,
    typeCommentReply,
    submitReply,
    alreadyCommented,
    hasUnreadNotifications,
    clickNotificationBell,
    getNotificationItems,
    markNotificationsRead,
    // Agentic-rework primitives
    clickNotificationItem,
    scrapeThreadHistoryWith,
    scrapeFeedNPages,
    scrapeCommentsOnCurrentPage,
    clickCommentReplyButton,
};
