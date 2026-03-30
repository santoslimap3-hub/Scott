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

  await page.goto(process.env.SKOOL_COMMUNITY_URL, { waitUntil: "networkidle" });
  await new Promise(r => setTimeout(r, 3000));

  // Get the first post wrapper's full HTML and all links
  const info = await page.evaluate(() => {
    const wrapper = document.querySelector('[class*="PostItemWrapper"]');
    if (!wrapper) return { error: "No wrapper found" };

    // Get all links inside the post
    const links = Array.from(wrapper.querySelectorAll("a")).map(a => ({
      href: a.href,
      text: a.textContent.trim().substring(0, 100),
      class: a.className.substring(0, 100),
    }));

    // Get the inner HTML structure (first 3000 chars)
    const html = wrapper.innerHTML.substring(0, 5000);

    // Try clicking the post title/body area and see what happens
    // First, find all clickable areas
    const clickables = Array.from(wrapper.querySelectorAll("[role='button'], [onclick], [class*='click'], [class*='Click'], [tabindex]")).map(el => ({
      tag: el.tagName,
      class: el.className.substring(0, 100),
      text: el.textContent.trim().substring(0, 50),
    }));

    return { links, clickables, html };
  });

  fs.writeFileSync("output/post_structure.json", JSON.stringify(info, null, 2));
  console.log("Links in first post: " + info.links.length);
  info.links.forEach(l => console.log("  " + l.text.padEnd(30) + " -> " + l.href));
  console.log("\nClickable elements: " + (info.clickables || []).length);

  // Now click the first post and see what happens
  console.log("\nClicking first post...");
  const wrapper = await page.$('[class*="PostItemWrapper"]');
  await wrapper.click();
  await new Promise(r => setTimeout(r, 3000));

  console.log("URL after click: " + page.url());
  await page.screenshot({ path: "output/after_click.png" });

  // Dump the comment area HTML
  const commentInfo = await page.evaluate(() => {
    const body = document.body.innerHTML;
    // Find comment-related elements
    const commentEls = document.querySelectorAll('[class*="omment"]');
    const results = Array.from(commentEls).slice(0, 10).map(el => ({
      tag: el.tagName,
      class: el.className.substring(0, 200),
      text: el.textContent.trim().substring(0, 300),
      childCount: el.children.length,
    }));

    // Also get the current URL
    return { url: window.location.href, commentElements: results, totalCommentEls: commentEls.length };
  });

  fs.writeFileSync("output/comment_structure.json", JSON.stringify(commentInfo, null, 2));
  console.log("Comment elements found: " + commentInfo.totalCommentEls);
  console.log("Current URL: " + commentInfo.url);

  await browser.close();
  console.log("DONE - check output/");
}

debug();
