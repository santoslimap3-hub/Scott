/**
 * build_persons.js — Build data/persons.json from all known sources.
 *
 * INPUTS:
 *   data/dm-classified.csv                       — DM source (Contact column = display name)
 *   scraper/output/posts_scott_v2.json           — new scraper output (slugs + displays)
 *   data/posts_with_scott_reply_threads.json     — legacy scraper output (display only)
 *   data/company_members.json                    — hand-curated team list
 *   data/person_overrides.json                   — manual gender/role overrides
 *
 * OUTPUT:
 *   data/persons.json
 *   data/persons_unresolved.json                 — display names we couldn't map to a slug
 *
 * CANONICAL ID RULES:
 *   - If a Skool slug is known for this person, id = slug (lowercased).
 *   - Otherwise id = "name:" + normalizeDisplay(displayName).
 *   - A display-name-only id is a candidate to be promoted once a slug
 *     for the same normalized name is discovered in another source.
 *
 * GENDER RULES (per project decision):
 *   - Default: "male".
 *   - Overridden ONLY by data/person_overrides.json.
 *   - Company members inherit gender from company_members.json.
 *
 * ROLE RULES:
 *   - Company members → role from company_members.json.
 *   - Otherwise       → "lead".
 */

const fs   = require("fs");
const path = require("path");

const ROOT            = path.resolve(__dirname, "..");
const DATA_DIR        = path.join(ROOT, "data");
const DM_CSV          = path.join(DATA_DIR, "dm-classified.csv");
const LEGACY_POSTS    = path.join(DATA_DIR, "posts_with_scott_reply_threads.json");
const V2_POSTS        = path.join(ROOT, "scraper", "output", "fresh_skool_data.json");
const COMPANY_FILE    = path.join(DATA_DIR, "company_members.json");
const OVERRIDES_FILE  = path.join(DATA_DIR, "person_overrides.json");
const OUTPUT_FILE     = path.join(DATA_DIR, "persons.json");
const UNRESOLVED_FILE = path.join(DATA_DIR, "persons_unresolved.json");

// ─── helpers ───────────────────────────────────────────────────────────────

function readJSON(p, fallback) {
    if (!fs.existsSync(p)) return fallback;
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return fallback; }
}

function normalizeDisplay(name) {
    if (!name) return "";
    return name.toString()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")  // strip diacritics
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Minimal CSV parser that correctly handles quoted fields with commas
function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
        var c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') { inQuotes = false; }
            else { field += c; }
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { row.push(field); field = ""; }
            else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
            else if (c === '\r') { /* skip */ }
            else { field += c; }
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// ─── source readers ────────────────────────────────────────────────────────

function readDMContacts() {
    if (!fs.existsSync(DM_CSV)) { console.log("⚠  no dm-classified.csv found — skipping"); return []; }
    var rows = parseCSV(fs.readFileSync(DM_CSV, "utf8"));
    if (!rows.length) return [];
    var header = rows[0];
    var idxContact = header.indexOf("Contact");
    if (idxContact === -1) { console.log("⚠  dm CSV missing Contact column"); return []; }
    var seen = new Set();
    var contacts = [];
    for (var i = 1; i < rows.length; i++) {
        var name = (rows[i][idxContact] || "").trim();
        if (!name) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        contacts.push(name);
    }
    console.log("  DM source: " + contacts.length + " unique contacts");
    return contacts;
}

function readV2Posts() {
    var data = readJSON(V2_POSTS, null);
    if (!data || !data.posts) { console.log("⚠  no posts_scott_v2.json yet — persons built without slugs from posts"); return []; }
    var out = [];
    data.posts.forEach(function(p) {
        if (p.post.authorSlug && p.post.authorDisplay) out.push({ slug: p.post.authorSlug, display: p.post.authorDisplay });
        p.threads.forEach(function(th) {
            if (th.comment.authorSlug && th.comment.authorDisplay) out.push({ slug: th.comment.authorSlug, display: th.comment.authorDisplay });
            th.replies.forEach(function(r){
                if (r.authorSlug && r.authorDisplay) out.push({ slug: r.authorSlug, display: r.authorDisplay });
            });
        });
    });
    console.log("  v2 posts: " + out.length + " slug+display pairs (pre-dedup)");
    return out;
}

function readLegacyPosts() {
    var data = readJSON(LEGACY_POSTS, null);
    if (!data) { console.log("⚠  no legacy posts_with_scott_reply_threads.json"); return []; }
    var out = [];
    data.forEach(function(p) {
        if (p.original_post && p.original_post.author) out.push({ display: p.original_post.author });
        (p.threads || []).forEach(function(th) {
            if (th.comment && th.comment.author) out.push({ display: th.comment.author });
            (th.replies || []).forEach(function(r){ if (r.author) out.push({ display: r.author }); });
        });
    });
    console.log("  legacy posts: " + out.length + " display-only authors (pre-dedup)");
    return out;
}

// ─── main build ────────────────────────────────────────────────────────────

function build() {
    console.log("\n🧩 Building persons.json ...");

    var company   = readJSON(COMPANY_FILE,   { members: [] }).members   || [];
    var overrides = readJSON(OVERRIDES_FILE, { overrides: {} }).overrides || {};

    // 1. Collect raw pairs from every source
    var rawSlugPairs = readV2Posts();                 // [{slug, display}]
    var rawDmNames   = readDMContacts();              // [display]
    var rawLegacy    = readLegacyPosts();             // [{display}]

    // 2. Build a normalized-name → slug map from slugged sources
    var nameToSlug = {};
    rawSlugPairs.forEach(function(p){
        var n = normalizeDisplay(p.display);
        if (n && !nameToSlug[n]) nameToSlug[n] = p.slug;
    });

    // 3. Seed persons map, keyed by canonical id
    var persons = {};
    function upsert(id, payload) {
        if (!persons[id]) persons[id] = {
            id:             id,
            slug:           null,
            displayName:    "",
            displayAliases: [],
            gender:         "male",         // project default
            role:           "lead",
            sources:        [],
        };
        var p = persons[id];
        if (payload.slug && !p.slug) p.slug = payload.slug;
        if (payload.display) {
            if (!p.displayName) p.displayName = payload.display;
            if (p.displayAliases.indexOf(payload.display) === -1 && payload.display !== p.displayName) {
                p.displayAliases.push(payload.display);
            }
        }
        if (payload.source && p.sources.indexOf(payload.source) === -1) p.sources.push(payload.source);
    }

    // a. v2 post authors — slug-keyed
    rawSlugPairs.forEach(function(p){ upsert(p.slug, { slug: p.slug, display: p.display, source: "v2_posts" }); });

    // b. DM contacts — try to promote to a slug id if we have one, else use "name:..."
    rawDmNames.forEach(function(display){
        var n = normalizeDisplay(display);
        var slug = nameToSlug[n];
        var id = slug ? slug : "name:" + n;
        upsert(id, { slug: slug || null, display: display, source: "dm_csv" });
    });

    // c. Legacy posts — same
    rawLegacy.forEach(function(r){
        if (!r.display) return;
        var n = normalizeDisplay(r.display);
        var slug = nameToSlug[n];
        var id = slug ? slug : "name:" + n;
        upsert(id, { slug: slug || null, display: r.display, source: "legacy_posts" });
    });

    // 4. Apply company membership
    company.forEach(function(m) {
        var id = m.slug || ("name:" + normalizeDisplay(m.displayName));
        upsert(id, { slug: m.slug || null, display: m.displayName, source: "company_members" });
        persons[id].role   = m.role   || "company-member:other";
        persons[id].gender = m.gender || persons[id].gender;
    });

    // 5. Apply manual overrides (wins over everything)
    Object.keys(overrides).forEach(function(id) {
        var o = overrides[id];
        if (!persons[id]) {
            // Override for someone we haven't seen yet — create the record
            persons[id] = {
                id: id, slug: id.startsWith("name:") ? null : id, displayName: "",
                displayAliases: [], gender: "male", role: "lead", sources: ["override"],
            };
        }
        if (o.gender) persons[id].gender = o.gender;
        if (o.role)   persons[id].role   = o.role;
        persons[id].sources = persons[id].sources || [];
        if (persons[id].sources.indexOf("override") === -1) persons[id].sources.push("override");
    });

    // 6. Stats + unresolved report
    var all    = Object.values(persons);
    var withSlug    = all.filter(function(p){ return !!p.slug; });
    var withoutSlug = all.filter(function(p){ return !p.slug; });
    var leads       = all.filter(function(p){ return p.role === "lead"; });
    var team        = all.filter(function(p){ return p.role.startsWith("company-member"); });
    var female      = all.filter(function(p){ return p.gender === "female"; });

    console.log("\n📊 persons summary");
    console.log("   total:          " + all.length);
    console.log("   with slug:      " + withSlug.length);
    console.log("   display-only:   " + withoutSlug.length + " (will be resolved when scraped)");
    console.log("   role=lead:      " + leads.length);
    console.log("   company team:   " + team.length);
    console.log("   gender=female:  " + female.length + "  (rest default male)");

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(),
        counts: {
            total: all.length, withSlug: withSlug.length, withoutSlug: withoutSlug.length,
            leads: leads.length, team: team.length, female: female.length,
        },
        persons: persons,
    }, null, 2));
    console.log("💾 wrote " + OUTPUT_FILE);

    fs.writeFileSync(UNRESOLVED_FILE, JSON.stringify({
        note: "Persons with no slug yet. After a fresh scraper_v2 run, re-run build_persons.js to resolve these.",
        count: withoutSlug.length,
        persons: withoutSlug.map(function(p){ return { id: p.id, displayName: p.displayName, aliases: p.displayAliases, sources: p.sources }; }),
    }, null, 2));
    console.log("💾 wrote " + UNRESOLVED_FILE);
}

build();
