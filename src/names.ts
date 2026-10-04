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


// A note in brackets at the end is how an agent or a person says which one. It is read in this order (Qloo's
// live answers for 122 such inputs are recorded in test/note-fixtures.json):
// - a title holding both the name and every word of the note that isn't already in the name or a kind word, each
//   as written, as a number in another form ("5", "V", "Five") or as a short form ("Pt. II", "Vol. 3"), in either
//   order ("Star Wars (The Empire Strikes Back)" is Episode V; "Parts Unknown (Anthony Bourdain)" is Anthony
//   Bourdain: Parts Unknown; "Batman (movie)" is not Batman: The Movie, "Interstellar (Nolan)" not Interstellar:
//   Nolan's Odyssey). Not for acts: an act holding both names is a collaboration ("Mos Def (Yasiin Bey & Marvin Gaye)");
// - the note as the exact name of one title ("Indiana Jones (Raiders of the Lost Ark)", "Fast & Furious (Fast
//   Five)", "La Casa de Papel (Money Heist)"), for a full name of two words or more that aren't kind words, and
//   never for an act: an act's note is as often a hometown that is also a band's name ("Moonsprout (New England)"),
//   so "Ye (Kanye West)" is not found rather than guessed;
// - when an entry is named exactly the name, the note may only continue it: a title must start with the name
//   ("The Mandalorian (Star Wars)" is not Lego Star Wars: The Mandalorian), and a title named in the note must share
//   a word with the name and add one ("Fast Five"), never name a parent ("Better Call Saul (Breaking Bad)");
// - the name alone, among entries that don't hold the note's words; a year in the note picks among the near names
//   holding the whole name, by Qloo's disambiguation ("Dune (2021 film)"; "The Lord of the Rings (2001)" is The
//   Fellowship of the Ring; "Spider-Man (2002 film)" is not Spider (2002)); "Dune (Part One)" is Dune, not Dune:
//   Part Two; a note of kind words is set aside ("Wednesday (band)" is not The Band).
// The note's words never make a match on their own ("Scream: The TV Series" for "Succession (TV series)", live),
// and the pick is only a closest match, since what was typed wasn't a name. A whole text that is exactly a name
// ("Birdman (or The Unexpected Virtue of Ignorance)") is that name.
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
  note?: "title" | "year" | "name" | "other name"; // how a note in brackets was read
  // Qloo is searched with the whole text first; the name alone is searched too when nothing matched, when the
  // name matched only loosely ("The Godfather (Part I)" found only Part II and III), when the note's year wasn't
  // among the entries ("Dune (2021 film)" found only the 1984 film), or before a pick the name itself may beat.
  searchName?: boolean;
}

// The candidates Qloo's search returned for what was typed, ranked; null when none resembles it.
// Words that only say what kind of thing it is; a note made of them (and years) is never another name ("Wednesday
// (band)" is not The Band).
const KIND = new Set("band group rapper singer songwriter musician artist act dj producer duo trio composer film movie series show tv sitcom documentary docuseries miniseries anime cartoon podcast book novel game album song".split(" "));
const years = (s: string | undefined): string[] => s?.match(/\b\d{4}\b/g) ?? [];
// In a title, a note's word must be there as written, or as its number twin ("2", "II", "Two") or short form.
const SHORT: Record<string, string> = { pt: "part", vol: "volume", ep: "episode", ch: "chapter" };
const NUMBER = new Map("1 i one,2 ii two,3 iii three,4 iv four,5 v five,6 vi six,7 vii seven,8 viii eight,9 ix nine,10 x ten".split(",").flatMap((g, i) => g.split(" ").map((w) => [w, i] as const)));
const sameWord = (a: string, b: string) => a === b || (NUMBER.has(a) && NUMBER.get(a) === NUMBER.get(b)) || (SHORT[a] ?? a) === (SHORT[b] ?? b);

export function rankNames(found: Entity[], input: string): Ranked | null {
  const all = rankTyped(found, input);
  const bare = withoutNote(input);
  if (all?.match === "exact" || bare === input) return all;
  const noted = NOTE.exec(input)![1];
  const named = words(bare).filter((w) => !SMALL.has(w));
  // The note's words that aren't already in the name ("Chance the Rapper (rapper)" adds nothing).
  const told = words(noted).filter((w) => !SMALL.has(w) && !closeTo(w, named, false));
  const holds = (e: Entity, ws: string[]) => !!ws.length && ws.every((w) => closeTo(w, words(e.name), false));
  const holdsNote = (e: Entity) => holds(e, told);
  const isArtist = (e: Entity) => e.types.includes("urn:entity:artist");
  // The name alone, among entries that don't hold the note's words.
  const r = rankTyped(found.filter((e) => !holdsNote(e)), bare);
  // When an entry is named exactly that, the note may only continue the name: a title must start with it ("Star
  // Wars (Episode 5)" is Episode V, but "The Mandalorian (Star Wars)" is not Lego Star Wars: The Mandalorian), and
  // another title named in the note must share a word with it and add one ("Fast & Furious (Fast Five)"), never
  // name a parent ("Better Call Saul (Breaking Bad)") or a part of the name ("Fear the Walking Dead (The Walking Dead)").
  const named_ = !!r && r.match !== "closest";
  const noteWords = words(noted).filter((w) => !SMALL.has(w));
  const continues = told.length > 0 && told.length < noteWords.length;
  // A title must hold the note's words that aren't kind words ("Batman (movie)" is not Batman: The Movie).
  const titleWords = told.filter((w) => !KIND.has(w));
  const holdsExactly = (e: Entity, ws: string[]) => !!ws.length && ws.every((w) => words(e.name).some((x) => sameWord(w, x)));
  const startsWithName = (e: Entity) => ` ${nameKey(e.name)} `.startsWith(` ${nameKey(bare)} `);
  const titled = found.filter((e) => !isArtist(e) && holdsExactly(e, titleWords) && holdsExactly(e, named) && (!named_ || startsWithName(e)));
  if (titled.length) {
    const near = (e: Entity) => share(words(input), words(e.name)) + share(words(e.name), words(input));
    const pick = titled.map((e, i) => ({ e, i, s: near(e) })).sort((x, y) => y.s - x.s || x.i - y.i)[0].e;
    const byName = rankTyped(found, bare);
    // A title that doesn't start with the name, with no entry named exactly that among the answers: the name alone is
    // searched too, since Qloo's search for the whole text can miss it ("The Mandalorian (Star Wars)" found Lego Star
    // Wars: The Mandalorian but not The Mandalorian).
    return { pick, match: "closest", list: [pick, ...(byName?.list ?? []).filter((e) => e !== pick)], offered: (e) => !!byName?.offered(e), note: "title", searchName: !startsWithName(pick) };
  }
  // The note names one title exactly ("Indiana Jones (Raiders of the Lost Ark)", "La Casa de Papel (Money Heist)"):
  // a full name of two words or more, not kind words, never an act (an act's note is as often a hometown that is
  // also a band's name: "Moonsprout (New England)"). With nothing like the name found yet, the name alone is
  // searched first ("Better Call Saul" may not be among the whole text's answers).
  const full = noteWords.filter((w) => !KIND.has(w) && !/^\d{4}$/.test(w));
  const other = full.length >= 2 && (!named_ || continues) ? rankTyped(found.filter((e) => !isArtist(e)), noted) : null;
  if (other && other.match !== "closest") return { ...other, match: "closest", note: "other name", searchName: !r };
  if (r) {
    // A year picks among the near names by Qloo's disambiguation: "The Lord of the Rings (2001)" is The Fellowship of
    // the Ring, not the 1978 film named exactly that.
    const year = years(noted);
    const said = year.length ? r.list.filter((e) => holds(e, named) && years(e.disambiguation).some((y) => year.includes(y))) : [];
    if (said.length) return { ...r, pick: said[0], match: "closest", list: [said[0], ...r.list.filter((e) => e !== said[0])], note: "year" };
    return { ...r, match: r.match === "exact" ? "closest" : r.match, note: "name", searchName: r.match === "closest" || year.length > 0 };
  }
  return null;
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
