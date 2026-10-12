/**
 * Time in a memory query, read deterministically (no model): "yesterday", "last week", "3 days ago", "in March",
 * "in August 2025", "on 3 June 2025", "2025-11-03", "last spring", "in autumn 2025", "this year", "the first
 * run", "the most recent run", "before February 2026", "before our price change". Dates are calendar days in the
 * user's time zone (offsetMinutes east of UTC); ranges are half-open [from, to) instants (ISO). Months, days and
 * bare years count only after a preposition ("in 2025", "on 3 June"), so a name such as "the 2024 tax return" or
 * "the Q2 update" is not taken for a time. Seasons are the northern meteorological ones (spring: March to May).
 * Pure.
 */

/** A time the query names. */
export interface TimeQuery {
  /** The period it asks about: [from, to) instants (ISO); either may be open. */
  from?: string;
  to?: string;
  /** It asks for the first or the most recent of what matches. */
  order?: "first" | "last";
  /** "before / after <something that happened>": the words naming it, to be found among dated memories. */
  anchor?: { side: "before" | "after"; words: string };
  /** It asks what something was earlier ("before", "used to", "previously"): replaced values matter. */
  past: boolean;
  /** It asks for the value now ("now", "currently", "these days", "still"). */
  current: boolean;
  /** The query without its time words (for matching what it is about). */
  rest: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = `(${MONTHS.map((m) => `${m}|${m.slice(0, 3)}`).join("|")})\\.?`;
/** First month (0-based) of each season, and its length in months. */
const SEASONS: Record<string, number> = { spring: 2, summer: 5, autumn: 8, fall: 8, winter: 11 };
const SEASON_MONTHS = 3;
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUMBER_RE = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")})`;
/** Words after which a month, a day or a bare year is a time. */
const PREP = `(?:in|on|during|since|until|till|before|after|from|by|around|of|throughout|for)`;
const PAST_RE = /\b(before|previous(?:ly)?|used to|formerly|originally|prior|earlier|old)\b/i;
const CURRENT_RE = /\b(now|current(?:ly)?|these days|nowadays|still|any ?more|at the moment)\b/i;
const FIRST_RE = /\b(first|earliest|initial)\b/i;
/** "at the earliest / at the latest" bound a time; they do not ask for the first or the last of anything. */
const AT_THE_RE = /\bat the (earliest|latest)\b/gi;
/** Words that only say which one or when (the order, "now"), not what the query is about. */
const CUE_WORDS_RE = /\b(first|earliest|initial|latest|most recent|newest|now|current(?:ly)?|these days|nowadays|still|any ?more|at the moment)\b/gi;
/** "last" as an order (the last run), not a period (last spring, last week): */
const LAST_RE = /\b(latest|most recent|newest|last(?!\s+(?:spring|summer|autumn|fall|winter|week|month|year|night|\d|few|couple|january|february|march|april|may|june|july|august|september|october|november|december)))\b/i;

const DAY_MS = 86_400_000;

type Range = { from: number; to: number };

/** The local calendar of `now` (offsetMinutes east of UTC) and a way back to instants. */
function calendar(now: Date, offsetMinutes: number) {
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  const at = (y: number, m: number, d = 1) => Date.UTC(y, m, d) - offsetMinutes * 60_000;
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), dow: (local.getUTCDay() + 6) % 7, at };
}

const monthOf = (name: string): number => MONTHS.findIndex((m) => name.toLowerCase().startsWith(m.slice(0, 3)));
const count = (w: string): number => NUMBER_WORDS[w.toLowerCase()] ?? Number(w);

interface Found {
  range: Range;
  index: number;
  length: number;
}

/** Every period `text` names, with where it is named. */
function periods(text: string, now: Date, offsetMinutes: number): Found[] {
  const cal = calendar(now, offsetMinutes);
  const out: Found[] = [];
  const add = (m: RegExpMatchArray, range: Range) => out.push({ range, index: m.index!, length: m[0].length });
  const day = (y: number, mo: number, d: number): Range => ({ from: cal.at(y, mo, d), to: cal.at(y, mo, d + 1) });
  const month = (y: number, mo: number): Range => ({ from: cal.at(y, mo), to: cal.at(y, mo + 1) });
  /** The most recent `mo` that has begun (this year's, else last year's). */
  const recentYear = (mo: number) => (mo <= cal.m ? cal.y : cal.y - 1);
  const today = cal.at(cal.y, cal.m, cal.d);

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(m, day(+m[1]!, +m[2]! - 1, +m[3]!));
  for (const m of text.matchAll(new RegExp(`\\b${PREP}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?\\b`, "gi"))) {
    const mo = monthOf(m[2]!);
    add(m, day(m[3] ? +m[3] : recentYear(mo), mo, +m[1]!));
  }
  for (const m of text.matchAll(new RegExp(`\\b${PREP}\\s+${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!\\d)`, "gi"))) {
    const mo = monthOf(m[1]!);
    if (+m[2]! >= 1 && +m[2]! <= 31) add(m, day(m[3] ? +m[3] : recentYear(mo), mo, +m[2]!));
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:${PREP}|last|this)\\s+${MONTH_RE}(?:\\s+(\\d{4}))?\\b(?!\\s+\\d{1,2}\\b)`, "gi"))) {
    const mo = monthOf(m[1]!);
    const lastOne = /^last\b/i.test(m[0]);
    add(m, month(m[2] ? +m[2] : lastOne && mo >= cal.m ? cal.y - 1 : recentYear(mo), mo));
  }
  for (const m of text.matchAll(new RegExp(`\\b${PREP}\\s+(?:the\\s+year\\s+)?((?:19|20)\\d{2})\\b(?![-./]\\d)`, "gi"))) add(m, { from: cal.at(+m[1]!, 0), to: cal.at(+m[1]! + 1, 0) });

  for (const m of text.matchAll(/\b(?:(last|this|past)\s+|in\s+(?:the\s+)?)?(spring|summer|autumn|fall|winter)(?:\s+(?:of\s+)?(\d{4}))?\b/gi)) {
    const first = SEASONS[m[2]!.toLowerCase()]!;
    const which = m[1]?.toLowerCase();
    let y: number;
    if (m[3]) y = +m[3];
    else {
      // The most recent start of that season; "last": the most recent one that has ended.
      y = first <= cal.m ? cal.y : cal.y - 1;
      const ends = cal.at(y, first + SEASON_MONTHS);
      if ((which === "last" || which === "past") && ends > now.getTime()) y -= 1;
    }
    add(m, { from: cal.at(y, first), to: cal.at(y, first + SEASON_MONTHS) });
  }

  for (const m of text.matchAll(/\b(today|tonight|this morning|this afternoon|this evening)\b/gi)) add(m, { from: today, to: today + DAY_MS });
  for (const m of text.matchAll(/\b(yesterday|last night)\b/gi)) add(m, { from: today - DAY_MS, to: today });
  for (const m of text.matchAll(/\b(this|last)\s+(week|month|year)\b/gi)) {
    const back = m[1]!.toLowerCase() === "last" ? 1 : 0;
    const unit = m[2]!.toLowerCase();
    if (unit === "week") {
      const monday = today - cal.dow * DAY_MS - back * 7 * DAY_MS;
      add(m, { from: monday, to: monday + 7 * DAY_MS });
    } else if (unit === "month") add(m, month(cal.y, cal.m - back));
    else add(m, { from: cal.at(cal.y - back, 0), to: cal.at(cal.y - back + 1, 0) });
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:(?:in\\s+)?the\\s+)?(?:last|past)\\s+${NUMBER_RE}\\s+(day|week|month|year)s?\\b`, "gi"))) {
    const n = count(m[1]!);
    add(m, { from: back(cal, m[2]!, n), to: now.getTime() });
  }
  for (const m of text.matchAll(new RegExp(`\\b${NUMBER_RE}\\s+(day|week|month|year)s?\\s+ago\\b`, "gi"))) {
    const n = count(m[1]!);
    const unit = m[2]!.toLowerCase();
    // "3 days ago": that day; "2 weeks ago": that week, give or take; "a month ago": that month.
    const at = back(cal, unit, n);
    const span = unit === "day" ? DAY_MS : unit === "week" ? 7 * DAY_MS : unit === "month" ? 31 * DAY_MS : 366 * DAY_MS;
    add(m, unit === "day" ? { from: at, to: at + DAY_MS } : { from: at - span / 2, to: at + span / 2 });
  }
  return out;
}

/** The instant `n` units before today's start. */
function back(cal: ReturnType<typeof calendar>, unit: string, n: number): number {
  const u = unit.toLowerCase();
  if (u === "day") return cal.at(cal.y, cal.m, cal.d - n);
  if (u === "week") return cal.at(cal.y, cal.m, cal.d - 7 * n);
  if (u === "month") return cal.at(cal.y, cal.m - n, cal.d);
  return cal.at(cal.y - n, cal.m, cal.d);
}

/** The time `text` names, if any (nothing: only `rest`, `past` and `current`). */
export function parseTime(text: string, now: Date, offsetMinutes = 0): TimeQuery {
  const found = periods(text, now, offsetMinutes).sort((a, b) => a.index - b.index || b.length - a.length);
  // Overlapping matches: the first, longest one wins.
  const kept: Found[] = [];
  for (const f of found) if (!kept.some((k) => f.index < k.index + k.length && k.index < f.index + f.length)) kept.push(f);

  const q: TimeQuery = { past: PAST_RE.test(text), current: CURRENT_RE.test(text), rest: text };
  const bound = /\b(before|after|since|prior to|until|till)\s+(.+?)(?=[?.!;,]|$)/i.exec(text);
  const side = bound ? (/^(after|since)$/i.test(bound[1]!) ? "after" : "before") : undefined;
  // A period named after "before"/"after" bounds the range; any other period is the range.
  const inBound = bound ? kept.filter((k) => k.index >= bound.index && k.index < bound.index + bound[0].length) : [];
  const plain = kept.filter((k) => !inBound.includes(k));
  if (plain.length) {
    q.from = iso(Math.min(...plain.map((k) => k.range.from)));
    q.to = iso(Math.max(...plain.map((k) => k.range.to)));
  }
  if (bound && side) {
    if (inBound.length) {
      if (side === "before") q.to = iso(Math.min(...inBound.map((k) => k.range.from)));
      else q.from = iso(Math.max(...inBound.map((k) => k.range.to)));
    } else {
      const words = bound[2]!.replace(/^(?:the|our|my|we|i|you)\s+/i, "").trim();
      if (words) q.anchor = { side, words };
    }
    // "right after X" asks for the first thing after it; "just before X" the last before it.
    if (!q.order) q.order = side === "after" ? "first" : "last";
  }
  const ordered = text.replace(AT_THE_RE, " ");
  if (FIRST_RE.test(ordered)) q.order = "first";
  else if (LAST_RE.test(ordered)) q.order = "last";

  let rest = text;
  // A period's possessive goes with it ("last week's payouts" -> "payouts").
  for (const k of [...kept].sort((a, b) => b.index - a.index)) rest = `${rest.slice(0, k.index)} ${rest.slice(k.index + k.length).replace(/^['’]s\b/, "")}`;
  if (bound && q.anchor) rest = rest.replace(bound[0], " ");
  q.rest = rest.replace(CUE_WORDS_RE, " ").replace(/\s+/g, " ").trim();
  return q;
}

const iso = (t: number) => new Date(t).toISOString();

/** Whether the query names a time at all (a period, an order, or an anchor). */
export const namesTime = (q: TimeQuery): boolean => q.from !== undefined || q.to !== undefined || q.order !== undefined || q.anchor !== undefined;
