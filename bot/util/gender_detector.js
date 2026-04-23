// ── Gender Detector ───────────────────────────────────────────────────────────
// Lightweight first-name heuristic for the rare case the LLM classifier
// doesn't return a gender field. Not exhaustive — covers the most common
// Western and Spanish/Portuguese names that appear in Self-Improvement Nation.
//
// Returns "male", "female", or "unknown".

var FEMALE_NAMES = new Set([
    "aaliyah","abby","abigail","ada","adele","adriana","agnes","alejandra","alessia",
    "alexa","alexandra","alexis","alice","alicia","alina","alisa","alisha","alison",
    "alissa","alix","alma","amalia","amanda","amelia","amelie","amy","ana","anastasia",
    "andrea","angela","angelica","angelina","anita","anna","anne","annette","antonia",
    "aria","ariana","arielle","ashley","astrid","aurora","ava","barbara","beatrice",
    "beatriz","belinda","bella","bianca","brigitte","camila","camille","carolina",
    "caroline","catherine","cecilia","celeste","chloe","christina","christine","ciara",
    "claire","clara","claudia","colette","connie","cynthia","daisy","dana","daniela",
    "deborah","diana","dina","dominique","donna","dorothy","elena","elisa","elisabetta",
    "elizabeth","ella","ellen","elsa","emily","emma","erika","esther","eva","evelyn",
    "fatima","fiona","florence","francesca","gabriela","grace","hanna","hannah",
    "helen","helena","ida","ilse","imogen","ines","ingrid","irene","isabella",
    "isla","ivana","jacqueline","jade","jana","jane","jasmine","jessica","joanna",
    "joelle","josephine","julia","julie","julieta","karen","kate","katharine",
    "katherine","kathryn","katia","katrina","kim","kira","krista","kristina",
    "larissa","laura","lauren","lea","leah","leila","lena","lily","linda","lisa",
    "lotte","louise","lucia","lucy","luna","lydia","madeleine","magda","manon",
    "margaret","margaux","maria","mariana","marie","marina","marta","martina",
    "mary","maya","mel","melissa","mia","michelle","miranda","monica","nadia",
    "natalia","natalie","nina","nora","olivia","paola","patricia","paula","petra",
    "philippa","rachel","rebecca","renata","rosa","rose","sabrina","samantha",
    "sandra","sara","sarah","simone","sofia","sophia","stephanie","susan","suzanne",
    "svetlana","sylvia","tamara","tanya","teresa","tina","valeria","valentina",
    "vanessa","vera","veronica","victoria","vicky","violet","virginia","vivian",
    "wendy","ximena","yasmin","zoe","zoé",
]);

var MALE_NAMES = new Set([
    "aaron","adam","adrien","ahmed","aidan","alan","albert","alejandro","alex",
    "alexander","alexei","alfred","ali","alvin","amadeus","amaru","ameet","anders",
    "andre","andrew","andy","angel","angelo","anthony","anton","antonio","arthur",
    "aryan","ash","ashley","austin","axel","ayaan","baptiste","bart","ben",
    "benedict","benjamin","bill","bob","boris","brad","brandon","brian","bruce",
    "bruno","caleb","cameron","carlos","charles","chris","christian","christoph",
    "christopher","claude","cole","colin","conor","daniel","david","david","dean",
    "dennis","derek","diego","dmitri","dominic","donald","dorian","douglas",
    "drew","dylan","ed","edgar","eduardo","edward","eli","elias","emilio",
    "eric","erwin","ethan","evan","ezra","fabian","felix","fernando","filip",
    "finn","florian","francisco","frank","fred","frederic","gabriel","gavin",
    "george","gerard","gerhard","giovanni","glen","greg","guillaume","guy",
    "hamish","hans","harry","hassan","hector","henry","hugo","ian","ignacio",
    "ivan","jack","jacob","jake","james","jared","jason","javier","jay",
    "jean","jeff","jeremy","jess","jesus","joel","john","jonathan","jordan",
    "jorge","jose","joseph","josh","joshua","juan","julian","justin","kai",
    "kevin","kilian","kyle","lars","leo","leon","liam","logan","louis",
    "luca","lucas","luis","luke","marc","marco","marcus","mark","martin",
    "mathieu","matt","matthew","max","maxime","michael","michel","miguel",
    "mike","miles","mitchell","morgan","nathan","neil","nico","nicholas",
    "nick","nicolas","noah","noel","nolan","oliver","omar","oscar","owen",
    "pablo","patrick","paul","pedro","peter","philip","pierre","rafael",
    "ramon","raphael","raul","raymond","remi","renaud","ricardo","richard",
    "rick","rob","robert","rodrigo","roman","ruben","ryan","samuel","scott",
    "sean","sebastian","sergei","simeon","simon","stefan","stephen","steven",
    "thomas","tim","tobias","tom","tyler","victor","vincent","vinh","vlad",
    "walter","william","xavier","yannis","zachary","zach",
]);

/**
 * Guess gender from a display name (first name lookup).
 * @param {string} fullName - e.g. "Lucas Premat" or "Lea Newkirk"
 * @returns {"male"|"female"|"unknown"}
 */
function guessGender(fullName) {
    if (!fullName || typeof fullName !== "string") return "unknown";

    // Extract first name — handle "FirstName LastName" or "FirstName"
    var firstName = fullName.trim().split(/\s+/)[0].toLowerCase();

    // Strip accents for comparison (e.g. "Léa" → "lea")
    firstName = firstName.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    if (FEMALE_NAMES.has(firstName)) return "female";
    if (MALE_NAMES.has(firstName))   return "male";
    return "unknown";
}

module.exports = { guessGender: guessGender };
