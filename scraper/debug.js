const { chromium } = require("playwright");
const fs = require("fs");
require("dotenv").config();

async function debug() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Login
  console.log("Logging in...");
  await page.goto("https://www.skool.com/login", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);
  await page.fill('input[name="email"], input[type="email"]', process.env.SKOOL_EMAIL);
  await page.fill('input[name="password"], input[type="password"]', process.env.SKOOL_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(5000);
  console.log("Logged in. URL: " + page.url());

  // Go to community
  const communityUrl = process.env.SKOOL_COMMUNITY_URL;
  console.log("Going to: " + communityUrl);
  await page.goto(communityUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(5000);
  console.log("Page loaded. URL: " + page.url());

  // Screenshot
  await page.screenshot({ path: "output/community_page.png", fullPage: true });
  console.log("Screenshot saved to output/community_page.png");

  // Dump the HTML structure (first 50000 chars)
  const html = await page.content();
  fs.writeFileSync("output/page_source.html", html);
  console.log("Full HTML saved to output/page_source.html");

  // Find ALL links on the page
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a")).map(a => ({
      href: a.href,
      text: a.textContent.trim().substring(0, 100),
    })).filter(l => l.href.includes("skool.com"));
  });
  fs.writeFileSync("output/all_links.json", JSON.stringify(links, null, 2));
  console.log("Found " + links.length + " links on page");

  // Try to find any post-like content
  const postCandidates = await page.evaluate(() => {
    const results = [];
    // Look for anything with post-related attributes or content
    const allElements = document.querySelectorAll("a[href*='/post/'], a[href*='post'], [data-testid*='post'], [class*='post'], [class*='Post'], [class*='feed'], [class*='Feed']");
    allElements.forEach((el, i) => {
      if (i < 30) {
        results.push({
          tag: el.tagName,
          class: el.className.substring(0, 200),
          href: el.href || "",
          text: el.textContent.trim().substring(0, 200),
          dataTestId: el.getAttribute("data-testid") || "",
        });
      }
    });
    return results;
  });
  fs.writeFileSync("output/post_candidates.json", JSON.stringify(postCandidates, null, 2));
  console.log("Found " + postCandidates.length + " post-like elements");

  await browser.close();
  console.log("DONE - check the output/ folder");
}

debug();
