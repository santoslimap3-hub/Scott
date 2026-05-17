// =============================================================================
// auto_reply.js -- agentic rework
//
// Thin orchestrator. The intelligence lives in:
//   - bot/agentic/config.js        (all four LLM prompts, edit this)
//   - bot/agentic/notif_phase.js   (Phase A: reply to notifications)
//   - bot/agentic/value_phase.js   (Phase B: leave value comments)
//   - bot/agentic/anthropic_client (callPicker, callWriter)
//   - bot/agentic/dedup.js         (no-duplicates ledger)
//
// Each phase is wrapped in its own try/catch -- a failure in one phase MUST
// NOT prevent the other from running, and neither should kill the cycle loop.
//
// Defaults to DRY_RUN=true for safety. Override by setting DRY_RUN=false.
// =============================================================================

"use strict";

const path = require("path");
// Always load the .env that lives next to this file (bot/.env),
// no matter what cwd the script is launched from.
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { chromium } = require("playwright");
const browser_mod  = require("./skool_browser");

const config        = require("./agentic/config");
const { runNotifPhase } = require("./agentic/notif_phase");
const { runValuePhase } = require("./agentic/value_phase");
const run_logger    = require("./agentic/run_logger");

// ---- env / defaults ---------------------------------------------------------

// DRY RUN defaults to TRUE. Must be set to "false" explicitly to go live.
const DRY_RUN  = process.env.DRY_RUN !== "false";
const HEADLESS = process.env.HEADLESS === "true";

// Community from .env (bot/.env -> COMMUNITY=...). Falls back to synthesizer.
const ENV_COMMUNITY_URL = process.env.COMMUNITY
    || process.env.SKOOL_COMMUNITY_URL_2
    || process.env.SKOOL_COMMUNITY_URL
    || "https://www.skool.com/synthesizer";

function nameFromUrl(u) {
    try {
        var slug = String(u).replace(/\/+$/, "").split("/").pop() || "";
        if (!slug) return u;
        return slug.split("-").map(function (w) {
            return w ? w[0].toUpperCase() + w.slice(1) : w;
        }).join(" ");
    } catch (_) { return u; }
}

// Alternating community rotation. Cycle 1 = first entry, cycle 2 = second, etc.
const COMMUNITIES = [
    { url: ENV_COMMUNITY_URL,                  name: process.env.COMMUNITY_NAME || nameFromUrl(ENV_COMMUNITY_URL) },
    { url: "https://www.skool.com/academy",    name: "Imperium Academy" },
];

const SKOOL_EMAIL    = process.env.SKOOL_EMAIL;
const SKOOL_PASSWORD = process.env.SKOOL_PASSWORD;

// ---- bar / banner -----------------------------------------------------------

function bar(char, n) { return new Array((n || 78) + 1).join(char || "="); }

function envCheck() {
    var missing = [];
    if (!SKOOL_EMAIL)              missing.push("SKOOL_EMAIL");
    if (!SKOOL_PASSWORD)           missing.push("SKOOL_PASSWORD");
    if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
    if (missing.length > 0) {
        console.error("\n[FATAL] Missing required env var(s): " + missing.join(", "));
        console.error("        Set them in your .env file before running.\n");
        process.exit(1);
    }
}

(async function main() {
    envCheck();

    // Initialize the per-run logger. Every LLM call (picker, writer, RAG)
    // from this point on is recorded to bot/logs/runs/run_<ts>.json AND
    // bot/logs/runs/latest.js (which the dashboard at bot/dashboard.html
    // loads via a <script> tag, no server needed).
    run_logger.init({
        startedAt:    new Date().toISOString(),
        dry_run:      DRY_RUN,
        headless:     HEADLESS,
        model:        config.runtime.anthropic_model,
        communities:  COMMUNITIES,
        pages_to_scrape:      config.runtime.pages_to_scrape,
        max_picks_per_phase:  config.runtime.max_picks_per_phase,
        max_comment_replies_per_post: config.runtime.max_comment_replies_per_post,
    });

    console.log("\n" + bar("#"));
    console.log("# AGENTIC AUTO-REPLY BOT");
    console.log("# DRY_RUN     : " + DRY_RUN + (DRY_RUN ? "  (no replies will be submitted)" : "  (LIVE -- replies WILL be posted)"));
    console.log("# HEADLESS    : " + HEADLESS);
    console.log("# COMMUNITIES : alternating each cycle --");
    COMMUNITIES.forEach(function (c, i) {
        console.log("#               [" + (i + 1) + "] " + c.name + "  -- " + c.url);
    });
    console.log("# MODEL       : " + config.runtime.anthropic_model);
    console.log("# PAGES SCRAPE: " + config.runtime.pages_to_scrape);
    console.log("# PICK CAP    : " + (config.runtime.max_picks_per_phase == null ? "none" : config.runtime.max_picks_per_phase) + " per phase");
    console.log("# MATCH TERMS : " + JSON.stringify(config.runtime.notification_match_terms));
    console.log(bar("#") + "\n");

    var browser = await chromium.launch({ headless: HEADLESS, slowMo: 50 });
    var context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport:  { width: 1280, height: 900 },
    });
    var page = await context.newPage();

    var botName = await browser_mod.login(page, SKOOL_EMAIL, SKOOL_PASSWORD);
    if (!botName || !botName.trim()) {
        console.error("\n" + bar("!"));
        console.error("[FATAL] Could not determine bot account name.");
        console.error("        Skool's nav-scrape failed AND BOT_NAME is not set in .env.");
        console.error("        Without an identity, thread-history matching is broken --");        console.error("        the bot would not recognize its OWN past comments in a thread.");
        console.error("        Fix: add a line like  BOT_NAME=Pedro Santos  to bot/.env");
        console.error("        (use the exact display name as it appears on your Skool profile)");
        console.error(bar("!") + "\n");
        process.exit(1);
    }
    console.log("\n[login] Bot identity: " + botName + "\n");

    var phaseCtx = {
        botName:      botName,
        config:       config,
        communityUrl: COMMUNITIES[0].url, // overwritten per-cycle below
        dryRun:       DRY_RUN,
    };

    var cycle = 1;
    while (true) {
        // Alternate community each cycle.
        var current = COMMUNITIES[(cycle - 1) % COMMUNITIES.length];
        phaseCtx.communityUrl  = current.url;
        phaseCtx.communityName = current.name;

        run_logger.beginCycle(cycle, current.url, current.name);

        console.log("\n" + bar("#"));
        console.log("# CYCLE " + cycle + (DRY_RUN ? "  [DRY RUN]" : ""));
        console.log("# COMMUNITY  : " + current.name + "  -- " + current.url);
        console.log(bar("#"));

        // Per-phase try/catch: a Phase A failure must not block Phase B,
        // and vice versa. Only an unrecoverable error escapes here.
        try {
            await runNotifPhase(page, phaseCtx);
        } catch (err) {
            console.error("\n[Phase A error] " + (err && err.stack ? err.stack : err));
            try { await page.goto("https://www.skool.com", { timeout: 15000 }); } catch (_) {}
        }

        try {
            await runValuePhase(page, phaseCtx);
        } catch (err) {
            console.error("\n[Phase B error] " + (err && err.stack ? err.stack : err));
            try { await page.goto("https://www.skool.com", { timeout: 15000 }); } catch (_) {}
        }

        cycle++;
        // No artificial cycle delay during testing -- add one back here if needed.
    }
})().catch(function(err) {
    console.error("\n[FATAL] " + (err && err.stack ? err.stack : err));
    process.exit(1);
});
