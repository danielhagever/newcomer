// Names typed by a person, matched to what Qloo's search returned. This file is identical in Newcomer and Booker
// (src/names.ts in both): change it in one, copy it to the other. An exact name is preferred; otherwise a candidate is
// used only if it resembles what was typed, near names are ranked by how close they are, and "Not it?" offers only
// close names. Pinned by Booker's 472 realistic inputs and the 349 names recorded from Qloo, in both repos' tests.

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
export const words = (s: string) => {
  const ws = allWords(s);
  return article(s, ws) ? ws.slice(1) : ws;
};
// "The Empty Bottle" and "Empty Bottle" are the same name; so are "Snail Mail" and "snail mail".
export const nameKey = (s: string) => words(s).join(" ");
// Without spaces, "S. G. Goodman" is S.G. Goodman: used only for initials (a one-letter word on either
// side) and only when no name is equal with its spaces, since Wild Child and Wildchild are different acts.
export const squashed = (s: string) => words(s).join("");

export function typoDistance(a: string, b: string): number {
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
export const SMALL = new Set(["of", "the", "and", "a", "an", "de", "la", "le", "el", "los", "las", "y", "et", "und", "der", "die", "das", "du", "des", "n"]);
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

export function wordsResemble(a: string[], b: string[], half: boolean): boolean {
  if (!a.length || !b.length) return false;
  const A = ` ${a.join(" ")} `, B = ` ${b.join(" ")} `;
  if (B.includes(A) || (A.includes(B) && (!half || b.length * 2 >= a.length))) return true;
  const close = (w: string) => b.some((x) => x === w || typoDistance(w, x) <= (w.length > 5 ? 2 : w.length > 3 ? 1 : 0));
  return a.filter(close).length / a.length >= 0.5;
}


// A note in brackets at the end is how an agent or a person says which one. It is read in this order (Qloo's
// live answers for 349 such inputs are recorded in test/note-fixtures.json):
// - first, the entry named the name (not an act) whose disambiguation holds every word of the note, after "by" if
//   there is one: a book's author ("Emma (Jane Austen)" is Emma, 1815, not a collection holding Emma; "Beloved (by
//   Toni Morrison)" is Qloo's "Beloved (Beloved Trilogy, #1)", 1987; a misspelling or a possessive still counts, a
//   year only as written), a place's town ("Joe's Pizza (Brooklyn)"), a film's year;
// - a title holding both the name and every word of the note that isn't already in the name or a kind word, each
//   as written, as a number in another form ("5", "V", "Five") or as a short form ("Pt. II", "Vol. 3"), in either
//   order ("Star Wars (The Empire Strikes Back)" is Episode V; "Parts Unknown (Anthony Bourdain)" is Anthony
//   Bourdain: Parts Unknown; "Batman (movie)" is not Batman: The Movie, "Interstellar (Nolan)" not Interstellar:
//   Nolan's Odyssey). Not for acts: an act holding both names is a collaboration ("Mos Def (Yasiin Bey & Marvin Gaye)");
// - the note as the exact name of one title ("Indiana Jones (Raiders of the Lost Ark)", "La Casa de Papel (Money
//   Heist)"), for a name of two words or more, not all kind words ("Game of Thrones" counts), and
//   never for an act: an act's note is as often a hometown that is also a band's name ("Moonsprout (New England)"),
//   so "Ye (Kanye West)" is not found rather than guessed;
// - when an entry is named exactly the name (or one letter off, two in a long name: "Better Call Saull"; or with its
//   number written otherwise: "Fantastic 4"), it wins
//   over a title named in the note, which is offered first under "Not it?" ("Better Call Saul (Breaking Bad)",
//   "Chicago P.D. (Chicago Fire)"; a note adding a number to the name's words is a sequel instead: "Fast & Furious
//   (Fast Five)" is Fast Five); and a title must continue
//   the name after a separator, a linking word or a number ("Star Wars: Episode V", "The Fast and the Furious: Tokyo
//   Drift", "Harry Potter and the...", "The Godfather Part II"), or start with the note that way and hold the name
//   ("Furiosa: A Mad Max Saga", "The Lost World: Jurassic Park", "War for the Planet of the Apes"): "The Mandalorian
//   (Star Wars)" is not Lego Star Wars: The Mandalorian, and "Amy (Winehouse documentary)" is not Amy Winehouse. A
//   note holding the whole name plus words is a fuller name, not a subtitle ("Amy (Amy Winehouse)" is Amy, 2015),
//   unless it adds a number ("Toy Story (Toy Story 3)", "(The Hunger Games: Mockingjay Part 1)", "Blade Runner
//   (Blade Runner 2049)", "Godzilla (Godzilla Minus One)": then the title named exactly the note is taken) or a word
//   in capitals ("Love Island (Love Island USA)", "Law & Order (Law & Order SVU)"; a note wholly in capitals reads like
//   the same note in lower case), continues the name with "and",
//   "of" or a linking word ("Deadpool (Deadpool & Wolverine)", "Toy Story (Toy Story of Terror)", "Bad Boys (Bad Boys
//   for Life)"), or continues the name after a separator ("Mad Max (Mad Max: Fury Road)"; such a note is read from after the name: "Twilight
//   (Twilight: New Moon)" is New Moon; a name ending in "!" counts as followed by one: "Mamma Mia (Mamma Mia! Here We Go
//   Again)"), nor is a note shaped like a title ("Planet of the Apes (Rise of the Planet of the Apes)", "Vacation
//   (National Lampoon's Vacation)") or naming
//   exactly a found title with a separator ("Jurassic Park (The Lost World Jurassic Park)"). A title that is a later part of the note's own title gives way to the entry
//   named exactly the note ("Rambo (First Blood)" is First Blood, not Rambo: First Blood Part II). Linking words
//   ("to", "in", "presents") and part words ("Part", "Vol.") are skipped: "Back to the Future (Part 2)" is Back to
//   the Future Part II, "Toy Story (Part 3)" Toy Story 3, "Fast & Furious (Hobbs & Shaw)" Fast & Furious Presents:
//   Hobbs & Shaw. A franchise's own words may come after the name, before the separator ("Twilight (New Moon)" is
//   The Twilight Saga: New Moon; "Law & Order (SVU)" is not The Paley Center Salutes Law & Order: SVU), the title holding more of the note's words wins ("Star Wars (Episode 1)" is Episode I, not
//   Rogue One), a word may be a title's initials ("Law & Order (SVU)" is Special Victims Unit, "NCIS (LA)" NCIS: Los
//   Angeles, "Star Trek (tng)" The Next Generation), and kind words in the note hide nothing ("SpongeBob (movie)" is The SpongeBob SquarePants Movie).
//   A note that is only a number (one to ten, as digits, words or Roman numerals, or an ordinal: "Shrek (2nd film)", also after the name: "Shrek (Shrek the Third)")
//   asks for the Nth: the title with that number right after the name ("Shrek (2)" is
//   Shrek 2), or holding the name and that number ("The Fast and the Furious (2)" is 2 Fast 2 Furious); else Qloo's
//   own top answer (its second, when the first is the film named exactly the name, only as a sequel not holding the
//   name: "Knives Out (2)" is Glass Onion) when it carries no number but the asked one (a part's own other number
//   only when the count below can't answer: "Mission: Impossible (7)" is Dead Reckoning Part One, but "Harry Potter
//   (3)" is Prisoner of Azkaban, not Deathly Hallows: Part 2) and belongs to the series, holding the name or coming after
//   the film named exactly the name ("Mad Max (2)" is The Road Warrior, "Fast & Furious (7)" Furious 7); else the Nth by year of the titles starting with the name, from the one named exactly that,
//   titles numbered otherwise left out ("The Hunger Games (2)" is Catching Fire, not Mockingjay - Part 2). On a TV
//   show a number or a season alone is a season of the show ("Skins (series 2)", "Squid Game (Season 2)" are the shows,
//   not a making-of special). Known limits: an
//   unrelated title that reads as a sequel wins ("Alien (2)" is Alien 2: On Earth, a 1980 film, not Aliens), and a
//   film Qloo's searches never return can't be picked ("Batman (2)", "Harry Potter (7)", "Henry (Henry the Fifth)"), and Qloo's own top answer
//   is sometimes wrong ("Twilight (4)" is Breaking Dawn - Part 2), and an older film named exactly the name starts
//   the count ("The Hobbit (1)" is the 1977 TV film), and a title holding the name plus a plain word reads as a fuller
//   name ("Halloween (Halloween Kills)" is Halloween; Halloween Kills is offered first), and a place's city is read only
//   as written ("Joe's Pizza (NYC)" is Qloo's "Joe's Pizza NYC" in Ann Arbor: Qloo writes "New York, NY"), and of two
//   films named exactly the name, a note naming neither year follows Qloo's order ("Truman (Harry S. Truman)"). When the count by year falls short (a film missing
//   from Qloo's answers), Qloo's second answer may stand as a title starting with the name ("Twilight (5)"). Kind words at the end of a note only say what it is ("(Raiders of the Lost Ark film)"). A title holding the
//   name and the note that isn't taken is offered first under "Not it?", and otherwise only entries holding the
//   name are offered ("Dune (Part Two)" isn't offered The Godfather Part II);
// - "aka" before the note says it's another name, so then an act may take it too ("Ye (aka Kanye West)");
// - the name alone, among entries that don't hold the note's words; a year in the note picks among the near names
//   holding the whole name, by Qloo's disambiguation ("Dune (2021 film)"; "The Lord of the Rings (2001)" is The
//   Fellowship of the Ring; "Spider-Man (2002 film)" is not Spider (2002)); "Dune (Part One)" is Dune, not Dune:
//   Part Two; a note of kind words is set aside ("Wednesday (band)" is not The Band).
// The note's words never make a match on their own ("Scream: The TV Series" for "Succession (TV series)", live),
// and the pick is only a closest match, since what was typed wasn't a name. A whole text that is exactly a name
// ("Birdman (or The Unexpected Virtue of Ignorance)") is that name.
const NOTE = /\s*[([]([^()[\]]*)[)\]]\s*$/;
// Qloo's search finds "Star Wars (Episode 1)" but not "Star Wars (Episode One)": a number word after a part word
// in the note is searched as a digit (matching still reads what was typed), and an ordinal note as its number, the
// way Qloo answers best ("Mad Max (second film)" is searched as "Mad Max (2)").
const SPELLED = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
export const forSearch = (s: string) =>
  s.replace(NOTE, (note, inner: string) => ordinalOf(inner) ? ` (${ordinalOf(inner)})` : note.replace(/\b(part|pt\.?|episode|ep\.?|vol\.?|volume|chapter|ch\.?)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (_, p: string, n: string) => `${p} ${SPELLED.indexOf(n.toLowerCase()) + 1}`));
export const withoutNote = (s: string) => {
  const note = NOTE.exec(s);
  return (note && s.slice(0, note.index).trim()) || s;
};

export interface Ranked {
  pick: Entity;
  match: "exact" | "ambiguous" | "closest";
  list: Entity[]; // every near name, best first
  offered: (e: Entity) => boolean; // close enough to offer under "Not it?"
  note?: "title" | "year" | "name" | "other name" | "credit"; // how a note in brackets was read
  // Qloo is searched with the whole text first; the name alone is searched too when nothing matched, when the
  // name matched only loosely ("The Godfather (Part I)" found only Part II and III), when the note's year wasn't
  // among the entries ("Dune (2021 film)" found only the 1984 film), before a pick the name itself may beat, or
  // when a book was taken as a title (its note is most often the author: "Emma (by Jane Austen)").
  searchName?: boolean;
}

// The candidates Qloo's search returned for what was typed, ranked; null when none resembles it.
// Words that only say what kind of thing it is; a note made of them (and years) is never another name ("Wednesday
// (band)" is not The Band).
const KIND = new Set("band group rapper singer songwriter musician artist act dj producer duo trio composer film movie series show tv sitcom documentary docuseries miniseries anime cartoon podcast book novel game album song".split(" "));
const LINKS = new Set(["for", "from", "to", "in", "on", "at", "with", "vs", "versus", "presents"]);
// Words that mark a sequel or a part ("Vol. 3", "Part II").
const PART = new Set(["part", "pt", "vol", "volume", "episode", "ep", "chapter", "ch", "season"]);
// "aka" before a note says it's another name.
const AKA = /^\s*(?:a\.?\s?k\.?\s?a\.?|also known as|known as)\s+/i;
// What comes right after the given words at the start of a title: a separator (":", "-"), a linking word ("and the",
// "of the"), a number or part word, another word, or nothing; null when the title doesn't start with those words.
export function after(title: string, given: string[]): "sep" | "link" | "number" | "word" | "end" | null {
  const ws = given.filter((w) => !SMALL.has(w) && !LINKS.has(w)); // "Back to the Future" is back, future
  const tokens = title.match(/[^\s:\u2013\u2014-]+|[:\u2013\u2014-]/g) ?? [];
  let k = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (/^[:\u2013\u2014-]$/.test(tokens[i])) {
      if (k === ws.length) return "sep";
      continue;
    }
    for (const w of words(tokens[i])) {
      if (k === ws.length) return SMALL.has(w) || LINKS.has(w) ? "link" : NUMBER.has(w) || PART.has(w) ? "number" : "word";
      if (SMALL.has(w) || LINKS.has(w)) continue;
      if (!sameWord(ws[k], w)) return null;
      k++;
      // A name ending in "!" or "?" is followed as by a separator ("Mamma Mia! Here We Go Again").
      if (k === ws.length && /[!?]$/.test(tokens[i]) && i < tokens.length - 1) return "sep";
    }
  }
  return k === ws.length ? "end" : null;
}
// The words of a title after the given words at its start, separators left out; null when it doesn't start with them.
function wordsAfter(title: string, given: string[]): string[] | null {
  const ws = given.filter((w) => !SMALL.has(w) && !LINKS.has(w));
  const rest: string[] = [];
  let k = 0;
  for (const token of title.match(/[^\s:\u2013\u2014-]+/g) ?? [])
    for (const w of words(token)) {
      if (k < ws.length) {
        if (SMALL.has(w) || LINKS.has(w)) continue;
        if (!sameWord(ws[k], w)) return null;
        k++;
      } else rest.push(w);
    }
  return k === ws.length ? rest : null;
}
// Kind words at the end of a note only say what it is ("Raiders of the Lost Ark film").
function trimKind(s: string): string {
  let t = s.trim();
  for (let m = /^(.*\S)\s+(\S+)$/.exec(t); m && words(m[2]).length && words(m[2]).every((w) => KIND.has(w)); m = /^(.*\S)\s+(\S+)$/.exec(t)) t = m[1];
  return t;
}
// A separator in a title: a colon or a dash between words, not a hyphen inside a word ("X-Men Origins: Wolverine").
const SEPARATOR = /\s*[:\u2013\u2014]\s*|\s+-\s+/;
const yearOf = (e: Entity) => Number(years(e.disambiguation)[0] ?? NaN);
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
// An ordinal note is its number ("Shrek (2nd film)", "The Matrix (the second one)" ask for the second).
function ordinalOf(note: string): number | null {
  const m = /^(?:the\s+)?(?:(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)|(\d+)(?:st|nd|rd|th))(?:\s+(?:one|part|installment))?$/i.exec(trimKind(note));
  return m ? Number(m[2] ?? ORDINALS.indexOf(m[1].toLowerCase()) + 1) : null;
}
const years = (s: string | undefined): string[] => s?.match(/\b\d{4}\b/g) ?? [];
// In a title, a note's word must be there as written, or as its number twin ("2", "II", "Two") or short form.
const SHORT: Record<string, string> = { pt: "part", vol: "volume", ep: "episode", ch: "chapter" };
const NUMBER = new Map("1 i one,2 ii two,3 iii three,4 iv four,5 v five,6 vi six,7 vii seven,8 viii eight,9 ix nine,10 x ten".split(",").flatMap((g, i) => g.split(" ").map((w) => [w, i] as const)));
const sameWord = (a: string, b: string) => a === b || (NUMBER.has(a) && NUMBER.get(a) === NUMBER.get(b)) || (SHORT[a] ?? a) === (SHORT[b] ?? b);
// A word of two letters or more may be a title's initials, words in a row ("Law & Order: Special Victims Unit" for
// "SVU" or "svu", "Star Trek: The Next Generation" for "TNG"); one letter is not an abbreviation.
export const abbreviates = (w: string, title: string) => w.length > 1 && words(title).map((x) => x[0]).join("").includes(w);
// The abbreviations in a note: words of two capitals or more ("SVU", "LA"; one capital is a person's initial: "Harry
// S. Truman"). A note wholly in capitals says nothing about abbreviations: it reads like the same note in lower case
// ("Amy (AMY WINEHOUSE)" is Amy).
// Initials written apart are one word, as Qloo writes them ("J. R. R. Tolkien" is "J.R.R. Tolkien").
const joinInitials = (ws: string[]) => ws.reduce((a: string[], w, i) => (w.length === 1 && /\p{L}/u.test(w) && i > 0 && ws[i - 1].length === 1 && /\p{L}/u.test(ws[i - 1]) ? [...a.slice(0, -1), a[a.length - 1] + w] : [...a, w]), []);
// Whether a disambiguation credits every word of a note ("1815, Jane Austen" for "Jane Austen"): a number as
// written (a year), other words within a letter or two ("Jane Austin", "Toni Morrison's").
export const credits = (note: string[], disambiguation: string) => {
  const ws = joinInitials(words(disambiguation));
  return joinInitials(note).every((w) => (/\d/.test(w) ? ws.includes(w) : closeTo(w, ws, false)));
};
export function abbreviations(note: string, name = ""): Set<string> {
  const own = new Set(name.match(/[\p{L}\p{N}]+/gu) ?? []);
  const rest = (note.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !own.has(t));
  const shouted = rest.length > 1 && !rest.some((t) => /\p{Ll}/u.test(t));
  return new Set(shouted ? [] : (note.match(/\b[A-Z]{2,}\b/g) ?? []).map((w) => w.toLowerCase()));
}

export function rankNames(found: Entity[], input: string): Ranked | null {
  const all = rankTyped(found, input);
  const bare = withoutNote(input);
  if (bare === input) return all;
  const named = words(bare).filter((w) => !SMALL.has(w));
  // With a note, "Not it?" offers only entries holding the name, besides the note's own titles ("Dune (Part Two)" isn't
  // offered The Godfather Part II, which shares "part two").
  const holdsName = (e: Entity) => named.every((w) => closeTo(w, words(e.name), false));
  if (all?.match === "exact") return { ...all, offered: (e) => all.offered(e) && holdsName(e) };
  const aka = AKA.exec(NOTE.exec(input)![1]);
  const rawNote = NOTE.exec(input)![1].slice(aka?.[0].length ?? 0).trim();
  // An ordinal after the name is its number too ("Shrek (Shrek the Third)", "Rocky (Rocky the Fourth)").
  const afterName = wordsAfter(rawNote, named);
  const ordinal = ordinalOf(rawNote) ?? (afterName?.length ? ordinalOf(afterName.join(" ")) : null);
  const noted = ordinal ? String(ordinal) : trimKind(rawNote);
  // The note's words that aren't already in the name ("Chance the Rapper (rapper)" adds nothing).
  // An abbreviation is never a small word ("NCIS (LA)" is not "la"; "La Luz (LA)" is La Luz, whose own "La" it is).
  const caps = abbreviations(rawNote, bare);
  const told = words(noted).filter((w) => (!SMALL.has(w) || caps.has(w)) && !closeTo(w, words(bare), false));
  const holds = (e: Entity, ws: string[]) => !!ws.length && ws.every((w) => closeTo(w, words(e.name), false));
  // Kind words don't make an entry the note's ("SpongeBob (movie)" keeps The SpongeBob Movie).
  // As written (number forms and short forms aside), like the title rule below: a typo-tolerant match would hide
  // "Dan Carlin's Hardcore History" for "Hardcore History (Dan Carlin)" without the title rule taking it back.
  const holdsNote = (e: Entity) => { const ws = told.filter((w) => !KIND.has(w)); return !!ws.length && ws.every((w) => words(e.name).some((x) => sameWord(w, x))); };
  const isArtist = (e: Entity) => e.types.includes("urn:entity:artist");
  // The name alone, among entries that don't hold the note's words.
  const r = rankTyped(found.filter((e) => !holdsNote(e)), bare);
  // When an entry is named exactly the name (see the header), it wins over a title named in the note, and a title
  // must continue the name or start with the note (below).
  // A name one letter off (two in a long name) counts as named too ("Better Call Saull (Breaking Bad)" is still
  // Better Call Saul).
  // So does the same name with a number written otherwise ("Fantastic 4" is Fantastic Four).
  const sameName = (a: string, b: string) => { const x = words(a), y = words(b); return x.length === y.length && x.every((w, i) => sameWord(w, y[i])); };
  const named_ = !!r && (r.match !== "closest" || sameName(r.pick.name, bare) || (typoDistance(squashed(r.pick.name), squashed(bare)) <= (squashed(bare).length > 10 ? 2 : 1)));
  const noteWords = words(noted).filter((w) => !SMALL.has(w));
  // A note holding the whole name and adding words is a fuller name ("Whitney (Whitney Houston)", "Amy (Amy
  // Winehouse)"), not a subtitle; adding a number, it's a sequel ("Toy Story (Toy Story 3)", "The Hunger
  // Games (The Hunger Games: Mockingjay Part 1)").
  // Nor when the note continues the name after a separator, as a title does ("Mad Max (Mad Max: Fury Road)").
  // A note shaped like a title (the name right after a small or linking word: "Planet of the Apes (Rise of the Planet of
  // the Apes)", "Predator (Alien vs. Predator)") is never a fuller name, nor one naming exactly a found title with a
  // separator in it ("Jurassic Park (The Lost World Jurassic Park)", "Star Trek (Star Trek The Next Generation)").
  const nw = allWords(noted);
  const at = named.length ? nw.findIndex((w) => sameWord(w, named[0])) : -1;
  // So is a note with a possessive right before the name ("Vacation (National Lampoon's Vacation)").
  const tokens = noted.split(/\s+/);
  const ati = named.length ? tokens.findIndex((t) => sameWord(words(t)[0] ?? "", named[0])) : -1;
  const titleShaped = (at > 0 && (SMALL.has(nw[at - 1]) || LINKS.has(nw[at - 1]))) || tokens.slice(0, Math.max(ati, 0)).some((t) => /['\u2019]s$/i.test(t));
  const namesTitle = found.some((e) => nameKey(e.name) === nameKey(noted) && (after(e.name, named) === "sep" || SEPARATOR.test(e.name)));
  // A person's name never adds a number ("Blade Runner (Blade Runner 2049)") or a word in capitals ("Love Island
  // (Love Island USA)"), nor continues with "and", "of" or a linking word ("Deadpool (Deadpool & Wolverine)", "Toy
  // Story (Toy Story of Terror)", "Bad Boys (Bad Boys for Life)"; not "Alexander (Alexander the Great)").
  const marksTitle = told.some((w) => NUMBER.has(w) || /\d/.test(w) || caps.has(w));
  const next = wordsAfter(noted, named)?.[0] ?? "";
  const fuller = named.every((w) => noteWords.some((x) => sameWord(w, x))) && !marksTitle && after(noted, named) !== "sep" && next !== "and" && next !== "of" && !LINKS.has(next) && !titleShaped && !namesTitle;
  // A title must hold the note's words that aren't kind words ("Batman (movie)" is not Batman: The Movie).
  // Part words only mark the number ("Toy Story (Part 3)" is Toy Story 3).
  const titleWords = told.filter((w) => !KIND.has(w) && !PART.has(w));
  // A note's word is in a title as written or as its initials ("Law & Order (SVU)" is Law & Order: Special Victims
  // Unit, "NCIS (LA)" NCIS: Los Angeles).
  const inName = (w: string, e: Entity) => words(e.name).some((x) => sameWord(w, x)) || abbreviates(w, e.name);
  const holdsExactly = (e: Entity, ws: string[]) => !!ws.length && ws.every((w) => inName(w, e));
  // Linking words don't count in a title ("War for the Planet of the Apes").
  // Next to an entry named exactly the name, a title must continue the name after a separator, a linking word or a
  // number ("Star Wars: Episode V", "Harry Potter and the Prisoner of Azkaban", "The Godfather Part II"), or start
  // with the note that way and hold the name ("Furiosa: A Mad Max Saga", "Rise of the Planet of the Apes"); a title
  // running the name straight on is another name ("Amy Winehouse" for "Amy (Winehouse documentary)").
  // A note repeating the name before a separator reads from after it ("Twilight (Twilight: New Moon)" is New Moon).
  // A title named exactly a note shaped like a title, naming a title, or adding a number or a word in capitals is
  // taken too ("Spider-Man (The Amazing Spider-Man 2)", "Godzilla (Godzilla Minus One)", "Love Island (Love Island USA)").
  const noteLead = (after(noted, named) === "sep" ? wordsAfter(noted, named) ?? noteWords : noteWords).filter((w) => !LINKS.has(w));
  const subtitle = (e: Entity) => ["sep", "link", "number"].includes(after(e.name, named) ?? "");
  const spinOff = (e: Entity) => ["sep", "link"].includes(after(e.name, noteLead) ?? "") || ((titleShaped || namesTitle || marksTitle) && nameKey(e.name) === nameKey(noted));
  // Or the name, then a franchise's own words, then a separator, then the note ("The Twilight Saga: New Moon"; not
  // "The Paley Center Salutes Law & Order: SVU").
  const franchise = (e: Entity) => {
    const cut = e.name.search(SEPARATOR);
    return cut > 0 && after(e.name.slice(0, cut), named) !== null && after(e.name.slice(cut).replace(/^\s*[:\u2013\u2014-]\s*/, ""), noteLead) !== null;
  };
  const startsWithName = (e: Entity) => after(e.name, named) !== null;
  // A note that is only a number ("The Hunger Games (2)", "Frozen (Part 2)") asks for the Nth film: the title
  // numbered that way right after the name ("Shrek 2", "Kill Bill: Vol. 2", "The Lord of the Rings: The Two
  // Towers"); else Qloo's own top answer for "Name (N)", when it carries no number but the asked one and belongs to
  // the series ("Mad
  // Max (2)" is The Road Warrior; not for the first); else the Nth by year of the titles starting with the name,
  // from the one named exactly that, titles numbered otherwise left out ("The Hunger Games (2)" is Catching Fire,
  // not Mockingjay - Part 2). On a TV show a number is a season, and Qloo keeps a show as one entry: the show.
  const numbers = titleWords.filter((w) => NUMBER.has(w));
  const anchor = named_ ? r!.pick : null;
  const show = (anchor ?? found[0])?.types.includes("urn:entity:tv_show");
  // A season note on a show ("Stranger Things (Season 5)", "Squid Game (Season 2)") is the show: no companion or
  // making-of title ("Stranger Things 5: Behind the Episode", "Squid Game: Making Season 2") is taken or offered first.
  const season = show && numbers.length === 1 && titleWords.length === 1; // not "Drive to Survive (Formula 1)"
  if (numbers.length === 1 && titleWords.length === 1 && !show) {
    const n = NUMBER.get(numbers[0])! + 1;
    // The number a title gives itself right after the name ("Rocky III", "The Two Towers"), if any.
    const ownNumber = (e: Entity) => {
      const rest = isArtist(e) ? null : wordsAfter(e.name, named);
      const w = rest?.find((x) => !PART.has(x) && !SMALL.has(x) && !LINKS.has(x));
      return w && NUMBER.has(w) ? w : null;
    };
    // Or a title holding the name and the number, not after a part word ("2 Fast 2 Furious"; not "The Hunger Games:
    // Mockingjay - Part 2", whose 2 belongs to Mockingjay).
    const ownsNumber = (e: Entity) => {
      const ws = words(e.name);
      return ws.some((w, i) => sameWord(numbers[0], w) && !(i > 0 && PART.has(ws[i - 1])));
    };
    const carries = (e: Entity) => !isArtist(e) && holdsName(e) && ownsNumber(e);
    const numbered = [...found.filter((e) => ownNumber(e) && sameWord(numbers[0], ownNumber(e)!)), ...found.filter(carries)];
    // Whether a title carries no number but the asked one: the name's own words aren't numbers here (the X of "X-Men",
    // the Four of "Fantastic 4"), and a number after a part word belongs to the title's own subtitle unless it is the
    // asked one ("Mission: Impossible (7)" may be Dead Reckoning Part One; "The Hunger Games (2)" is not Mockingjay -
    // Part 2). A title carrying the asked number must hold a word of the name ("Fast & Furious (7)" is Furious 7, an
    // unrelated "Inside Out 2" is not taken).
    const numberAsked = (e: Entity) => {
      const ws = words(e.name);
      let asked = false;
      for (let i = 0; i < ws.length; i++) {
        if (!NUMBER.has(ws[i]) || named.some((x) => sameWord(x, ws[i]))) continue;
        const same = sameWord(numbers[0], ws[i]);
        if (i > 0 && PART.has(ws[i - 1])) { if (same) return false; continue; }
        if (!same) return false;
        asked = true;
      }
      return !asked || named.some((w) => ws.some((x) => sameWord(w, x)));
    };
    // Qloo's first answer, or its second when the first is the film named exactly the name ("Knives Out (2)": Knives
    // Out, then Glass Onion). A second answer is weaker evidence: only a sequel named otherwise, not holding the name
    // ("The Making of The Matrix", "The Matrix Resurrections" are left to the count by year).
    const second = !!anchor && found[0] === anchor;
    const top = second ? found[1] : found[0];
    // A top answer holding the name is the series' own; one that doesn't must come after the film counted as named
    // ("Dark City" is not "The Matrix (2)"), since that film may not be the first ("Fast & Furious" is the fourth, and
    // "Fast & Furious 6", one character off, the sixth: "Fast & Furious (3)" is Tokyo Drift).
    const trusted = n > 1 && !!top && !isArtist(top) && numberAsked(top) && (holdsName(top) || (!!anchor && yearOf(top) > yearOf(anchor))) && (!second || !holdsName(top));
    const since = anchor ? yearOf(anchor) : NaN;
    const later = found
      .filter((e) => e !== anchor && !isArtist(e) && startsWithName(e) && !ownNumber(e) && !Number.isNaN(yearOf(e)) && (Number.isNaN(since) || yearOf(e) > since))
      .map((e, i) => ({ e, i }))
      .sort((x, y) => yearOf(x.e) - yearOf(y.e) || x.i - y.i)
      .map((x) => x.e);
    const series = anchor ? [anchor, ...later] : later;
    // When the count can't reach N (a film missing from Qloo's answers), Qloo's second answer may stand as a title
    // starting with the name ("Twilight (5)": Twilight, then Breaking Dawn - Part 2; Eclipse is never returned).
    const fallback = second && n > 1 && !!top && !isArtist(top) && startsWithName(top) && numberAsked(top) ? top : undefined;
    // A top answer whose own part number differs from the asked one is taken only when the count can't answer
    // ("Harry Potter (3)" is Prisoner of Azkaban by the count, not Deathly Hallows: Part 2, which Qloo lists first for
    // any number; "Mission: Impossible (7)" can't be counted, so Dead Reckoning Part One stands).
    const ws = top ? words(top.name) : [];
    const otherPart = ws.some((w, i) => i > 0 && PART.has(ws[i - 1]) && NUMBER.has(w) && !sameWord(numbers[0], w));
    const pick = numbered[0] ?? (trusted && !(otherPart && series[n - 1]) ? top : series[n - 1] ?? fallback);
    if (pick) {
      const byName = rankTyped(found, bare);
      return { pick, match: "closest", list: [pick, ...(byName?.list ?? []).filter((e) => e !== pick)], offered: (e) => !!byName?.offered(e) && holdsName(e), note: "title", searchName: !numbered.length && !anchor && !trusted };
    }
  }
  const held = season ? [] : found.filter((e) => !isArtist(e) && holdsExactly(e, titleWords) && holdsExactly(e, named));
  const titled = held.filter((e) => !named_ || (!fuller && (subtitle(e) || spinOff(e) || franchise(e))));
  // The note names one title exactly ("Indiana Jones (Raiders of the Lost Ark)", "La Casa de Papel (Money Heist)"):
  // a name of two words or more, not all kind words, never an act (an act's note is as often a hometown that is
  // also a band's name: "Moonsprout (New England)"). The name alone is searched first, since an entry named exactly
  // that wins and may not be among the whole text's answers ("Better Call Saul" may be missing from them).
  // "aka" says the note is another name, so then an act may take it too, and one word is enough ("Ye (aka Kanye West)").
  // The note as typed first ("That '70s Show" ends in a kind word but is a title), then without its kind words.
  const asTitle = (cands: Entity[]) => {
    const whole = rankTyped(cands, rawNote);
    return whole && whole.match !== "closest" ? whole : rankTyped(cands, noted);
  };
  const other = aka ? asTitle(found) : noteWords.length >= 2 && noteWords.some((w) => !KIND.has(w) && !/^\d{4}$/.test(w)) ? asTitle(found.filter((e) => !isArtist(e))) : null;
  const otherPick = other && other.match !== "closest" ? other.pick : null;
  // A book's author is in Qloo's disambiguation: an entry named the name (Qloo's own series note aside: "Dune (Dune,
  // #1)") whose disambiguation holds every word of the note is taken first ("Emma (Jane Austen)" is Emma, 1815, not
  // a collection holding Emma). Not an act, whose disambiguation is its name.
  const credit = told.includes("by") ? told.slice(told.indexOf("by") + 1) : told;
  // Qloo's own series note counts too ("Thief of Time (Discworld, #26)" is "Thief of Time (Discworld, #26; Death, #5)").
  // Else a title starting with the name ("The Hobbit (J.R.R. Tolkien)" is "The Hobbit, or There and Back Again", not
  // a graphic novel named exactly The Hobbit), or whose series does ("Percy Jackson (Rick Riordan)" is The Lightning
  // Thief, Percy Jackson and the Olympians, #1): the earliest one ("Harry Potter (J.K. Rowling)" is the Sorcerer's Stone,
  // 1997, not Qloo's first answer, #3), with the name searched alone too, where the exact one may be.
  const namedCredit = credit.length ? found.find((e) => !isArtist(e) && nameKey(unseries(e.name)) === nameKey(bare) && credits(credit, `${e.disambiguation ?? ""} ${SERIES.exec(e.name)?.[0] ?? ""}`)) : undefined;
  const seriesOf = (e: Entity) => SERIES.exec(e.name)?.[0].replace(/^\s*\(|\)\s*$/g, "") ?? "";
  const yr = (e: Entity) => { const y = yearOf(e); return Number.isNaN(y) ? Infinity : y; };
  const creditedTitles = credit.length ? found.filter((e) => !isArtist(e) && (wordsAfter(unseries(e.name), named) !== null || wordsAfter(seriesOf(e), named) !== null) && credits(credit, e.disambiguation ?? "")) : [];
  creditedTitles.sort((a, b) => yr(a) - yr(b)); // a stable sort: Qloo's order among the same year
  const credited = namedCredit ?? creditedTitles[0];
  if (credited) {
    const byName = rankTyped(found, bare);
    return { pick: credited, match: "closest", list: [credited, ...(byName?.list ?? []).filter((e) => e !== credited)], offered: (e) => !!byName?.offered(e) && holdsName(e), note: "credit", searchName: !namedCredit };
  }
  if (titled.length) {
    // The title holding more of the note's words first, part words too ("Star Wars (Episode 1)" is Episode I, not
    // Rogue One), then the closer one.
    const heldNote = (e: Entity) => noteLead.filter((w) => words(e.name).some((x) => sameWord(w, x))).length;
    const near = (e: Entity) => share(words(input), words(e.name)) + share(words(e.name), words(input));
    const pick = titled.map((e, i) => ({ e, i, h: heldNote(e), s: near(e) })).sort((x, y) => y.h - x.h || y.s - x.s || x.i - y.i)[0].e;
    // A title that is a later part of the note's own title ("Rambo: First Blood Part II" for "Rambo (First Blood)")
    // gives way to the entry named exactly the note.
    const rest = wordsAfter(pick.name, named) ?? [];
    const laterPart = otherPick && rest.length > noteLead.length && noteLead.every((w, i) => sameWord(w, rest[i])) && rest.slice(noteLead.length).every((w) => PART.has(w) || (NUMBER.has(w) && NUMBER.get(w)! > 0));
    const byName = rankTyped(found, bare);
    if (laterPart)
      return { ...other!, match: "closest", list: [otherPick!, pick, ...(byName?.list ?? []).filter((e) => e !== pick && e !== otherPick)], offered: (e) => e === pick || (!!byName?.offered(e) && holdsName(e)), note: "other name" };
    // A title that doesn't start with the name, with no entry named exactly that among the answers: the name alone is
    // searched too, since Qloo's search for the whole text can miss it ("The Mandalorian (Star Wars)" found Lego Star
    // Wars: The Mandalorian but not The Mandalorian). So is a book's, whose note is most often its author ("Emma (by
    // Jane Austen)" found an annotated edition, not Emma).
    return { pick, match: "closest", list: [pick, ...(byName?.list ?? []).filter((e) => e !== pick)], offered: (e) => !!byName?.offered(e) && holdsName(e), note: "title", searchName: !startsWithName(pick) || pick.types.includes("urn:entity:book") };
  }
  if (otherPick && !named_) return { ...other!, match: "closest", note: "other name", searchName: true };
  if (r) {
    // A year picks among the near names by Qloo's disambiguation: "The Lord of the Rings (2001)" is The Fellowship of
    // the Ring, not the 1978 film named exactly that.
    const year = years(noted);
    const said = year.length ? r.list.filter((e) => holds(e, named) && years(e.disambiguation).some((y) => year.includes(y))) : [];
    if (said.length) return { ...r, pick: said[0], match: "closest", list: [said[0], ...r.list.filter((e) => e !== said[0])], note: "year" };
    // A title named in the note, or one holding the name and the note that wasn't taken, is offered first.
    const offer = [...(otherPick ? [otherPick] : []), ...held].filter((e, i, a) => a.indexOf(e) === i && e !== r.pick);
    return { ...r, match: r.match === "exact" ? "closest" : r.match, list: [r.pick, ...offer, ...r.list.filter((e) => e !== r.pick && !offer.includes(e))], offered: (e) => offer.includes(e) || (r.offered(e) && holdsName(e)), note: "name", searchName: r.match === "closest" || year.length > 0 };
  }
  return null;
}

// Search results for the whole text, then those for the name alone that weren't among them.
export const together = (a: Entity[], b: Entity[]) => [...a, ...b.filter((e) => !a.some((x) => x.id === e.id))];

// Qloo names a book in a series with the series after it ("Beloved (Beloved Trilogy, #1)", "Dune (Dune, #1)"): not
// part of the name.
const SERIES = /\s*\([^()]*#\d+\)\s*$/;
const unseries = (s: string) => s.replace(SERIES, "");
function rankTyped(found: Entity[], input: string): Ranked | null {
  // Typed with an article, the name letter for letter comes first ("The Killers" is The Killers before
  // Killers; "A Savage" is A. Savage before Savage), and a name equal without the article still makes it
  // ambiguous ("The Eagles" may mean Eagles). Typed without one, the spelling says nothing about the article:
  // "Killers" is ambiguous between The Killers and Killers, in Qloo's order.
  const literalKey = allWords(input).join(" ");
  const startsWithArticle = allWords(input).length > 1 && ARTICLES.has(allWords(input)[0]); // also "A. Savage"
  // Among those, a typed initial puts the record written the same way first ("A. Savage" is A. Savage before A
  // Savage); typed without the dot, Qloo's order stands.
  const literally = startsWithArticle ? found.filter((e) => allWords(unseries(e.name)).join(" ") === literalKey) : [];
  if (!article(input, allWords(input))) literally.sort((x, y) => Number(nameKey(y.name) === nameKey(input)) - Number(nameKey(x.name) === nameKey(input)));
  const spaced = [...literally, ...found.filter((e) => (nameKey(unseries(e.name)) === nameKey(input) || nameKey(e.name) === nameKey(input)) && !literally.includes(e))];
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
  // A name equal only once Qloo's series note is set aside is the right pick, not an exact name: "Dune" typed as a book
  // is Dune (Dune, #1), and the film is still offered in case the kind was a guess; typed with the note, it is exact.
  return { pick, match: exact.length > 1 ? "ambiguous" : exact.length === 1 && (unseries(exact[0].name) === exact[0].name || nameKey(exact[0].name) === nameKey(input)) ? "exact" : "closest", list, offered };
}
