/**
 * build_v7_jsonl.js — generate finetune_data_v7.jsonl from person_streams.
 *
 * WHAT'S NEW vs v6:
 *   1. PER-PERSON HISTORY. Each training row is one Scott response with the
 *      FULL prior history of interactions with that person across channels
 *      (DMs + post comments). Cross-channel continuity.
 *
 *   2. ⟨BUBBLE⟩ DELIMITER. Consecutive Scott DMs (contiguous speaker=scott
 *      in the same DM stream with no intervening lead message) are joined
 *      with ⟨BUBBLE⟩. The bot splits on this at inference and sends each
 *      segment as a SEPARATE message bubble. Post-comment replies never use
 *      the delimiter (Skool comments can't be multi-bubble).
 *
 *   3. --- PERSON --- BLOCK. Added to the user content:
 *         Name, Gender, Role
 *      So the model knows who it's talking to. Forces "sister" instead of
 *      "bro" when Gender=female, avoids pitching company members.
 *
 *   4. EXCLUDES company×company streams entirely.
 *
 *   5. GENDER CLEANUP: any training example where Scott addresses a female
 *      with masculine vocatives is dropped (logged to a report file) so
 *      the new PERSON block isn't contradicted by bad training data.
 *
 * OUTPUT:
 *   data/fine_tune/finetune_data_v7.jsonl
 *   data/fine_tune/v7_build_report.json   — per-stream counts, dropped examples
 */

const fs   = require("fs");
const path = require("path");

const ROOT          = path.resolve(__dirname, "..");
const DATA_DIR      = path.join(ROOT, "data");
const STREAMS_FILE  = path.join(DATA_DIR, "person_streams.json");
const OUT_JSONL     = path.join(DATA_DIR, "fine_tune", "finetune_data_v7.jsonl");
const OUT_REPORT    = path.join(DATA_DIR, "fine_tune", "v7_build_report.json");

const BUBBLE_DELIM = "⟨BUBBLE⟩";

// Two consecutive same-speaker events are only joined into ONE multi-bubble
// turn (⟨BUBBLE⟩-separated) if the time gap between them is at most this.
// Anything longer is treated as a new turn — which for Scott means a separate
// training example with the prior Scott message in HISTORY. That's how the
// model learns follow-up behavior after being ghosted.
//
// 5 minutes: covers real bubble bursts (typing three short thoughts in quick
// succession) without collapsing multi-day follow-up sequences.
const BUBBLE_MAX_GAP_MS = 5 * 60 * 1000;

const SYSTEM_PREAMBLE =
  "You are Jack Walford, appointment setter for Answer 42 and Self-Improvement Nation on Skool.\n\n" +
  "Your mentor and CEO is Scott Northwolf. You funnel qualified leads to book calls with him.\n\n" +
  "VOICE: Brotherhood energy. Raw, direct, high-energy. Never corporate. Speak like a man who's been through darkness and found the light. You reference philosophy, ancient wisdom and self-improvement naturally because you've lived it. Short punchy sentences. No bullet points, no dashes.\n\n" +
  "RULES: Never be needy. Never overexplain. Never use dashes or bullet formatting in messages. Create intrigue. You don't need them, they need what you have. Be the sun, not the chaser.\n\n" +
  "PERSON CONTEXT: Every user prompt begins with a --- PERSON --- block telling you Name, Gender, Role. If Gender is female, use 'sister,' 'queen,' or neutral address — never 'bro,' 'brother,' 'king.' If Role is company-member, this person is ON YOUR TEAM — speak peer to peer, never pitch. If Role is lead, they are a prospect.\n\n" +
  "MULTIPLE MESSAGE BUBBLES: In DMs you can split your reply into multiple bubbles by inserting " + BUBBLE_DELIM + " between them. This mimics real human texting where short thoughts are sent as separate messages. Use it when Scott would: two or three short hits beat one paragraph. Never use " + BUBBLE_DELIM + " in post/comment replies — only in DMs.";

const MASC_REGEX = /\b(bro|brother|brothers|king|my man|kings|bruv)\b/i;

function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

function escapeText(s) { return (s || "").toString(); }

// Build the --- PERSON --- block for the user content
function personBlock(person) {
    var name    = person.displayName || person.id;
    var gender  = person.gender || "male";
    var roleRaw = person.role || "lead";
    var roleLabel;
    if (roleRaw === "lead") roleLabel = "lead (prospect)";
    else if (roleRaw.indexOf("company-member") === 0) {
        var sub = roleRaw.replace("company-member:", "");
        roleLabel = "company-member (" + sub + ")";
    } else roleLabel = roleRaw;
    return "--- PERSON ---\nName: " + name + "\nGender: " + gender + "\nRole: " + roleLabel;
}

// Format one event for inclusion in the HISTORY block
function formatHistoryEvent(e, person) {
    var dt = (e.ts || "").substring(0, 16).replace("T", " ");
    if (e.channel === "dm") {
        var who = e.speaker === "scott" ? "Scott" : (person.displayName || "Them");
        return "[DM " + dt + "] " + who + ": " + escapeText(e.text);
    }
    if (e.channel === "post") {
        return "[POST " + dt + "] " + (person.displayName || "Them") + " posted \"" + (e.postTitle || "") + "\":\n" + escapeText(e.text);
    }
    if (e.channel === "comment") {
        var w = e.speaker === "scott" ? "Scott" : (person.displayName || "Them");
        return "[COMMENT " + dt + " on \"" + (e.postTitle || "") + "\"] " + w + ": " + escapeText(e.text);
    }
    return "[" + e.channel + " " + dt + "] " + escapeText(e.text);
}

/**
 * Group the stream into turn-chunks. Each chunk is a contiguous run of
 * same speaker×channel events that are WITHIN BUBBLE_MAX_GAP_MS of each other.
 *
 * BUBBLE_MAX_GAP_MS (5 min) is the threshold for consecutive "bubbles."
 * If Scott sends a message, then 30 minutes later sends another, those are
 * two separate TURNS (two training examples), not one multi-bubble message.
 *
 * This preserves Scott's "follow-up after ghosting" behavior as a distinct
 * pattern in the training data.
 */
function groupTurns(events) {
    var turns = [];
    var current = null;
    events.forEach(function(e) {
        var lastEvent = current && current.events.length > 0 ? current.events[current.events.length - 1] : null;
        var timeSinceLastMs = lastEvent ? (new Date(e.ts) - new Date(lastEvent.ts)) : Infinity;
        var sameSpeakerChannel = current && e.speaker === current.speaker && e.channel === current.channel;
        var withinBubbleGap = timeSinceLastMs <= BUBBLE_MAX_GAP_MS;

        if (sameSpeakerChannel && withinBubbleGap) {
            // Same speaker/channel AND within bubble gap → join with ⟨BUBBLE⟩
            current.events.push(e);
        } else {
            // New turn (different speaker, different channel, or time gap > 5 min)
            current = { speaker: e.speaker, channel: e.channel, events: [e] };
            turns.push(current);
        }
    });
    return turns;
}

function buildSystemFor(channel) {
    if (channel === "dm") return SYSTEM_PREAMBLE + "\n\nSITUATION: DM conversation on Skool.";
    if (channel === "comment") return SYSTEM_PREAMBLE + "\n\nSITUATION: Replying to a Skool post comment.";
    if (channel === "post") return SYSTEM_PREAMBLE + "\n\nSITUATION: Replying to a Skool post.";
    return SYSTEM_PREAMBLE;
}

/**
 * Render assistant content for a Scott turn.
 *  - If DM channel: join events' text with BUBBLE_DELIM.
 *  - Else: events should typically be 1; join with \n\n as a fallback.
 */
function renderAssistant(turn) {
    var texts = turn.events.map(function(e){ return e.text || ""; }).filter(Boolean);
    if (turn.channel === "dm") return texts.join(BUBBLE_DELIM);
    return texts.join("\n\n");
}

/**
 * Render the user content (history + PERSON block).
 *
 * For the last "trigger" event before the Scott turn, we also isolate it
 * in a --- REPLY TO --- block so the model sees the exact message Scott
 * is responding to. Everything prior is HISTORY context.
 */
function renderUser(person, priorEvents, triggerTurn) {
    var parts = [];
    parts.push(personBlock(person));

    if (priorEvents.length > 0) {
        parts.push("--- HISTORY ---");
        priorEvents.forEach(function(e){ parts.push(formatHistoryEvent(e, person)); });
    }

    // REPLY TO = the last lead turn BEFORE the Scott turn, if any
    if (triggerTurn) {
        parts.push("--- REPLY TO ---");
        var label;
        if (triggerTurn.channel === "dm")     label = "[DM] " + (person.displayName || "Them");
        else if (triggerTurn.channel === "post")    label = "[POST] " + (person.displayName || "Them");
        else                                   label = "[COMMENT] " + (person.displayName || "Them");
        triggerTurn.events.forEach(function(e){ parts.push(label + ": " + (e.text || "")); });
    }

    return parts.join("\n");
}

function build() {
    console.log("\n📝 Building finetune_data_v7.jsonl ...");
    if (!fs.existsSync(path.dirname(OUT_JSONL))) fs.mkdirSync(path.dirname(OUT_JSONL), { recursive: true });

    var doc = readJSON(STREAMS_FILE);
    var streams = doc.streams;

    var examplesWritten = 0;
    var droppedEmpty    = 0;
    var droppedMasc     = 0;   // masculine-to-female
    var droppedCompany  = 0;   // company×company
    var droppedOther    = 0;
    var perChannel      = { dm: 0, comment: 0, post: 0 };
    var droppedExamples = [];
    var out = fs.createWriteStream(OUT_JSONL);

    Object.values(streams).forEach(function(s) {
        if (s.excludeFromTraining) { droppedCompany++; return; }
        var person = s.person;
        var turns  = groupTurns(s.events);

        // Walk turns: every Scott turn produces one training example,
        // with HISTORY = all events before this turn's first event.
        var flatPriorEvents = [];
        for (var i = 0; i < turns.length; i++) {
            var turn = turns[i];
            if (turn.speaker !== "scott") {
                turn.events.forEach(function(e){ flatPriorEvents.push(e); });
                continue;
            }

            // Trigger = the previous non-scott turn (often lead DM or lead comment)
            var triggerTurn = null;
            for (var j = i - 1; j >= 0; j--) {
                if (turns[j].speaker !== "scott") { triggerTurn = turns[j]; break; }
            }

            var assistantText = renderAssistant(turn);
            if (!assistantText.trim()) { droppedEmpty++; continue; }

            // Gender cleanup: female person + masculine vocative in assistant
            if (person.gender === "female" && MASC_REGEX.test(assistantText)) {
                droppedMasc++;
                if (droppedExamples.length < 20) droppedExamples.push({
                    reason: "masculine-to-female", person: person.displayName, text: assistantText.substring(0, 160),
                });
                // push turn events to flatPriorEvents for future examples, then skip
                turn.events.forEach(function(e){ flatPriorEvents.push(e); });
                continue;
            }

            // Pick system prompt based on THIS Scott turn's channel
            var systemContent = buildSystemFor(turn.channel);

            // HISTORY = all events that happened strictly before this turn
            var priorForExample = flatPriorEvents.slice();

            var userContent = renderUser(person, priorForExample, triggerTurn);

            var example = {
                messages: [
                    { role: "system",    content: systemContent },
                    { role: "user",      content: userContent },
                    { role: "assistant", content: assistantText },
                ],
            };
            out.write(JSON.stringify(example) + "\n");
            examplesWritten++;
            perChannel[turn.channel] = (perChannel[turn.channel] || 0) + 1;

            // Add this turn's events to the prior log for subsequent examples
            turn.events.forEach(function(e){ flatPriorEvents.push(e); });
        }
    });

    out.end();
    var report = {
        generatedAt: new Date().toISOString(),
        examplesWritten: examplesWritten,
        perChannel: perChannel,
        droppedCompanyCompanyStreams: droppedCompany,
        droppedEmptyAssistant: droppedEmpty,
        droppedMasculineToFemale: droppedMasc,
        droppedOther: droppedOther,
        sampleDroppedExamples: droppedExamples,
        bubbleDelimiter: BUBBLE_DELIM,
    };
    fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 2));

    console.log("\n📊 v7 build summary");
    console.log("   examples written:      " + examplesWritten);
    console.log("   per channel:           " + JSON.stringify(perChannel));
    console.log("   dropped company×co:    " + droppedCompany + " streams");
    console.log("   dropped empty:         " + droppedEmpty);
    console.log("   dropped masc→female:   " + droppedMasc);
    console.log("💾 wrote " + OUT_JSONL);
    console.log("💾 wrote " + OUT_REPORT);
}

build();
