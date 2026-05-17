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

const crypto  = require("crypto");
const browser = require("../skool_browser");
const dedup   = require("./dedup");
const rag     = require("./rag_picker");
const { callPicker, callWriter } = require("./anthropic_client");
const { stripAllMentions, stripMentionsAndChrome, stripSkoolCommentMeta } = require("./text_sanitizer");

// SIN_COMMUNITY_URL controls which community the RAG layer treats as "Scott's
// own community" (Self-Improvement Nation). Anything else is treated as
// external. The RAG picker uses this to filter examples so the writer only
// ever sees few-shots from the SAME side as where the bot is currently
// engaging.
const SIN_COMMUNITY_URL = (process.env.SIN_COMMUNITY_URL
    || "https://www.skool.com/self-improvement-nation").toLowerCase();

function isCommunityInSin(communityUrl) {
    if (!communityUrl) return false;
    var u = String(communityUrl).toLowerCase();
    return u.indexOf("self-improvement-nation") !== -1
        || u === SIN_COMMUNITY_URL
        || u.indexOf(SIN_COMMUNITY_URL.replace(/^https?:\/\//, "")) !== -1;
}

function bar(char, n) { return new Array((n || 78) + 1).join(char || "-"); }

function step(label) {
    console.log("\n" + bar("─") + "\n[Phase B] " + label + "\n" + bar("─"));
}

function info(msg) { console.log("  " + msg); }

// Build a synthetic dedup URL for a comment-engagement. The dedup ledger
// stores it under comments_left just like a post URL, but the synthetic shape
// (`<postHref>#cmt::<author>::<sha8(text)>`) keeps post-comment and
// reply-to-comment engagements distinct.
function commentEngagementUrl(postHref, commentAuthor, commentText) {
    var sha = crypto.createHash("sha1")
        .update(((commentText || "")).substring(0, 240), "utf8")
        .digest("hex").substring(0, 12);
    var slug = (commentAuthor || "anon")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "anon";
    return (postHref || "") + "#cmt::" + slug + "::" + sha;
}

async function runValuePhase(page, ctx) {
    var config       = ctx.config;
    var dryRun       = !!ctx.dryRun;
    var botName      = ctx.botName;
    var communityUrl = ctx.communityUrl;
    var pages        = config.runtime.pages_to_scrape;
    var modelName    = config.runtime.anthropic_model;
    var cap          = config.runtime.max_picks_per_phase;
    var commentCap   = (config.runtime.max_comment_replies_per_post != null)
        ? config.runtime.max_comment_replies_per_post : 5;

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
            body:     stripSkoolCommentMeta(stripAllMentions((post.body || "").substring(0, 600))),
            href:     post.href,
            _post:    post,   // not sent to LLM
        };
    });

    var pickerUserPrompt = (config.value_picker.snippet ? (config.value_picker.snippet + "\n\n") : "")
        + "Here is a list of posts. Find posts by people who look like they would be a good fit for scott's program 'I take self-improvement coaches from 0 to 10k in 42 days or they don't pay' to leave value comments under.\n\n"
        + JSON.stringify(candidates.map(function(c) {
            return { id: c.id, author: c.author, category: c.category, title: c.title, body: stripAllMentions(c.body) };
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

            // RAG few-shots: pull 3-5 of Scott's actual past replies that
            // resemble this situation. Community-matched: external posts only
            // surface external-community examples, etc.
            var inSin = isCommunityInSin(communityUrl);
            var ragQuery =
                "Post title: " + rag.safeTruncate(fullPost.title || cand.title || "", 300) + "\n" +
                "Post author: " + (fullPost.author || cand.author || "") + "\n" +
                "Post body:  " + rag.safeTruncate(stripSkoolCommentMeta(stripAllMentions(fullBody)), 800);
            var ragExamples = "";
            try {
                ragExamples = await rag.getExamplesBlock(ragQuery, { inSin: inSin, k: 4 });
            } catch (ragErr) {
                info("[rag] picker failed (continuing without few-shots): " + ragErr.message);
            }

            var commenterUserPrompt = (config.value_commenter.snippet ? (config.value_commenter.snippet + "\n\n") : "")
                + (ragExamples ? (ragExamples + "\n\n") : "")
                + "Here is a post/comment you chose to reply to, leave a value comment under it using the knowledge above.\n\n"
                + "Author: " + (fullPost.author || cand.author) + "\n"
                + "Title: " + (fullPost.title || cand.title) + "\n\n"
                + stripSkoolCommentMeta(stripAllMentions(fullBody));

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

            // -----------------------------------------------------------------
            // Comment pass: also reply to ICP-authored comments under this post
            // -----------------------------------------------------------------
            if (commentCap > 0) {
                try {
                    await replyToIcpCommentsUnderPost(page, {
                        post:       fullPost,
                        postHref:   cand.href,
                        ledger:     ledger,
                        botName:    botName,
                        commentCap: commentCap,
                        config:     config,
                        modelName:  modelName,
                        dryRun:     dryRun,
                    });
                } catch (commentErr) {
                    info("[comment-pass error] " + (commentErr && commentErr.message ? commentErr.message : commentErr));
                }
            }

        } catch (err) {
            info("[error] " + err.message);
        }
    }

    console.log("\n" + bar("=") + "\nPHASE B complete.\n" + bar("="));
}

// =============================================================================
// Comment pass -- search for ICP-authored comments under a chosen post and
// reply to them directly (not as a top-level value comment).
//
// Assumes we are already on the post page (openPostAndGetBody was just called)
// and that the bot's top-level value comment, if any, has already been posted.
// We re-scrape the rendered DOM for comments, run them through the picker LLM,
// and reply to each pick via typeCommentReply + submitReply.
// =============================================================================

async function replyToIcpCommentsUnderPost(page, args) {
    var post       = args.post;
    var postHref   = args.postHref;
    var ledger     = args.ledger;
    var botName    = args.botName;
    var commentCap = args.commentCap;
    var config     = args.config;
    var modelName  = args.modelName;
    var dryRun     = !!args.dryRun;

    step("Comment-pass -- scraping comments under \"" + ((post.title || "").substring(0, 50)) + "\"");

    // 1) Make sure we're on the post page (a prior submitReply call may have
    //    triggered a re-render but kept the URL stable; reloading is the
    //    safest way to get a clean DOM with all comments rendered).
    try {
        await page.goto(postHref, { waitUntil: "domcontentloaded", timeout: 30000 });
        await browser.sleep(2500);
    } catch (navErr) {
        info("[comment-pass] could not reload post page: " + navErr.message);
        return;
    }

    // 2) Scrape comments (skip bot's own + post author's self-replies).
    var comments = await browser.scrapeCommentsOnCurrentPage(page, {
        botName:    botName,
        postAuthor: post.author || "",
        maxComments: 80,
    });
    info("Comments scraped: " + comments.length);
    if (comments.length === 0) return;

    // 3) Drop comments we've already engaged with (dedup).
    var fresh = [];
    for (var i = 0; i < comments.length; i++) {
        var c = comments[i];
        var k = commentEngagementUrl(postHref, c.author, c.text);
        if (dedup.alreadyCommentedOn(ledger, k)) {
            info("[dedup-skip-comment] " + c.author + " :: " + c.text.substring(0, 50));
            continue;
        }
        fresh.push(c);
    }
    info("Comments surviving dedup: " + fresh.length);
    if (fresh.length === 0) return;

    // 4) Picker LLM call -- ask which comments to engage with.
    var candidates = fresh.map(function(c, idx) {
        return {
            id:     "cmt_" + (idx + 1),
            author: c.author,
            text:   stripSkoolCommentMeta(stripAllMentions((c.text || "").substring(0, 600))),
            _raw:   c,
        };
    });

    var pickerUserPrompt = (config.value_picker.snippet ? (config.value_picker.snippet + "\n\n") : "")
        + "Here is a list of COMMENTS left by other people under the post titled \""
        + (post.title || "(untitled)") + "\" by " + (post.author || "(unknown)") + ".\n"
        + "Find comments by people who look like they would be a good fit for scott's program "
        + "'I take self-improvement coaches from 0 to 10k in 42 days or they don't pay' "
        + "so we can engage them directly with a value-add reply.\n"
        + "Only pick comments where the COMMENTER (not the post author) shows ICP traits "
        + "(self-improvement coach / wanna-be coach, growth mindset, main character energy, "
        + "money/freedom/discipline focus). Skip generic 'great post', emojis-only, and one-word replies.\n\n"
        + JSON.stringify(candidates.map(function(c) {
            return { id: c.id, author: c.author, text: stripSkoolCommentMeta(stripAllMentions(c.text)) };
        }), null, 2);

    var pick = await callPicker({
        label:        "value_picker [comments under " + (post.author || "?") + "]",
        model:        modelName,
        system:       config.value_picker.system,
        user:         pickerUserPrompt,
        candidateIds: candidates.map(function(c) { return c.id; }),
    });

    var chosenIds = pick.chosen_ids || [];
    if (commentCap != null && chosenIds.length > commentCap) {
        info("[cap] Comment-picker returned " + chosenIds.length + " ids; trimming to commentCap=" + commentCap);
        chosenIds = chosenIds.slice(0, commentCap);
    }
    info("Chosen comment ids: " + JSON.stringify(chosenIds));
    if (chosenIds.length === 0) return;

    var byId = {};
    candidates.forEach(function(c) { byId[c.id] = c; });

    // 5) Reply to each chosen comment.
    for (var n = 0; n < chosenIds.length; n++) {
        var chosen = byId[chosenIds[n]];
        if (!chosen) continue;
        var c = chosen._raw;

        var engagementUrl = commentEngagementUrl(postHref, c.author, c.text);
        if (dedup.alreadyCommentedOn(ledger, engagementUrl)) {
            info("[dedup-skip-comment] " + c.author + " (since picker call)");
            continue;
        }

        step("Comment-reply " + (n + 1) + "/" + chosenIds.length + " -- replying to " + c.author);

        try {
            // RAG few-shots for this specific comment situation, community-matched.
            var inSin = isCommunityInSin(postHref);
            var ragQuery =
                "Post title: " + rag.safeTruncate(post.title || "", 300) + "\n" +
                "Post author: " + (post.author || "") + "\n" +
                "Comment by " + c.author + ":\n" + rag.safeTruncate(stripSkoolCommentMeta(stripAllMentions(c.text) || ""), 600);
            var ragExamples = "";
            try {
                ragExamples = await rag.getExamplesBlock(ragQuery, { inSin: inSin, k: 4 });
            } catch (ragErr) {
                info("[rag] picker failed for comment-reply (continuing without few-shots): " + ragErr.message);
            }

            // Compose reply text via the value_commenter writer.
            var writerUser = (config.value_commenter.snippet ? (config.value_commenter.snippet + "\n\n") : "")
                + (ragExamples ? (ragExamples + "\n\n") : "")
                + "Here is a COMMENT (not a top-level post) left by " + c.author
                + " under the post titled \"" + (post.title || "(untitled)") + "\" by "
                + (post.author || "(unknown)") + ". Reply directly to this commenter with a value-add "
                + "reply using the knowledge above. Speak to THEM, not to the original post author.\n\n"
                + "Comment by " + c.author + ":\n" + stripSkoolCommentMeta(stripAllMentions(c.text || ""));

            var replyText = await callWriter({
                label:     "value_commenter [reply to " + c.author + "]",
                model:     modelName,
                system:    config.value_commenter.system,
                user:      writerUser,
                maxTokens: 800,
            });

            if (!replyText) {
                info("[warn] Empty reply from LLM -- skipping " + c.author);
                continue;
            }

            if (dryRun) {
                info("[DRY RUN] would reply to " + c.author + "'s comment (NOT submitted):");
                console.log("    " + replyText.split("\n").join("\n    "));
                info("[DRY RUN] dedup NOT marked for this comment.");
                continue;
            }

            // Live path: click Reply on the comment, type, submit.
            await browser.typeCommentReply(page, { author: c.author, text: c.text }, replyText);
            await browser.submitReply(page);
            info("Comment reply submitted to " + c.author + ".");

            dedup.markCommentLeft(ledger, engagementUrl, {
                kind:         "comment_reply",
                postHref:     postHref,
                commenter:    c.author,
                snippet:      (c.text || "").substring(0, 240),
                replyLen:     replyText.length,
            });
            info("Marked dedup for comment engagement.");

            // Give Skool a moment to settle before the next click.
            await browser.sleep(1500);
        } catch (replyErr) {
            info("[error] reply to " + c.author + " failed: " + (replyErr && replyErr.message ? replyErr.message : replyErr));
        }
    }
}

module.exports = { runValuePhase };
