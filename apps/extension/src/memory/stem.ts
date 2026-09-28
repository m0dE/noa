/**
 * The Porter stemmer (M. F. Porter, "An algorithm for suffix stripping", 1980), as in Porter's own reference
 * implementations (https://tartarus.org/martin/PorterStemmer/), so "booked", "booking" and "books" all match
 * "book", and "cancelled" matches "cancel". English only: a word with anything but the letters a-z (another
 * script, digits, an address) is returned as it is. Pure and deterministic.
 */

const STEP2: Record<string, string> = {
  ational: "ate",
  tional: "tion",
  enci: "ence",
  anci: "ance",
  izer: "ize",
  bli: "ble",
  alli: "al",
  entli: "ent",
  eli: "e",
  ousli: "ous",
  ization: "ize",
  ation: "ate",
  ator: "ate",
  alism: "al",
  iveness: "ive",
  fulness: "ful",
  ousness: "ous",
  aliti: "al",
  iviti: "ive",
  biliti: "ble",
  logi: "log",
};
const STEP3: Record<string, string> = { icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "" };

// A consonant is a letter other than a e i o u, and other than y after a consonant; m() counts VC sequences.
const c = "[^aeiou]";
const v = "[aeiouy]";
const C = `${c}[^aeiouy]*`;
const V = `${v}[aeiou]*`;
/** m > 0 */
const MGR0 = new RegExp(`^(${C})?${V}${C}`);
/** m = 1 */
const MEQ1 = new RegExp(`^(${C})?${V}${C}(${V})?$`);
/** m > 1 */
const MGR1 = new RegExp(`^(${C})?${V}${C}${V}${C}`);
/** The stem has a vowel. */
const HAS_VOWEL = new RegExp(`^(${C})?${v}`);
/** Ends consonant-vowel-consonant, the last not w, x or y (*o). */
const CVC = new RegExp(`^${C}${v}[^aeiouwxy]$`);

/** Words shorter than this are not stemmed. */
const MIN_STEM_LENGTH = 3;
/** Stems remembered (words repeat across entries; past it the memo starts over). */
const MAX_MEMO = 50_000;
const memo = new Map<string, string>();

/** The word's stem ("reconciled" -> "reconcil", "flights" -> "flight"); a word that is not plain a-z as it is. */
export function stem(word: string): string {
  if (word.length < MIN_STEM_LENGTH || !/^[a-z]+$/.test(word)) return word;
  let s = memo.get(word);
  if (s === undefined) {
    if (memo.size >= MAX_MEMO) memo.clear();
    memo.set(word, (s = porter(word)));
  }
  return s;
}

function porter(word: string): string {
  let w = word;
  const firstY = w[0] === "y";
  if (firstY) w = `Y${w.slice(1)}`;

  // Step 1a: plurals.
  if (/^(.+?)(ss|i)es$/.test(w)) w = w.replace(/^(.+?)(ss|i)es$/, "$1$2");
  else if (/^(.+?)([^s])s$/.test(w)) w = w.replace(/^(.+?)([^s])s$/, "$1$2");

  // Step 1b: -eed, -ed, -ing.
  let m: RegExpExecArray | null;
  if ((m = /^(.+?)eed$/.exec(w))) {
    if (MGR0.test(m[1]!)) w = w.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(w)) && HAS_VOWEL.test(m[1]!)) {
    w = m[1]!;
    if (/(at|bl|iz)$/.test(w)) w += "e";
    else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
    else if (CVC.test(w)) w += "e";
  }

  // Step 1c: y -> i after a vowel in the stem.
  if ((m = /^(.+?)y$/.exec(w)) && HAS_VOWEL.test(m[1]!)) w = `${m[1]}i`;

  // Step 2 and 3: double and single suffixes, when the stem has m > 0.
  if ((m = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(w))) {
    if (MGR0.test(m[1]!)) w = m[1]! + STEP2[m[2]!];
  }
  if ((m = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w))) {
    if (MGR0.test(m[1]!)) w = m[1]! + STEP3[m[2]!];
  }

  // Step 4: suffixes dropped when the stem has m > 1.
  if ((m = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w))) {
    if (MGR1.test(m[1]!)) w = m[1]!;
  } else if ((m = /^(.+?)(s|t)(ion)$/.exec(w))) {
    if (MGR1.test(m[1]! + m[2]!)) w = m[1]! + m[2]!;
  }

  // Step 5: a final -e, and -ll.
  if ((m = /^(.+?)e$/.exec(w))) {
    const s = m[1]!;
    if (MGR1.test(s) || (MEQ1.test(s) && !CVC.test(s))) w = s;
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);

  return firstY ? `y${w.slice(1)}` : w;
}
