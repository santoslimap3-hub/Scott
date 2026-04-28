const fs = require("fs");
const path = require("path");

const CLASSIFICATIONS_FILE = path.join(__dirname, "..", "post_classifications.json");

function loadDb() {
    try {
        if (fs.existsSync(CLASSIFICATIONS_FILE)) {
            var data = JSON.parse(fs.readFileSync(CLASSIFICATIONS_FILE, "utf8"));
            var count = Object.keys(data || {}).length;
            console.log("🗂️  [PostClassificationsDB] Loaded " + count + " classified posts");
            return data || {};
        }
    } catch (e) {
        console.warn("⚠️  [PostClassificationsDB] Could not load post_classifications.json, starting fresh:", e.message);
    }
    return {};
}

function saveDb(db) {
    try {
        var tmp = CLASSIFICATIONS_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
        fs.renameSync(tmp, CLASSIFICATIONS_FILE);
    } catch (e) {
        console.warn("⚠️  [PostClassificationsDB] Save failed:", e.message);
    }
}

function getRecord(db, postHref) {
    if (!db || !postHref) return null;
    return db[postHref] || null;
}

function hasClassification(db, postHref) {
    return !!getRecord(db, postHref);
}

function attachClassification(post, record) {
    if (!post || !record) return post;
    post.category_class = record.category_class || "other";
    post.urgency = typeof record.urgency === "number" ? record.urgency : 0;
    post.classifiedAt = record.classifiedAt || "";
    return post;
}

function upsertClassification(db, post) {
    if (!db || !post || !post.href) return;
    db[post.href] = {
        href: post.href,
        author: post.author || "Unknown",
        title: post.title || "",
        category: post.category || "General",
        bodyPreview: (post.body || "").substring(0, 500),
        category_class: post.category_class || "other",
        urgency: typeof post.urgency === "number" ? post.urgency : 0,
        commentCount: typeof post.commentCount === "number" ? post.commentCount : 0,
        community: post.community || "",
        classifiedAt: new Date().toISOString(),
    };
    saveDb(db);
}

module.exports = {
    loadDb: loadDb,
    saveDb: saveDb,
    getRecord: getRecord,
    hasClassification: hasClassification,
    attachClassification: attachClassification,
    upsertClassification: upsertClassification,
};
