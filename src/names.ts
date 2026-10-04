// Names typed by a person, matched to what Qloo's search returned (ported from Booker, where 463 realistic
// inputs and 60 review passes pinned these rules). An exact name is preferred; otherwise a candidate is used
// only if it resembles what was typed, near names are ranked by how close they are, and "Not it?" offers only
// close names.

import { normalizeName, type Entity } from "./qloo.ts";

// Only a leading article is dropped ("The Empty Bottle" is Empty Bottle), and "&" is "and"; "of" stays,
// since of Montreal isn't Montreal.
const ARTICLES = new Set(["the", "a", "an"]);
const FOLD: Record<string, string> = { "\u00f8": "o", "\u00e6": "ae", "\u0153": "oe", "\u00df": "ss", "\u0142": "l", "\u0111": "d", "\u00fe": "th" };
// Accents are folded ("Beyonce" is Beyoncé); apostrophes, colons and dots join ("Cat's" is "Cats", "9:30"
// is "930"); other punctuation separates words.
const SPELLING: Record<string, string> = { theater: "theatre", amphitheater: "amphitheatre", centre: "center", ave: "avenue", blvd: "boulevard" };
// Letters written as signs read as letters: P!nk is Pink (between consonants only: GO!GO!7188 is "go go"),
// Ke$ha is Kesha, Joey Bada$$ is Badass, $uicideboy$ is Suicideboys.
const allWords = (s: string) =>
  normalizeName(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u00f8\u00e6\u0153\u00df\u0142\u0111\u00fe]/g, (c) => FOLD[c])
    .replace(/(?<=[b-df-hj-np-tv-z])!(?=[b-df-hj-np-tv-z])/g, "i")
    .replace(/\$+(?=\p{L})|(?<=\p{L})\$+/gu, (m) => "s".repeat(m.length))
    .replace(/[&+]/g, " and ") // "Florence + the Machine", "Simon & Garfunkel"
    .replace(/['\u2018\u2019`:.]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SPELLING[w] ?? w);
// "A" before an initial is an initial too: "A. R. Rahman", "A G Cook".
const article = (s: string, ws: string[]) => ws.length > 1 && ARTICLES.has(ws[0]) && !(ws[0] === "a" && (/^\s*a\./i.test(s) || ws[1].length === 1));
const words = (s: string) => {
  const ws = allWords(s);
  return article(s, ws) ? ws.slice(1) : ws;
};
// "The Empty Bottle" and "Empty Bottle" are the same name; so are "Snail Mail" and "snail mail".
export const nameKey = (s: string) => words(s).join(" ");
// Without spaces, "S. G. Goodman" is S.G. Goodman: used only for initials (a one-letter word on either
// side) and only when no name is equal with its spaces, since Wild Child and Wildchild are different acts.
export const squashed = (s: string) => words(s).join("");

function typoDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

// Whole words only ("Bea" isn't Beach House). The typed text is part of the name ("Gary Clark" is Gary
// Clark Jr.); or the name is part of the typed text and at least half of it ("Nobody Real Band Xyz" isn't
// The Band); or at least half the typed words appear in the name, allowing a typo or two.
export function resembles(typed: string, name: string): boolean {
  return wordsResemble(words(typed), words(name), true);
}

// Small words don't make two names alike ("of", "the", "and", "de", "la").
const SMALL = new Set(["of", "the", "and", "a", "an", "de", "la", "le", "el", "los", "las", "y", "et", "und", "der", "die", "das", "du", "des", "n"]);
// Words written two ways count as close, not equal ("Hank Williams 3" is close to Hank Williams III, "Maroon
// Five" to Maroon 5), so that initials still compare without spaces ("J. R. Writer" is J.R. Writer); so does a
// plural of a short word ("Fleet Fox" is Fleet Foxes).
const TWINS = [["1", "one"], ["2", "ii", "two"], ["3", "iii", "three"], ["4", "iv", "four"], ["5", "five"], ["6", "six"], ["7", "seven"], ["8", "eight"], ["9", "nine"], ["10", "ten"], ["20", "twenty"], ["jr", "junior"]];
const TWIN = new Map(TWINS.flatMap((g, i) => g.map((w) => [w, i] as const)));
const twins = (a: string, b: string) => TWIN.has(a) && TWIN.get(a) === TWIN.get(b);
const plural = (a: string, b: string) => [a, b].some((x) => x.length >= 3 && [`${x}s`, `${x}es`].includes(x === a ? b : a));
const closeTo = (w: string, b: string[], plurals = true) => b.some((x) => x === w || twins(w, x) || (plurals && plural(w, x)) || typoDistance(w, x) <= (w.length > 5 ? 2 : w.length > 3 ? 1 : 0));
// The share of a's words, small words aside, that are close to some word of b. Plurals of words of three
// letters or more count between names of as many words: "Fleet Fox" is close to Fleet Foxes and "The Car" to
// The Cars, but "Boy" isn't to Boys Noize.
function share(a: string[], b: string[], withPlurals = true): number {
  const keep = (ws: string[]) => (ws.some((w) => !SMALL.has(w)) ? ws.filter((w) => !SMALL.has(w)) : ws);
  const ca = keep(a), cb = keep(b);
  const plurals = withPlurals && ca.length === cb.length;
  return ca.length ? ca.filter((w) => closeTo(w, cb, plurals)).length / ca.length : 0;
}

function wordsResemble(a: string[], b: string[], half: boolean): boolean {
  if (!a.length || !b.length) return false;
  const A = ` ${a.join(" ")} `, B = ` ${b.join(" ")} `;
  if (B.includes(A) || (A.includes(B) && (!half || b.length * 2 >= a.length))) return true;
  const close = (w: string) => b.some((x) => x === w || typoDistance(w, x) <= (w.length > 5 ? 2 : w.length > 3 ? 1 : 0));
  return a.filter(close).length / a.length >= 0.5;
}


// A note in brackets at the end is how an agent or a person says which one. It is read in this order:
// - part of the name, a subtitle: the entry holding both the name and the note's words ("Star Wars (The Empire
//   Strikes Back)" is Episode V, not the 1977 film);
// - about the name: the name before it is matched, and the note's words pick among entries that share that name
//   by Qloo's disambiguation, a film's year ("Dune (2021 film)"; "Succession (TV series)" is Succession);
// - another name for it, used only when it is that name exactly ("Yasiin Bey (Mos Def)").
// The note's words never make a match on their own ("Scream: The TV Series" for "Succession (TV series)",
// seen live), and the pick is only a closest match, since what was typed wasn't a name. A whole text that is
// exactly a name ("Birdman (or The Unexpected Virtue of Ignorance)") is that name.
const NOTE = /\s*[([]([^()[\]]*)[)\]]\s*$/;
export const withoutNote = (s: string) => {
  const note = NOTE.exec(s);
  return (note && s.slice(0, note.index).trim()) || s;
};

export interface Ranked {
  pick: Entity;
  match: "exact" | "ambiguous" | "closest";
  list: Entity[]; // every near name, best first
  offered: (e: Entity) => boolean; // close enough to offer under "Not it?"
  // How a note in brackets was read; "set aside" means it told nothing, so a search for the name alone may
  // find better candidates (Qloo's search with the whole text can miss the name: live, "Dune (2021 film)"
  // found only the 1984 film).
  note?: "subtitle" | "year" | "set aside" | "other name";
}

// The candidates Qloo's search returned for what was typed, ranked; null when none resembles it.
export function rankNames(found: Entity[], input: string): Ranked | null {
  const all = rankTyped(found, input);
  const bare = withoutNote(input);
  if (all?.match === "exact" || bare === input) return all;
  const noted = NOTE.exec(input)![1];
  const told = words(noted).filter((w) => !SMALL.has(w));
  const both = (e: Entity) => !!rankTyped([e], bare) && !!told.length && share(told, words(e.name)) >= 0.5;
  const subtitled = found.filter(both);
  if (subtitled.length) {
    const near = (e: Entity) => share(words(input), words(e.name)) + share(words(e.name), words(input));
    const pick = subtitled.map((e, i) => ({ e, i, s: near(e) })).sort((x, y) => y.s - x.s || x.i - y.i)[0].e;
    const r = rankTyped(found, bare);
    return { pick, match: "closest", list: [pick, ...(r?.list ?? []).filter((e) => e !== pick)], offered: (e) => !!r?.offered(e), note: "subtitle" };
  }
  const r = rankTyped(found, bare);
  if (r) {
    const said = r.match === "ambiguous" ? r.list.filter((e) => squashed(e.name) === squashed(r.pick.name) && !!e.disambiguation && words(e.disambiguation).some((w) => told.includes(w))) : [];
    if (said.length === 1) return { ...r, pick: said[0], match: "closest", list: [said[0], ...r.list.filter((e) => e !== said[0])], note: "year" };
    return { ...r, match: r.match === "exact" ? "closest" : r.match, note: "set aside" };
  }
  const other = rankTyped(found, noted);
  return other && other.match !== "closest" ? { ...other, match: "closest", note: "other name" } : null;
}

// Search results for the whole text, then those for the name alone that weren't among them.
export const together = (a: Entity[], b: Entity[]) => [...a, ...b.filter((e) => !a.some((x) => x.id === e.id))];

function rankTyped(found: Entity[], input: string): Ranked | null {
  // Typed with an article, the name letter for letter comes first ("The Killers" is The Killers before
  // Killers; "A Savage" is A. Savage before Savage), and a name equal without the article still makes it
  // ambiguous ("The Eagles" may mean Eagles). Typed without one, the spelling says nothing about the article:
  // "Killers" is ambiguous between The Killers and Killers, in Qloo's order.
  const literalKey = allWords(input).join(" ");
  const startsWithArticle = allWords(input).length > 1 && ARTICLES.has(allWords(input)[0]); // also "A. Savage"
  // Among those, a typed initial puts the record written the same way first ("A. Savage" is A. Savage before A
  // Savage); typed without the dot, Qloo's order stands.
  const literally = startsWithArticle ? found.filter((e) => allWords(e.name).join(" ") === literalKey) : [];
  if (!article(input, allWords(input))) literally.sort((x, y) => Number(nameKey(y.name) === nameKey(input)) - Number(nameKey(x.name) === nameKey(input)));
  const spaced = [...literally, ...found.filter((e) => nameKey(e.name) === nameKey(input) && !literally.includes(e))];
  const initials = (x: string) => words(x).some((w) => w.length === 1);
  const same = (e: Entity) => squashed(e.name) === squashed(input);
  const exact = spaced.length ? spaced : found.filter((e) => (initials(input) || initials(e.name)) && same(e));
  // Otherwise the same letters spaced differently are the closest match: "ACDC" for AC/DC, "boy genius" for
  // boygenius, ahead of other near names.
  // A near name must resemble from both sides unless what was typed is part of it: "Marcia Ball" shares one
  // word with "Cock and Ball Torture" (half of what was typed, a quarter of that name), while "Edward Sharpe"
  // is part of "Edward Sharpe & The Magnetic Zeros".
  // Otherwise half of what was typed, small words aside, must be close to the name and half the name to what
  // was typed, and near names are ranked by how close they are, not Qloo's order ("Tom Pety" is Tom Petty,
  // not Tom Waits). "Not it?" offers only names closer than that: most of what was typed ("Big Thief" isn't
  // offered Big Sean; "Horse Jumper of Love" isn't offered Love of Lesbian).
  const typedWords = words(input);
  // Typed with its article, the name must hold the article too, in place ("The Hip" in The Hip Abduction) or
  // leading the name ("The Hip" in The Tragically Hip; "The Weekend" isn't in Vampire Weekend, "The The" isn't
  // in The Head and the Heart).
  const literal = (e: Entity) => ` ${allWords(e.name).join(" ")} `.includes(` ${literalKey} `);
  const typedArticle = article(input, allWords(input)) ? allWords(input)[0] : "";
  const leading = (e: Entity) =>
    !!typedArticle && allWords(e.name)[0] === typedArticle && typedWords.some((w) => !SMALL.has(w)) && ` ${words(e.name).join(" ")} `.includes(` ${typedWords.join(" ")} `);
  const inside = (e: Entity) => literal(e) || leading(e);
  const part = (e: Entity) => { const n = words(e.name); return ` ${typedWords.join(" ")} `.includes(` ${n.join(" ")} `) && n.length * 2 >= typedWords.length; };
  const sure = (e: Entity) => exact.includes(e) || same(e) || inside(e) || part(e);
  // Near names rank in three tiers. A name holding everything typed comes first ("Mavis" is Mavis Staples,
  // not The Mavis's; "Margo" is Margo Price, not Margot); then a whole name one letter off ("Future Island"
  // is Future Islands, not Future; "De La Sol" is De La Soul, whose short words must otherwise match
  // exactly; "Boy Genious" is boygenius); then the rest by closeness. Not one letter off: a name held whole by
  // what was typed (Hank Williams for "Hank Williams 3"), or a word of one or two letters swapped (Hank
  // Williams Jr. for "Hank Williams Sr.", Chapter 8 for "Chapter 4").
  const typedWhole = squashed(input);
  const whole = (e: Entity) => {
    const n = squashed(e.name), nw = words(e.name);
    if (Math.min(n.length, typedWhole.length) < 5 || typoDistance(n, typedWhole) > 1 || part(e)) return false;
    return nw.length !== typedWords.length || nw.every((w, i) => w === typedWords[i] || Math.min(w.length, typedWords[i].length) >= 3);
  };
  const closeness = (e: Entity) => share(typedWords, words(e.name)) + share(words(e.name), typedWords);
  // A name held only after a leading article ranks below one letter off that also leads with it: "The Monkeys"
  // is The Monkees, not The Mighty Monkeys; but "The Stones" is The Rolling Stones, not Stone or The Stone (a
  // plural of it isn't a typo; "The Killer" is still The Killers, not The Lady Killer).
  const pluralOf = (e: Entity) => { const n = squashed(e.name); return [`${n}s`, `${n}es`].includes(typedWhole); };
  const anyWhole = found.some((e) => whole(e) && allWords(e.name)[0] === typedArticle && !pluralOf(e));
  const score = (e: Entity) => (exact.includes(e) || same(e) ? 100 : (literal(e) ? 30 : whole(e) ? 20 : leading(e) ? (anyWhole ? 10 : 30) : 0) + closeness(e));
  const near = (e: Entity) => sure(e) || whole(e) || (share(typedWords, words(e.name)) >= 0.5 && share(words(e.name), typedWords) >= 0.5);
  const list = found.filter(near).map((e, i) => ({ e, i, s: score(e) })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.e);
  if (!list.length) return null;
  // Not it? doesn't offer a mere plural of an exact one-word name ("Kiss" isn't offered Kisses), but does for
  // longer names ("Black Key" is offered The Black Keys) and when nothing matched exactly ("The Car": The Cars).
  const plurals = typedWords.filter((w) => !SMALL.has(w)).length > 1 || !exact.length;
  // Nor, next to an exact match, a fragment of what was typed ("Graves" for Shakey Graves, W.E.T. for Wet Leg).
  const fragment = (e: Entity) => !!exact.length && part(e) && !inside(e) && !exact.includes(e) && !same(e);
  const offered = (e: Entity) => (sure(e) && !fragment(e)) || share(typedWords, words(e.name), plurals) > 0.5;
  const pick = exact[0] ?? list[0];
  return { pick, match: exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : "closest", list, offered };
}
