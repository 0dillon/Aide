// Nigerian Pidgin, arriving through an English speech recognizer.
//
// The Web Speech API has no Pidgin model. `pcm` is not a language tag it
// accepts, so `en-NG` is the closest available and pidgin comes back rendered
// as the nearest English words — "dey" as "day", "wetin" as "we tin", "sabi"
// as "savvy", "comot" as "come out". The agent then reads English that means
// something else, or nothing, and asks the user to repeat themselves.
//
// THE RULE THAT OUTRANKS EVERYTHING HERE: never touch anything that could be
// an amount. This text becomes a withdrawal. Misunderstanding a sentence costs
// one "sorry, say that again"; rewriting "one thousand" costs a worker money
// they cannot see to check. Every rule below is anchored on words that make
// the number reading impossible.

// Words that only appear in pidgin, used to score a candidate transcript.
// Deliberately excludes anything that is also ordinary English ("day", "one",
// "come out"), so the score cannot be inflated by an English sentence.
const MARKERS = [
  "abeg",
  "wetin",
  "dey",
  "comot",
  "sabi",
  "una",
  "oya",
  "abi",
  "wahala",
  "naija",
  "biko",
  "shey",
  "chop",
  "waka",
  "yawa",
  "gbese",
  "kudi",
  "ego",
  "oga",
  "madam",
  "pikin",
  "wey",
  "make i",
  "no be",
  "na so",
  "how far",
  "i go",
  "e go",
  "e be",
  "dem",
];

// How much a transcript reads as Pidgin. Used only to choose between the
// recognizer's own alternatives — never to reject what the user said.
export function pidginScore(text: string): number {
  const t = ` ${text.toLowerCase()} `;
  let score = 0;
  for (const m of MARKERS) {
    // Word-boundary anchored so "dem" does not match "modem" and "ego" does
    // not match "category".
    const re = new RegExp(`(^|[^a-z])${m.replace(/ /g, "\\s+")}([^a-z]|$)`, "g");
    score += (t.match(re) ?? []).length;
  }
  return score;
}

// The Web Speech API returns several candidate transcriptions ranked by its
// own English language model, which systematically prefers English readings of
// pidgin. The right words are often present but second.
//
// The first alternative wins ties and wins outright unless another is
// STRICTLY more pidgin — the recognizer is better at this than the heuristic
// is, and should only be overruled on positive evidence.
export function bestAlternative(alternatives: string[]): string {
  if (alternatives.length === 0) return "";
  let best = alternatives[0];
  let bestScore = pidginScore(best);
  for (const alt of alternatives.slice(1)) {
    const score = pidginScore(alt);
    if (score > bestScore) {
      best = alt;
      bestScore = score;
    }
  }
  return best;
}

// Case is left exactly as the recognizer produced it, apart from the words
// being replaced. An earlier version tried to carry the leading capital across
// and turned "I dey" into "I Dey" — capitalisation is not worth a rule that
// can misfire on text headed for a money command.

// Ordered. Each entry is anchored on context that rules out the English
// reading — that anchoring is the whole safety argument.
const REPAIRS: Array<[RegExp, string]> = [
  // "wetin" — the recognizer splits it or spells it phonetically. No English
  // reading of "we tin" exists, so this is unconditional.
  [/\bwe\s+tin\b/gi, "wetin"],
  [/\bweting\b/gi, "wetin"],
  [/\bwe\s+ting\b/gi, "wetin"],

  // "abeg" (please). "I beg" and "a beg" are how it lands. In Nigerian usage
  // "I beg" IS this word, so nothing is lost.
  [/\b(?:i|a)\s+beg\b/gi, "abeg"],

  // "dey" — only where "day" cannot be a day. Anchored on a pronoun or
  // negation in front, or a possessive/preposition behind. "every day",
  // "three day", "next day" are untouched because none of these match.
  [/\b(i|you|we|dem|e|he|she|they|it|no|money|work|who|wetin|dis|this)\s+day\b/gi, "$1 dey"],
  [/\bday\s+(my|your|our|their|for|there|here|inside|come|go|find|wait|work)\b/gi, "dey $1"],

  // "comot" (take out / remove). "come out my money" is not English.
  [/\bcome\s+out\s+(my|the|all)\b/gi, "comot $1"],

  // "sabi" (know). "savvy" is the recognizer's nearest word.
  [/\bsavvy\b/gi, "sabi"],

  // "wan" (want). ONLY after a pronoun and ONLY when what follows is not a
  // number — "I one thousand naira" is a badly-spoken amount, not "I want".
  // This is the rule that would do real damage if it were loose.
  [
    /\b(i|we|you|dem|e|he|she|they)\s+one\s+(?!hundred|thousand|million|billion|naira|zero|one|two|three|four|five|six|seven|eight|nine|ten|\d)/gi,
    "$1 wan ",
  ],

  // "una" (you plural), heard as two words.
  [/\byou\s+nah\b/gi, "una"],
  [/\boona\b/gi, "una"],

  // "oya" (come on / let's go).
  [/\boh\s+ya\b/gi, "oya"],
];

export function normalizePidgin(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPAIRS) out = out.replace(pattern, replacement);
  // Collapse whitespace the substitutions may have doubled, without trimming
  // meaning.
  return out.replace(/[ \t]{2,}/g, " ").trim();
}
