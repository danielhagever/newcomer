// City lookup against 457 realistic ways people type tour cities (test/geo-cases.json), each with the
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

test("city lookup: 457 realistic inputs land on the right city, and only real mismatches are flagged", async () => {
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
  assert.equal(CASES.length, 457);
  assert.deepEqual(wrong, []);
});

test("a city typed as one of Object's own names ('constructor', '__proto__') is not found, not a crash", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    for (const city of ["Constructor", "__proto__", "Austin, __proto__", "__proto__, Texas", "St constructor, constructor", "constructor, us", "toString, valueOf"])
      assert.equal(await cityCenter(memoryKV().kv, new Budget(48), city), null, city);
  } finally {
    globalThis.fetch = original;
  }
});

test("100 places are asked for only when what follows the comma fits none of the first 10, and only places of that exact name are added", async () => {
  // Live: Newport, Rhode Island; Salem, Massachusetts; Jackson, Wyoming are past Open-Meteo's first 10 of their names.
  const R = (name: string, admin1: string, population: number, latitude: number) => ({ name, admin1, country: "United States", country_code: "US", population, feature_code: "PPL", latitude, longitude: -71 });
  const TEN = [R("Testville", "Ohio", 1000, 40), R("Testville", "Indiana", 500, 39)];
  const HUNDRED = [...TEN, R("Testville Heights", "Rhode Island", 50000, 41.5), R("Testville", "Rhode Island", 20000, 41.6), R("Testville", "Kansas", 90000, 38)];
  const original = globalThis.fetch;
  const counts: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    counts.push(u.searchParams.get("count")!);
    return new Response(JSON.stringify({ results: u.searchParams.get("count") === "100" ? HUNDRED : TEN }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const ri = await cityCenter(memoryKV().kv, new Budget(48), "Testville, Rhode Island");
    assert.equal(ri?.lat, 41.6, "Testville itself, not the bigger Testville Heights");
    assert.equal(ri?.unmatched, undefined);
    const nowhere = await cityCenter(memoryKV().kv, new Budget(48), "Testville, Nowhere");
    assert.equal(nowhere?.lat, 40, "nothing fits Nowhere among 100 either: the first 10's answer, flagged");
    assert.equal(nowhere?.unmatched, "Nowhere");
    // Whole words only: "India" isn't Indiana (live: "Calcutta, India" was Calcutta, Indiana, unflagged).
    const india = await cityCenter(memoryKV().kv, new Budget(48), "Testville, India");
    assert.equal(india?.unmatched, "India");
    counts.length = 0;
    await cityCenter(memoryKV().kv, new Budget(48), "Testville, Ohio");
    assert.deepEqual(counts, ["10"], "a region that fits is asked once");
  } finally {
    globalThis.fetch = original;
  }
});

test("a territory's record has no country name: its own name labels it, and Hong Kong and Macau are also China", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results: [{ name: "Testville", admin1: "Ilhas", country_code: "MO", population: 50000, feature_code: "PPLA", latitude: 22.2, longitude: 113.5 }, { name: "Testville", admin1: "Guangdong", country: "China", country_code: "CN", population: 900, feature_code: "PPL", latitude: 23, longitude: 113 }] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const macau = await cityCenter(memoryKV().kv, new Budget(48), "Testville, Macau");
    assert.equal(macau?.name, "Testville, Macau");
    const china = await cityCenter(memoryKV().kv, new Budget(48), "Testville, China");
    assert.equal(china?.name, "Testville, Macau", "Macau is China too; the bigger place wins");
    assert.equal(china?.unmatched, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
