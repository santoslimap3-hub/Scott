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

  await page.goto("https://www.skool.com/self-improvement-nation-3104/we-have-our-very-own-website-now", { waitUntil: "domcontentloaded", timeout: 15000 });
  await new Promise(r => setTimeout(r, 3000));

  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 500));
  }

  // Check how threads/replies are structured
  const threadInfo = await page.evaluate(() => {
    const results = [];
    const bubbles = document.querySelectorAll('[class*="CommentItemBubble"]');

    bubbles.forEach((bubble, idx) => {
      // Get author
      const profileLinks = Array.from(bubble.querySelectorAll('a[href*="/@"]'));
      let author = "Unknown";
      for (const link of profileLinks) {
        const txt = link.textContent.trim();
        if (/^\d+$/.test(txt) || txt.startsWith("@")) continue;
        author = txt;
        break;
      }

      // Check nesting depth — how many levels up to find a thread container
      let depth = 0;
      let parent = bubble.parentElement;
      let parentClasses = [];
      for (let i = 0; i < 15; i++) {
        if (!parent) break;
        const cls = parent.className || "";
        parentClasses.push(cls.substring(0, 80));
        if (cls.includes("Thread") || cls.includes("thread") || cls.includes("Reply") || cls.includes("reply") || cls.includes("Nested") || cls.includes("nested")) {
          depth++;
        }
        parent = parent.parentElement;
      }

      // Check if this bubble is inside a reply/thread container
      const threadContainer = bubble.closest('[class*="Thread"], [class*="thread"], [class*="Repl"], [class*="repl"], [class*="Nested"], [class*="nested"], [class*="Child"], [class*="child"]');
      const isReply = threadContainer !== null;

      // Check indentation or margin-left as a thread indicator
      const style = window.getComputedStyle(bubble);
      const marginLeft = style.marginLeft;

      // Check parent for reply indicators
      const commentItem = bubble.closest('[class*="CommentItem"]');
      const commentItemClass = commentItem ? commentItem.className.substring(0, 200) : "none";

      results.push({
        idx,
        author,
        isReply,
        threadContainerClass: threadContainer ? threadContainer.className.substring(0, 100) : "none",
        commentItemClass,
        marginLeft,
        parentClasses: parentClasses.slice(0, 5),
        text: bubble.textContent.trim().substring(0, 100),
      });
    });
    return results;
  });

  console.log("Comment thread analysis:");
  threadInfo.forEach(t => {
    const indent = t.isReply ? "  ↳ " : "";
    console.log(indent + t.author + ": " + t.text.substring(0, 60));
    console.log("  isReply: " + t.isReply + " | threadClass: " + t.threadContainerClass.substring(0, 60));
    console.log("  commentItemClass: " + t.commentItemClass.substring(0, 80));
    console.log("");
  });

  fs.writeFileSync("output/thread_structure.json", JSON.stringify(threadInfo, null, 2));
  await browser.close();
  console.log("DONE");
}

debug();
