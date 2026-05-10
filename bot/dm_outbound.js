// dm_outbound.js
// ────────────────────────────────────────────────────────────────────────────
// Phase 4 — outbound DM opens, gated on stage 2 (publicly-warm).
//
// Per AUTO_REPLY_V2_UNIFIED_PLAN.md §3 / §4:
//   - Pull everyone newly promoted to stage 2 since the last cycle.
//   - Send ONE DM opener apiece (cap MAX_OUTBOUND_DM_OPENS_PER_CYCLE).
//   - The opener references the public exchange specifically.
//   - After send, the person moves to stage 3 (dm-opened).
//
// Stage 2 promotions are written by:
//   - Phase 1 notification handler (partner replied substantively or @-mentioned us)
//   - Phase 1 DM sweep (partner DM'd us first)
//   - any cycle stage that bumps a person from 1 → 2
//
// This module does NOT classify or decide who to DM — it trusts the persons DB.
// Senders use the same chat-panel plumbing dm_sweep.js owns.
// ────────────────────────────────────────────────────────────────────────────

"use strict";

const personsDb       = require("./db/persons_db");
const dmSweep         = require("./dm_sweep");
const ragOutcomes     = require("./logger/rag_outcomes");
const { generateDmOpener } = require("./generate_reply");
const { splitBubbles, interBubbleDelayMs } = require("./bubble");

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ── Find the search-and-open-DM input ───────────────────────────────────────
// The chat panel has a "New message" button or search box that lets us start
// a DM with any community member. We type the partner's name, click the
// matching result, then send the opener.

async function findNewMessageEntry(page) {
    // Look for a "+" / "New" / pencil button inside the chat panel
    var btns = await page.$$('button, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
        var aria = (await btns[i].getAttribute("aria-label") || "").toLowerCase();
        var text = ((await btns[i].textContent()) || "").trim().toLowerCase();
        if (/new\s+(message|chat|dm)|compose|start\s+chat/.test(aria + " " + text)) {
            return btns[i];
        }
    }
    return null;
}

async function snapshotForDebug(page, label) {
    try {
        var stamp = new Date().toISOString().replace(/[:.]/g, "-");
        var fname = "dm_out_debug_" + label + "_" + stamp + ".png";
        await page.screenshot({ path: fname, fullPage: false });
        console.log("    [debug] screenshot saved: " + fname);
    } catch (_) {}
}

// Returns { ok: true } on success, or { ok: false, reason: "..." } with detail.
async function startDmWith(page, partnerName) {
    var entry = await findNewMessageEntry(page);
    if (!entry) {
        await snapshotForDebug(page, "no-compose-button");
        return { ok: false, reason: "no compose button (new-message entry not found)" };
    }
    try { await entry.click({ force: true }); }
    catch (clickErr) {
        return { ok: false, reason: "compose click threw: " + clickErr.message };
    }
    await sleep(800);

    // Type the partner's name into the search box
    var input = await page.$(
        'input[placeholder*="Search"], input[placeholder*="To:"], input[type="search"], input[type="text"]'
    );
    if (!input) {
        await snapshotForDebug(page, "no-search-input");
        return { ok: false, reason: "no search input after clicking compose" };
    }
    await input.click({ force: true });
    await sleep(200);
    await page.keyboard.type(partnerName, { delay: 40 });
    await sleep(1500);

    // Click the first matching result
    var result = await page.$(
        '[class*="SearchResult"], [class*="MemberRow"], [class*="UserRow"], [class*="DropdownOption"], [class*="Suggestion"], li'
    );
    if (!result) {
        await snapshotForDebug(page, "no-search-result-" + partnerName.replace(/\s+/g, "-"));
        return { ok: false, reason: "no search result matched '" + partnerName + "'" };
    }
    try { await result.click({ force: true }); }
    catch (resultErr) {
        return { ok: false, reason: "result click threw: " + resultErr.message };
    }
    await sleep(1500);
    return { ok: true };
}

// ── Main: run one outbound-opens pass ───────────────────────────────────────

/**
 * @param {Object} ctx
 *   page         — Playwright page
 *   botName      — string
 *   persons      — loaded persons DB
 *   openai       — OpenAI client
 *   opts         — { maxOpens, dryRun, lookbackMs }
 * @returns {Promise<{ opened: number, decisions: Array }>}
 */
async function runOutboundOpens(ctx) {
    var page    = ctx.page;
    var botName = ctx.botName;
    var persons = ctx.persons;
    var openai  = ctx.openai;
    var opts    = ctx.opts || {};

    var maxOpens   = typeof opts.maxOpens === "number"
        ? opts.maxOpens
        : parseInt(process.env.MAX_OUTBOUND_DM_OPENS_PER_CYCLE || "2", 10);
    var dryRun     = !!opts.dryRun;
    var lookbackMs = typeof opts.lookbackMs === "number" ? opts.lookbackMs : (24 * 60 * 60 * 1000);

    // Find everyone newly at stage 2 in the lookback window
    var candidates = personsDb.listPromotedTo(persons, 2, lookbackMs);
    if (candidates.length === 0) {
        console.log("[DM-OUT] no stage-2 candidates in lookback window");
        return { opened: 0, decisions: [] };
    }

    candidates = candidates.slice(0, maxOpens);
    console.log("[DM-OUT] " + candidates.length + " candidate(s): " +
        candidates.map(function(c) { return c.name; }).join(", "));

    var decisions = [];
    var opened    = 0;

    // Make sure chat panel is open
    var chatOpened = await dmSweep.openChatPanel(page);
    if (!chatOpened) {
        console.log("[DM-OUT] chat panel didn't open — abort");
        return { opened: 0, decisions: [] };
    }
    try { await page.waitForSelector('[class*="MessageContent"]', { timeout: 8000 }); } catch (_) {}
    await sleep(300);

    // ── One-shot precheck: does this community even allow new DMs? ───────────
    // If there's no compose button, any LLM opener generation in the loop
    // below is wasted spend. Abort the phase here before paying any tokens.
    var composePrecheck = await findNewMessageEntry(page);
    if (!composePrecheck) {
        await snapshotForDebug(page, "no-compose-button-precheck");
        console.log("[DM-OUT] no compose button on this community — aborting Phase 4 (saves LLM cost). " +
            "Set DISABLE_OUTBOUND_DMS=true in .env to skip the precheck too.");
        var failed = candidates.map(function(c) {
            return { partner: c.name, action: "ERROR", reason: "no compose button (precheck — community doesn't allow DMs)" };
        });
        return { opened: 0, decisions: failed };
    }

    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        var partner = c.name;

        // Skip if we already DM'd them — somehow they reached stage >= 3 already
        var current = personsDb.getStage(persons, partner);
        if (current >= 3) {
            decisions.push({ partner: partner, action: "SKIP", reason: "already at stage " + current });
            continue;
        }

        // Build payload from their public history
        var history = personsDb.getPersonHistory(persons, partner);
        var ourPublicReply = "";
        var partnerPublicReply = "";
        var postTitle = "";
        var postBody = "";
        for (var h = history.length - 1; h >= 0; h--) {
            var item = history[h];
            if (!partnerPublicReply && item.type === "comment") {
                partnerPublicReply = (item.text || "").substring(0, 300);
                postTitle = item.post_title || postTitle;
            }
            if (!ourPublicReply && item.type === "scott_reply") {
                ourPublicReply = (item.text || "").substring(0, 300);
                postTitle = postTitle || item.post_title || "";
            }
            if (!postBody && item.type === "post") {
                postTitle = postTitle || item.title || "";
                postBody  = (item.body || "").substring(0, 600);
            }
            if (ourPublicReply && partnerPublicReply) break;
        }

        var openerText;
        var openerPayload = {
            partnerName:        partner,
            postTitle:          postTitle,
            postBody:           postBody,
            ourPublicReply:     ourPublicReply,
            partnerPublicReply: partnerPublicReply,
            personContext:      personsDb.buildPersonContext(persons, partner),
        };
        try {
            openerText = await generateDmOpener(openai, openerPayload, process.env.GENERATION_MODEL || process.env.OPENAI_MODEL);
        } catch (genErr) {
            decisions.push({ partner: partner, action: "ERROR", reason: "generation failed: " + genErr.message });
            continue;
        }

        var bubbles = splitBubbles(openerText);
        if (bubbles.length === 0) bubbles = [openerText];

        // Try to start the DM with this partner
        var started = await startDmWith(page, partner);
        if (!started || !started.ok) {
            var why = (started && started.reason) || "couldn't start DM (unknown failure)";
            decisions.push({ partner: partner, action: "ERROR", reason: why });
            // If the compose button doesn't exist, this community doesn't allow
            // DMs (or at least doesn't expose them to us). No point attempting
            // the rest of this cycle's candidates — they'll all hit the same wall.
            if (/no compose button/i.test(why)) {
                console.log("[DM-OUT] no compose button — aborting remaining candidates this cycle. " +
                    "Set DISABLE_OUTBOUND_DMS=true in .env to skip Phase 4 entirely.");
                break;
            }
            continue;
        }

        var sent = await dmSweep.sendBubbles(page, bubbles, dryRun);
        if (!sent) {
            decisions.push({ partner: partner, action: "ERROR", reason: "no input box on opened DM" });
            continue;
        }

        if (!dryRun) {
            // Log to persons DB and promote stage 2 → 3
            for (var b = 0; b < bubbles.length; b++) {
                personsDb.addInteraction(persons, partner, {
                    type: "dm",
                    author: botName,
                    text: bubbles[b],
                    sender: "bot",
                    timestamp: new Date().toISOString(),
                });
            }
            personsDb.promote(persons, partner, 3, "outbound DM opener sent");

            ragOutcomes.logSend({
                channel:       "dm-opener",
                dm_stage:      "general-dm",
                partner:       partner,
                partner_stage: personsDb.getStage(persons, partner),
                retrieved_ids: openerPayload._ragExampleIds || [],
                reply_text:    openerText,
            });
        }

        decisions.push({ partner: partner, action: "OPENED", bubbles: bubbles.length });
        opened++;

        // Close and reopen chat panel for the next candidate
        await dmSweep.closeChatPanel(page);
        await sleep(800);
        if (i < candidates.length - 1) {
            await dmSweep.openChatPanel(page);
            try { await page.waitForSelector('[class*="MessageContent"]', { timeout: 8000 }); } catch (_) {}
            await sleep(300);
        }
    }

    await dmSweep.closeChatPanel(page);
    return { opened: opened, decisions: decisions };
}

module.exports = {
    runOutboundOpens:    runOutboundOpens,
    findNewMessageEntry: findNewMessageEntry,
    startDmWith:         startDmWith,
};
