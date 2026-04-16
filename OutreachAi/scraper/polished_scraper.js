/**
 * polished_scraper.js
 *
 * Scrapes ALL of Scott Northwolf's interactions from multiple Skool communities.
 * Every data point is tagged with its source community.
 *
 * Communities scraped:
 *   - Self-Improvement Nation (self-improvement-nation-3104)
 *   - Synthesizer (synthesizer)
 *
 * Strategy: Uses Scott's contributions page per community to collect every URL
 * where he posted or commented, then fetches the full post + thread context for
 * each one. This guarantees we capture 100% of his interactions rather than
 * relying on the feed scroll (which can miss older content).
 *
 * Output: ./output/polished_scrape_output.json
 *
 * Usage:
 *   node polished_scraper.js
 *
 * Requirements:
 *   .env must contain: SKOOL_EMAIL, SKOOL_PASSWORD
 */

"use strict";

require("dotenv").config();
const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // Credentials (from .env)
  email:    process.env.SKOOL_EMAIL,
  password: process.env.SKOOL_PASSWORD,

  // The person whose interactions we are scraping
  targetMember:    "Scott Northwolf",
  scottProfileSlug: "scott-northwolf-3818",

  // Communities to scrape — add more entries here to expand
  communities: [
    {
      name: "Self-Improvement Nation",
      slug: "self-improvement-nation-3104",
      communityUrl: "https://www.skool.com/self-improvement-nation-3104",
    },
    {
      name: "Synthesizer",
      slug: "synthesizer",
      communityUrl: "https://www.skool.com/synthesizer",
    },
  ],

  // File paths
  outputDir:      "./output",
  outputFile:     "polished_scrape_output.json",
  progressFile:   "polished_scrape_progress.json",

  // Parallelism
  parallel: 3,              // Concurrent post-fetch tabs per batch

  // Safety caps
  maxContribPages: 100,     // Max pagination pages on contributions page

  // Scroll / expand tuning
  scrollCount:    8,        // Number of scroll passes to load lazy comments
  expandRounds:   8,        // Rounds of "view replies" button clicking
  seeMoreRounds:  10,       // Rounds of "see more" button clicking
  expandWaitMs:   450,      // Delay between expand rounds (ms)
  seeMoreWaitMs:  350,      // Delay between see-more rounds (ms)
  postLoadWaitMs: 2500,     // Wait after navigating to a post
  pageNavWaitMs:  2000,     // Wait after paginating to next contributions page

  headless: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function saveJSON(filepath, data) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Content cleaning
// Strips all known Skool UI artifacts from scraped text.
// ─────────────────────────────────────────────────────────────────────────────

function cleanContent(raw) {
  if (!raw) return "";
  let text = String(raw);

  // Drag-and-drop accessibility instructions
  text = text.replace(
    /\n?\s*To pick up a draggable item[\s\S]*?press escape to cancel\.?\s*/gim,
    ""
  );

  // Emoji picker dumps (various entry points)
  text = text.replace(/\s*Recently Used[\s\S]*$/m, "");
  text = text.replace(/\s*Smileys & People[\s\S]*$/m, "");
  text = text.replace(/\s*Drop files here to upload[\s\S]*$/m, "");

  // Editor toolbar labels that leak into innerText
  text = text.replace(/\s*\b(Bold|Italic|Underline|Strikethrough|Link)\b\s*/g, " ");

  // Trailing "Reply / Replies / Like / Likes" counts (UI buttons)
  text = text.replace(/\s*\d*\s*(Reply|Replies|Like|Likes|Comment|Comments)\s*$/gi, "");

  // Video / audio timestamps appended at end of message (e.g. "3:45 PM" or "1:20")
  text = text.replace(/\s+\d{1,2}:\d{2}(\s*[AaPp][Mm])?\s*$/g, "");

  // Leftover "see more" text that wasn't expanded
  text = text.replace(/\s*\bsee more\b\s*$/gi, "");

  // Collapse runs of 3+ newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// Returns an array of human-readable issue strings. Empty = clean.
// ─────────────────────────────────────────────────────────────────────────────

function detectIssues(text, label) {
  const issues = [];
  if (!text || text.trim().length < 2)             issues.push(`${label}: empty or too short`);
  if (/\bsee more\b/i.test(text))                  issues.push(`${label}: contains "see more"`);
  if (/To pick up a draggable item/i.test(text))   issues.push(`${label}: contains drag-drop UI text`);
  if (/Recently Used.*Smileys/is.test(text))       issues.push(`${label}: contains emoji picker dump`);
  return issues;
}

function validateEntry(entry) {
  const issues = [];

  issues.push(...detectIssues(entry.original_post.title, "post.title"));
  issues.push(...detectIssues(entry.original_post.body,  "post.body"));

  entry.threads.forEach((thread, ti) => {
    issues.push(...detectIssues(thread.comment.content, `thread[${ti}].comment`));
    thread.replies.forEach((reply, ri) => {
      issues.push(...detectIssues(reply.content, `thread[${ti}].reply[${ri}]`));
    });
  });

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

async function login(page) {
  log("Logging in to Skool...");
  await page.goto("https://www.skool.com/login", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await sleep(2000);

  await page.fill('input[type="email"]',    CONFIG.email);
  await page.fill('input[type="password"]', CONFIG.password);
  await page.click('button[type="submit"]');

  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(3000);
  log("Login successful.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Content expander
// Clicks all "view replies" and "see more" buttons on the current page.
// Runs multiple rounds because each expansion can reveal new buttons.
// ─────────────────────────────────────────────────────────────────────────────

async function expandAllContent(page) {
  // ── Round 1: Expand reply threads ──────────────────────────────────────────
  for (let round = 0; round < CONFIG.expandRounds; round++) {
    const clicked = await page.evaluate(() => {
      let count = 0;
      const candidates = Array.from(
        document.querySelectorAll("button, span[role='button'], a, div[role='button']")
      );
      for (const el of candidates) {
        if (!el.offsetParent) continue; // skip hidden elements
        const text = (el.textContent || "").trim();
        const cls  = (el.className  || "").toString();
        const isReplyExpander =
          /view\s*\d*\s*repl|show\s*\d*\s*repl|expand\s*repl|\d+\s*repl/i.test(text) ||
          /viewrepl|showrepl|expandrepl/i.test(cls);
        if (isReplyExpander) {
          el.click();
          count++;
        }
      }
      return count;
    });
    if (clicked === 0) break;
    await sleep(CONFIG.expandWaitMs);
  }

  // ── Round 2: Expand "See more" truncations ─────────────────────────────────
  for (let round = 0; round < CONFIG.seeMoreRounds; round++) {
    const clicked = await page.evaluate(() => {
      let count = 0;
      const candidates = Array.from(
        document.querySelectorAll("button, span[role='button'], a, div[role='button']")
      );
      for (const el of candidates) {
        if (!el.offsetParent) continue;
        const text = (el.textContent || "").trim().toLowerCase();
        const cls  = (el.className  || "").toString().toLowerCase();
        const isSeeMore =
          text === "see more"  ||
          text === "read more" ||
          text === "show more" ||
          /seemore|readmore|showmore|truncat/i.test(cls);
        if (isSeeMore) {
          el.scrollIntoView({ block: "center" });
          el.click();
          count++;
        }
      }
      return count;
    });
    if (clicked === 0) break;
    await sleep(CONFIG.seeMoreWaitMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Post metadata extractor
// Pulls title, author, category, timestamp, and body from the open post page.
// ─────────────────────────────────────────────────────────────────────────────

async function extractPostMetadata(page) {
  return page.evaluate(() => {
    // ── Title ────────────────────────────────────────────────────────────────
    const titleEl =
      document.querySelector('[class*="PostTitle"]') ||
      document.querySelector("h1");
    const title = titleEl ? (titleEl.innerText || "").trim() : "";

    // ── Author ───────────────────────────────────────────────────────────────
    // The post header contains a profile link; avoid matching comment links
    const postHeader = document.querySelector(
      '[class*="PostHeader"], [class*="PostMeta"], [class*="PostAuthor"]'
    );
    let author = "";
    if (postHeader) {
      const authorLink = postHeader.querySelector('a[href*="/@"]');
      if (authorLink) author = (authorLink.innerText || "").trim();
    }

    // ── Category ─────────────────────────────────────────────────────────────
    const catEl = document.querySelector('[class*="GroupFeedLinkLabel"]');
    const category = catEl ? (catEl.innerText || "").trim() : "";

    // ── Timestamp ────────────────────────────────────────────────────────────
    const timeEl =
      document.querySelector('[class*="PostTimeContent"]') ||
      document.querySelector('[class*="PostTime"]')         ||
      document.querySelector("time");
    const timestamp = timeEl
      ? ((timeEl.getAttribute("datetime") || timeEl.innerText || "").trim())
      : "";

    // ── Body ─────────────────────────────────────────────────────────────────
    // Try selectors from most specific to most general.
    // For each candidate, clone it, strip the comments section and UI noise,
    // then read innerText.
    const bodySelectors = [
      '[class*="PostBody"]',
      '[class*="PostContent"] > [class*="Content"]',
      '[class*="PostItemCardContent"]',
      '[class*="RichText"]',
      '[class*="PostContent"]',
    ];

    let body = "";
    for (const sel of bodySelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;

      const clone = el.cloneNode(true);

      // Remove comments section so it doesn't bleed into body text
      for (const junk of clone.querySelectorAll(
        '[class*="CommentsSection"], [class*="CommentsList"], [class*="CommentsWrapper"]'
      )) {
        junk.remove();
      }
      // Remove emoji pickers / toolbar
      for (const junk of clone.querySelectorAll(
        '[class*="Emoji"], [class*="Picker"], [class*="Toolbar"], [class*="Editor"]'
      )) {
        junk.remove();
      }

      const rawBody = (clone.innerText || clone.textContent || "").trim();
      if (rawBody.length > 10) {
        body = rawBody;
        break;
      }
    }

    return {
      author,
      title,
      body,
      category,
      timestamp,
      url: window.location.href,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread extractor
// Extracts all comment threads (with replies) from the currently open post page.
// Returns: Array<{ comment: CommentObj, replies: CommentObj[] }>
// CommentObj: { author, content, isTargetMember }
// ─────────────────────────────────────────────────────────────────────────────

async function extractThreads(page, targetMember) {
  // Scroll to load all lazy comments
  for (let i = 0; i < CONFIG.scrollCount; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
  }
  await sleep(800);

  // Expand everything
  await expandAllContent(page);
  await sleep(500);

  return page.evaluate((targetMember) => {
    // ── Helper: extract author + content from a bubble element ───────────────
    function extractBubble(bubble) {
      // Author: pull from the profile link text inside this bubble
      let author = "";
      const profileLink = bubble.querySelector('a[href*="/@"]');
      if (profileLink) {
        author = (profileLink.innerText || profileLink.textContent || "").trim();
      }

      // Content: use innerText of the bubble, strip the author prefix
      let content = (bubble.innerText || bubble.textContent || "").trim();
      if (author && content.startsWith(author)) {
        content = content.slice(author.length).trimStart();
      }

      return { author, content, isTargetMember: author === targetMember };
    }

    // ── Helper: check if an element is a nested/reply bubble ─────────────────
    // Walk up the DOM; if we pass through a container that signals "reply"
    // before hitting the top-level comments section, it's a reply bubble.
    function isNestedBubble(bubble) {
      let node = bubble.parentElement;
      let depth = 0;
      while (node && depth < 15) {
        const cls = (node.className || "").toString().toLowerCase();
        // If we hit the main comments list wrapper, this is top-level
        if (/commentslist|commentssection|commentswrapper/i.test(cls)) return false;
        // If we pass through a reply-specific container, it's nested
        if (/repl(y|ies)|nested|child-comment|indent/i.test(cls)) return true;
        node = node.parentElement;
        depth++;
      }
      return false;
    }

    // ── Collect all CommentItemBubble elements ────────────────────────────────
    const allBubbles = Array.from(
      document.querySelectorAll('[class*="CommentItemBubble"]')
    );
    if (allBubbles.length === 0) return [];

    // Separate into top-level and reply bubbles
    const topLevelBubbles = allBubbles.filter((b) => !isNestedBubble(b));

    // ── Build thread structure ────────────────────────────────────────────────
    const threads = [];

    for (const topBubble of topLevelBubbles) {
      const commentData = extractBubble(topBubble);

      // Skip completely empty bubbles (e.g. deleted comments)
      if (!commentData.content || commentData.content.length < 1) continue;

      // Find reply bubbles that belong to this top-level comment.
      // Replies live in a container that is a sibling or descendant of
      // topBubble's parent CommentItem container.
      const parentItem =
        topBubble.closest('[class*="CommentItem"]:not([class*="CommentItemBubble"])') ||
        topBubble.parentElement;

      const replies = [];
      if (parentItem) {
        const nestedBubbles = Array.from(
          parentItem.querySelectorAll('[class*="CommentItemBubble"]')
        );
        for (const nb of nestedBubbles) {
          if (nb === topBubble) continue; // skip the top bubble itself
          const replyData = extractBubble(nb);
          if (!replyData.content || replyData.content.length < 1) continue;
          replies.push(replyData);
        }
      }

      threads.push({ comment: commentData, replies });
    }

    return threads;
  }, targetMember);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full post fetcher
// Opens a post URL, extracts metadata + threads, cleans, validates.
// Returns the full entry object or null on unrecoverable failure.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchFullPost(browser, postUrl, communityName, communitySlug, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let page = null;
    try {
      page = await browser.newPage();

      await page.goto(postUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await sleep(CONFIG.postLoadWaitMs);

      // Extract raw data
      const metadata = await extractPostMetadata(page);
      const threads  = await extractThreads(page, CONFIG.targetMember);

      // Clean all text fields
      metadata.title  = cleanContent(metadata.title);
      metadata.body   = cleanContent(metadata.body);
      for (const thread of threads) {
        thread.comment.content = cleanContent(thread.comment.content);
        for (const reply of thread.replies) {
          reply.content = cleanContent(reply.content);
        }
      }

      // Determine Scott involvement
      const scottInvolved =
        metadata.author === CONFIG.targetMember ||
        threads.some(
          (t) =>
            t.comment.isTargetMember ||
            t.replies.some((r) => r.isTargetMember)
        );

      const entry = {
        original_post: metadata,
        threads,
        scott_involved:     scottInvolved,
        community:          communityName,
        community_slug:     communitySlug,
        scraped_at:         new Date().toISOString(),
        validation_issues:  [],
      };

      entry.validation_issues = validateEntry(entry);

      await page.close();
      return entry;

    } catch (err) {
      if (page) {
        try { await page.close(); } catch (_) { /* ignore */ }
      }
      if (attempt < retries) {
        log(`  ↺ Retry ${attempt + 1}/${retries} — ${postUrl.slice(-60)}: ${err.message}`);
        await sleep(2500);
      } else {
        log(`  ✗ Failed after ${retries + 1} attempts — ${postUrl.slice(-60)}: ${err.message}`);
        return null;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contributions URL collector
// Paginates through Scott's contributions page for a community and collects
// every unique post URL.
// ─────────────────────────────────────────────────────────────────────────────

async function collectContributionUrls(page, communitySlug) {
  const profileUrl = `https://www.skool.com/@${CONFIG.scottProfileSlug}?g=${communitySlug}`;
  log(`  → Navigating to contributions: ${profileUrl}`);

  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await sleep(3000);

  const urlSet = new Set();
  let   pageNum = 1;

  while (pageNum <= CONFIG.maxContribPages) {
    // Scroll to trigger any lazy-loaded content on this page
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);

    // Harvest all valid post links on this page
    const newUrls = await page.evaluate((communitySlug) => {
      return Array.from(document.querySelectorAll("a[href]"))
        .map((a) => {
          try {
            const url   = new URL(a.href);
            const parts = url.pathname.split("/").filter(Boolean);
            // Must be: skool.com/<communitySlug>/<post-slug>
            // Exclude: profile pages (/@), category filters (?c=), pagination (?p=)
            if (
              url.hostname === "www.skool.com" &&
              parts[0]     === communitySlug   &&
              parts.length >= 2                &&
              !a.href.includes("?c=")          &&
              !a.href.includes("/@")           &&
              !a.href.includes("?p=")
            ) {
              // Normalize: strip query params and trailing slash
              return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
            }
          } catch (_) { /* bad URL */ }
          return null;
        })
        .filter(Boolean);
    }, communitySlug);

    let addedCount = 0;
    for (const url of newUrls) {
      if (!urlSet.has(url)) {
        urlSet.add(url);
        addedCount++;
      }
    }
    log(`  Page ${pageNum}: +${addedCount} new URLs (running total: ${urlSet.size})`);

    // Try to advance to the next contributions page
    const movedToNext = await page.evaluate(() => {
      const allClickables = Array.from(document.querySelectorAll("button, a"));
      for (const el of allClickables) {
        const text       = (el.textContent || "").trim();
        const isDisabled =
          el.disabled                                     ||
          el.getAttribute("aria-disabled") === "true"    ||
          (el.className || "").toString().includes("disabled");

        if (
          (text === "Next ›" || text === "›" || text === "Next") &&
          !isDisabled
        ) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (!movedToNext) {
      log(`  No more contribution pages.`);
      break;
    }

    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await sleep(CONFIG.pageNavWaitMs);
    pageNum++;
  }

  return Array.from(urlSet);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallel batch processor
// Fetches post URLs in parallel batches of CONFIG.parallel.
// ─────────────────────────────────────────────────────────────────────────────

async function processUrlsInParallel(browser, urls, communityName, communitySlug) {
  const results    = [];
  const batchSize  = CONFIG.parallel;
  const totalBatches = Math.ceil(urls.length / batchSize);

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch    = urls.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    log(`  Batch ${batchNum}/${totalBatches} — ${batch.length} post(s)`);

    const batchResults = await Promise.all(
      batch.map((url) => fetchFullPost(browser, url, communityName, communitySlug))
    );

    for (const result of batchResults) {
      if (result !== null) results.push(result);
    }

    // Brief pause between batches to avoid hammering Skool
    await sleep(600);
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication
// If the same post URL appears from two communities or two scrape runs,
// keep the copy with fewer validation issues.
// ─────────────────────────────────────────────────────────────────────────────

function deduplicate(entries) {
  const byUrl = new Map();
  for (const entry of entries) {
    const url = entry.original_post.url;
    if (!url) continue;

    const existing = byUrl.get(url);
    if (
      !existing ||
      (entry.validation_issues.length < existing.validation_issues.length)
    ) {
      byUrl.set(url, entry);
    }
  }
  return Array.from(byUrl.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // ── Pre-flight checks ───────────────────────────────────────────────────────
  if (!CONFIG.email || !CONFIG.password) {
    console.error(
      "\n[ERROR] SKOOL_EMAIL and SKOOL_PASSWORD must be set in scraper/.env\n"
    );
    process.exit(1);
  }

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  log("=".repeat(60));
  log("OutreachAI Polished Scraper");
  log(`Target member: ${CONFIG.targetMember}`);
  log(`Communities:   ${CONFIG.communities.map((c) => c.name).join(", ")}`);
  log("=".repeat(60));

  const browser    = await chromium.launch({ headless: CONFIG.headless });
  const allEntries = [];

  try {
    for (const community of CONFIG.communities) {
      log(`\n${"─".repeat(60)}`);
      log(`Community: ${community.name}`);
      log(`${"─".repeat(60)}`);

      // Login on a fresh page for each community
      const loginPage = await browser.newPage();
      await login(loginPage);

      // Collect contribution URLs
      const urls = await collectContributionUrls(loginPage, community.slug);
      await loginPage.close();

      if (urls.length === 0) {
        log(`  WARNING: No contribution URLs found for "${community.name}". Skipping.`);
        continue;
      }
      log(`  Found ${urls.length} contribution URLs for ${community.name}`);

      // Fetch all posts with full thread context
      log(`  Fetching full content...`);
      const entries = await processUrlsInParallel(
        browser,
        urls,
        community.name,
        community.slug
      );

      const scottCount  = entries.filter((e) => e.scott_involved).length;
      const issueCount  = entries.filter((e) => e.validation_issues.length > 0).length;
      const failedCount = urls.length - entries.length;

      log(`\n  ── ${community.name} results ──`);
      log(`  URLs collected:      ${urls.length}`);
      log(`  Successfully fetched: ${entries.length}`);
      log(`  Failed/null:         ${failedCount}`);
      log(`  Scott involved:      ${scottCount}`);
      log(`  Entries with issues: ${issueCount}`);

      allEntries.push(...entries);

      // Save progress after each community so we don't lose data mid-run
      const progressPath = path.join(CONFIG.outputDir, CONFIG.progressFile);
      saveJSON(progressPath, allEntries);
      log(`  Progress saved → ${progressPath}`);
    }

  } finally {
    await browser.close();
  }

  // ── Post-processing ──────────────────────────────────────────────────────────
  log(`\n${"─".repeat(60)}`);
  log("Post-processing...");

  // Deduplicate
  const deduped = deduplicate(allEntries);
  log(`Deduplication: ${allEntries.length} → ${deduped.length} unique entries`);

  // Assign sequential IDs
  const finalEntries = deduped.map((entry, idx) => ({
    id: String(idx + 1).padStart(3, "0"),
    ...entry,
  }));

  // ── Build final output ───────────────────────────────────────────────────────
  const byCommunity = {};
  for (const e of finalEntries) {
    byCommunity[e.community] = (byCommunity[e.community] || 0) + 1;
  }

  const scottOnly  = finalEntries.filter((e) => e.scott_involved);
  const withIssues = finalEntries.filter((e) => e.validation_issues.length > 0);

  const output = {
    metadata: {
      generated_at:                    new Date().toISOString(),
      target_member:                   CONFIG.targetMember,
      total_entries:                   finalEntries.length,
      scott_involved_count:            scottOnly.length,
      entries_with_validation_issues:  withIssues.length,
      by_community:                    byCommunity,
    },
    entries: finalEntries,
  };

  const outputPath = path.join(CONFIG.outputDir, CONFIG.outputFile);
  saveJSON(outputPath, output);

  // ── Final summary ────────────────────────────────────────────────────────────
  log(`\n${"=".repeat(60)}`);
  log("SCRAPE COMPLETE");
  log(`${"=".repeat(60)}`);
  log(`Total entries:         ${finalEntries.length}`);
  log(`Scott involved:        ${scottOnly.length}`);
  log(`Validation issues:     ${withIssues.length}`);
  log(`By community:`);
  for (const [name, count] of Object.entries(byCommunity)) {
    log(`  ${name}: ${count}`);
  }
  log(`\nOutput → ${outputPath}`);

  if (withIssues.length > 0) {
    log(`\nEntries with validation issues (first 15):`);
    for (const e of withIssues.slice(0, 15)) {
      log(`  [${e.id}] ${e.original_post.url}`);
      for (const issue of e.validation_issues) {
        log(`    • ${issue}`);
      }
    }
    if (withIssues.length > 15) {
      log(`  ... and ${withIssues.length - 15} more (see full output JSON)`);
    }
  }
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
