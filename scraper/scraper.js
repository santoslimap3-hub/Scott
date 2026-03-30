const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const CONFIG = {
  email: process.env.SKOOL_EMAIL,
  password: process.env.SKOOL_PASSWORD,
  communityUrl: process.env.SKOOL_COMMUNITY_URL || "https://www.skool.com/self-improvement-nation-3104",
  targetMember: process.env.TARGET_MEMBER || "Scott Northwolf",
  outputFile: process.env.OUTPUT_FILE || "skool_data.json",
  headless: true,
  outputDir: "./output",
  parallel: 3,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureOutputDir() {
  if (!fs.existsSync(CONFIG.outputDir)) fs.mkdirSync(CONFIG.outputDir, { recursive: true });
}

function saveJSON(filename, data) {
  const fp = path.join(CONFIG.outputDir, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function formatTime(ms) {
  var secs = Math.floor(ms / 1000);
  var mins = Math.floor(secs / 60);
  secs = secs % 60;
  if (mins > 0) return mins + "m " + secs + "s";
  return secs + "s";
}

async function login(page) {
  console.log("🔐 Logging in...");
  await page.goto("https://www.skool.com/login", { waitUntil: "networkidle" });
  await sleep(800);
  await page.fill('input[name="email"], input[type="email"]', CONFIG.email);
  await page.fill('input[name="password"], input[type="password"]', CONFIG.password);
  await page.click('button[type="submit"]');
  await sleep(3000);
  if (page.url().includes("login")) throw new Error("Login failed");
  console.log("✅ Logged in");
}

async function collectAllPosts(page) {
  console.log("\n📋 Phase 1: Collecting posts...");
  var phase1Start = Date.now();
  var allPosts = [];
  var pageNum = 1;

  while (true) {
    var posts = await page.evaluate(function() {
      var cards = [];
      var wrappers = document.querySelectorAll('[class*="PostItemWrapper"]');
      var base = window.location.origin + "/" + window.location.pathname.split("/")[1];
      wrappers.forEach(function(el) {
        var links = Array.from(el.querySelectorAll("a")).map(function(a) {
          return { href: a.href, text: a.textContent.trim() };
        });
        var profileLinks = links.filter(function(l) { return l.href.includes("/@"); });
        var author = "Unknown";
        for (var i = 0; i < profileLinks.length; i++) {
          if (!/^\d+$/.test(profileLinks[i].text)) { author = profileLinks[i].text; break; }
        }
        var postLink = links.find(function(l) {
          return l.href.startsWith(base + "/") && !l.href.includes("/@") && !l.href.includes("?c=") && !l.href.includes("?p=") && l.href.split("/").length > 4;
        });
        var categoryEl = el.querySelector('[class*="GroupFeedLinkLabel"]');
        var timeEl = el.querySelector('[class*="PostTimeContent"]');
        var contentEl = el.querySelector('[class*="PostItemCardContent"]');
        cards.push({
          author: author,
          title: postLink ? postLink.text : "",
          category: categoryEl ? categoryEl.textContent.trim() : "",
          timestamp: timeEl ? timeEl.textContent.trim().replace(".", "").trim() : "",
          postUrl: postLink ? postLink.href : null,
          body: contentEl ? contentEl.textContent.trim().substring(0, 1000) : "",
        });
      });
      return cards;
    });
    console.log("  Page " + pageNum + ": " + posts.length + " posts");
    allPosts = allPosts.concat(posts);
    var wentNext = await page.evaluate(function() {
      var btns = document.querySelectorAll("button, a");
      for (var i = 0; i < btns.length; i++) {
        var txt = btns[i].textContent.trim();
        if (txt === ">" || txt === "Next" || txt === "›") {
          if (!btns[i].disabled) { btns[i].click(); return true; }
        }
      }
      return false;
    });
    if (!wentNext) break;
    await sleep(600);
    pageNum++;
    if (pageNum > 20) break;
  }

  var phase1Time = Date.now() - phase1Start;
  console.log("✅ " + allPosts.length + " posts collected in " + formatTime(phase1Time));
  return allPosts;
}

async function extractThreadedComments(page, postUrl, targetName) {
  await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await sleep(1500);

  // Scroll to load all comments
  for (var i = 0; i < 6; i++) {
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await sleep(500);
  }

  // Expand all collapsed reply threads — try multiple rounds
  for (var attempt = 0; attempt < 5; attempt++) {
    var clicked = await page.evaluate(function() {
      var count = 0;
      // Strategy 1: class-based selectors for reply expand buttons
      var expandBtns = document.querySelectorAll('[class*="ViewRepl"], [class*="viewRepl"], [class*="ShowRepl"], [class*="showRepl"], [class*="ExpandRepl"], [class*="expandRepl"], [class*="view-repl"], [class*="show-repl"]');
      expandBtns.forEach(function(el) {
        try { el.click(); count++; } catch(e) {}
      });
      // Strategy 2: text-based — look for small elements mentioning replies with a count
      if (count === 0) {
        var allEls = document.querySelectorAll('button, a, span[role="button"], div[role="button"], [class*="Repl"] span, [class*="repl"] span');
        for (var i = 0; i < allEls.length; i++) {
          var txt = allEls[i].textContent.trim();
          if (txt.length > 50) continue;
          if (/\d+\s*repl/i.test(txt) || /view.*repl/i.test(txt) || /show.*repl/i.test(txt)) {
            try { allEls[i].click(); count++; } catch(e) {}
          }
        }
      }
      return count;
    });
    if (clicked === 0) break;
    await sleep(800);
  }

  // Scroll again after expanding replies
  await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
  await sleep(300);

  return await page.evaluate(function(targetName) {
    var conversations = [];
    var allBubbles = document.querySelectorAll('[class*="CommentItemBubble"]');
    var seen = new Set();

    function getAuthor(bubble) {
      var links = Array.from(bubble.querySelectorAll('a[href*="/@"]'));
      for (var i = 0; i < links.length; i++) {
        var txt = links[i].textContent.trim();
        if (/^\d+$/.test(txt) || txt.startsWith("@")) continue;
        return txt;
      }
      return "Unknown";
    }

    function getContent(bubble) {
      var text = bubble.textContent.trim();
      var author = getAuthor(bubble);
      var idx = text.indexOf(author);
      if (idx !== -1) text = text.substring(idx + author.length).trim();
      text = text.replace(/^[^\w@]*[·•]\s*\d+[hmd]\s*/i, "").trim();
      text = text.replace(/^[^\w@]*[·•]\s*\w+\s+\d+\s*/i, "").trim();
      return text;
    }

    function isTarget(author) {
      return author.trim() === targetName;
    }

    // Check if a bubble is a reply (nested inside a reply container)
    var replyClassPattern = /Reply|reply|Replies|replies|Nested|nested|Child|child/;
    function isReplyBubble(bubble) {
      var el = bubble.parentElement;
      for (var i = 0; i < 10; i++) {
        if (!el) break;
        var cls = el.className || "";
        if (replyClassPattern.test(cls)) return true;
        el = el.parentElement;
      }
      return false;
    }

    // Find replies for a top-level comment bubble
    function findReplies(bubble) {
      var replies = [];
      // Walk up parent chain and look for a sibling that contains reply bubbles
      var node = bubble;
      for (var i = 0; i < 10; i++) {
        if (!node || !node.parentElement) break;
        node = node.parentElement;
        // Check next sibling
        var sibling = node.nextElementSibling;
        if (sibling) {
          var cls = sibling.className || "";
          if (replyClassPattern.test(cls)) {
            var replyBubbles = sibling.querySelectorAll('[class*="CommentItemBubble"]');
            replyBubbles.forEach(function(rb) {
              var rAuthor = getAuthor(rb);
              if (rAuthor === "Unknown") return;
              var rContent = getContent(rb);
              var rKey = rAuthor + "|" + rContent.substring(0, 50);
              if (!seen.has(rKey)) {
                seen.add(rKey);
                replies.push({ author: rAuthor, content: rContent, isTargetMember: isTarget(rAuthor) });
              }
            });
            if (replies.length > 0) return replies;
          }
        }
        // Also check all subsequent siblings (reply container might not be immediately next)
        var nextSib = node.nextElementSibling;
        while (nextSib) {
          var nCls = nextSib.className || "";
          if (nCls && replyClassPattern.test(nCls)) {
            var rbs = nextSib.querySelectorAll('[class*="CommentItemBubble"]');
            rbs.forEach(function(rb) {
              var rAuthor = getAuthor(rb);
              if (rAuthor === "Unknown") return;
              var rContent = getContent(rb);
              var rKey = rAuthor + "|" + rContent.substring(0, 50);
              if (!seen.has(rKey)) {
                seen.add(rKey);
                replies.push({ author: rAuthor, content: rContent, isTargetMember: isTarget(rAuthor) });
              }
            });
            if (replies.length > 0) return replies;
          }
          nextSib = nextSib.nextElementSibling;
        }
      }
      return replies;
    }

    allBubbles.forEach(function(bubble) {
      if (isReplyBubble(bubble)) return;
      var author = getAuthor(bubble);
      if (author === "Unknown") return;
      var content = getContent(bubble);
      var key = author + "|" + content.substring(0, 50);
      if (seen.has(key)) return;
      seen.add(key);
      var thread = {
        comment: { author: author, content: content, isTargetMember: isTarget(author) },
        replies: findReplies(bubble),
      };
      conversations.push(thread);
    });
    return conversations;
  }, targetName);
}

async function main() {
  var totalStart = Date.now();
  console.log("🚀 SKOOL SCRAPER (parallel mode)");
  console.log("=================================");
  console.log("Target: " + CONFIG.targetMember);
  console.log("Community: " + CONFIG.communityUrl);
  console.log("Parallel tabs: " + CONFIG.parallel);
  console.log("");

  if (!CONFIG.email || !CONFIG.password) { console.error("Missing .env"); process.exit(1); }
  ensureOutputDir();

  var browser = await chromium.launch({ headless: CONFIG.headless, slowMo: 0 });
  var context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  var mainPage = await context.newPage();

  try {
    await login(mainPage);
    await mainPage.goto(CONFIG.communityUrl, { waitUntil: "networkidle" });
    await sleep(500);

    var allPosts = await collectAllPosts(mainPage);

    var dataset = {
      metadata: {
        community: CONFIG.communityUrl,
        targetMember: CONFIG.targetMember,
        scrapedAt: new Date().toISOString(),
        totalPosts: allPosts.length,
        postsWithTargetResponses: 0,
        totalThreads: 0,
      },
      interactions: new Array(allPosts.length),
    };

    var totalBatches = Math.ceil(allPosts.length / CONFIG.parallel);
    var phase2Start = Date.now();
    var batchTimes = [];

    console.log("\n💬 Phase 2: Extracting comments...");
    console.log("  " + allPosts.length + " posts / " + CONFIG.parallel + " parallel = " + totalBatches + " batches\n");

    for (var batch = 0; batch < allPosts.length; batch += CONFIG.parallel) {
      var batchStart = Date.now();
      var batchNum = Math.floor(batch / CONFIG.parallel) + 1;
      var batchEnd = Math.min(batch + CONFIG.parallel, allPosts.length);
      var batchPosts = allPosts.slice(batch, batchEnd);

      // Elapsed time
      var elapsed = Date.now() - phase2Start;

      // ETA prediction
      var eta = "calculating...";
      if (batchTimes.length > 0) {
        var avgBatchTime = batchTimes.reduce(function(a,b){return a+b}, 0) / batchTimes.length;
        var remainingBatches = totalBatches - batchNum + 1;
        var etaMs = avgBatchTime * remainingBatches;
        eta = formatTime(etaMs);
      }

      var titles = batchPosts.map(function(p) { return (p.title || "?").substring(0, 18); }).join(" | ");
      console.log("  Batch " + batchNum + "/" + totalBatches + "  [" + formatTime(elapsed) + " elapsed | ETA: " + eta + "]");
      console.log("    → " + titles);

      var promises = batchPosts.map(async function(post, idx) {
        var globalIdx = batch + idx;
        var threads = [];
        if (post.postUrl) {
          var pg = await context.newPage();
          try {
            threads = await extractThreadedComments(pg, post.postUrl, CONFIG.targetMember);
          } catch(e) {
            try { threads = await extractThreadedComments(pg, post.postUrl, CONFIG.targetMember); } catch(e2) {}
          }
          await pg.close();
        }
        var scottInvolved = false;
        threads.forEach(function(t) {
          if (t.comment.isTargetMember) scottInvolved = true;
          t.replies.forEach(function(r) { if (r.isTargetMember) scottInvolved = true; });
        });
        return {
          idx: globalIdx,
          interaction: {
            id: String(globalIdx + 1).padStart(3, "0"),
            original_post: { author: post.author, title: post.title, body: post.body, category: post.category, timestamp: post.timestamp, url: post.postUrl },
            threads: threads,
            scott_involved: scottInvolved,
          },
          scottInvolved: scottInvolved,
          threadCount: threads.length,
        };
      });

      var results = await Promise.all(promises);

      var batchThreads = 0;
      var batchScott = 0;
      results.forEach(function(r) {
        dataset.interactions[r.idx] = r.interaction;
        if (r.scottInvolved) { dataset.metadata.postsWithTargetResponses++; batchScott++; }
        dataset.metadata.totalThreads += r.threadCount;
        batchThreads += r.threadCount;
      });

      var batchTime = Date.now() - batchStart;
      batchTimes.push(batchTime);

      console.log("    ✓ " + formatTime(batchTime) + " — " + batchThreads + " threads, " + batchScott + " with Scott");

      saveJSON(CONFIG.outputFile, dataset);
    }

    var totalTime = Date.now() - totalStart;

    console.log("\n=================================");
    console.log("🎉 DONE in " + formatTime(totalTime));
    console.log("");
    console.log("  Posts scraped:    " + dataset.interactions.length);
    console.log("  Total threads:   " + dataset.metadata.totalThreads);
    console.log("  Scott involved:  " + dataset.metadata.postsWithTargetResponses);
    console.log("  Avg per batch:   " + formatTime(batchTimes.reduce(function(a,b){return a+b},0) / batchTimes.length));
    console.log("=================================");

  } catch(e) {
    console.error("Error: " + e.message);
    await mainPage.screenshot({ path: path.join(CONFIG.outputDir, "error.png") });
  } finally {
    await browser.close();
  }
}

main();
