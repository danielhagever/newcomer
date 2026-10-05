// Name matching against the realistic artist inputs Booker's review passes collected (test/name-cases.mjs, shared
// with Booker; its venue and list cases don't apply here and are skipped). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { after, forSearch, rankNames, together, withoutNote } from "../src/names.ts";
import { readFileSync } from "node:fs";
// @ts-ignore: plain JavaScript table
import cases from "./name-cases.mjs";

let n = 0;
const art = (name: string, genre = "Indie") => ({ id: `a${++n}`, name, types: ["urn:entity:artist"], genres: [genre] });
const show = (r: any) => (r ? `${r.pick.name} ${r.match}` : "none");
const is = (...want: string[]) => (out: string) => want.includes(out);
const starts = (...want: string[]) => (out: string) => want.some((w) => out.startsWith(w));
const eqList = (...xs: string[]) => (out: string) => out === JSON.stringify(xs);

test("name matching: every realistic artist input from Booker's table gets the answer a reasonable person expects", async () => {
  const wrong: string[] = [];
  let count = 0;
  await cases({
    place: () => ({}), art, is, starts, eqList,
    runVenue: async () => {},
    runSplit: () => {},
    runArtist: async (typed: string, found: any[], ok: (o: string) => boolean) => {
      count++;
      const out = show(rankNames(found, typed));
      if (!ok(out)) wrong.push(`${JSON.stringify(typed)} -> ${out}`);
    },
  });
  assert.ok(count > 150, `${count} artist inputs`);
  assert.deepEqual(wrong, []);
});

// A note in brackets at the end is how an agent (or a person) says which one; it isn't part of the name.
const film = (name: string, year?: string) => ({ id: `f${++n}`, name, types: ["urn:entity:movie"], ...(year ? { disambiguation: year } : {}) });
const label = (r: any) => (r ? `${r.pick.name}${r.pick.disambiguation ? ` (${r.pick.disambiguation})` : ""} ${r.match}` : "none");
const NOTES: [string, any[], string][] = [
  ["Succession (TV series)", [film("Succession")], "Succession closest"],
  ["Succession [HBO]", [film("Succession")], "Succession closest"],
  ["Dune (2021 film)", [film("Dune", "1984"), film("Dune", "2021"), film("Dune: Part Two", "2024")], "Dune (2021) closest"],
  ["Dune (1984)", [film("Dune", "2021"), film("Dune", "1984")], "Dune (1984) closest"],
  ["Dune (film)", [film("Dune", "2021"), film("Dune", "1984")], "Dune (2021) ambiguous"], // the note doesn't say which: Qloo's order, flagged
  ["The Bear (FX show)", [film("The Bear", "2022"), film("Bear Grylls")], "The Bear (2022) closest"],
  ["Wednesday (indie rock band)", [art("Wednesday"), art("Wednesday 13")], "Wednesday closest"],
  ["Tom Pety (singer)", [art("Tom Waits"), art("Tom Petty")], "Tom Petty closest"],
  // A name that itself ends in brackets is still exact.
  ["Birdman (or The Unexpected Virtue of Ignorance)", [film("Birdman (or The Unexpected Virtue of Ignorance)", "2014"), film("Birdman")], "Birdman (or The Unexpected Virtue of Ignorance) (2014) exact"],
  // Seen live (Qloo searched with the whole text): a candidate that only shares the note's words is not a match.
  ["Succession (TV series)", [film("Scream: The TV Series", "2015,2019")], "none"],
  ["Wednesday (indie rock band)", [art("Lafayette Afro Rock Band")], "none"],
  ["Dune (2021 film)", [film("Dune", "1984")], "Dune (1984) closest"], // the year can't pick what wasn't found; flagged as closest
  // The note is part of the name: a subtitle picks the entry that holds both (seen as a regression: these went to the first film).
  ["Star Wars (The Empire Strikes Back)", [film("Star Wars", "1977"), film("Star Wars: Episode V - The Empire Strikes Back", "1980"), film("Star Wars: Episode VI - Return of the Jedi", "1983")], "Star Wars: Episode V - The Empire Strikes Back (1980) closest"],
  ["Star Wars (Return of the Jedi)", [film("Star Wars", "1977"), film("Star Wars: Episode V - The Empire Strikes Back", "1980"), film("Star Wars: Episode VI - Return of the Jedi", "1983")], "Star Wars: Episode VI - Return of the Jedi (1983) closest"],
  ["Harry Potter (Prisoner of Azkaban)", [film("Harry Potter and the Sorcerer's Stone", "2001"), film("Harry Potter and the Prisoner of Azkaban", "2004")], "Harry Potter and the Prisoner of Azkaban (2004) closest"],
  ["Lord of the Rings (Return of the King)", [film("The Lord of the Rings: The Fellowship of the Ring", "2001"), film("The Lord of the Rings: The Return of the King", "2003")], "The Lord of the Rings: The Return of the King (2003) closest"],
  ["Dune (Part Two)", [film("Dune", "2021"), film("Dune: Part Two", "2024")], "Dune: Part Two (2024) exact"], // the same words as the name
  // The note is another name for it: used only when it is that name exactly.
  ["Yasiin Bey (Mos Def)", [art("Mos Def")], "none"], // never another name for an act (pass 5); live, the name alone finds Yasiin Bey
  ["La Casa de Papel (Money Heist)", [film("Money Heist", "2017,2021")], "Money Heist (2017,2021) closest"],
  ["Moonsprout (indie rock band)", [art("Indie Rock Allstars")], "none"],
  // A title starts with the name with small words aside ("The Fast and the Furious" starts with "Fast & Furious"),
  // even next to an entry named exactly the name (Qloo's real titles).
  ["Fast & Furious (Tokyo)", [film("Fast & Furious", "2009"), film("The Fast and the Furious: Tokyo Drift", "2006")], "The Fast and the Furious: Tokyo Drift (2006) closest"],
  // The title holding more of the note's words wins: "Rogue One" holds a 1 too, but not "Episode".
  ["Star Wars (Episode 1)", [film("Rogue One: A Star Wars Story", "2016"), film("Star Wars: Episode I - The Phantom Menace", "1999"), film("Star Wars: Episode IV - A New Hope", "1977")], "Star Wars: Episode I - The Phantom Menace (1999) closest"],
  // A number-only note counts titles starting with the name by year, but not titles numbered otherwise, and keeps Part 1 ones.
  ["The Hunger Games (3)", [film("The Hunger Games", "2012"), film("The Hunger Games: Mockingjay - Part 2", "2015"), film("The Hunger Games: Catching Fire", "2013"), film("The Hunger Games: Mockingjay - Part 1", "2014")], "The Hunger Games: Mockingjay - Part 1 (2014) closest"],
  ["Rocky (2)", [film("Rocky", "1976"), film("Rocky III", "1982"), film("Rocky IV", "1985")], "Rocky (1976) closest"], // Rocky II not among the answers: not Rocky III
  ["The Matrix (2)", [film("The Matrix", "1999"), film("The Making of The Matrix", "2001"), film("The Matrix Reloaded", "2003")], "The Matrix Reloaded (2003) closest"], // only titles starting with the name count
  ["Toy Story (1)", [film("Toy Story That Time Forgot", "2014"), film("Toy Story", "1995")], "Toy Story (1995) closest"], // Qloo's top answer is never the first
  ["The Matrix (2)", [film("Dark City", "1998"), film("The Matrix", "1999"), film("The Matrix Reloaded", "2003")], "The Matrix Reloaded (2003) closest"], // nor older than the film named exactly that
  ["Twilight (2)", [film("Inside Out 2", "2024"), film("Twilight", "2008"), film("The Twilight Saga: New Moon", "2009")], "The Twilight Saga: New Moon (2009) closest"], // Qloo's top answer carries the 2 but no word of the name
  ["The Matrix (2)", [film("The Matrix", "1999"), film("The Matrix Resurrections", "2021"), film("The Matrix Reloaded", "2003")], "The Matrix Reloaded (2003) closest"], // Qloo's second answer only as a sequel named otherwise
  ["Fantastic 4 (2)", [film("Fantastic Four: Rise of the Silver Surfer", "2007"), film("The Fantastic Four: First Steps", "2025")], "Fantastic Four: Rise of the Silver Surfer (2007) closest"], // the name's Four is the typed 4, not another number
  ["The Hunger Games (3)", [film("The Hunger Games: Mockingjay - Part 2", "2015"), film("The Hunger Games", "2012"), film("The Hunger Games: Catching Fire", "2013"), film("The Hunger Games: Mockingjay - Part 1", "2014")], "The Hunger Games: Mockingjay - Part 1 (2014) closest"], // a top answer with another part number loses to the count
  ["Mission: Impossible (Dead Reckoning)", [film("Mission: Impossible - Dead Reckoning Part One", "2023"), film("Dead Reckoning", "1947")], "Mission: Impossible - Dead Reckoning Part One (2023) closest"], // "Part One" is not a later part: not the 1947 film
  ["Mission: Impossible (Dead Reckoning film)", [film("Mission: Impossible - Dead Reckoning", "2023"), film("Dead Reckoning", "1947")], "Mission: Impossible - Dead Reckoning (2023) closest"], // nothing after the note: not a later part either
  // A one-word note is never the name of another title: "Phoenix" is the actor here, though a 2014 film is named that.
  ["Joker (Phoenix)", [film("Joker", "2019"), film("Phoenix", "2014")], "Joker (2019) closest"],
  // Nothing before the note, or nothing like it: no guess.
  ["(TV series)", [film("Succession")], "none"],
  ["Nobody Real (TV series)", [film("Succession")], "none"],
];

test("a note in brackets at the end picks which one; unless the whole text is a name, the pick is only a closest match", () => {
  const wrong = NOTES.filter(([typed, found, want]) => label(rankNames(found, typed)) !== want).map(([typed, found]) => `${typed} -> ${label(rankNames(found, typed))}`);
  assert.deepEqual(wrong, []);
});

test("how a title goes on after the name: a separator, a \"!\" or \"?\" before more words, or a dash (real titles)", () => {
  assert.equal(after("Mamma Mia! Here We Go Again", ["mamma", "mia"]), "sep");
  assert.equal(after("Are You Being Served? Again!", ["are", "you", "being", "served"]), "sep");
  assert.equal(after("Mamma Mia!", ["mamma", "mia"]), "end"); // nothing after the "!"
  assert.equal(after("Yo! MTV Raps", ["yo", "mtv", "raps"]), "end"); // a "!" inside the name
  let n = 0;
  const film = (name: string, year: string) => ({ id: `t${++n}`, name, types: ["urn:entity:movie"], disambiguation: year });
  const pick = (input: string, found: any[]) => { const r = rankNames(found, input); return r ? `${r.pick.name} (${r.pick.disambiguation})` : "none"; };
  assert.equal(pick("Are You Being Served (Again)", [film("Are You Being Served?", "1977"), film("Are You Being Served? Again!", "1992")]), "Are You Being Served? Again! (1992)");
  // A found title named exactly the note, with a separator in it, is a title, not a fuller name (Qloo writes ":").
  for (const dash of [" - ", " \u2013 ", " \u2014 "])
    assert.equal(pick("Jurassic Park (The Lost World Jurassic Park)", [film("Jurassic Park", "1993"), film(`The Lost World${dash}Jurassic Park`, "1997")]), `The Lost World${dash}Jurassic Park (1997)`);
  // A hyphen inside a name is not a separator: on Qloo's recorded answers for "X-Men" alone, with X-Men (2000) among
  // them, "X-Men Origins: Wolverine" is X-Men, then Origins, then the note.
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  assert.equal(rankNames(F["movie|X-Men"], "X-Men (Wolverine)")?.pick.name, "X-Men Origins: Wolverine");
});

test("Qloo is searched with the name before a note in brackets", () => {
  assert.equal(withoutNote("Succession (TV series)"), "Succession");
  assert.equal(withoutNote("Dune [2021]"), "Dune");
  assert.equal(withoutNote("(TV series)"), "(TV series)");
  assert.equal(withoutNote("Sunn O)))"), "Sunn O)))");
});

test("notes in brackets on Qloo's live answers: 296 realistic inputs get the entry a reasonable person expects (known limits listed)", async () => {
  const { T } = await import("./note-cases.mjs" as string);
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  const show = (e: any) => `${e.name}${e.disambiguation && e.disambiguation.toLowerCase() !== e.name.toLowerCase() ? ` (${e.disambiguation})` : ""}`;
  const wrong: string[] = [];
  let searches = 0;
  const known: string[] = [];
  for (const [input, kind, want, limit] of T) {
    // The same flow as resolveEntity: the whole text, then the name alone when that may find a better entry.
    const whole = F[`${kind}|${forSearch(input)}`];
    let r = rankNames(whole, input);
    searches++;
    if (withoutNote(input) !== input && (!r || r.searchName)) {
      r = rankNames(together(whole, F[`${kind}|${withoutNote(input)}`]), input);
      searches++;
    }
    const got = r ? show(r.pick) : "none";
    if (limit) known.push(input);
    if (!want(got)) wrong.push(input);
  }
  // Every miss is a known limit, and every known limit still misses (so a fix there is noticed).
  assert.deepEqual(wrong, known);
  assert.ok(searches <= 369, `${searches} Qloo searches for 296 names`);
});

test("when the exact name wins, the title named in the note is offered first under Not it? (Qloo's live answers)", () => {
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  for (const [input, kind, offered] of [["Chicago P.D. (Chicago Fire)", "tv_show", "Chicago Fire"], ["Better Call Saul (Breaking Bad)", "tv_show", "Breaking Bad"], ["Fuller House (Full House)", "tv_show", "Full House"], ["House of the Dragon (Game of Thrones)", "tv_show", "Game of Thrones"], ["Amy (Amy Winehouse)", "movie", "Amy Winehouse"], ["Amy (Winehouse documentary)", "movie", "Amy Winehouse"], ["Whitney (Whitney Houston)", "movie", "Whitney Houston: I Wanna Dance with Somebody"], ["Fear the Walking Dead (The Walking Dead)", "tv_show", "The Walking Dead"], ["That '90s Show (That '70s Show)", "tv_show", "That '70s Show"], ["Halloween (Halloween Kills)", "movie", "Halloween Kills"]]) {
    const r = rankNames(together(F[`${kind}|${input}`], F[`${kind}|${withoutNote(input)}`]), input)!;
    assert.equal(r.list.filter((e) => e !== r.pick && r.offered(e))[0]?.name, offered, input);
  }
});

test("a number word after a part word is searched as a digit (Qloo finds Episode 1, not Episode One); the rest stays", () => {
  assert.equal(forSearch("Star Wars (Episode One)"), "Star Wars (Episode 1)");
  assert.equal(forSearch("Dune (Part Two)"), "Dune (Part 2)");
  assert.equal(forSearch("Kill Bill (Vol. Two)"), "Kill Bill (Vol. 2)");
  assert.equal(forSearch("Fast & Furious (Fast Five)"), "Fast & Furious (Fast Five)");
  assert.equal(forSearch("Part One Records"), "Part One Records");
});

test("with a note, Not it? offers only entries holding the name, besides the note's own titles (Qloo's live answers)", () => {
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  for (const [input, kind] of [["Dune (Part Two)", "movie"], ["The Godfather (Part II)", "movie"], ["It (Chapter Two)", "movie"], ["Rambo (First Blood)", "movie"]]) {
    const r = rankNames(together(F[`${kind}|${forSearch(input)}`], F[`${kind}|${withoutNote(input)}`]), input)!;
    const name = withoutNote(input).toLowerCase().replace(/^the /, "");
    const offered = r.list.filter((e) => e !== r.pick && r.offered(e));
    assert.deepEqual(offered.filter((e) => !e.name.toLowerCase().includes(name)).map((e) => e.name), [], input);
    assert.equal(new Set(offered).size, offered.length, `${input}: offered twice`);
  }
});
