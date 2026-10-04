// Name matching against the realistic artist inputs Booker's review passes collected (test/name-cases.mjs, shared
// with Booker; its venue and list cases don't apply here and are skipped). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankNames, together, withoutNote } from "../src/names.ts";
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
  // A one-word note is never the name of another title: "Phoenix" is the actor here, though a 2014 film is named that.
  ["Joker (Phoenix)", [film("Joker", "2019"), film("Phoenix", "2014")], "Joker (2019) closest"],
  // Nothing before the note, or nothing like it: no guess.
  ["(TV series)", [film("Succession")], "none"],
  ["Nobody Real (TV series)", [film("Succession")], "none"],
];

test("a note in brackets at the end picks which one, and the pick is only ever a closest match", () => {
  const wrong = NOTES.filter(([typed, found, want]) => label(rankNames(found, typed)) !== want).map(([typed, found]) => `${typed} -> ${label(rankNames(found, typed))}`);
  assert.deepEqual(wrong, []);
});

test("Qloo is searched with the name before a note in brackets", () => {
  assert.equal(withoutNote("Succession (TV series)"), "Succession");
  assert.equal(withoutNote("Dune [2021]"), "Dune");
  assert.equal(withoutNote("(TV series)"), "(TV series)");
  assert.equal(withoutNote("Sunn O)))"), "Sunn O)))");
});

test("notes in brackets on Qloo's live answers: 112 realistic inputs get the entry a reasonable person expects", async () => {
  const { T } = await import("./note-cases.mjs" as string);
  const F = JSON.parse(readFileSync(new URL("./note-fixtures.json", import.meta.url), "utf8"));
  const show = (e: any) => `${e.name}${e.disambiguation && e.disambiguation.toLowerCase() !== e.name.toLowerCase() ? ` (${e.disambiguation})` : ""}`;
  const wrong: string[] = [];
  let searches = 0;
  for (const [input, kind, want] of T) {
    // The same flow as resolveEntity: the whole text, then the name alone when that may find a better entry.
    const whole = F[`${kind}|${input}`];
    let r = rankNames(whole, input);
    searches++;
    if (withoutNote(input) !== input && (!r || r.searchName)) {
      r = rankNames(together(whole, F[`${kind}|${withoutNote(input)}`]), input);
      searches++;
    }
    const got = r ? show(r.pick) : "none";
    if (!want(got)) wrong.push(`${input} -> ${got}`);
  }
  assert.deepEqual(wrong, []);
  assert.ok(searches <= 138, `${searches} Qloo searches for 112 names`);
});
