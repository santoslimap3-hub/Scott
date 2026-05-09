// =============================================================================
// agentic/value_phase.js
//
// Phase B -- Leave value comments.
//
// Workflow:
//   1. Scrape the last N "pages" of the community feed (config.runtime.pages_to_scrape).
//   2. Drop posts already in the dedup ledger.
//   3. Send the remaining list to the picker LLM. Picker returns chosen ids.
//   4. For each chosen post:
//        a. Open the post and pull the body.
//        b. Call the value-commenter LLM with snippet + fixed-instruction + post text.
//        c. Post the comment (skipped in DRY_RUN).
//        d. Mark dedup.
//
// Verbose stdout logging at every step.
// =============================================================================

"use strict";

const browser = require("../skool_browser");
const dedup   = require("./dedup");
const { callPicker, callWriter } = require("./anthropic_client");

function bar(char, n) { return new Array((n || 78) + 1).join(char || "-"); }

function step(label) {
    console.log("\n" + bar("─") + "\n[Phase B] " + label + "\n" + bar("─"));
}

function info(msg) { console.log("  " + msg); }

async function runValuePhase(page, ctx) {
    var config       = ctx.config;
    var dryRun       = !!ctx.dryRun;
    var botName      = ctx.botName;
    var communityUrl = ctx.communityUrl;
    var pages        = config.runtime.pages_to_scrape;
    var modelName    = config.runtime.anthropic_model;
    var cap          = config.runtime.max_picks_per_phase;

    console.log("\n" + bar("=") + "\nPHASE B -- VALUE COMMENTS" + (dryRun ? "  [DRY RUN]" : "") + "\n" + bar("="));
    info("Community: " + communityUrl);
    info("Pages to scrape: " + pages + " | Model: " + modelName + " | Pick cap: " + (cap == null ? "none" : cap));

    // ---- Step 1: Scrape feed -----------------------------------------------
    step("Step 1 -- scraping last " + pages + " pages of community feed");
    var allPosts = [];
    try {
        allPosts = await browser.scrapeFeedNPages(page, communityUrl, pages);
    } catch (e) {
        info("[error] feed scrape failed: " + e.message);
        return;
    }
    info("Posts collected: " + allPosts.length);

    if (allPosts.length === 0) {
        info("No posts found. Exiting Phase B.");
        return;
    }

    // ---- Step 2: Drop dedup hits -------------------------------------------
    step("Step 2 -- dropping posts already commented on");
    var ledger = dedup.load();
    var fresh = [];
    for (var p = 0; p < allPosts.length; p++) {
        var post = allPosts[p];
        if (dedup.alreadyCommentedOn(ledger, post.href)) {
            info("[dedup-skip] " + post.author + " :: " + (post.title || "").substring(0, 60));
            continue;
        }
        fresh.push(post);
    }
    info("Posts surviving dedup: " + fresh.length);

    if (fresh.length === 0) {
        info("Nothing to do in Phase B this cycle.");
        return;
    }

    // ---- Step 3: Picker LLM call -------------------------------------------
    step("Step 3 -- calling picker LLM to choose which posts to value-comment under");

    // Tag each post with a stable id we can pass to the picker
    var candidates = fresh.map(function(post, i) {
        return {
            id:       "post_" + (i + 1),
            author:   post.author,
            title:    post.title,
            category: post.category,
            body:     (post.body || "").substring(0, 600),
            href:     post.href,
            _post:    post,   // not sent to LLM
        };
    });

    var pickerUserPrompt = (config.value_picker.snippet ? (config.value_picker.snippet + "\n\n") : "")
        + "Here is a list of posts. Find posts by people who look like they would be a good fit for scott's program 'I take self-improvement coaches from 0 to 10k in 42 days or they don't pay' to leave value comments under.\n\n"
        + JSON.stringify(candidates.map(function(c) {
            return { id: c.id, author: c.author, category: c.category, title: c.title, body: c.body };
        }), null, 2);

    var pick = await callPicker({
        label:        "value_picker",
        model:        modelName,
        system:       config.value_picker.system,
        user:         pickerUserPrompt,
        candidateIds: candidates.map(function(c) { return c.id; }),
    });

    var chosenIds = pick.chosen_ids || [];
    if (cap != null && chosenIds.length > cap) {
        info("[cap] Picker returned " + chosenIds.length + " ids; trimming to cap=" + cap);
        chosenIds = chosenIds.slice(0, cap);
    }
    info("Chosen post ids: " + JSON.stringify(chosenIds));

    var byId = {};
    candidates.forEach(function(c) { byId[c.id] = c; });
    var chosenCandidates = chosenIds.map(function(id) { return byId[id]; }).filter(Boolean);

    // ---- Step 4: Comment on each chosen post -------------------------------
    for (var k = 0; k < chosenCandidates.length; k++) {
        var cand = chosenCandidates[k];
        step("Step 4." + (k + 1) + " of " + chosenCandidates.length + " -- value-commenting on \"" + (cand.title || "").substring(0, 50) + "\" by " + cand.author);

        if (dedup.alreadyCommentedOn(ledger, cand.href)) {
            info("[dedup-skip] Already commented since picker call -- skipping");
            continue;
        }

        try {
            var fullPost = await browser.openPostAndGetBody(page, cand._post);

            var fullBody = (fullPost.body || cand.body || "").trim() || "(empty post body)";

            var commenterUserPrompt = (config.value_commenter.snippet ? (config.value_commenter.snippet + "\n\n") : "")
                + "Here is a post/comment you chose to reply to, leave a value comment under it using the knowledge above.\n\n"
                + "Author: " + (fullPost.author || cand.author) + "\n"
                + "Title: " + (fullPost.title || cand.title) + "\n\n"
                + fullBody;

            var commentText = await callWriter({
                label:     "value_commenter (" + (fullPost.author || cand.author) + ")",
                model:     modelName,
                system:    config.value_commenter.system,
                user:      commenterUserPrompt,
                maxTokens: 800,
            });

            if (!commentText) {
                info("[warn] Empty comment from LLM -- skipping");
                continue;
            }

            if (dryRun) {
                info("[DRY RUN] would post the following value comment (NOT submitted):");
                console.log("    " + commentText.split("\n").join("\n    "));
            } else {
                // Defence: re-check for an already-posted comment by the bot on this thread
                if (await browser.alreadyCommented(page, botName)) {
                    info("[skip] Bot already has a comment on this thread (DOM check) -- marking dedup, not re-posting.");
                    dedup.markCommentLeft(ledger, cand.href, { author: fullPost.author || cand.author, dryRun: false, reason: "already-commented-dom" });
                    continue;
                }
                info("Posting value comment ...");
                await browser.typeReply(page, commentText);
                await browser.submitReply(page);
                info("Comment submitted.");
            }

            // Only mark dedup on real submissions. Dry-run iterations should
            // be re-runnable against the same posts without skipping.
            if (dryRun) {
                info("[DRY RUN] dedup NOT marked (would have been on a real run).");
            } else {
                dedup.markCommentLeft(ledger, cand.href, {
                    author:     fullPost.author || cand.author,
                    commentLen: commentText.length,
                });
                info("Marked dedup.");
            }

        } catch (err) {
            info("[error] " + err.message);
        }
    }

    console.log("\n" + bar("=") + "\nPHASE B complete.\n" + bar("="));
}

module.exports = { runValuePhase };
