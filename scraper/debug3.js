const { chromium } = require("playwright");
const fs = require("fs");
require("dotenv").config();

async function debug() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  console.log("Logging in...");
  await page.goto("https://www.skool.com/login", { waitUntil: "networkidle" });
  await new Promise(r => setTimeout(r, 2000));
  await page.fill('input[name="email"], input[type="email"]', process.env.SKOOL_EMAIL);
  await page.fill('input[name="password"], input[type="password"]', process.env.SKOOL_PASSWORD);
  await page.click('button[type="submit"]');
  await new Promise(r => setTimeout(r, 5000));

  // Go directly to a post URL
  console.log("Opening post directly...");
  await page.goto("https://www.skool.com/self-improvement-nation-3104/we-have-our-very-own-website-now", { waitUntil: "networkidle" });
  await new Promise(r => setTimeout(r, 3000));

  // Scroll to load all comments
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 1000));
  }

  // Find all elements that contain author profile links AND are inside the comment area
  const commentData = await page.evaluate(() => {
    const results = [];

    // Find all profile links on the page
    const allProfileLinks = document.querySelectorAll('a[href*="/@"]');
    const seen = new Set();

    allProfileLinks.forEach(link => {
      // Walk up to find the comment container
      let container = link.closest('[class*="CommentItem"], [class*="commentItem"], [class*="ReplyWrapper"], [class*="replyWrapper"]');

      // If no specific comment class, try walking up to a reasonable parent
      if (!container) {
        let parent = link.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!parent) break;
          const cls = parent.className || "";
          if (cls.includes("omment") || cls.includes("eply") || cls.includes("Thread")) {
            container = parent;
            break;
          }
          parent = parent.parentElement;
        }
      }

      if (!container) return;

      // Avoid duplicates
      const key = link.textContent.trim() + container.textContent.trim().substring(0, 50);
      if (seen.has(key)) return;
      seen.add(key);

      const author = link.textContent.trim();
      // Skip level badges (just numbers)
      if (/^\d+$/.test(author)) return;

      results.push({
        author,
        containerClass: (container.className || "").substring(0, 200),
        fullText: container.textContent.trim().substring(0, 500),
        containerTag: container.tagName,
      });
    });

    return results;
  });

  console.log("Found " + commentData.length + " comment-like elements:");
  commentData.forEach((c, i) => {
    console.log("\n--- Comment " + (i+1) + " ---");
    console.log("Author: " + c.author);
    console.log("Class: " + c.containerClass.substring(0, 80));
    console.log("Text: " + c.fullText.substring(0, 200));
  });

  fs.writeFileSync("output/comment_detail.json", JSON.stringify(commentData, null, 2));

  await browser.close();
  console.log("\nDONE");
}

debug();
