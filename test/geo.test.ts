// City lookup against 426 realistic ways people type tour cities (test/geo-cases.json), each with the
// city it should land on and whether the answer should flag what followed the comma. The geocoder's real
// answers were recorded once (test/geo-fixtures.json, trimmed), so this runs offline. Not included, because
// Open-Meteo's answer doesn't hold the right place: Orange County, "Stoke, UK", "Kingston, UK", "St Johns, NL"
// (Oahu, Kauai, Big Island and "Newcastle, UK/England" are now aliases in geo.ts); and the ambiguous bare names
// Newcastle, Victoria, Hong Kong, St Andrews, St Malo / Saint Malo (Manitoba, or a French village: Open-Meteo
// gives Saint-Malo itself no population), Prince Edward Island. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cityCenter } from "../src/geo.ts";
import { Budget } from "../src/limits.ts";
import { memoryKV } from "./mock.ts";

const FIX: Record<string, unknown[]> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("./geo-fixtures.json", import.meta.url), "utf8")) as Record<string, unknown[]>).map(([k, v]) => [decodeURIComponent(k), v]),
);
const CASES: [string, string, string | null][] = JSON.parse(readFileSync(new URL("./geo-cases.json", import.meta.url), "utf8"));

test("city lookup: 426 realistic inputs land on the right city, and only real mismatches are flagged", async () => {
  const original = globalThis.fetch;
  const missing = new Set<string>();
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const key = decodeURIComponent(`${u.pathname.replace("/v1/", "")}${u.search}`);
    if (!(key in FIX)) missing.add(key);
    // /v1/search answers { results: [...] }; /v1/get answers the one record.
    const body = key.startsWith("get?") ? (FIX[key]?.[0] ?? {}) : { results: FIX[key] ?? [] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const wrong: string[] = [];
  try {
    // Two places can share a label: the UK's nations must pick the right one (Bangor in Wales, not Northern Ireland).
    const wales = await cityCenter(memoryKV().kv, new Budget(48), "Bangor, Wales");
    const ni = await cityCenter(memoryKV().kv, new Budget(48), "Bangor, Northern Ireland");
    assert.ok(Math.abs(wales!.lat - 53.23) < 0.1 && Math.abs(ni!.lat - 54.66) < 0.1, `Bangor, Wales at ${wales!.lat}; Northern Ireland at ${ni!.lat}`);
    for (const [typed, want, note] of CASES) {
      const p = await cityCenter(memoryKV().kv, new Budget(48), typed);
      const got = p ? p.name : "NULL (not placed)";
      if (got !== want || (p?.unmatched ?? null) !== note) wrong.push(`${typed} -> ${got}${p?.unmatched ? ` [note ${p.unmatched}]` : ""}, want ${want}${note ? ` [note ${note}]` : ""}`);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual([...missing], [], "every geocoder call has a recorded answer");
  assert.equal(CASES.length, 426);
  assert.deepEqual(wrong, []);
});
