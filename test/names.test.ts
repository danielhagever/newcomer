// Name matching against the realistic artist inputs Booker's review passes collected (test/name-cases.mjs, shared
// with Booker; its venue and list cases don't apply here and are skipped). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankNames } from "../src/names.ts";
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
  // Nothing before the note, or nothing like it: no guess.
  ["(TV series)", [film("Succession")], "none"],
  ["Nobody Real (TV series)", [film("Succession")], "none"],
];

test("a note in brackets at the end picks which one, and the pick is only ever a closest match", () => {
  const wrong = NOTES.filter(([typed, found, want]) => label(rankNames(found, typed)) !== want).map(([typed, found]) => `${typed} -> ${label(rankNames(found, typed))}`);
  assert.deepEqual(wrong, []);
});
