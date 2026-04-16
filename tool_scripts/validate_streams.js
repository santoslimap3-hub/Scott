/**
 * validate_streams.js — sanity-check person_streams.json before JSONL gen.
 *
 * Checks:
 *   1. Every event has a ts that parses to a real date.
 *   2. Events per person are monotonically non-decreasing by ts.
 *   3. DM row count in streams matches DM CSV row count (within dropped window).
 *   4. Every Scott post/comment in the v2 scrape is represented somewhere.
 *   5. Gendered-language flags: count cases where speaker=scott+text includes
 *      "bro|brother|king|my man" AND the OTHER party in the stream is female.
 *   6. Excluded-stream check: every company×company stream is flagged.
 *
 * Exits non-zero if any hard check fails. Soft checks are printed.
 */

const fs   = require("fs");
const path = require("path");

const ROOT          = path.resolve(__dirname, "..");
const DATA_DIR      = path.join(ROOT, "data");
const STREAMS_FILE  = path.join(DATA_DIR, "person_streams.json");
const PERSONS_FILE  = path.join(DATA_DIR, "persons.json");
const V2_POSTS      = path.join(ROOT, "scraper", "output", "posts_scott_v2.json");
const DM_CSV        = path.join(DATA_DIR, "dm-classified.csv");

function readJSON(p, fb){ if(!fs.existsSync(p)) return fb; try{ return JSON.parse(fs.readFileSync(p,"utf8")); } catch(_){ return fb; } }

function parseCSV(text){var rows=[],row=[],f="",q=false;for(var i=0;i<text.length;i++){var c=text[i];if(q){if(c==='"'&&text[i+1]==='"'){f+='"';i++;}else if(c==='"')q=false;else f+=c;}else{if(c==='"')q=true;else if(c===','){row.push(f);f="";}else if(c==='\n'){row.push(f);rows.push(row);row=[];f="";}else if(c==='\r'){}else f+=c;}}if(f.length||row.length){row.push(f);rows.push(row);}return rows;}

function main() {
    console.log("\n🔎 Validating person_streams.json ...");
    var hardFails = 0, softFails = 0;

    var streamsDoc = readJSON(STREAMS_FILE, null);
    if (!streamsDoc) { console.error("streams file missing"); process.exit(1); }
    var personsDoc = readJSON(PERSONS_FILE, null);
    if (!personsDoc) { console.error("persons file missing"); process.exit(1); }

    var streams = streamsDoc.streams;

    // 1. ts parseable
    var badTs = 0;
    Object.values(streams).forEach(function(s) {
        s.events.forEach(function(e) {
            if (!e.ts || isNaN(new Date(e.ts).getTime())) badTs++;
        });
    });
    if (badTs > 0) { console.error("❌ " + badTs + " events with unparseable ts"); hardFails++; }
    else           { console.log("✅ all events have parseable ts"); }

    // 2. monotonic
    var outOfOrder = 0;
    Object.values(streams).forEach(function(s) {
        var prev = null;
        s.events.forEach(function(e) {
            if (prev && e.ts < prev) outOfOrder++;
            prev = e.ts;
        });
    });
    if (outOfOrder > 0) { console.error("❌ " + outOfOrder + " out-of-order events (post-sort — should be 0)"); hardFails++; }
    else                 { console.log("✅ events monotonic per person"); }

    // 3. DM count check
    if (fs.existsSync(DM_CSV)) {
        var rows = parseCSV(fs.readFileSync(DM_CSV, "utf8"));
        var csvCount = Math.max(0, rows.length - 1);  // header
        var dmEvents = 0;
        Object.values(streams).forEach(function(s){ s.events.forEach(function(e){ if(e.channel==="dm") dmEvents++; }); });
        if (Math.abs(csvCount - dmEvents) > csvCount * 0.01) {
            console.error("❌ DM count mismatch: CSV=" + csvCount + ", streams=" + dmEvents);
            hardFails++;
        } else {
            console.log("✅ DM count aligned (csv=" + csvCount + ", stream=" + dmEvents + ")");
        }
    }

    // 4. Every Scott scrape message represented (mirrored counts)
    var v2 = readJSON(V2_POSTS, null);
    if (v2 && v2.posts) {
        var scottCommentsV2 = 0;
        v2.posts.forEach(function(p) {
            p.threads.forEach(function(th) {
                if (th.comment.isTarget) scottCommentsV2++;
                th.replies.forEach(function(r){ if (r.isTarget) scottCommentsV2++; });
            });
        });
        var scottStreamEvents = 0;
        Object.values(streams).forEach(function(s){
            s.events.forEach(function(e){
                if (e.speaker === "scott" && e.channel === "comment" && !e.mirroredFromThread) scottStreamEvents++;
            });
        });
        if (scottStreamEvents < scottCommentsV2) {
            console.error("⚠  Scott comment count low: scrape=" + scottCommentsV2 + ", streams=" + scottStreamEvents);
            softFails++;
        } else {
            console.log("✅ Scott comment coverage OK (scrape=" + scottCommentsV2 + ", streams=" + scottStreamEvents + ")");
        }
    }

    // 5. Gender-conflict flags
    var brRegex = /\b(bro|brother|brothers|king|my man|kings|bruv)\b/i;
    var femaleConflicts = [];
    Object.values(streams).forEach(function(s) {
        var person = s.person;
        if (!person || person.gender !== "female") return;
        s.events.forEach(function(e) {
            if (e.speaker === "scott" && brRegex.test(e.text || "")) {
                femaleConflicts.push({ person: person.displayName, id: person.id, text: (e.text||"").substring(0, 120), ts: e.ts });
            }
        });
    });
    if (femaleConflicts.length > 0) {
        console.log("⚠  " + femaleConflicts.length + " Scott messages used masculine address with a female person. Listing first 10:");
        femaleConflicts.slice(0, 10).forEach(function(c){
            console.log("   [" + c.ts + "] " + c.person + " → " + c.text);
        });
        softFails++;
    } else {
        console.log("✅ no masculine-to-female Scott messages flagged");
    }

    // 6. Company×company exclusion
    var companyPairs = 0;
    Object.values(streams).forEach(function(s) {
        if (!s.person) return;
        var isCompany = s.person.role && s.person.role.indexOf("company-member") === 0;
        var isScott   = s.person.id === "scott-northwolf";
        if (isCompany && !isScott) {
            companyPairs++;
            if (!s.excludeFromTraining) {
                console.error("❌ company-member stream NOT flagged excludeFromTraining: " + s.person.displayName);
                hardFails++;
            }
        }
    });
    console.log("✅ " + companyPairs + " company-member streams reviewed for exclusion");

    // ─── summary ───────────────────────────────────────────────────────────
    console.log("\n─── validation summary ───");
    console.log("   hard fails: " + hardFails);
    console.log("   soft fails: " + softFails);
    console.log("   (hard fails block JSONL gen; soft fails are warnings)");
    if (hardFails > 0) process.exit(1);
}

main();
