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
