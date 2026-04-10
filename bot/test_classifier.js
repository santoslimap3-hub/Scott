/**
 * test_classifier.js
 *
 * Run this directly to test the classifier in isolation and see the exact error:
 *   node test_classifier.js
 */

require("dotenv").config();
const classifyReply = require("./classify/tag_classifier");

async function run() {
    console.log("=== Classifier Diagnostic ===\n");
    console.log("OPENAI_API_KEY present:", !!process.env.OPENAI_API_KEY);
    console.log("OPENAI_API_KEY prefix: ", (process.env.OPENAI_API_KEY || "").substring(0, 8) + "...");
    console.log("");

    var result = await classifyReply({
        postAuthor: "Lea Newkirk",
        postTitle:  "Protecting the Focus.",
        postBody:   "I've been reading Deep Work by Cal Newport and it's shifted how I look at goals.",
        thread:     [],
    });

    console.log("\nResult:", JSON.stringify(result, null, 2));
}

run().catch(function(err) {
    console.error("Top-level error:", err);
});
