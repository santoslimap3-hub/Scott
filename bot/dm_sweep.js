// dm_sweep.js
// ────────────────────────────────────────────────────────────────────────────
// One DM inbox pass. Called from the unified Phase-1 inbound sweep.
//
// Self-contained — owns its chat panel plumbing, conversation reading, and
// human-typing. The legacy dm_reply.js used to do this in its own loop;
// here it's a single function the cycle calls each pass:
//
//   var result = await sweepDMs({ page, botName, persons, openai, opts });
//
// `result` is { handled: N, decisions: [...] } so the cycle can show a summary.
//
// Decision routing per AUTO_REPLY_V2_UNIFIED_PLAN.md §3 (Phase 1) and §6:
//
//   1. Read each pending conversation (last message from partner)
//   2. Pre-classifier (gpt-4o-mini) routes to REPLY | ACK | NO_REPLY
//   3. NO_REPLY  → mark handled, no message sent
//      ACK      → render ack_template verbatim, send single bubble
//      REPLY    → classify DM stage (3/4/5) → generate stage-aware reply
//                 If stage 5 + calendly green light → drop link template
//   4. Persons DB writes for every send (incl. stage promotion)
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const fs   = require("fs");
const path = require("path");

const personsDb        = require("./db/persons_db");
const classifyDM       = require("./classify/dm_classifier");
const classifyInbound  = require("./classify/pre_classifier");
const ackTemplates     = require("./ack_templates");
const calendlyGuard    = require("./calendly_guard");
const ragOutcomes      = require("./logger/rag_outcomes");
const { generateDmReply } = require("./generate_reply");
const { splitBubbles, interBubbleDelayMs } = require("./bubble");

const STATE_FILE = path.join(__dirname, "conversation_state.json");

// ── Tiny utilities ───────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function randomBetween(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function formatMs(ms) {
    var s = Math.round(ms / 1000);
    return s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s";
}

// ── Conversation state on disk ───────────────────────────────────────────────

function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        }
    } catch (_) {}
    return {};
}

function saveState(state) {
    var tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
}

function hasNewMessage(state, convName, currentPreview) {
    var s = state[convName];
    if (!s) return true;
    var prev = (currentPreview || "").substring(0, 150);
    return prev !== s.lastPreview && prev !== s.lastPartnerMsg;
}

function markHandled(state, convName, opts) {
    state[convName] = {
        lastPreview:    (opts.lastPreview    || "").substring(0, 150),
        lastPartnerMsg: (opts.lastPartnerMsg || "").substring(0, 150),
        lastReplyText:  (opts.lastReplyText  || "").substring(0, 150),
        lastRepliedAt:  Date.now(),
    };
}

// ── Overlay dismissal (Skool DropdownBackground intercepts clicks) ──────────

async function dismissOverlays(page) {
    await page.evaluate(function() {
        var sels = ['[class*="DropdownBackground"]', '[class*="Backdrop"]', '[class*="backdrop"]', '[class*="Overlay"]'];
        sels.forEach(function(sel) {
            document.querySelectorAll(sel).forEach(function(el) { el.click(); });
        });
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await sleep(250);
    await page.keyboard.press("Escape");
    await sleep(200);
    try {
        await page.waitForFunction(function() {
            return document.querySelectorAll('[class*="DropdownBackground"]').length === 0;
        }, { timeout: 3000 });
    } catch (_) {}
    await sleep(150);
}

// ── Human-like typing ────────────────────────────────────────────────────────

async function humanType(page, text) {
    for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        await page.keyboard.type(ch);

        var delay;
        if (ch === " ")              delay = randomBetween(60, 160);
        else if (/[.!?]/.test(ch))   delay = randomBetween(120, 350);
        else if (/[,;:]/.test(ch))   delay = randomBetween(80, 200);
        else                         delay = randomBetween(28, 110);

        if (Math.random() < 0.03) delay += randomBetween(600, 2200);
        await sleep(delay);

        if (Math.random() < 0.004 && i < text.length - 1) {
            var fat = "qwertyuiopasdfghjklzxcvbnm";
            await page.keyboard.type(fat[Math.floor(Math.random() * fat.length)]);
            await sleep(randomBetween(250, 700));
            await page.keyboard.press("Backspace");
            await sleep(randomBetween(80, 200));
        }
    }
}

// ── Chat panel ───────────────────────────────────────────────────────────────

async function openChatPanel(page) {
    var chatBtn = await page.$(
        '[class*="ChatNotificationsIconButton"], [class*="ChatIconWrapper"], [class*="ChatIcon"]'
    );
    if (chatBtn) {
        await chatBtn.click({ force: true });
        return true;
    }
    var navItems = await page.$$('nav button, header button, nav a, header a, [class*="Nav"] button');
    for (var i = 0; i < navItems.length; i++) {
        var cls = (await navItems[i].getAttribute("class")) || "";
        if (/chat|message/i.test(cls)) {
            await navItems[i].click({ force: true });
            return true;
        }
    }
    return false;
}

async function closeChatPanel(page) {
    await page.keyboard.press("Escape");
    await sleep(300);
    await page.keyboard.press("Escape");
    await sleep(500);
}

// ── List + read conversations ───────────────────────────────────────────────

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

        for (var k = 0; k < rows.length; k++) {
            var row = rows[k];
            var conv = { name: null, lastMsg: null, isUnread: false, index: k };

            var avatars = row.querySelectorAll('img[alt], [title]:not([title=""])');
            for (var a = 0; a < avatars.length; a++) {
                var name = (avatars[a].getAttribute("alt") || avatars[a].getAttribute("title") || "").trim();
                if (name && name !== botDisplayName && !/^\d+$/.test(name) && name.length > 1) {
                    conv.name = name;
                    break;
                }
            }
            if (!conv.name) {
                var nameLinks = row.querySelectorAll('a[href*="/@"]');
                for (var n = 0; n < nameLinks.length; n++) {
                    var t = nameLinks[n].textContent.trim();
                    if (t && !/^\d+$/.test(t) && t !== botDisplayName) { conv.name = t; break; }
                }
            }

            var msgEl = row.querySelector('[class*="MessageContent"]');
            if (msgEl) conv.lastMsg = msgEl.textContent.trim().substring(0, 150);
            if (msgEl) {
                var msgFw = parseInt(window.getComputedStyle(msgEl).fontWeight) || 0;
                if (msgFw >= 600) conv.isUnread = true;
            }
            var dot = row.querySelector('[class*="Unread"], [class*="unread"], [class*="Badge"], [class*="Dot"], [class*="Indicator"]');
            if (dot) conv.isUnread = true;

            if (conv.name) result.conversations.push(conv);
        }
        return result;
    }, botName);
}

async function clickConversation(page, targetIndex) {
    var rect = await page.evaluate(function(idx) {
        var msgEls = document.querySelectorAll('[class*="MessageContent"]');
        if (msgEls.length === 0) return null;
        var probe = msgEls[0];
        var listContainer = null;
        var parent = probe.parentElement;
        while (parent) {
            if (parent.querySelectorAll('[class*="MessageContent"]').length > 1) { listContainer = parent; break; }
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
        if (!rows[idx]) return null;
        var r = rows[idx].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, targetIndex);
    if (!rect) return false;
    await page.mouse.click(rect.x, rect.y);
    return true;
}

async function readFullConversation(page, botName) {
    return await page.evaluate(function(args) {
        var botDisplayName = args.botDisplayName;
        var result = { partner: null, messages: [], lastSender: null };

        // Resolve the partner's FULL name. Order of preference:
        //   1. Chat-header profile link  (a[href*="/@"]) — full canonical name
        //   2. Chat-header avatar alt    (img[alt])      — same alt the
        //                                                   conversation list
        //                                                   uses successfully
        //   3. Chat-header [title]        (any node)     — Skool sometimes
        //                                                   stores the name here
        //   4. Textarea placeholder       ("Message Lea") — last-resort, gives
        //                                                   only the first
        //                                                   name; matched by
        //                                                   the placeholder
        //                                                   regex below
        // Falling through to the placeholder is what caused company-member
        // detection to miss "Lea Newkirk" in earlier runs (key was "Lea").
        function pickName(value) {
            var t = (value || "").trim();
            if (!t) return null;
            if (/^\d+$/.test(t)) return null;
            if (t === botDisplayName) return null;
            if (t.length < 2 || t.length > 80) return null;
            return t;
        }

        var headerCandidates = document.querySelectorAll('[class*="ChatHeader"], [class*="ChatPanelHeader"], [class*="DMHeader"], [class*="ConversationHeader"]');
        for (var hc = 0; hc < headerCandidates.length && !result.partner; hc++) {
            var header = headerCandidates[hc];

            // 1. profile link
            var links = header.querySelectorAll('a[href*="/@"]');
            for (var h = 0; h < links.length; h++) {
                var text = pickName(links[h].textContent);
                if (text) { result.partner = text; break; }
            }
            if (result.partner) break;

            // 2. avatar alt
            var imgs = header.querySelectorAll('img[alt]');
            for (var ig = 0; ig < imgs.length; ig++) {
                var altName = pickName(imgs[ig].getAttribute("alt"));
                if (altName) { result.partner = altName; break; }
            }
            if (result.partner) break;

            // 3. [title] attribute on any descendant
            var titled = header.querySelectorAll('[title]:not([title=""])');
            for (var ti = 0; ti < titled.length; ti++) {
                var titleName = pickName(titled[ti].getAttribute("title"));
                if (titleName) { result.partner = titleName; break; }
            }
        }
        if (!result.partner) {
            var allInputs = document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]');
            for (var i = 0; i < allInputs.length; i++) {
                var ph = allInputs[i].getAttribute("placeholder") || "";
                var match = ph.match(/^Message\s+(.+)/i);
                if (match) { result.partner = match[1].trim(); break; }
            }
        }

        var msgSelectors = ['[class*="ChatBubble"]','[class*="MessageBubble"]','[class*="ChatMessage"]','[class*="MessageItem"]','[class*="MessageRow"]'];
        var bubbles = [];
        for (var s = 0; s < msgSelectors.length; s++) {
            bubbles = document.querySelectorAll(msgSelectors[s]);
            if (bubbles.length > 0) break;
        }
        if (bubbles.length === 0) return result;

        var partnerLow = result.partner ? result.partner.toLowerCase() : null;
        var lastAuthor = null;
        for (var b = 0; b < bubbles.length; b++) {
            var bubble = bubbles[b];
            var nameSelectors = ['a[href*="/@"]','[class*="UserNameText"]','[class*="AuthorName"]','[class*="SenderName"]','[class*="UserName"]','[class*="MemberName"]','[class*="DisplayName"]'];
            var foundName = null;
            for (var ns = 0; ns < nameSelectors.length; ns++) {
                var nameEl = bubble.querySelector(nameSelectors[ns]);
                if (nameEl) {
                    var nm = nameEl.textContent.trim();
                    if (nm && nm.length > 1 && nm.length < 60) { foundName = nm; break; }
                }
            }
            if (!foundName && partnerLow) {
                var rawText = bubble.textContent.trim();
                if (rawText.toLowerCase().startsWith(partnerLow)) foundName = result.partner;
            }
            var author = foundName || lastAuthor;
            if (foundName) lastAuthor = foundName;

            var role;
            if (author && partnerLow) {
                var aFW = author.toLowerCase().split(/\s+/)[0];
                var pFW = partnerLow.split(/\s+/)[0];
                role = aFW === pFW ? "partner" : "bot";
            } else if (author === botDisplayName) {
                role = "bot";
            } else {
                role = "partner";
            }

            var msgTextEl = bubble.querySelector('[class*="MessageBody"], [class*="TextContent"], p');
            var msgText = msgTextEl ? msgTextEl.textContent.trim() : bubble.textContent.trim();
            if (author && msgText.startsWith(author)) msgText = msgText.substring(author.length).trim();
            msgText = msgText.replace(/^\d+[dhms]\s*/i, "").replace(/^\d{1,2}:\d{2}\s*(am|pm)\s*/i, "").trim();

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

// ── Send a single bubble or a multi-bubble message ──────────────────────────

async function sendBubbles(page, bubbles, dryRun) {
    var dmInput = await page.$(
        'textarea[placeholder*="Message"], [class*="ChatTextArea"] textarea, [class*="ChatInput"] textarea, [class*="Chat"] [contenteditable="true"], [class*="chat"] [contenteditable="true"]'
    );
    if (!dmInput) return false;

    await dmInput.click({ force: true });
    await sleep(randomBetween(200, 500));

    for (var bi = 0; bi < bubbles.length; bi++) {
        if (bi > 0) {
            var fresh = await page.$(
                'textarea[placeholder*="Message"], [class*="ChatTextArea"] textarea, [class*="ChatInput"] textarea, [class*="Chat"] [contenteditable="true"], [class*="chat"] [contenteditable="true"]'
            );
            if (fresh) { try { await fresh.click({ force: true }); } catch(_){} }
        }
        await humanType(page, bubbles[bi]);
        await sleep(randomBetween(180, 500));

        if (dryRun) {
            console.log("      [DRY] would send: " + bubbles[bi].substring(0, 60));
            await page.keyboard.press("Escape");
        } else {
            await page.keyboard.press("Enter");
            console.log("      sent: " + bubbles[bi].substring(0, 60));
            if (bi < bubbles.length - 1) {
                await sleep(interBubbleDelayMs(bubbles[bi + 1]));
            }
        }
    }
    return true;
}

// ── Logging persons-DB DM exchanges ─────────────────────────────────────────

function logExchangeToPersons(persons, partner, partnerLastMsg, botBubbles, botName) {
    if (!persons) return;
    personsDb.addInteraction(persons, partner, {
        type: "dm",
        author: partner,
        text:   partnerLastMsg,
        sender: "person",
        timestamp: new Date().toISOString(),
    });
    for (var i = 0; i < botBubbles.length; i++) {
        personsDb.addInteraction(persons, partner, {
            type: "dm",
            author: botName,
            text:   botBubbles[i],
            sender: "bot",
            timestamp: new Date().toISOString(),
        });
    }
}

// ── DM stage helper: was a call already floated by the bot in this thread? ──

function botFloatedCallInThread(messages) {
    var pat = /(jump|hop)\s+on\s+a\s+(quick\s+)?call|hop\s+on\s+a\s+call|set\s+up\s+a\s+call|schedule\s+a\s+call|do\s+a\s+(quick\s+)?call/i;
    return (messages || []).some(function(m) {
        return m.role === "bot" && pat.test(m.text || "");
    });
}

// ── Main: one DM sweep pass ─────────────────────────────────────────────────

/**
 * @param {Object} ctx
 *   page              — Playwright page
 *   botName           — string
 *   persons           — loaded persons DB
 *   openai            — OpenAI client (used by generation)
 *   opts              — { maxReplies, dryRun, allowCalendly }
 * @returns {Promise<{ handled: number, decisions: Array }>}
 */
async function sweepDMs(ctx) {
    var page    = ctx.page;
    var botName = ctx.botName;
    var persons = ctx.persons;
    var openai  = ctx.openai;
    var opts    = ctx.opts || {};

    var maxReplies   = typeof opts.maxReplies === "number" ? opts.maxReplies : parseInt(process.env.MAX_DM_REPLIES_PER_CYCLE || "5", 10);
    var dryRun       = !!opts.dryRun;

    var convState = loadState();
    var decisions = [];
    var handled   = 0;

    // Make sure we're somewhere with chat in the nav
    var url = page.url();
    if (!url.includes("skool.com") || url.includes("login")) {
        try { await page.goto("https://www.skool.com", { waitUntil: "domcontentloaded", timeout: 30000 }); } catch (_) {}
        await sleep(2000);
    }

    await dismissOverlays(page);

    var opened = await openChatPanel(page);
    if (!opened) {
        console.log("[DM] Could not open chat panel — skipping sweep");
        return { handled: 0, decisions: [] };
    }
    try {
        await page.waitForSelector('[class*="MessageContent"]', { timeout: 8000 });
    } catch (_) { /* empty inbox is fine */ }
    await sleep(300);

    var convList = await getConversationList(page, botName);
    var pending = convList.conversations.filter(function(c) {
        if (!c.name || c.name.trim().length <= 1) return false;
        return hasNewMessage(convState, c.name, c.lastMsg);
    });

    if (pending.length > maxReplies) {
        console.log("[DM] " + pending.length + " pending — capping at " + maxReplies);
        pending = pending.slice(0, maxReplies);
    }
    if (pending.length === 0) {
        await closeChatPanel(page);
        return { handled: 0, decisions: [] };
    }

    console.log("[DM] " + pending.length + " conversation(s) to handle: " +
        pending.map(function(c) { return c.name; }).join(", "));

    for (var di = 0; di < pending.length; di++) {
        var target = pending[di];

        if (di > 0) {
            await closeChatPanel(page);
            var reopened = await openChatPanel(page);
            if (!reopened) break;
            try { await page.waitForSelector('[class*="MessageContent"]', { timeout: 10000 }); } catch (_) {}
            await sleep(500);

            // Re-find by name in case order shifted
            var fresh = await getConversationList(page, botName);
            var targetNorm = target.name.trim().toLowerCase();
            var refound = fresh.conversations.find(function(c) {
                return (c.name || "").trim().toLowerCase() === targetNorm;
            });
            if (refound) target = refound;
        }

        var clicked = await clickConversation(page, target.index);
        if (!clicked) {
            decisions.push({ partner: target.name, action: "ERROR", reason: "couldn't click" });
            continue;
        }
        await sleep(2500);

        var conv = await readFullConversation(page, botName);
        if (conv.messages.length === 0) {
            await sleep(2500);
            conv = await readFullConversation(page, botName);
        }
        // Prefer the conversation-list name (target.name, sourced from img[alt])
        // when it's MORE complete than what readFullConversation extracted —
        // i.e. when both share a first word but the list version has more
        // tokens. Otherwise prefer conv.partner (it had a chance at the header
        // selectors first). This keeps "Lea Newkirk" winning over "Lea" without
        // overriding cases where the list shows a stale name and the chat
        // header has the right one.
        var partner;
        if (target.name && conv.partner) {
            var listFirst = target.name.split(/\s+/)[0].toLowerCase();
            var convFirst = conv.partner.split(/\s+/)[0].toLowerCase();
            if (listFirst === convFirst &&
                target.name.split(/\s+/).length > conv.partner.split(/\s+/).length) {
                partner = target.name;
            } else {
                partner = conv.partner;
            }
        } else {
            partner = conv.partner || target.name;
        }

        if (conv.lastSender !== "partner" || conv.messages.length === 0) {
            markHandled(convState, target.name, {
                lastPreview: target.lastMsg, lastPartnerMsg: target.lastMsg, lastReplyText: "",
            });
            saveState(convState);
            decisions.push({ partner: partner, action: "SKIP", reason: "no partner msg" });
            await closeChatPanel(page);
            continue;
        }

        var partnerLastMsg = conv.messages[conv.messages.length - 1].text;
        var recentForPre   = conv.messages.slice(-3);

        // ── Pre-classifier: REPLY | ACK | NO_REPLY ────────────────────────────
        var pre = await classifyInbound({
            partnerName: partner,
            text:        partnerLastMsg,
            context:     "DM",
            recent:      recentForPre,
        });
        console.log("[DM/" + partner + "] pre-classifier: " + pre.action +
            (pre.ack_template ? " (" + pre.ack_template + ")" : "") +
            " — " + pre.reason);

        var bubbles = [];
        var actionTaken = pre.action;

        if (pre.action === "NO_REPLY") {
            markHandled(convState, target.name, {
                lastPreview: partnerLastMsg, lastPartnerMsg: partnerLastMsg, lastReplyText: "[NO_REPLY]",
            });
            saveState(convState);
            decisions.push({ partner: partner, action: "NO_REPLY", reason: pre.reason });
            await closeChatPanel(page);
            await sleep(500);
            continue;

        } else if (pre.action === "ACK") {
            // Bypass the LLM. Print exactly the template.
            var ackText = ackTemplates.renderAck(pre.ack_template, partnerLastMsg);
            bubbles = [ackText];
            console.log("[DM/" + partner + "] ACK → " + ackText);

        } else {
            // REPLY — run DM stage classifier and pick prompt accordingly.
            var tags = await classifyDM(partner, conv.messages);
            console.log("[DM/" + partner + "] dm_stage=" + (tags.dm_stage || "null") +
                " | sales=" + tags.sales_stage + " | intent=" + tags.intent +
                " | tone=" + (tags.tone_tags || []).join(","));

            // Calendly green-light check (only if dm_stage hints we should)
            var floated = botFloatedCallInThread(conv.messages);
            var calendlyAllowed = (tags.dm_stage === "send-calendly" || tags.dm_stage === "pre-qualify");
            var dropResult = null;
            if (calendlyAllowed) {
                dropResult = await calendlyGuard.dropLine({
                    partnerName:        partner,
                    partnerLastMessage: partnerLastMsg,
                    recent:             conv.messages.slice(-4),
                    botFloatedCall:     floated,
                    stage:              personsDb.getStage(persons, partner),
                });
                console.log("[DM/" + partner + "] calendly guard: " + (dropResult.drop ? "DROP" : "WAIT") +
                    " (" + dropResult.info.source + ": " + dropResult.info.reason + ")");
            }

            var replyText;
            var dmPayload = null;
            if (dropResult && dropResult.drop) {
                replyText = dropResult.line;
                actionTaken = "REPLY:CALENDLY";
            } else {
                // Map dm_stage to numeric stage hint for generate_reply
                var stageHint = 3;
                if (tags.dm_stage === "offer-call" || tags.dm_stage === "pre-qualify") stageHint = 4;
                if (tags.dm_stage === "send-calendly") stageHint = 4; // gated; ask one more question instead of dropping
                dmPayload = {
                    partnerName: partner,
                    messages:    conv.messages,
                    dmStage:     stageHint,
                    // The ENTIRE interaction history (posts, comments, DMs)
                    // belongs in the system prompt's PERSON HISTORY block.
                    // The user prompt is now bare ("Reply as Jack.") so we
                    // raise the cap here to fit a full DM thread without
                    // truncation. buildDmConvoUser deliberately does not
                    // re-emit any of this in the user prompt.
                    personContext: personsDb.buildPersonContext(persons, partner, { maxItems: 60 }),
                };
                replyText = await generateDmReply(openai, dmPayload, process.env.GENERATION_MODEL || process.env.OPENAI_MODEL);
                actionTaken = "REPLY:STAGE-" + stageHint;
            }

            // Record retrieved-example IDs for the outcome log
            ragOutcomes.logSend({
                channel:       "dm",
                dm_stage:      tags.dm_stage,
                intent:        tags.intent,
                sales_stage:   tags.sales_stage,
                partner:       partner,
                partner_stage: personsDb.getStage(persons, partner),
                retrieved_ids: (dmPayload && dmPayload._ragExampleIds) || [],
                reply_text:    replyText,
            });

            bubbles = splitBubbles(replyText);
            if (bubbles.length === 0) bubbles = [replyText];
        }

        // Reading pause + send
        var readMs = Math.min(4000, 1200 + partnerLastMsg.length * 15) + randomBetween(0, 1500);
        await sleep(readMs);

        var ok = await sendBubbles(page, bubbles, dryRun);
        if (!ok) {
            decisions.push({ partner: partner, action: "ERROR", reason: "no input box" });
            await closeChatPanel(page);
            continue;
        }

        if (!dryRun) {
            logExchangeToPersons(persons, partner, partnerLastMsg, bubbles, botName);
            // Stage promotions
            if (actionTaken === "REPLY:CALENDLY") {
                personsDb.setStage(persons, partner, 6, "calendly link sent");
            } else if (actionTaken && actionTaken.indexOf("REPLY") === 0) {
                personsDb.promote(persons, partner, 3, "DM exchange (sweep)");
            }
        }

        markHandled(convState, target.name, {
            lastPreview:    bubbles.join(" ").substring(0, 150),
            lastPartnerMsg: partnerLastMsg,
            lastReplyText:  bubbles.join(" "),
        });
        saveState(convState);

        decisions.push({ partner: partner, action: actionTaken, reason: pre.reason || "" });
        handled++;

        await closeChatPanel(page);
        await sleep(500);
    }

    await closeChatPanel(page);
    return { handled: handled, decisions: decisions };
}

module.exports = {
    sweepDMs:              sweepDMs,
    // Helpers exported for reuse / tests
    openChatPanel:         openChatPanel,
    closeChatPanel:        closeChatPanel,
    dismissOverlays:       dismissOverlays,
    humanType:             humanType,
    getConversationList:   getConversationList,
    clickConversation:     clickConversation,
    readFullConversation:  readFullConversation,
    sendBubbles:           sendBubbles,
    botFloatedCallInThread: botFloatedCallInThread,
    loadState:             loadState,
    saveState:             saveState,
    hasNewMessage:         hasNewMessage,
    markHandled:           markHandled,
};
