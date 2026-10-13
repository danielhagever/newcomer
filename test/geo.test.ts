// City lookup against 592 realistic ways people type tour cities (test/geo-cases.json), each with the
// city it should land on and whether the answer should flag what followed the comma. The geocoder's real
// answers were recorded once (test/geo-fixtures.json, trimmed), so this runs offline. Not included, because
// Open-Meteo's answer doesn't hold the right place: Orange County, "Stoke, UK", "Kingston, UK", "St Johns, NL",
// "Windsor, Berkshire" (filed under Windsor and Maidenhead: Windsor, Ontario, flagged), "Derry, Ireland" (filed as
// Londonderry), "Lorenskog" (no Lørenskog at all), "Ennis" and "Cobh" alone (the geocoder ranks Surprise,
// Arizona, and Cobham first; with the county they work: a name alone is never preferred, as "Brussel" is Brussels and
// "Derry" Londonderry), "Bodo" alone (Bodo in Chad is a town of that name), a native city name with a region
// that isn't its country ("Roma, Lazio"), "Newcastle, North East England" (the geocoder's Newcastle upon Tyne goes by
// that name only: an alias reaches it from "Newcastle, UK" or "Newcastle, England"), "Ayvalik, Turkey" and "Bakirkoy,
// Turkey" (filed as Aivali and under Istanbul: a village of the name is found)
// (Oahu, Kauai, Big Island and "Newcastle, UK/England" are now aliases in city.ts); and the ambiguous bare names
// Newcastle, Victoria, Hong Kong, St Andrews, St Malo / Saint Malo (Manitoba, or a French village: Open-Meteo
// gives Saint-Malo itself no population), Prince Edward Island. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cityCenter } from "../src/city.ts";
import { Budget } from "../src/limits.ts";
import { memoryKV } from "./mock.ts";

const FIX: Record<string, unknown[]> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("./geo-fixtures.json", import.meta.url), "utf8")) as Record<string, unknown[]>).map(([k, v]) => [decodeURIComponent(k), v]),
);
const CASES: [string, string, string | null][] = JSON.parse(readFileSync(new URL("./geo-cases.json", import.meta.url), "utf8"));

test("city lookup: 592 realistic inputs land on the right city, and only real mismatches are flagged", async () => {
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
  assert.equal(CASES.length, 592);
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

test("a place of exactly the typed name that fits beats another name that fits, unless that one is over 10 times bigger", async () => {
  // Live: Open-Meteo's first 10 for "Hartford" hold Oak Harbor, Ohio (some old name of it); Hartford, Ohio is further down.
  // An old name keeps its city: "Saigon" finds Ho Chi Minh City, not a hamlet of that name.
  const R = (name: string, population: number, latitude: number) => ({ name, admin1: "Ohio", country: "United States", country_code: "US", population, feature_code: "PPL", latitude, longitude: -82 });
  const answers: Record<string, any[]> = { "Testford|10": [R("Oak Harbor", 2715, 41.5)], "Testford|100": [R("Oak Harbor", 2715, 41.5), R("Testford", 384, 41.2)], "Oldname|10": [R("Bigcity", 6000, 39)], "Oldname|100": [R("Bigcity", 6000, 39), R("Oldname", 300, 40)] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    return new Response(JSON.stringify({ results: answers[`${u.searchParams.get("name")}|${u.searchParams.get("count")}`] ?? [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Testford, Ohio"))?.lat, 41.2);
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Oldname, Ohio"))?.lat, 39, "20 times bigger keeps the other name");
  } finally {
    globalThis.fetch = original;
  }
});

test("a Norwegian or Danish name typed without ø or æ is asked again with them; an answer of another name counts only with people", async () => {
  const R = (name: string, population?: number) => ({ name, admin1: "Troms", country: "Norway", country_code: "NO", ...(population ? { population } : {}), feature_code: "PPL", latitude: 69, longitude: 19 });
  const answers: Record<string, any[]> = { "Testsø": [R("Testsø Kommune", 5000)], "Testbø": [R("Testbø Airport")], "TESTæ": [R("Testæ", 800)] };
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    asked.push(u.searchParams.get("name")!);
    return new Response(JSON.stringify({ results: answers[u.searchParams.get("name")!] ?? [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Testso, Norway"))?.name, "Testsø Kommune, Norway");
    assert.equal(await cityCenter(memoryKV().kv, new Budget(48), "Testbo, Norway"), null, "an airport isn't the town");
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "TESTAE, Norway"))?.name, "Testæ, Norway", "capitals too");
    asked.length = 0;
    await cityCenter(memoryKV().kv, new Budget(48), "Testbo, Ohio");
    assert.ok(!asked.includes("Testbø"), "only with no country or a Nordic one");
    asked.length = 0;
    await cityCenter(memoryKV().kv, new Budget(48), "Testoboi");
    assert.deepEqual(asked, ["Testoboi", "Testobøi", "Testøboi"], "two respellings at most (ø here, before ı)");
  } finally {
    globalThis.fetch = original;
  }
});

test("a direction typed before a region is dropped only when nothing fits with it, among 100 places too", async () => {
  const R = (admin1: string, population: number, latitude: number) => ({ name: "Testburg", admin1, country: "Testland", country_code: "TL", population, feature_code: "PPL", latitude, longitude: 0 });
  const TEN = [R("Northern Upland", 1000, 10), R("Upland", 90000, 20)];
  const HUNDRED = [...TEN, R("Coast", 500, 30)];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    return new Response(JSON.stringify({ results: u.searchParams.get("count") === "100" ? HUNDRED : TEN }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Testburg, Northern Upland"))?.lat, 10, "it fits as typed");
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Testburg, South Upland"))?.lat, 20, "Upland, the biggest that fits without South");
    const coast = await cityCenter(memoryKV().kv, new Budget(48), "Testburg, West Coast");
    assert.equal(coast?.lat, 30, "found among 100 by the region without its direction");
    assert.equal(coast?.unmatched, "West Coast", "flagged: the direction itself wasn't matched");
  } finally {
    globalThis.fetch = original;
  }
});

test("a region typed with plain letters fits one written with ø, æ, ı or ð", async () => {
  const R = (admin1: string, country: string, country_code: string, latitude: number) => ({ name: "Testby", admin1, country, country_code, population: 900, feature_code: "PPL", latitude, longitude: 0 });
  const TEN = [R("Kırşehir", "Republic of Türkiye", "TR", 39), R("Suðurland", "Iceland", "IS", 64), R("Møre og Romsdal", "Norway", "NO", 62), R("Ohio", "United States", "US", 40)];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ results: TEN }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    for (const [typed, lat] of [["Testby, Kirsehir", 39], ["Testby, Sudurland", 64], ["Testby, More og Romsdal", 62]] as const) {
      const p = await cityCenter(memoryKV().kv, new Budget(48), typed);
      assert.equal(p?.lat, lat, typed);
      assert.equal(p?.unmatched, undefined, typed);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("a county fits only outside the US and only for a word that isn't a state or country", async () => {
  // Open-Meteo writes US counties bare: Southampton, Massachusetts is in "Hampshire" (live). And a typed state is the
  // state, even where a place elsewhere has a county of that name.
  const R = (name: string, admin1: string, admin2: string, country_code: string, population: number, latitude: number) => ({ name, admin1, admin2, country_code, population, feature_code: "PPL", latitude, longitude: 0 });
  const TEN = [R("Testburg", "England", "Testburg", "GB", 250000, 51), R("Testburg", "Massachusetts", "Hampshire", "US", 5000, 42), R("Testburg", "Ontario", "Ohio", "CA", 90000, 43), R("Testburg", "Ohio", "Lake", "US", 1000, 41)];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ results: TEN }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const hants = await cityCenter(memoryKV().kv, new Budget(48), "Testburg, Hampshire");
    assert.equal(hants?.lat, 51, "not the US town in Hampshire County: the biggest Testburg, flagged");
    assert.equal(hants?.unmatched, "Hampshire");
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Testburg, Ohio"))?.lat, 41, "Ohio the state, not a county named Ohio");
  } finally {
    globalThis.fetch = original;
  }
});

test("a coordinate the geocoder leaves out is 0 (it drops exactly 0: Stratford, London has no longitude)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ results: [{ name: "Testford", admin1: "England", admin2: "Greater London", country: "United Kingdom", country_code: "GB", population: 51387, feature_code: "PPL", latitude: 51.54 }] }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const p = await cityCenter(memoryKV().kv, new Budget(48), "Testford, London");
    assert.equal(p?.lon, 0);
    assert.equal(p?.lat, 51.54);
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
