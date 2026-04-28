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
};
