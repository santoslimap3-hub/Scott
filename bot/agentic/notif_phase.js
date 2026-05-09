// =============================================================================
// agentic/notif_phase.js
//
// Phase A -- Reply to notifications.
//
// Workflow:
//   1. Open the notification bell.
//   2. Filter to "X replied to your comment" notifications (per spec).
//   3. Drop items already in the dedup ledger.
//   4. For each remaining: literally CLICK the notification (so it navigates
//      and Skool marks it read), parse its text, build a candidate record.
//   5. Batch the whole list to the picker LLM. Picker returns chosen ids.
//   6. For each chosen item:
//        a. Navigate to the post.
//        b. Scrape the bot/partner thread history.
//        c. Call the replier LLM with snippet + fixed-instruction + history.
//        d. Post the reply (skipped in DRY_RUN).
//        e. Mark dedup.
//
// Verbose stdout logging at every step.
// =============================================================================

"use strict";

const browser = require("../skool_browser");
const dedup   = require("./dedup");
const { callPicker, callWriter } = require("./anthropic_client");

// ---- Helpers ---------------------------------------------------------------

function bar(char, n) { return new Array((n || 78) + 1).join(char || "-"); }

function step(label) {
    console.log("\n" + bar("─") + "\n[Phase A] " + label + "\n" + bar("─"));
}

function info(msg) { console.log("  " + msg); }

function isReplyNotif(text, matchTerms) {
    var lower = (text || "").toLowerCase();
    return (matchTerms || ["replied"]).some(function(term) { return lower.indexOf(term.toLowerCase()) !== -1; });
}

function extractAuthorFromNotifText(text) {
    // Skool decorates names with status emojis (🔥, 💎, 👑, ⭐ etc.) sitting
    // directly between the name and the verb -- "Jack Shiller🔥 mentioned".
    // Strip those decorative symbols before matching, otherwise the
    // \s+verb anchor in the regex never finds whitespace and we return
    // "Unknown" for every decorated user.
    var clean = (text || "")
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu, "")
        .replace(/[‍️]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    var m = clean.match(/^([A-Z][a-zA-ZÀ-ÿ''-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'.''-]+){0,2})\s+(?:replied|commented|mentioned|liked|reacted)/);
    return m ? m[1].trim() : "";
}

// Extract just the partner's reply text from a notification snippet.
// Notification dropdown text looks like:
//   'Jeremiah Bergeron🔥 mentioned you in reply • 2d@Pedro Lima Actually reminds me of...'
//   'Paul Galbreath mentioned you in reply • 4h@Pedro Lima Yeah my classroom is literally...'
// We want everything after the timestamp.
function extractPartnerMessageFromNotif(text) {
    if (!text) return "";
    var m = text.match(/•\s*\d+\s*[smhdwy]\b\s*(.+)$/i);
    if (m && m[1]) return m[1].trim();
    var idx = text.indexOf("•");
    if (idx !== -1) {
        var after = text.substring(idx + 1).trim().replace(/^\d+\s*[smhdwy]\s*/i, "");
        return after.trim();
    }
    return text.trim();
}

// Build the @-mention patterns the partner would use when replying to us.
// Skool auto-prepends "@<full display name>" when you click Reply, so a
// partner message that mentions us by name is reliably a reply to us
// (and not a reply to one of seven other people in the same thread).
function botMentionPatterns(allBotNames) {
    var pats = [];
    (allBotNames || []).forEach(function(n) {
        if (!n) return;
        pats.push(n);
        var first = n.split(/\s+/)[0];
        if (first && first !== n) pats.push(first);
    });
    return pats;
}

// Reduce the scraped thread to only the messages that are actually part of
// the bot ↔ partner exchange. Drop partner replies aimed at other people.
function filterHistoryToExchange(history, allBotNames) {
    var pats = botMentionPatterns(allBotNames).map(function(p) { return ("@" + p).toLowerCase(); });
    var filtered = (history || []).filter(function(h) {
        if (h.isBot) return true;  // bot's own comments form the other half
        var lc = (h.text || "").toLowerCase();
        return pats.some(function(p) { return lc.indexOf(p) !== -1; });
    });
    // Safety net: if filtering wiped out all partner messages but they did
    // exist, fall back to the full scrape so the LLM at least sees something.
    var partnerHits = filtered.filter(function(h) { return !h.isBot; }).length;
    if (partnerHits === 0 && (history || []).some(function(h) { return !h.isBot; })) {
        return history;
    }
    return filtered;
}

// ---- Phase A ---------------------------------------------------------------

async function runNotifPhase(page, ctx) {
    var config       = ctx.config;
    var dryRun       = !!ctx.dryRun;
    var botName      = ctx.botName;
    var botAltNames  = (process.env.BOT_ALT_NAMES || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    var allBotNames  = [botName].concat(botAltNames).filter(Boolean);
    var communityUrl = ctx.communityUrl;
    var matchTerms   = config.runtime.notification_match_terms || ["replied"];
    var modelName    = config.runtime.anthropic_model;
    var cap          = config.runtime.max_picks_per_phase;

    console.log("\n" + bar("=") + "\nPHASE A -- NOTIFICATION REPLY" + (dryRun ? "  [DRY RUN]" : "") + "\n" + bar("="));
    info("Bot identity names: " + JSON.stringify(allBotNames));
    info("Notification match terms: " + JSON.stringify(matchTerms));
    info("Model: " + modelName + " | Pick cap: " + (cap == null ? "none" : cap));

    // ---- Step 1: Open community + bell ------------------------------------
    step("Step 1 -- navigating to community + opening notification bell");
    await page.goto(communityUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await browser.sleep(3000);

    var hasUnread = await browser.hasUnreadNotifications(page);
    info("Unread notifications present? " + hasUnread);

    var opened = await browser.clickNotificationBell(page);
    if (!opened) {
        info("Could not open notification bell -- exiting Phase A");
        return;
    }
    await browser.sleep(1500);

    // ---- Step 2: Read items + filter to replies ---------------------------
    step("Step 2 -- reading notification items + filtering to replies");
    var rawItems = await browser.getNotificationItems(page);
    info("Total notification items in dropdown: " + rawItems.length);

    var replyItems = [];
    var droppedItems = [];
    for (var ri = 0; ri < rawItems.length; ri++) {
        var raw = rawItems[ri];
        if (!raw.href) { droppedItems.push({ reason: "no-href", text: raw.text || "" }); continue; }
        if (isReplyNotif(raw.text, matchTerms)) replyItems.push(raw);
        else droppedItems.push({ reason: "no-match", text: raw.text || "" });
    }
    info("After filter (" + matchTerms.join("/") + "): " + replyItems.length);
    if (droppedItems.length > 0) {
        info("Dropped " + droppedItems.length + " notification(s) that did not match the filter:");
        droppedItems.forEach(function(d, i) {
            console.log("    [" + (i + 1) + "] [" + d.reason + "] " + (d.text || "").substring(0, 110));
        });
    }

    // ---- Step 3: Drop dedup hits ------------------------------------------
    step("Step 3 -- dropping notifications already in dedup ledger");
    var ledger = dedup.load();
    var fresh = [];
    for (var r = 0; r < replyItems.length; r++) {
        var it = replyItems[r];
        var author = extractAuthorFromNotifText(it.text);
        if (dedup.alreadyRepliedToNotif(ledger, it.href, author, it.text)) {
            info("[dedup-skip] " + author + " :: " + (it.text || "").substring(0, 60));
            continue;
        }
        fresh.push({ item: it, author: author });
    }
    info("Notifications surviving dedup: " + fresh.length);

    if (fresh.length === 0) {
        info("Nothing to do in Phase A this cycle.");
        await browser.markNotificationsRead(page);
        return;
    }

    // ---- Step 4: Click each + collect candidate text ----------------------
    // Per spec, we literally click each notification (so it navigates and Skool
    // marks it read). While we're on the post page we ALSO scrape the partner's
    // most recent comment so the picker sees the full reply text, not the
    // truncated "..." dropdown preview Skool gives us.
    step("Step 4 -- clicking each surviving notification (per spec) + scraping full reply text");
    var candidates = [];
    for (var c = 0; c < fresh.length; c++) {
        var rec = fresh[c];
        var id  = "notif_" + (c + 1);
        info("[" + id + "] Clicking notification: " + (rec.item.text || "").substring(0, 80));
        var landedUrl   = null;
        var fullReply   = "";
        try {
            // Re-open the bell each time -- clicking navigates away and closes the dropdown.
            if (c > 0) {
                await page.goto(communityUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                await browser.sleep(1500);
                await browser.clickNotificationBell(page);
                await browser.sleep(1200);
            }
            landedUrl = await browser.clickNotificationItem(page, rec.item);
            info("  -> landed on: " + landedUrl);

            // Now scrape the partner's most recent comment from the post page.
            // The dropdown only gave us a "..." truncated preview; the real
            // reply text lives in the comment thread.
            if (rec.author && rec.author !== "Unknown") {
                try {
                    await browser.sleep(1500);  // settle for comments to render
                    var history = await browser.scrapeThreadHistoryWith(page, rec.author, allBotNames);
                    var partnerMsgs = (history || []).filter(function(h) { return h.isPartner; });
                    if (partnerMsgs.length > 0) {
                        // Prefer the most recent partner message that actually
                        // @-mentions the bot (i.e. is replying TO us, not to
                        // one of seven other people in the same thread).
                        var pats = botMentionPatterns(allBotNames).map(function(p) { return ("@" + p).toLowerCase(); });
                        var atUs = partnerMsgs.filter(function(h) {
                            var lc = (h.text || "").toLowerCase();
                            return pats.some(function(p) { return lc.indexOf(p) !== -1; });
                        });
                        var pick = atUs.length > 0 ? atUs[atUs.length - 1] : partnerMsgs[partnerMsgs.length - 1];
                        fullReply = (pick.text || "").trim();
                        info("  -> scraped reply text (" + fullReply.length + " chars" + (atUs.length > 0 ? ", @-mention match" : ", DOM-order fallback") + "): " + fullReply.substring(0, 120) + (fullReply.length > 120 ? "..." : ""));
                    } else {
                        info("  [warn] no partner messages found on post page -- falling back to dropdown snippet");
                    }
                } catch (scrapeErr) {
                    info("  [warn] thread-history scrape failed: " + scrapeErr.message);
                }
            } else {
                info("  [warn] author unknown -- skipping thread-history scrape, using dropdown snippet");
            }
        } catch (e) {
            info("  [warn] click failed: " + e.message);
            landedUrl = rec.item.href;
        }

        candidates.push({
            id:           id,
            href:         (landedUrl || rec.item.href || "").split("?")[0],
            author:       rec.author || "Unknown",
            notification: rec.item.text || "",   // dropdown header (truncated by Skool)
            reply_text:   fullReply || (rec.item.text || ""),  // full text from post page (or fallback)
        });
    }

    // ---- Step 5: Picker LLM call ------------------------------------------
    step("Step 5 -- calling picker LLM to choose which to reply to");

    var pickerUserPrompt = (config.notif_picker.snippet ? (config.notif_picker.snippet + "\n\n") : "")
        + "Here are all the notifications of people who have replied to you, choose wich ones to reply to.\n\n"
        + JSON.stringify(candidates.map(function(c) {
            return {
                id:           c.id,
                author:       c.author,
                notification: c.notification,
                reply_text:   c.reply_text,
            };
        }), null, 2);

    var pick = await callPicker({
        label:        "notif_picker",
        model:        modelName,
        system:       config.notif_picker.system,
        user:         pickerUserPrompt,
        candidateIds: candidates.map(function(c) { return c.id; }),
    });

    var chosenIds = pick.chosen_ids || [];
    if (cap != null && chosenIds.length > cap) {
        info("[cap] Picker returned " + chosenIds.length + " ids; trimming to cap=" + cap);
        chosenIds = chosenIds.slice(0, cap);
    }
    info("Chosen notif ids: " + JSON.stringify(chosenIds));

    var byId = {};
    candidates.forEach(function(c) { byId[c.id] = c; });
    var chosenCandidates = chosenIds.map(function(id) { return byId[id]; }).filter(Boolean);

    // ---- Step 6: Reply to each chosen one ---------------------------------
    for (var k = 0; k < chosenCandidates.length; k++) {
        var cand = chosenCandidates[k];
        step("Step 6." + (k + 1) + " of " + chosenCandidates.length + " -- replying to " + cand.author);

        // Belt-and-braces dedup re-check (use the same key fields as Step 3
        // so the check matches what was stored on the previous run).
        if (dedup.alreadyRepliedToNotif(ledger, cand.href, cand.author, cand.notification)) {
            info("[dedup-skip] Already replied since picker call -- skipping");
            continue;
        }

        try {
            // Navigate to the post page (re-open in case we're elsewhere)
            await page.goto(cand.href, { waitUntil: "domcontentloaded", timeout: 30000 });
            await browser.sleep(2500);

            // Scrape thread history
            info("Scraping thread history with " + cand.author + " ...");
            var rawHistory = await browser.scrapeThreadHistoryWith(page, cand.author, allBotNames);
            // Trim out partner replies that were directed at other people in
            // the same thread -- only keep the bot ↔ partner exchange.
            var history = filterHistoryToExchange(rawHistory, allBotNames);
            info("Thread messages collected: " + rawHistory.length + " raw -> " + history.length + " kept (bot + @-mentions)");
            history.forEach(function(h, i) {
                console.log("    [" + (i + 1) + "] " + (h.isBot ? "[BOT] " : "[" + cand.author + "] ") + (h.text || "").substring(0, 140));
            });

            // Determine the partner's most recent message (the one that
            // triggered the notification). Prefer the full text scraped in
            // Step 4; fall back to extracting the message portion out of the
            // notification dropdown snippet ('• 2d@Pedro Lima Actually...').
            var partnerLatest = "";
            var step4Scraped = cand.reply_text && cand.reply_text !== cand.notification;
            if (step4Scraped) {
                partnerLatest = (cand.reply_text || "").trim();
            } else {
                partnerLatest = extractPartnerMessageFromNotif(cand.notification || cand.reply_text || "");
            }

            // Format history for the LLM. ALWAYS include the partner's
            // latest message explicitly -- if Step 4 + the in-page scrape
            // both fail, the LLM still needs to know what it's replying to.
            var historyBlock;
            if (history.length > 0) {
                historyBlock = "Conversation so far in this thread between you and " + cand.author + ":\n\n"
                    + history.map(function(h) {
                        var who = h.isBot ? "You" : cand.author;
                        return who + ": " + h.text;
                    }).join("\n\n");
            } else {
                historyBlock = "(prior thread history could not be scraped from the page -- only the message that triggered the notification is shown below)";
            }

            var replierUserPrompt = (config.notif_replier.snippet ? (config.notif_replier.snippet + "\n\n") : "")
                + "You are replying to a comment from " + cand.author + " in a Skool thread.\n\n"
                + historyBlock + "\n\n"
                + cand.author + "'s latest message (the one you must reply to):\n"
                + (partnerLatest || "(text could not be captured)") + "\n\n"
                + "Now write your reply to " + cand.author + ".";

            info("Partner latest message (" + (step4Scraped ? "from page" : "from notif snippet") + "): " + partnerLatest.substring(0, 160) + (partnerLatest.length > 160 ? "..." : ""));

            var replyText = await callWriter({
                label:     "notif_replier (" + cand.author + ")",
                model:     modelName,
                system:    config.notif_replier.system,
                user:      replierUserPrompt,
                maxTokens: 800,
            });

            if (!replyText) {
                info("[warn] Empty reply from LLM -- skipping post");
                continue;
            }

            if (dryRun) {
                info("[DRY RUN] would post the following reply (NOT submitted):");
                console.log("    " + replyText.split("\n").join("\n    "));
            } else {
                info("Posting reply ...");
                await browser.typeCommentReply(page, { author: cand.author, text: cand.reply_text || cand.notification || "" }, replyText);
                await browser.submitReply(page, { inlineTarget: true });
                info("Reply submitted.");
            }

            // Only mark dedup on real submissions. Dry-run iterations should
            // be re-runnable against the same notifications without skipping.
            if (dryRun) {
                info("[DRY RUN] dedup NOT marked (would have been on a real run).");
            } else {
                dedup.markNotifReplied(ledger, cand.href, cand.author, cand.notification, {
                    replyLen: replyText.length,
                });
                info("Marked dedup.");
            }

        } catch (err) {
            info("[error] " + err.message);
        }
    }

    console.log("\n" + bar("=") + "\nPHASE A complete.\n" + bar("="));
}

module.exports = { runNotifPhase };
