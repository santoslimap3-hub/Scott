const { chromium } = require("playwright");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── MOTHER AI system ───────────────────────────────────────────────────────────
// Same classify → tag-aware prompt → fine-tuned model pipeline as auto_reply.js
// Extended with the 8-step DM appointment setting workflow stage.
const dmClassifier = require("./classify/dm_classifier");
const classifyDM   = dmClassifier;
const sessionLog   = require("./logger/session_log");
const trainingLog  = require("./logger/training_log");
const { INTENTS: INTENT_DEFS, SALES_STAGES: STAGE_DEFS } = require("./classify/tags");
const { splitBubbles, interBubbleDelayMs, BUBBLE_DELIM } = require("./bubble");

// ── Persons database ────────────────────────────────────────────────────────
// Tracks all people the bot has interacted with and their full interaction
// history. DM exchanges are logged here so the full relationship context
// (including any prior post/comment interactions) persists across sessions.
const personsDb      = require("./db/persons_db");
const promptBuilders = require("./prompt_builders");
const guessGender    = require("./util/gender_detector");

const STATE_FILE = path.join(__dirname, "conversation_state.json");

const CONFIG = {
    email: process.env.SKOOL_EMAIL,
    password: process.env.SKOOL_PASSWORD,
    headless: false,
    dryRun: false,
    // Active period
    activeMinMs:   10 * 60 * 1000,   // 10 min
    activeMaxMs:   60 * 60 * 1000,   //  1 hr
    // Inactive period
    inactiveMinMs: 20 * 60 * 1000,   // 20 min
    inactiveMaxMs: 90 * 60 * 1000,   // 1.5 hr
    // Delay before replying — realistic human range
    replyDelayMinMs:  8 * 1000,      //  8 sec  (never instant)
    replyDelayMaxMs:  4 * 60 * 1000, //  4 min
    // Poll frequency during active period
    pollIntervalMs:   2 * 60 * 1000, //  2 min between polls
    // Max conversations to reply to per poll (spread replies out naturally)
    maxRepliesPerPoll: 3,
};

function randomBetween(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatMs(ms) {
    var totalSec = Math.round(ms / 1000);
    var min = Math.floor(totalSec / 60);
    var sec = totalSec % 60;
    return min > 0 ? min + "m " + sec + "s" : sec + "s";
}

// ─── HUMAN-LIKE TYPING ───────────────────────────────────
// Types text with variable inter-character delays, brief thinking pauses at
// punctuation, and a rare typo+backspace to look like a real person.

async function humanType(page, text) {
    for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        await page.keyboard.type(ch);

        // Base delay: space after word = slightly longer, punctuation = pause, else fast
        var delay;
        if (ch === ' ') {
            delay = randomBetween(60, 160);
        } else if (/[.!?]/.test(ch)) {
            delay = randomBetween(120, 350); // end of sentence — brief think
        } else if (/[,;:]/.test(ch)) {
            delay = randomBetween(80, 200);
        } else {
            delay = randomBetween(28, 110);
        }

        // ~3% chance of a thinking pause mid-sentence (picked up phone, glanced away)
        if (Math.random() < 0.03) delay += randomBetween(600, 2200);

        await sleep(delay);

        // ~0.4% chance of fat-finger typo → backspace and retype
        if (Math.random() < 0.004 && i < text.length - 1) {
            var fat = 'qwertyuiopasdfghjklzxcvbnm';
            await page.keyboard.type(fat[Math.floor(Math.random() * fat.length)]);
            await sleep(randomBetween(250, 700)); // realise the mistake
            await page.keyboard.press('Backspace');
            await sleep(randomBetween(80, 200));
        }
    }
}

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

// ── Per-person conversation state ────────────────────────────────────────────
// Format: { "Scott Northwolf": { lastPreview, lastPartnerMsg, lastReplyText, lastRepliedAt } }
// "lastPreview"    — the conversation list preview we last saw when we replied/skipped.
//                   If the current preview still matches → nothing new → skip.
// "lastPartnerMsg" — what THEY last said before our reply (backup match for slow preview refresh).
// "lastReplyText"  — what WE sent (for logging / dedup).
// "lastRepliedAt"  — unix ms timestamp of our last reply (for rate-limit checks).

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            var data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
            var n = Object.keys(data).length;
            console.log("Loaded conversation state for " + n + " people");
            return data;
        }
    } catch (e) {
        console.warn("Could not load conversation_state.json, starting fresh:", e.message);
    }
    return {};
}

function saveState(state) {
    var tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
}

function hasNewMessage(state, convName, currentPreview) {
    var s = state[convName];
    if (!s) return true; // never spoken to this person
    var prev = (currentPreview || '').substring(0, 150);
    // Skip if preview matches either our last reply or their last message we handled
    return prev !== s.lastPreview && prev !== s.lastPartnerMsg;
}

function markHandled(state, convName, opts) {
    // opts: { lastPreview, lastPartnerMsg, lastReplyText }
    state[convName] = {
        lastPreview:    (opts.lastPreview    || '').substring(0, 150),
        lastPartnerMsg: (opts.lastPartnerMsg || '').substring(0, 150),
        lastReplyText:  (opts.lastReplyText  || '').substring(0, 150),
        lastRepliedAt:  Date.now(),
    };
}

// ─── DISMISS OVERLAYS ────────────────────────────────────
// Skool's DropdownBackground overlay intercepts all clicks when a menu is open.
// Call this before any click operation to guarantee a clean state.

async function dismissOverlays(page) {
    // Run JS directly inside the browser to click the backdrop —
    // this bypasses Playwright's own interception detection entirely.
    await page.evaluate(function() {
        var selectors = [
            '[class*="DropdownBackground"]',
            '[class*="Backdrop"]',
            '[class*="backdrop"]',
            '[class*="Overlay"]',
        ];
        selectors.forEach(function(sel) {
            document.querySelectorAll(sel).forEach(function(el) { el.click(); });
        });
        // Fire Escape inside the page too
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await sleep(250);

    // Playwright-level Escape as belt-and-suspenders
    await page.keyboard.press('Escape');
    await sleep(200);

    // Wait until the DropdownBackground is gone from the DOM
    try {
        await page.waitForFunction(function() {
            return document.querySelectorAll('[class*="DropdownBackground"]').length === 0;
        }, { timeout: 3000 });
    } catch (e) { /* wasn't there or already gone */ }
    await sleep(150);
}

// ─── LOGIN ───────────────────────────────────────────────

async function login(page) {
    console.log("Logging in...");
    await page.goto("https://www.skool.com/login", { waitUntil: "networkidle" });
    await sleep(1000);

    // Snapshot page state — only used if login fails
    var pageState = await page.evaluate(function() {
        var inputs = Array.from(document.querySelectorAll('input')).map(function(el) {
            return { type: el.type, name: el.name, id: el.id };
        });
        var buttons = Array.from(document.querySelectorAll('button')).map(function(el) {
            return { type: el.type, text: el.textContent.trim().substring(0, 30) };
        });
        return { inputs: inputs, buttons: buttons };
    });

    // Click + type (not fill) so React's onChange events fire correctly
    await page.click('#email');
    await sleep(200);
    await page.keyboard.type(CONFIG.email, { delay: 40 });
    await sleep(300);
    await page.click('#password');
    await sleep(200);
    await page.keyboard.type(CONFIG.password, { delay: 40 });
    await sleep(500);

    // Try submit button — multiple selectors in priority order
    var submitted = false;
    var btnSelectors = [
        'button[type="submit"]',
        'form button',
        'button:has-text("Sign in")',
        'button:has-text("Log in")',
        'button:has-text("Continue")',
        '[class*="Submit"]',
        '[class*="LoginButton"]',
    ];
    for (var bi = 0; bi < btnSelectors.length; bi++) {
        try {
            var btn = await page.$(btnSelectors[bi]);
            if (btn) {
                console.log("Clicking submit button with selector:", btnSelectors[bi]);
                await btn.click();
                submitted = true;
                break;
            }
        } catch (e) { /* try next */ }
    }
    if (!submitted) {
        console.log("Login page state:", JSON.stringify(pageState));
        throw new Error("Could not find submit button on login page");
    }

    // Wait for navigation away from login page (up to 20s)
    try {
        await page.waitForNavigation({ timeout: 20000, waitUntil: 'domcontentloaded' });
    } catch (e) { /* navigation may have already completed */ }

    if (page.url().includes('/login')) {
        console.log("Login page state:", JSON.stringify(pageState));
        console.log("Pausing 10s so you can read the browser window...");
        await sleep(10000);
        var pageText = await page.evaluate(function() {
            return document.body.innerText.substring(0, 400);
        });
        throw new Error("Login failed. Page text: " + pageText);
    }
    console.log("Logged in");

    // ── Get the bot's display name ──────────────────────────────────────────────
    // BOT_NAME in .env is the most reliable override — set it if auto-detection
    // ever picks up the wrong account (e.g. community owner instead of bot account).
    if (process.env.BOT_NAME) {
        console.log("Bot account name: " + process.env.BOT_NAME + " (from BOT_NAME env)\n");
        return process.env.BOT_NAME;
    }

    // Navigate home and try to read the bot's display name from the page.
    await page.goto("https://www.skool.com", { waitUntil: "domcontentloaded" });
    await sleep(3000);

    // Strategy 1: look in the top nav / header ONLY — this avoids picking up
    // community members whose profile links appear first in the page feed.
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
        // Strategy 2: look for nav avatar img alt text (Skool sets this to the user's name)
        var navImgSelectors = [
            'nav img[alt]', 'header img[alt]',
            '[class*="TopNav"] img[alt]',
            '[class*="NavBar"] img[alt]',
        ];
        for (var ni = 0; ni < navImgSelectors.length; ni++) {
            var imgs = document.querySelectorAll(navImgSelectors[ni]);
            for (var ii = 0; ii < imgs.length; ii++) {
                var alt = (imgs[ii].getAttribute('alt') || '').trim();
                if (alt.length > 1 && !/logo|icon/i.test(alt) && !alt.match(/^\d+$/)) return alt;
            }
        }
        return "";
    });

    // Strategy 3: open the avatar dropdown — the dropdown only contains OUR profile info
    if (!botName) {
        var avatarBtn = await page.$('[class*="UserAvatar"], [class*="avatar"], img[class*="Avatar"]');
        if (avatarBtn) {
            await avatarBtn.click();
            await sleep(800);
            botName = await page.evaluate(function() {
                // Look ONLY inside dropdown/popover elements that just appeared
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
            await dismissOverlays(page);
        }
    }

    if (!botName) {
        console.warn("⚠️  Could not detect bot name. Add BOT_NAME=Your Name to .env to fix this.");
    }
    console.log("Bot account name: " + (botName || "(unknown)") + "\n");
    return botName;
}

// ─── OPEN / CLOSE CHAT PANEL ─────────────────────────────

async function openChatPanel(page) {
    var chatBtn = await page.$(
        '[class*="ChatNotificationsIconButton"], ' +
        '[class*="ChatIconWrapper"], ' +
        '[class*="ChatIcon"]'
    );
    if (chatBtn) {
        // force:true bypasses any overlay still in the way as a last resort
        await chatBtn.click({ force: true });
        return true;
    }

    var navItems = await page.$$('nav button, header button, nav a, header a, [class*="Nav"] button');
    for (var i = 0; i < navItems.length; i++) {
        var cls = await navItems[i].getAttribute('class') || '';
        if (/chat|message/i.test(cls)) {
            await navItems[i].click({ force: true });
            return true;
        }
    }
    return false;
}

async function closeChatPanel(page) {
    await page.keyboard.press('Escape');
    await sleep(300);
    await page.keyboard.press('Escape');
    await sleep(500);
}

// ─── GET CONVERSATION LIST ────────────────────────────────

async function getConversationList(page, botName) {
    return await page.evaluate(function(botDisplayName) {
        var result = { conversations: [] };

        var msgEls = document.querySelectorAll('[class*="MessageContent"]');
        if (msgEls.length === 0) return result;

        var probe = msgEls[0];
        var listContainer = null;
        var parent = probe.parentElement;
        while (parent) {
            if (parent.querySelectorAll('[class*="MessageContent"]').length > 1) {
                listContainer = parent;
                break;
            }
            parent = parent.parentElement;
        }
        if (!listContainer) return result;

        var rows = [];
        for (var c = 0; c < listContainer.children.length; c++) {
            var child = listContainer.children[c];
            if (child.querySelector('[class*="MessageContent"]') || child.matches('[class*="MessageContent"]')) {
                rows.push(child);
            }
        }

        if (rows.length < msgEls.length && rows.length > 0) {
            var expandedRows = [];
            for (var r = 0; r < rows.length; r++) {
                if (rows[r].querySelectorAll('[class*="MessageContent"]').length > 1) {
                    for (var sc = 0; sc < rows[r].children.length; sc++) {
                        if (rows[r].children[sc].querySelector('[class*="MessageContent"]') ||
                            rows[r].children[sc].matches('[class*="MessageContent"]')) {
                            expandedRows.push(rows[r].children[sc]);
                        }
                    }
                } else {
                    expandedRows.push(rows[r]);
                }
            }
            if (expandedRows.length > rows.length) rows = expandedRows;
        }

        for (var k = 0; k < rows.length; k++) {
            var row = rows[k];
            var conv = { name: null, lastMsg: null, isUnread: false, index: k };

            var avatars = row.querySelectorAll('img[alt], [title]:not([title=""])');
            for (var a = 0; a < avatars.length; a++) {
                var name = avatars[a].getAttribute('alt') || avatars[a].getAttribute('title') || '';
                name = name.trim();
                if (name && name !== botDisplayName && !/^\d+$/.test(name) && name.length > 1) {
                    conv.name = name;
                    break;
                }
            }

            if (!conv.name) {
                var nameLinks = row.querySelectorAll('a[href*="/@"]');
                for (var n = 0; n < nameLinks.length; n++) {
                    var linkText = nameLinks[n].textContent.trim();
                    if (linkText && !/^\d+$/.test(linkText) && linkText !== botDisplayName) {
                        conv.name = linkText;
                        break;
                    }
                }
            }

            if (!conv.name) {
                var msgContent = row.querySelector('[class*="MessageContent"]');
                var timeEl = row.querySelector('[class*="LastMessageTime"], [class*="Time"]');
                var msgText = msgContent ? msgContent.textContent.trim() : '';
                var timeText = timeEl ? timeEl.textContent.trim() : '';
                var fullText = row.textContent.trim();
                var remaining = fullText;
                if (msgText) remaining = remaining.replace(msgText, '');
                if (timeText) remaining = remaining.replace(timeText, '');
                remaining = remaining.replace(/^\d+\s*/, '').replace(/\s*\d+$/, '').trim();
                if (remaining && remaining.length > 1 && remaining.length < 60) {
                    conv.name = remaining;
                }
            }

            var msgEl = row.querySelector('[class*="MessageContent"]');
            if (msgEl) conv.lastMsg = msgEl.textContent.trim().substring(0, 150);

            if (msgEl) {
                var msgStyle = window.getComputedStyle(msgEl);
                var msgFw = parseInt(msgStyle.fontWeight) || 0;
                if (msgFw >= 600 || /bold/i.test(msgStyle.fontWeight)) {
                    conv.isUnread = true;
                }
            }
            var dot = row.querySelector('[class*="Unread"], [class*="unread"], [class*="Badge"], [class*="Dot"], [class*="Indicator"]');
            if (dot) {
                conv.isUnread = true;
            }

            if (conv.name) result.conversations.push(conv);
        }

        return result;
    }, botName);
}

// ─── CLICK INTO A CONVERSATION ────────────────────────────

async function clickConversation(page, targetIndex) {
    var convRect = await page.evaluate(function(targetIndex) {
        var msgEls = document.querySelectorAll('[class*="MessageContent"]');
        if (msgEls.length === 0) return null;
        var probe = msgEls[0];
        var listContainer = null;
        var parent = probe.parentElement;
        while (parent) {
            if (parent.querySelectorAll('[class*="MessageContent"]').length > 1) {
                listContainer = parent;
                break;
            }
            parent = parent.parentElement;
        }
        if (!listContainer) return null;
        var rows = [];
        for (var c = 0; c < listContainer.children.length; c++) {
            var child = listContainer.children[c];
            if (child.querySelector('[class*="MessageContent"]') || child.matches('[class*="MessageContent"]')) {
                rows.push(child);
            }
        }
        if (rows.length < msgEls.length && rows.length > 0) {
            var expanded = [];
            for (var r = 0; r < rows.length; r++) {
                if (rows[r].querySelectorAll('[class*="MessageContent"]').length > 1) {
                    for (var sc = 0; sc < rows[r].children.length; sc++) {
                        if (rows[r].children[sc].querySelector('[class*="MessageContent"]') ||
                            rows[r].children[sc].matches('[class*="MessageContent"]')) {
                            expanded.push(rows[r].children[sc]);
                        }
                    }
                } else {
                    expanded.push(rows[r]);
                }
            }
            if (expanded.length > rows.length) rows = expanded;
        }
        if (targetIndex >= rows.length) return null;
        var rect = rows[targetIndex].getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, targetIndex);

    if (!convRect) return false;
    await page.mouse.click(convRect.x, convRect.y);
    return true;
}

// ─── READ FULL CONVERSATION ──────────────────────────────

async function readFullConversation(page, botName) {
    return await page.evaluate(function(args) {
        var botDisplayName = args.botDisplayName;
        var result = { partner: null, messages: [], lastSender: null, debugInfo: [] };

        // Get partner name from input placeholder ("Message Sulav")
        var allInputs = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]');
        for (var i = 0; i < allInputs.length; i++) {
            var ph = allInputs[i].getAttribute('placeholder') || '';
            var match = ph.match(/^Message\s+(.+)/i);
            if (match) {
                result.partner = match[1].trim();
                break;
            }
        }

        // Fallback: ChatHeader link
        if (!result.partner) {
            var header = document.querySelector('[class*="ChatHeader"]');
            if (header) {
                var links = header.querySelectorAll('a[href*="/@"]');
                for (var h = 0; h < links.length; h++) {
                    var text = links[h].textContent.trim();
                    if (text && !/^\d+$/.test(text) && text !== botDisplayName) {
                        result.partner = text;
                        break;
                    }
                }
            }
        }

        // Find message bubbles
        var msgSelectors = [
            '[class*="ChatBubble"]', '[class*="MessageBubble"]',
            '[class*="ChatMessage"]', '[class*="MessageItem"]',
            '[class*="MessageRow"]',
        ];
        var bubbles = [];
        var usedSelector = '(none)';
        for (var s = 0; s < msgSelectors.length; s++) {
            bubbles = document.querySelectorAll(msgSelectors[s]);
            if (bubbles.length > 0) { usedSelector = msgSelectors[s]; break; }
        }

        if (bubbles.length === 0) {
            result.debugInfo.push({ error: 'no bubbles found' });
            return result;
        }

        // ── NOTE: Skool DMs show ALL messages left-aligned with the sender's name ──
        // Position-based detection doesn't work here. Instead we extract the author
        // name from the DOM for every message and compare against the partner's name.
        // In a 2-person DM: if author != partner → it's the bot.

        result.debugInfo.push({
            selector: usedSelector,
            bubbleCount: bubbles.length,
            partner: result.partner,
        });

        var partnerLow = result.partner ? result.partner.toLowerCase() : null;
        var lastAuthor = null;

        for (var b = 0; b < bubbles.length; b++) {
            var bubble = bubbles[b];

            // Try multiple selectors to extract the sender's name
            var nameSelectors = [
                'a[href*="/@"]',
                '[class*="UserNameText"]',
                '[class*="AuthorName"]',
                '[class*="SenderName"]',
                '[class*="UserName"]',
                '[class*="MemberName"]',
                '[class*="DisplayName"]',
            ];
            var foundName = null;
            for (var ns = 0; ns < nameSelectors.length; ns++) {
                var nameEl = bubble.querySelector(nameSelectors[ns]);
                if (nameEl) {
                    var nm = nameEl.textContent.trim();
                    if (nm && nm.length > 1 && nm.length < 60) { foundName = nm; break; }
                }
            }

            // Fallback: if bubble text starts with the known partner name
            if (!foundName && partnerLow) {
                var rawText = bubble.textContent.trim();
                if (rawText.toLowerCase().startsWith(partnerLow)) foundName = result.partner;
            }

            var author;
            if (foundName) { author = foundName; lastAuthor = foundName; }
            else            { author = lastAuthor; }

            // Determine role: partner vs bot.
            // The placeholder gives only the first name ("Message Scott" → "Scott").
            // The DOM name may use non-breaking spaces (\u00a0) between first/last name,
            // so we split on any whitespace and compare first words.
            var role;
            if (author && partnerLow) {
                var authorFirstWord = author.toLowerCase().split(/\s+/)[0];
                var partnerFirstWord = partnerLow.split(/\s+/)[0];
                var isPartner = authorFirstWord === partnerFirstWord;
                role = isPartner ? 'partner' : 'bot';
            } else if (author === botDisplayName) {
                role = 'bot';
            } else {
                role = 'partner'; // safe default
            }

            // Get message text
            var msgTextEl = bubble.querySelector('[class*="MessageBody"], [class*="TextContent"], p');
            var msgText = msgTextEl ? msgTextEl.textContent.trim() : bubble.textContent.trim();

            // Strip author name and timestamp prefixes
            if (author && msgText.startsWith(author)) msgText = msgText.substring(author.length).trim();
            msgText = msgText.replace(/^\d+[dhms]\s*/i, '').replace(/^\d{1,2}:\d{2}\s*(am|pm)\s*/i, '').trim();

            // Debug: capture first 6 bubbles
            if (b < 6) {
                result.debugInfo.push({
                    idx: b,
                    foundName: foundName,
                    role: role,
                    text: (msgText || '').substring(0, 50),
                });
            }

            if (msgText && author) {
                result.messages.push({ role: role, author: author, text: msgText });
            }
        }

        if (result.messages.length > 0) {
            result.lastSender = result.messages[result.messages.length - 1].role;
        }

        return result;
    }, { botDisplayName: botName });
}

// ─── DM WORKFLOW STAGE INSTRUCTIONS ──────────────────────────────────────────
// What Scott should specifically DO at each stage of the appointment setting flow.

var DM_STAGE_INSTRUCTIONS = {
    "connect": "This is your OPENING MOVE. Reference something SPECIFIC — their post, a shared interest, something they mentioned. Open with genuine curiosity. Never mention your program. Never pitch. Just start a real human conversation.",

    "gather-intel": "ASK 1-2 targeted questions to understand their situation. Learn: what kind of coaching they do, where they're stuck, how long they've been at it. LISTEN MODE — do not offer solutions or hint at your program yet. Make them feel heard.",

    "share-authority": "BUILD TRUST through your story. Share something personal, vulnerable, and real — a moment you struggled, a breakthrough you had, a result you achieved. Make them feel you've walked their path. NO pitching — pure human connection.",

    "frame-outcome": "HELP THEM SEE THE GAP. Guide them toward defining their dream outcome. Ask what their business would look like if everything worked. Make the distance between where they are and where they want to be feel real and worth solving.",

    "offer-call": "INVITE THEM TO A CALL. Frame it as a free 30-minute diagnostic — you just want to understand their situation, zero pressure, no pitch. Something like: 'Let me get a clear picture of where you're at on a quick call — no pitch, just want to understand your situation.'",

    "pre-qualify": "GET REAL ON INVESTMENT. Ask directly but casually — are they serious about making a change? If the fit is right, can they invest? You only work with people who are committed. Be warm but honest — this saves both of you time.",

    "send-calendly": "THEY'RE READY. Send the Calendly link confidently. Keep it warm and direct. Tell them to pick a time and you'll see them there. No over-explaining. Short, energetic, done.",

    "nurture-free": "THEY'RE NOT READY — and that's fine. Point them toward free resources: your Skool community, your content, your free trainings. Stay warm. Keep the door wide open. Plant seeds for when the time is right.",
};

// ─── BUILD DM REPLY SYSTEM PROMPT ────────────────────────────────────────────
// The MOTHER AI equivalent for DMs: uses classified tags to create a
// stage-aware, tone-specific system prompt for each individual conversation.

function buildDMReplySystemPrompt(tags) {
    var stageInstruction = tags.dm_stage ?
        (DM_STAGE_INSTRUCTIONS[tags.dm_stage] || "Continue the conversation naturally.") :
        "This is a non-sales conversation. Be warm, natural, and human.";

    return [
        "You are Jack Walford, appointment setter for Answer 42 and Self-Improvement Nation on Skool.",
        "",
        "Your mentor and CEO is Scott Northwolf. You funnel qualified leads to book calls with him.",
        "",
        "VOICE: Brotherhood energy. Raw, direct, high-energy. Never corporate. Speak like a man who's been through darkness and found the light. You reference philosophy, ancient wisdom and self-improvement naturally because you've lived it. Short punchy sentences. No bullet points, no dashes.",
        "",
        "RULES: Never be needy. Never overexplain. Never use dashes or bullet formatting in messages. Create intrigue. You don't need them, they need what you have. Be the sun, not the chaser.",
        "",
        "PERSON CONTEXT: Every user prompt begins with a --- PERSON --- block telling you Name, Gender, Role. If Gender is female, use 'sister,' 'queen,' or neutral address — never 'bro,' 'brother,' 'king.' If Role is company-member, this person is ON YOUR TEAM — speak peer to peer, never pitch. If Role is lead, they are a prospect.",
        "",
        "MULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting \u27e8BUBBLE\u27e9 between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use \u27e8BUBBLE\u27e9 in post/comment replies — only in DMs.",
        "WORKFLOW STAGE: " + (tags.dm_stage || "non-sales") + " — " + stageInstruction,
        "STAGE: " + tags.sales_stage,
        "INTENT: " + tags.intent,
        "TONE: " + tags.tone_tags.join(", "),
        "SITUATION: Replying to a Skool DM.",
        "",
        "IMPORTANT: If the message genuinely does not deserve a reply — e.g. it's a one-word reaction ('lol', 'ok', '👍'), a low-effort meme with no question, pure spam, or the conversation has naturally closed — output exactly this and nothing else: [NO_REPLY]",
        "Only use [NO_REPLY] when a real human would leave it on read. When in doubt, reply.",
    ].join("\n");
}

function buildDMReplySystemPromptV2(tags, context) {
    context = context || {};

    var stageInstruction = tags.dm_stage ?
        (DM_STAGE_INSTRUCTIONS[tags.dm_stage] || "Continue the conversation naturally.") :
        "This is a non-sales conversation. Be warm, natural, and human.";
    var partnerName = context.partnerName || "this person";
    var gender = context.gender || "unknown";
    var role = context.role || "lead (prospect)";
    var interactionHistoryText = context.interactionHistoryText || "No prior interactions available.";

    return [
        "You are Jack Walford, appointment setter for Answer 42 and Self-Improvement Nation on Skool.",
        "",
        "Your mentor and CEO is Scott Northwolf. You funnel qualified leads to book calls with him.",
        "",
        "VOICE: Brotherhood energy. Raw, direct, high-energy. Never corporate. Speak like a man who's been through darkness and found the light. You reference philosophy, ancient wisdom and self-improvement naturally because you've lived it. Short punchy sentences. No bullet points, no dashes.",
        "",
        "RULES: Never be needy. Never overexplain. Never use dashes or bullet formatting in messages. Create intrigue. You don't need them, they need what you have. Be the sun, not the chaser.",
        "",
        "PERSON CONTEXT: You are replying to " + partnerName + ". Gender: " + gender + ". Role: " + role + ". If gender is female, use 'sister,' 'queen,' or neutral address, never 'bro,' 'brother,' or 'king.' If role is company-member, this person is on your team, so speak peer to peer and never pitch. If role is lead, they are a prospect.",
        "",
        "MULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting \u27e8BUBBLE\u27e9 between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use \u27e8BUBBLE\u27e9 in post/comment replies, only in DMs.",
        "WORKFLOW STAGE: " + (tags.dm_stage || "non-sales") + " - " + stageInstruction,
        "STAGE: " + tags.sales_stage,
        "INTENT: " + tags.intent,
        "TONE: " + tags.tone_tags.join(", "),
        "SITUATION: Replying to a Skool DM.",
        "",
        "Here are all the interactions you have had with " + partnerName + " so far:",
        interactionHistoryText,
        "Respond to the below DM.",
        "",
        "IMPORTANT: If the message genuinely does not deserve a reply - for example, it's a one-word reaction ('lol', 'ok', 'thumbs up'), a low-effort meme with no question, pure spam, or the conversation has naturally closed - output exactly this and nothing else: [NO_REPLY]",
        "Only use [NO_REPLY] when a real human would leave it on read. When in doubt, reply.",
    ].join("\n");
}

// ─── GENERATE DM REPLY — MOTHER AI PIPELINE ──────────────────────────────────
// 1. Classify the conversation  → dm_stage, tone_tags, intent, sales_stage
// 2. Build tag-aware system prompt  → stage-specific instructions
// 3. Generate reply via fine-tuned model
// 4. Log everything to session log for review

async function generateDMReply(partnerName, messages, persons, botName) {
    console.log("    Classifying conversation with " + partnerName + "...");

    // ── Step 1: Classify ──────────────────────────────────────────────────────
    var tags = await classifyDM(partnerName, messages);
    console.log("    Tags → stage:" + (tags.dm_stage || "null") +
        " | intent:" + tags.intent +
        " | sales:" + tags.sales_stage +
        " | tone:" + tags.tone_tags.join(",") +
        " | gender:" + (tags.gender || "unknown"));
    console.log("    Reasoning: " + tags.reasoning);

    // ── Step 2: Resolve gender and role ──────────────────────────────────────
    var gender = (tags.gender && tags.gender !== "unknown") ? tags.gender : guessGender(partnerName);
    if (persons) personsDb.setPersonGender(persons, partnerName, gender);
    var role = (persons && personsDb.isCompanyMember(persons, partnerName))
        ? "company-member (" + personsDb.getCompanyRole(persons, partnerName) + ")"
        : "lead (prospect)";

    // ── Step 3: Build v6-format user prompt ──────────────────────────────────
    var dbHistory  = (persons ? personsDb.getPersonHistory(persons, partnerName) : []);
    var interactionHistoryText = promptBuilders.buildDMInteractionHistory(
        partnerName,
        dbHistory,
        messages,
        botName || "Jack Walford"
    );
    var userMessage = promptBuilders.buildDMUserPrompt(
        partnerName, dbHistory, messages, botName || "Jack Walford", gender, role
    );

    // ── Step 4: Build system prompt ───────────────────────────────────────────
    var systemPrompt = buildDMReplySystemPromptV2(tags, {
        partnerName: partnerName,
        gender: gender,
        role: role,
        interactionHistoryText: interactionHistoryText,
    });

    // ── Step 5: Generate reply ────────────────────────────────────────────────
    console.log("    " + "─".repeat(50));
    console.log("    SYSTEM PROMPT:");
    console.log(systemPrompt.split("\n").map(function(l){ return "      " + l; }).join("\n"));
    console.log("    USER MESSAGE:");
    console.log(userMessage.split("\n").map(function(l){ return "      " + l; }).join("\n"));
    console.log("    " + "─".repeat(50));
    console.log("    Generating reply (" + messages.length + " messages in context)...");
    var model = process.env.OPENAI_MODEL || "gpt-4o";
    var completion = await openai.chat.completions.create({
        model: model,
        max_tokens: 300,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userMessage },
        ],
    });
    var replyText = completion.choices[0].message.content.trim();

    // ── Step 6: Log (session file) ────────────────────────────────────────────
    sessionLog.addEntry({
        type: "dm",
        partnerName: partnerName,
        tags: tags,
        conversation: messages.slice(-6).map(function(m) {
            return { role: m.role, text: m.text };
        }),
        reply: replyText,
    });

    // ── Step 7: Append to persistent fine-tuning training log ─────────────────
    trainingLog.appendDMEntry({
        partner:      partnerName,
        conversation: messages.map(function(m) {
            return { role: m.role, author: m.role === 'bot' ? (botName || 'Jack Walford') : partnerName, text: m.text };
        }),
        classifierSystemPrompt: dmClassifier.SYSTEM_PROMPT,
        classifierUserMessage:  dmClassifier.buildUserPrompt(partnerName, messages),
        tags:     tags,
        generationSystemPrompt: systemPrompt,
        generationUserMessage:  userMessage,
        model:    model,
        reply:    replyText,
        sent:     true,
    });

    return replyText;
}

// ─── SINGLE POLL: check for unreads and reply ────────────

async function pollAndReply(page, botName, convState, persons) {
    var handled = 0;

    // Make sure we're on Skool
    var currentUrl = page.url();
    if (!currentUrl.includes('skool.com') || currentUrl.includes('login')) {
        await page.goto("https://www.skool.com", { waitUntil: "domcontentloaded" });
        await sleep(2000);
    }

    // Dismiss any open dropdowns/overlays before touching the UI
    await dismissOverlays(page);

    // Open chat panel and wait for conversation list to actually render
    var chatOpened = await openChatPanel(page);
    if (!chatOpened) {
        console.log("    Could not find chat icon — skipping poll");
        return 0;
    }
    try {
        await page.waitForSelector('[class*="MessageContent"]', { timeout: 8000 });
    } catch (e) { /* no conversations visible — getConversationList will return empty */ }
    await sleep(300);

    // Get ALL conversations — reply to any that have a new message since we last handled them.
    var convList = await getConversationList(page, botName);
    var pendingConvs = convList.conversations.filter(function(c) {
        if (!c.name || c.name.trim().length <= 1) return false; // no real name
        return hasNewMessage(convState, c.name, c.lastMsg);
    });

    // Cap replies per poll — don't blast everyone at once, pick the most recent
    if (pendingConvs.length > CONFIG.maxRepliesPerPoll) {
        console.log("  " + pendingConvs.length + " pending — capping at " + CONFIG.maxRepliesPerPoll + " this poll");
        pendingConvs = pendingConvs.slice(0, CONFIG.maxRepliesPerPoll);
    }

    if (pendingConvs.length === 0) {
        // Close chat panel silently
        await closeChatPanel(page);
        return 0;
    }

    console.log("  " + pendingConvs.length + " conversation(s) to check: " +
        pendingConvs.map(function(c) { return c.name; }).join(", "));

    for (var di = 0; di < pendingConvs.length; di++) {
        var targetConv = pendingConvs[di];

        // For 2nd+ conversation, close and reopen chat panel for fresh DOM
        if (di > 0) {
            await closeChatPanel(page);
            var reopened = await openChatPanel(page);
            if (!reopened) {
                console.log("    Could not reopen chat panel — stopping");
                break;
            }
            // Wait for the conversation list to actually render before scanning
            try {
                await page.waitForSelector('[class*="MessageContent"]', { timeout: 10000 });
            } catch (e) { /* panel open but empty — handled below */ }
            await sleep(500);

            // Re-scan and find by name (normalized: trimmed + lowercase)
            var freshList = await getConversationList(page, botName);
            var freshConv = null;
            var targetNorm = targetConv.name.trim().toLowerCase();
            for (var fi = 0; fi < freshList.conversations.length; fi++) {
                var n = (freshList.conversations[fi].name || '').trim().toLowerCase();
                if (n === targetNorm) {
                    freshConv = freshList.conversations[fi];
                    break;
                }
            }
            if (!freshConv) {
                var foundNames = freshList.conversations.map(function(c) { return c.name; }).join(', ');
                console.log("    " + targetConv.name + " not found — list has: [" + foundNames + "] — proceeding with original position");
                // Don't skip — fall through with original targetConv index
            } else {
                targetConv = freshConv;
            }
        }

        // Random reply delay (0s – 60s) — keep the panel open while we wait.
        // Closing and reopening causes the DM list DOM to be empty for 10+ seconds.
        var replyDelay = randomBetween(CONFIG.replyDelayMinMs, CONFIG.replyDelayMaxMs);
        if (replyDelay > 1000) {
            console.log("    Waiting " + formatMs(replyDelay) + " before replying to " + targetConv.name + "...");
            await sleep(replyDelay);
        }

        // Click into conversation
        var clicked = await clickConversation(page, targetConv.index);
        if (!clicked) {
            console.log("    Could not click conversation with " + targetConv.name + " — skipping");
            continue;
        }
        await sleep(2500);

        // Read full conversation — retry once with longer wait if no bubbles found
        var convInfo = await readFullConversation(page, botName);
        if (convInfo.messages.length === 0 && (!convInfo.debugInfo || !convInfo.debugInfo[0] || convInfo.debugInfo[0].bubbleCount === 0)) {
            console.log("    [" + (convInfo.partner || targetConv.name) + "] No bubbles on first read — waiting 3s and retrying...");
            await sleep(3000);
            convInfo = await readFullConversation(page, botName);
        }
        var partner = convInfo.partner || targetConv.name;

        // ── Debug: print sender-detection info ────────────────────────────────
        if (convInfo.debugInfo && convInfo.debugInfo.length > 0) {
            var selectorInfo = convInfo.debugInfo[0];
            if (selectorInfo.error) {
                console.log("    [" + partner + "] WARN: " + selectorInfo.error);
            } else {
                console.log("    [" + partner + "] selector:" + selectorInfo.selector +
                    " bubbles:" + selectorInfo.bubbleCount +
                    " partner:'" + selectorInfo.partner + "'");
            }
            for (var dbg = 1; dbg < convInfo.debugInfo.length; dbg++) {
                var d = convInfo.debugInfo[dbg];
                console.log("      bubble[" + d.idx + "] role:" + d.role +
                    " name:'" + (d.foundName || '?') + "'" +
                    " text:" + d.text);
            }
        }
        console.log("    [" + partner + "] " + convInfo.messages.length + " messages, last sender: " + (convInfo.lastSender || "unknown"));

        if (convInfo.lastSender === 'bot') {
            console.log("    [" + partner + "] Last message is ours — no reply needed");
            markHandled(convState, targetConv.name, {
                lastPreview:    targetConv.lastMsg,
                lastPartnerMsg: targetConv.lastMsg,
                lastReplyText:  '',
            });
            saveState(convState);

        } else if (convInfo.lastSender === 'partner' && convInfo.messages.length > 0) {
            var lastPartnerMsg = convInfo.messages[convInfo.messages.length - 1].text;
            console.log("    [" + partner + "] Their last msg: " + lastPartnerMsg.substring(0, 80));

            // ── Reading pause: simulate reading the message before responding ──
            var readMs = Math.min(4000, 1200 + lastPartnerMsg.length * 15) + randomBetween(0, 1500);
            console.log("    [" + partner + "] Reading for " + formatMs(readMs) + "...");
            await sleep(readMs);

            // Generate reply
            var dmReply = await generateDMReply(partner, convInfo.messages, persons, botName);

            // Model decided this doesn't warrant a reply
            if (dmReply.trim() === '[NO_REPLY]') {
                console.log("    [" + partner + "] Leaving on read (model decided no reply needed)");
                markHandled(convState, targetConv.name, {
                    lastPreview:    targetConv.lastMsg,
                    lastPartnerMsg: lastPartnerMsg,
                    lastReplyText:  '[NO_REPLY]',
                });
                saveState(convState);
                continue;
            }

            console.log("    " + "─".repeat(40));
            console.log("    REPLY TO " + partner + ":");
            console.log("    " + dmReply);
            console.log("    " + "─".repeat(40));

            // Find the chat input
            var dmInput = await page.$(
                'textarea[placeholder*="Message"], ' +
                '[class*="ChatTextArea"] textarea, ' +
                '[class*="ChatInput"] textarea, ' +
                '[class*="Chat"] [contenteditable="true"], ' +
                '[class*="chat"] [contenteditable="true"]'
            );
            if (dmInput) {
                // ── BUBBLE-AWARE SEND ──────────────────────────────────
                // The model may emit multiple bubbles separated by ⟨BUBBLE⟩.
                // We type + Enter each bubble as a distinct message, with a
                // human-variable pause between them that scales with the
                // NEXT bubble's length (reading + thinking + typing prep).
                var bubbles = splitBubbles(dmReply);
                if (bubbles.length === 0) bubbles = [dmReply];

                console.log("    → sending " + bubbles.length + " bubble" + (bubbles.length === 1 ? "" : "s"));

                await dmInput.click({ force: true });
                await sleep(randomBetween(200, 500)); // pause before first keystroke

                var lastSendOk = false;
                for (var bi = 0; bi < bubbles.length; bi++) {
                    var bubble = bubbles[bi];

                    // Re-focus the input each time in case Skool re-renders it after send
                    if (bi > 0) {
                        var freshInput = await page.$(
                            'textarea[placeholder*="Message"], ' +
                            '[class*="ChatTextArea"] textarea, ' +
                            '[class*="ChatInput"] textarea, ' +
                            '[class*="Chat"] [contenteditable="true"], ' +
                            '[class*="chat"] [contenteditable="true"]'
                        );
                        if (freshInput) { try { await freshInput.click({ force: true }); } catch(_){} }
                    }

                    await humanType(page, bubble);
                    await sleep(randomBetween(180, 500)); // brief pause before hitting send

                    if (CONFIG.dryRun) {
                        console.log("      [" + (bi+1) + "/" + bubbles.length + "] DRY RUN — typed: " + bubble.substring(0, 60));
                        await page.keyboard.press('Escape');
                        lastSendOk = true;
                    } else {
                        await page.keyboard.press('Enter');
                        console.log("      [" + (bi+1) + "/" + bubbles.length + "] sent: " + bubble.substring(0, 60));
                        lastSendOk = true;

                        // Inter-bubble pause — skip after the last bubble
                        if (bi < bubbles.length - 1) {
                            var delay = interBubbleDelayMs(bubbles[bi + 1]);
                            await sleep(delay);
                        }
                    }
                }

                if (!CONFIG.dryRun) {
                    // ── Verify the final message actually appeared in the conversation ──
                    await sleep(1500);
                    var verify = await readFullConversation(page, botName);
                    var lastMsg = verify.messages.length > 0 ? verify.messages[verify.messages.length - 1] : null;
                    if (lastMsg && lastMsg.role === 'bot') {
                        console.log("    ✓ Sent and confirmed (" + bubbles.length + " bubbles)!");
                    } else {
                        console.log("    ⚠ Could not confirm send — last bubble may not have gone through");
                    }
                }

                // ── Log DM exchange to persons DB ─────────────────────────
                // Log their message first, then each of Scott's bubbles.
                if (persons) {
                    var isNewDMPerson = !personsDb.personExists(persons, partner);
                    if (isNewDMPerson) {
                        console.log("    👤 [PersonsDB] First contact via DM: " + partner);
                    }
                    personsDb.addInteraction(persons, partner, {
                        type: "dm",
                        author: partner,
                        text: lastPartnerMsg,
                        sender: "person",
                        timestamp: new Date().toISOString(),
                    });
                    for (var dbl = 0; dbl < bubbles.length; dbl++) {
                        personsDb.addInteraction(persons, partner, {
                            type: "dm",
                            author: botName,
                            text: bubbles[dbl],
                            sender: "bot",
                            timestamp: new Date().toISOString(),
                        });
                    }
                }

                markHandled(convState, targetConv.name, {
                    lastPreview:    dmReply,         // preview will show our reply once it refreshes
                    lastPartnerMsg: lastPartnerMsg,  // backup: matches preview before it refreshes
                    lastReplyText:  dmReply,
                });
                saveState(convState);
                handled++;
            } else {
                console.log("    Could not find DM input box — skipping");
            }

        } else {
            console.log("    [" + partner + "] Could not read messages — muting for this session");
            markHandled(convState, targetConv.name, {
                lastPreview:    targetConv.lastMsg,
                lastPartnerMsg: targetConv.lastMsg,
                lastReplyText:  '',
            });
            saveState(convState);
        }

        // Go back to conversation list
        // Just close the panel — the next iteration's di>0 block will reopen it
        await closeChatPanel(page);
        await sleep(500);
    }

    // Close chat panel
    await closeChatPanel(page);
    return handled;
}

// ─── MAIN ─────────────────────────────────────────────────

async function main() {
    if (!CONFIG.email || !CONFIG.password) {
        console.error("Set SKOOL_EMAIL and SKOOL_PASSWORD in your .env file");
        process.exit(1);
    }

    var convState = loadState();
    var persons   = personsDb.loadPersons();
    var browser, context, page, botName;
    var cycle = 0;

    async function launchBrowser() {
        if (browser) { try { await browser.close(); } catch (e) {} }
        browser = await chromium.launch({ headless: CONFIG.headless });
        context = await browser.newContext();
        page    = await context.newPage();
        botName = await login(page);
    }

    await launchBrowser();

    while (true) {
        cycle++;

        // ── ACTIVE PERIOD ──
        var activeTime = randomBetween(CONFIG.activeMinMs, CONFIG.activeMaxMs);
        var activeEnd = Date.now() + activeTime;
        console.log("\n" + "=".repeat(55));
        console.log("CYCLE " + cycle + " — ACTIVE for " + formatMs(activeTime));
        console.log("=".repeat(55));

        var totalHandled = 0;
        var pollCount = 0;

        while (Date.now() < activeEnd) {
            pollCount++;
            var remaining = activeEnd - Date.now();
            var ts = new Date().toLocaleTimeString();
            console.log("\n[" + ts + "] Poll #" + pollCount + " (" + formatMs(remaining) + " left in active period)");

            try {
                var handled = await pollAndReply(page, botName, convState, persons);
                totalHandled += handled;
                if (handled === 0 && pollCount > 1) {
                    process.stdout.write("  . no new DMs\n");
                }
            } catch (err) {
                // Detect browser/page crash and auto-recover
                if (/target closed|page crashed|context destroyed|session closed/i.test(err.message)) {
                    console.error("  Browser crash detected — relaunching in 30s...");
                    await sleep(30000);
                    try { await launchBrowser(); console.log("  Relaunched successfully"); }
                    catch (e2) { console.error("  Relaunch failed: " + e2.message); await sleep(60000); }
                } else {
                    console.error("  Error during poll: " + err.message);
                }
            }

            if (Date.now() < activeEnd) {
                await sleep(CONFIG.pollIntervalMs);
            }
        }

        console.log("\n" + "-".repeat(55));
        console.log("ACTIVE PERIOD DONE — replied to " + totalHandled + " DMs across " + pollCount + " polls");
        console.log("-".repeat(55));

        sessionLog.writeLogs();

        // ── INACTIVE PERIOD ──
        var inactiveTime = randomBetween(CONFIG.inactiveMinMs, CONFIG.inactiveMaxMs);
        console.log("\nINACTIVE for " + formatMs(inactiveTime) + "\n");
        await countdown(inactiveTime, "Sleeping");
    }
}

main().catch(function(err) {
    console.error("Fatal error:", err.message);
    process.exit(1);
});
