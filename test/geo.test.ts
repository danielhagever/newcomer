// City lookup against 779 realistic ways people type tour cities (test/geo-cases.json), each with the
// city it should land on and whether the answer should flag what followed the comma. The geocoder's real
// answers were recorded once (test/geo-fixtures.json, trimmed), so this runs offline. Not included, because
// Open-Meteo's answer doesn't hold the right place: Orange County, "Stoke, UK", "Kingston, UK", "St Johns, NL",
// "Windsor, Berkshire" (filed under Windsor and Maidenhead: Windsor, Ontario, flagged), "Derry, Ireland" (filed as
// Londonderry), "Lorenskog" (no Lørenskog at all), "Ennis", "Cobh" and "Chelm" alone (the geocoder ranks Surprise,
// Arizona, Cobham and Chelmsford first; with the county they work: a name alone is never preferred, as "Brussel" is Brussels and
// "Derry" Londonderry), "Bodo" alone (Bodo in Chad is a town of that name), a native city name with a region
// that isn't its country ("Roma, Lazio"), "Newcastle, North East England" (the geocoder's Newcastle upon Tyne goes by
// that name only: an alias reaches it from "Newcastle, UK" or "Newcastle, England"), "Ayvalik, Turkey" and "Bakirkoy,
// Turkey" (filed as Aivali and under Istanbul: a village of the name is found), "Hamilton, North Island" (no region of
// that name: a Hamilton in Rhode Island, another country, flagged), "Arlington, NoVA" ("Nova" is in Nova Scotia),
// "Union City, North Jersey" and "Halifax, West Yorkshire" (filed under Calderdale), flagged; one-letter directions
// ("Charleston, W. Virginia"), a direction as its own part ("Naples, SW, Florida"), a county with its country in
// brackets ("Dover, Kent (UK)"), "Bethlehem, West Bank", airports the geocoder files under the typed name ("Raleigh-Durham, NC", "Dallas/Fort
// Worth"), "Laayoune, Morocco", "Dakhla, Morocco" and "Bethlehem, Israel" (the geocoder files the cities under Western
// Sahara and Palestine: a village of the name fits the typed country), a city, state and country with no commas
// ("Salem MA USA"), and a region with a direction or county before its country with no comma ("Vernon, Okanagan
// Canada")
// (Oahu, Kauai, Big Island and "Newcastle, UK/England" are now aliases in city.ts); a nickname followed only by a
// continent or a ZIP code ("Venice, Europe" is Dayton, Ohio, "St Pete, 33701" Saint Petersburg, Russia, both flagged), a
// name needing ø, ı or ł followed only by a continent ("Tromso, Europe" is the island, flagged), and a Polish name typed
// alone (with no country only two spellings are asked, the Nordic first: "Kolobrzeg" isn't found, "Glogow" is a
// Bulgarian village), "San Sebastian" with a Spanish region other than its own ("San Sebastian, Canary Islands, Spain" is
// Donostia, flagged: a native name holds when its country is typed), postal codes whose letters aren't the country's
// code (Dutch "1012 AB" reads AB as Alberta, Malta's "VLT 1117", Austria's "A-1010", flagged), a native name followed
// only by a postal code ("Wien, 1010" is in Poland, "Lisboa, 1100-148" Mozambique, flagged: the twin of a nickname's),
// a postal code with no comma before or after the city ("Portland ME 04101", "10115 Berlin": not found, said so), old
// names other than those measured in OLD_NAMES, an old name typed with its state ("Calcutta, West Bengal", "Madras, Tamil
// Nadu": the namesake elsewhere, flagged), a namesake of an old name without people typed with its state ("Danzig, ND" is
// Gdańsk, flagged), a "Mt." name the geocoder doesn't know ("Mt. Washington, KY" is Mt. Pleasant, South Carolina,
// flagged), "City of X" in another language ("Ciudad de Guatemala" is Los Angeles, "Ville de Monaco" Phnom Penh, flagged),
// a whole name that is also a hamlet's ("Roma Texas" is a village of that name in Mexico, unflagged), a hyphenated saint
// or "Fort de" name typed with spaces where the geocoder's first answer is elsewhere ("Saint Lambert, QC" and "Saint
// Sauveur, QC" are in France, "Saint Albans, UK" in Australia, "Fort de France, Martinique" in Indonesia, "Pont Saint
// Martin" Pont-Sainte-Maxence; flagged), regions written with "St." ("Castries, St Lucia", "Jamestown, St Helena":
// flagged), an Italian province code without a comma ("Schio VI" is in Japan, flagged), a name Open-Meteo knows only in plain letters
// ("Bielsko-Biała" isn't found; "Bielsko-Biala" is), a region in its own language that no list holds ("Düsseldorf,
// Nordrhein-Westfalen", "Bordeaux, Nouvelle-Aquitaine": the right city, flagged); and the ambiguous bare names
// Newcastle, Victoria, Hong Kong, St Andrews, St Malo / Saint Malo (Manitoba, or a French village: Open-Meteo
// gives Saint-Malo itself no population), Prince Edward Island. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cityCenter, cityRadiusKm, readNote } from "../src/city.ts";
import { Budget } from "../src/limits.ts";
import { memoryKV } from "./mock.ts";

const FIX: Record<string, unknown[]> = Object.fromEntries(
  Object.entries(JSON.parse(readFileSync(new URL("./geo-fixtures.json", import.meta.url), "utf8")) as Record<string, unknown[]>).map(([k, v]) => [decodeURIComponent(k), v]),
);
const CASES: [string, string, string | null][] = JSON.parse(readFileSync(new URL("./geo-cases.json", import.meta.url), "utf8"));
// What some answers say: a direction dropped and a part set aside are both said, the part set aside not as fitting
// (pass 53: "West Wales" went unsaid).
const NOTES: Record<string, string> = {
  "Newport, West Wales, Cymru": `"Newport, West Wales, Cymru" was read as Newport, Wales; "West Wales, Cymru" fit only as "Wales", so check this is the city you meant.`,
  "Newport, West Wales": `"Newport, West Wales" was read as Newport, Wales; "West Wales" fit only as "Wales", so check this is the city you meant.`,
  "Venice, Italy, Europe": `"Venice, Italy, Europe" was read as Venice, Italy; "Europe" didn't match its state or country, so check this is the city you meant.`,
};

test("city lookup: 779 realistic inputs land on the right city, and only real mismatches are flagged", async () => {
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
      if (typed in NOTES && (!p || readNote(typed, p) !== NOTES[typed])) wrong.push(`${typed} says ${p && readNote(typed, p)}`);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual([...missing], [], "every geocoder call has a recorded answer");
  assert.equal(CASES.length, 779);
  assert.deepEqual(wrong, []);
});

test("a city's circle holds its people at about 3,000 per km², from 3 to 25 km", () => {
  assert.deepEqual([434, 94589, 960000, 2720546, 9733276, undefined].map(cityRadiusKm), [3, 3, 10, 17, 25, 3]); // Morrison .. Tokyo
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

test("a part fitting a place found so far counts for another spelling; among 100, only the places of the typed name count", async () => {
  const R = (name: string, admin1: string, country: string, country_code: string, population: number, latitude: number, feature_code = "PPL") => ({ name, admin1, country, country_code, population, feature_code, latitude, longitude: 10 });
  const answers: Record<string, any[]> = {
    // The first answer's island fits Troms and Norway, so a spelling found in Vestland doesn't fit and the next is asked.
    "Tostso|10": [R("Tostsoya", "Troms", "Norway", "NO", 0, 69, "ISL")],
    "Tostsø|10": [R("Tostsø", "Vestland", "Norway", "NO", 5000, 60)],
    "Tøstso|10": [R("Tøstso", "Troms", "Norway", "NO", 3000, 69.5)],
    // Testville itself, in Mexico, isn't kept out by a place of another name in the first 10 that fits Texas.
    "Testville|10": [R("Testville Junction", "Texas", "United States", "US", 2000, 31), R("Testville Norte", "Chihuahua", "Mexico", "MX", 3000, 28)],
    "Testville|100": [R("Testville Junction", "Texas", "United States", "US", 2000, 31), R("Testville Norte", "Chihuahua", "Mexico", "MX", 3000, 28), R("Testville", "Nuevo León", "Mexico", "MX", 500000, 25)],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    return new Response(JSON.stringify({ results: answers[`${u.searchParams.get("name")}|${u.searchParams.get("count")}`] ?? [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Tostso, Troms, Norway"))?.lat, 69.5);
    const t = await cityCenter(memoryKV().kv, new Budget(48), "Testville, Texas, Mexico");
    assert.equal(t?.lat, 25);
    assert.equal(t?.unmatched, "Texas, Mexico");
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
    assert.equal(coast?.regionAs, "Coast", "and the region as it fit, in the typed words");
    assert.equal((await cityCenter(memoryKV().kv, new Budget(48), "Testburg, West Coast,."))?.regionAs, "Coast", "a part of only punctuation is left out (it crashed)");
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
