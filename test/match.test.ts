// The pipeline against a mock Qloo shaped like the live API. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchNeighborhoods, planDay, rankAreas, resembles, samePlace } from "../src/match.ts";
import { Qloo, signalParams } from "../src/qloo.ts";
import { cityCenter, km } from "../src/geo.ts";
import { AppError, Budget } from "../src/limits.ts";
import { AUSTIN, ENV, heatmap, memoryKV, mockFetch, place, places, tag, type Call } from "./mock.ts";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const qloo = (c: Call) => c.host === "qloo.test";
const isHeat = (c: Call) => qloo(c) && c.params.get("filter.type") === "urn:heatmap";
const isPlaces = (c: Call) => qloo(c) && c.params.get("filter.type") === "urn:entity:place";
const PLACE = "urn:entity:place";

// Records by ID, as GET /entities answers for a picked ID (an unknown ID is left out).
const BY_ID = [
  { entity_id: UUID(1), name: "Dune", disambiguation: "2021", types: ["urn:entity:movie"] },
  { entity_id: UUID(2), name: "Dune", disambiguation: "1984", types: ["urn:entity:movie"] },
  { entity_id: UUID(3), name: "Phoebe Bridgers", disambiguation: "Phoebe Bridgers", types: ["urn:entity:artist"] },
  { entity_id: UUID(6), name: "Fauda", disambiguation: "2015", types: ["urn:entity:tv_show"] },
  { entity_id: UUID(7), name: "Joe's Pizza", disambiguation: "216 Bedford Ave Brooklyn, NY 11249", types: [PLACE] },
  { entity_id: UUID(8), name: "Blue Note", types: ["urn:entity:artist"] },
];

// A Qloo that knows a few things the way the live one answers them.
function standardQloo(opts: { heat?: (c: Call) => unknown; hood?: (c: Call) => string | null } = {}) {
  return (c: Call) => {
    if (!qloo(c)) return undefined;
    if (c.path === "/search") {
      const q = c.params.get("query")!;
      if (q === "Dune")
        return { body: { results: [
          { entity_id: UUID(1), name: "Dune", disambiguation: "2021", types: ["urn:entity:movie"] },
          { entity_id: UUID(2), name: "Dune", disambiguation: "1984", types: ["urn:entity:movie"] },
          { entity_id: UUID(5), name: "Dune: Part Two", disambiguation: "2024", types: ["urn:entity:movie"] },
        ] } };
      if (q === "Phoebe Bridgers") return { body: { results: [{ entity_id: UUID(3), name: "Phoebe Bridgers", disambiguation: "Phoebe Bridgers", types: ["urn:entity:artist"] }] } };
      if (q === "Phoebe") return { body: { results: [{ entity_id: UUID(3), name: "Phoebe Bridgers", types: ["urn:entity:artist"] }, { entity_id: UUID(4), name: "Phoebe Snow", types: ["urn:entity:artist"] }] } };
      return { body: { results: [] } };
    }
    if (c.path === "/entities") {
      const ids = (c.params.get("entity_ids") ?? "").split(",");
      // Live: an ID that isn't a valid UUID is a 400 ("entity_ids should be an array of valid UUIDs").
      if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) return { status: 400, body: { errors: [{ message: "entity_ids:  entity_ids should be an array of valid UUIDs" }] } };
      return { body: { results: BY_ID.filter((e) => ids.includes(e.entity_id)) } };
    }
    if (c.path === "/v2/tags") {
      const q = c.params.get("filter.query")!;
      if (q === "ramen")
        return { body: { results: { tags: [
          tag("urn:tag:cuisine:qloo:ramen", "Ramen", [PLACE]),
          tag("urn:tag:popular_food_item:qloo:ramen", "Ramen", ["urn:entity:locality"]),
          tag("urn:tag:cuisine:qloo:japanese_ramen", "Japanese Ramen", [PLACE]),
          tag("urn:tag:keyword:media:ramen", "ramen", ["urn:entity:tv_show", "urn:entity:movie"]),
        ] } } };
      if (q === "jazz")
        return { body: { results: { tags: [
          tag("urn:tag:genre:qloo:jazz", "Jazz", ["urn:entity:artist", "urn:entity:movie"]),
          tag("urn:tag:interests:qloo:jazz", "Jazz", [PLACE, "urn:entity:movie"]),
        ] } } };
      if (q === "bouldering") return { body: { results: { tags: [tag("urn:tag:activity_type:qloo:bouldering", "Bouldering", [PLACE]), tag("urn:tag:genre:qloo:bouldering", "Bouldering", ["urn:entity:person"])] } } };
      return { body: { results: { tags: [] } } };
    }
    if (isHeat(c)) return { body: opts.heat?.(c) ?? heatmap(AUSTIN.latitude, AUSTIN.longitude) };
    if (isPlaces(c)) {
      const at = (c.params.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
      if (c.params.get("filter.tags")) return { body: { results: { entities: [place("R-1", "Ramen Shop", "Downtown", AUSTIN.latitude + 0.001, AUSTIN.longitude, ["Ramen restaurant"], ["Evening"])] } } };
      const lat = at ? +at[2] : AUSTIN.latitude, lon = at ? +at[1] : AUSTIN.longitude;
      const hood = opts.hood ? opts.hood(c) : `Hood ${Math.round(lat * 1000) % 97}`;
      return { body: { results: { entities: places(`P${lat.toFixed(3)}`, hood, lat, lon) } } };
    }
    return undefined;
  };
}

test("an exact Qloo name wins; two things with the same name are 'ambiguous' and labeled by year", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Dune", kind: "movie" }, { name: "Phoebe Bridgers", kind: "artist" }]);
    const dune = r.resolved.find((x) => x.input === "Dune")!;
    assert.equal(dune.match, "ambiguous");
    assert.equal(dune.as, "Dune (2021)");
    assert.deepEqual(dune.alternatives.map((a) => a.name), ["Dune (1984)", "Dune: Part Two (2024)"]);
    assert.ok(dune.alternatives.every((a) => a.type === "film"));
    const pb = r.resolved.find((x) => x.input === "Phoebe Bridgers")!;
    assert.equal(pb.match, "exact");
    assert.equal(pb.as, "Phoebe Bridgers", "a disambiguation equal to the name isn't repeated");
    assert.ok(m.calls.filter((c) => c.path === "/search").every((c) => c.params.get("take") === "5"));
    assert.ok(m.calls.filter((c) => c.path === "/v2/tags").every((c) => c.params.get("feature.semantic_search") === "true"));
  } finally {
    m.restore();
  }
});

test("no exact name: the top hit is 'closest'; two names for the same thing are counted, not dropped", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe", kind: "artist" }, { name: "Phoebe Bridgers", kind: "artist" }]);
    assert.equal(r.resolved.length, 1);
    assert.equal(r.resolved[0].match, "closest");
    assert.deepEqual(r.resolved[0].alternatives.map((a) => a.name), ["Phoebe Snow"]);
    assert.match(r.trace.find((t) => t.step === "Understand")!.detail, /^2 of 2 interests matched.*Phoebe Bridgers is the same as Phoebe/);
  } finally {
    m.restore();
  }
});

test("food and activity tastes pick places, not the map; genres do both", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }, { name: "jazz", kind: "tag" }]);
    const ramen = r.resolved.find((x) => x.input === "ramen")!;
    assert.deepEqual(ramen.use, ["places"]);
    assert.equal(ramen.id, "urn:tag:cuisine:qloo:ramen", "the cuisine, not the media keyword or the food item");
    const jazz = r.resolved.find((x) => x.input === "jazz")!;
    assert.deepEqual(jazz.use, ["map", "places"]);
    const heat = m.calls.find(isHeat)!;
    assert.equal(heat.params.get("signal.interests.tags"), "urn:tag:genre:qloo:jazz");
    assert.equal(heat.params.get("signal.interests.entities"), UUID(3));
    const tagged = m.calls.find((c) => isPlaces(c) && c.params.get("filter.tags"))!;
    assert.equal(tagged.params.get("filter.tags"), "urn:tag:cuisine:qloo:ramen,urn:tag:interests:qloo:jazz");
    assert.equal(tagged.params.get("operator.filter.tags"), "union");
    assert.ok(r.neighborhoods.some((h) => h.matches.some((p) => p.name === "Ramen Shop")), "the ramen place shows under its neighborhood");
  } finally {
    m.restore();
  }
});

test("the heatmap is asked without take or boundary (the live API rejects take > 50 and has no neighborhood boundary)", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    const heat = m.calls.filter(isHeat);
    assert.equal(heat.length, 1);
    assert.equal(heat[0].params.get("take"), null);
    assert.equal(heat[0].params.get("output.heatmap.boundary"), null);
    assert.ok(m.calls.filter(isPlaces).every((c) => Number(c.params.get("take")) <= 50));
  } finally {
    m.restore();
  }
});

test("the heatmap waits all of the search's 40 s for Qloo, its retry after a 429 too, every other Qloo call 12 s (live heatmaps took over 12 s and 20.9 s)", async () => {
  const m = mockFetch(standardQloo());
  const timeout = AbortSignal.timeout;
  const limit = new Map<AbortSignal, number>();
  AbortSignal.timeout = (ms: number) => { const s = timeout.call(AbortSignal, ms); limit.set(s, ms); return s; };
  const mocked = globalThis.fetch;
  const asked: [string, number | undefined][] = [];
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.host === "qloo.test") asked.push([u.searchParams.get("filter.type") ?? u.pathname, limit.get(init!.signal!)]);
    if (asked.filter(([what]) => what === "urn:heatmap").length === 1 && u.searchParams.get("filter.type") === "urn:heatmap") return Promise.resolve(new Response("{}", { status: 429 }));
    return mocked(input, init);
  }) as typeof fetch;
  try {
    const { kv } = memoryKV();
    await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.deepEqual(asked.filter(([what]) => what === "urn:heatmap").map(([, ms]) => ms > 35000 && ms <= 40000), [true, true]);
    const rest = asked.filter(([what]) => what !== "urn:heatmap");
    assert.ok(rest.length >= 2 && rest.every(([, ms]) => ms === 12000), JSON.stringify(rest));
  } finally {
    globalThis.fetch = mocked;
    AbortSignal.timeout = timeout;
    m.restore();
  }
});

test("a Qloo call that runs out of time says so, never 'not found' or 'no taste map', even when the answer was cut off midway", async () => {
  const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
  // Headers came, then the time ran out while the answer was still arriving (as a stalled server does in Node).
  const cutOff = () => Promise.resolve(new Response(new ReadableStream({ start: (c) => c.error(timeout()) }), { status: 200 }));
  const isHeat = (u: URL) => u.searchParams.get("filter.type") === "urn:heatmap";
  const isSearch = (u: URL) => u.pathname === "/search";
  for (const [what, hit, fail] of [["heatmap never answered", isHeat, () => Promise.reject(timeout())], ["heatmap cut off", isHeat, cutOff], ["search cut off", isSearch, cutOff]] as const) {
    const m = mockFetch(standardQloo());
    const mocked = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: RequestInit) => (hit(new URL(String(input))) ? fail() : mocked(input, init))) as typeof fetch;
    try {
      const { kv } = memoryKV();
      await assert.rejects(matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]), (e: AppError) => /took too long/.test(e.message) && e.status === 504, what);
    } finally {
      globalThis.fetch = mocked;
      m.restore();
    }
  }
});

test("a search's Qloo calls share 40 s: each waits at most what is left, and none starts with under a second left", async () => {
  const timeout = AbortSignal.timeout;
  const limit = new Map<AbortSignal, number>();
  AbortSignal.timeout = (ms: number) => { const s = timeout.call(AbortSignal, ms); limit.set(s, ms); return s; };
  const m = mockFetch(standardQloo());
  const mocked = globalThis.fetch;
  const asked: number[] = [];
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    if (new URL(String(input)).host === "qloo.test") asked.push(limit.get(init!.signal!)!);
    return mocked(input, init);
  }) as typeof fetch;
  try {
    await matchNeighborhoods({ ...ENV(memoryKV().kv), QLOO_TOTAL_MS: "5000" }, new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(asked.length > 1 && asked.every((ms) => ms > 1000 && ms <= 5000), JSON.stringify(asked));
    const before = asked.length;
    await assert.rejects(matchNeighborhoods({ ...ENV(memoryKV().kv), QLOO_TOTAL_MS: "0" }, new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]), (e: AppError) => /took too long/.test(e.message) && e.status === 504);
    assert.equal(asked.length, before, "no Qloo call starts");
  } finally {
    globalThis.fetch = mocked;
    AbortSignal.timeout = timeout;
    m.restore();
  }
});

test("the 40 s are counted from the start of the search: 38 s in a call still starts, 39.5 s in none does", async () => {
  const m = mockFetch(standardQloo());
  const now = Date.now;
  let shift = 0;
  Date.now = () => now() + shift;
  try {
    for (const [at, starts] of [[38000, true], [39500, false]] as const) {
      shift = 0;
      const q = new Qloo(ENV(memoryKV().kv), new Budget(48));
      shift = at;
      const before = m.calls.length;
      if (starts) await q.search("Phoebe Bridgers");
      else await assert.rejects(q.search("Phoebe Bridgers"), (e: AppError) => e.status === 504);
      assert.equal(m.calls.length - before, starts ? 1 : 0, `${at} ms in`);
    }
  } finally {
    Date.now = now;
    m.restore();
  }
});

test("a Qloo call that fails is still listed among the calls, with status 0", async () => {
  const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const cutOff = () => Promise.resolve(new Response(new ReadableStream({ start: (c) => c.error(timeout()) }), { status: 200 }));
  for (const fail of [() => Promise.reject(timeout()), cutOff, () => Promise.reject(new TypeError("fetch failed"))]) {
    const mocked = globalThis.fetch;
    globalThis.fetch = fail as typeof fetch;
    try {
      const q = new Qloo(ENV(memoryKV().kv), new Budget(48));
      await assert.rejects(q.search("Phoebe Bridgers"));
      assert.deepEqual(q.calls.map((c) => [c.path, c.status]), [["/search", 0]]);
    } finally {
      globalThis.fetch = mocked;
    }
  }
});

test("an answer that isn't JSON (a gateway's error page) is reported with Qloo's status, not as a timeout", async () => {
  const m = mockFetch(() => undefined);
  const mocked = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: RequestInit) =>
    new URL(String(input)).host === "qloo.test" ? Promise.resolve(new Response("<html>502 Bad Gateway</html>", { status: 502 })) : mocked(input, init)) as typeof fetch;
  try {
    const { kv } = memoryKV();
    await assert.rejects(matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]), (e: AppError) => /Qloo answered 502/.test(e.message) && e.status === 502);
  } finally {
    globalThis.fetch = mocked;
    m.restore();
  }
});

test("areas are ~1 km squares ranked by the mean percentile of all their cells, not by one hot cell", () => {
  // Square A: one perfect cell and seven weak ones. Square B: eight good cells.
  const cell = (g: string, i: number, affinity: number) => ({ lat: 30.005 + { a: 0, b: 0.02, c: 0.04 }[g]!, lon: -96.995, geohash: `9v6s0${g}${"bcdefghj"[i]}`, affinity });
  const pts = [cell("a", 0, 1), ...Array.from({ length: 7 }, (_, i) => cell("a", i + 1, 0.2)), ...Array.from({ length: 8 }, (_, i) => cell("b", i, 0.9)), ...Array.from({ length: 8 }, (_, i) => cell("c", i, 0.5))];
  const areas = rankAreas(pts);
  assert.ok(Math.abs(areas[0].affinity - 0.9) < 1e-9);
  assert.equal(areas[0].cells, 8);
});

test("areas are named by Qloo's own neighborhood field; OpenStreetMap is not called when Qloo names them", async () => {
  const m = mockFetch(standardQloo({ hood: () => "East Cesar Chavez" }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.equal(r.neighborhoods[0].name, "East Cesar Chavez");
    assert.equal(r.neighborhoods.length, 1, "squares Qloo puts in the same neighborhood are merged");
    assert.equal(m.calls.filter((c) => c.host === "photon.komoot.io").length, 0);
  } finally {
    m.restore();
  }
});

test("an area is named by the places inside its own square, else OpenStreetMap, else the places around it; never the city or a ward", async () => {
  // Live in Arlington: Rosslyn's square found Georgetown's places across the river, and Qloo has no neighborhood for
  // Rosslyn's own; Qloo files the National Mall under "Ward 2"; OpenStreetMap names a Brooklyn square "Brooklyn".
  type Opts = { inside?: string | null | string[]; around?: string | null; osm?: Record<string, unknown>; insideIs?: string; across?: "north" | "east"; coarse?: boolean; city?: string; kv?: KVNamespace; photonStatus?: number; far?: boolean; locality?: string };
  const run = async (o: Opts) => {
    const city = o.city ?? "Austin, Texas";
    const m = mockFetch((c) => {
      if (c.host === "photon.komoot.io") return { status: o.photonStatus ?? 200, body: { features: [{ properties: o.osm ?? { district: "Rosslyn" } }] } };
      if (c.host === "geocoding-api.open-meteo.com" && city.includes("Japan")) return { body: { results: [{ ...AUSTIN, name: "Tokyo", admin1: "Tokyo", country: "Japan", country_code: "JP" }] } };
      if (c.host === "geocoding-api.open-meteo.com" && city.includes("Korea")) return { body: { results: [{ ...AUSTIN, name: "Seoul", admin1: "Seoul", country: "South Korea", country_code: "KR" }] } };
      if (c.host === "geocoding-api.open-meteo.com" && city.includes("Victoria")) return { body: { results: [{ ...AUSTIN, admin1: "Victoria", country: "Australia", country_code: "AU" }] } };
      if (c.host === "geocoding-api.open-meteo.com" && city.includes("Ontario")) return { body: { results: [{ ...AUSTIN, admin1: "Ontario", country: "Canada", country_code: "CA" }] } };
      if ((o.far || o.locality) && isHeat(c)) return { body: heatmap(AUSTIN.latitude + (o.far ? 0.05 : 0), AUSTIN.longitude, 9, 8, o.locality) };
      if (o.coarse && isHeat(c)) {
        const h = heatmap(AUSTIN.latitude, AUSTIN.longitude);
        for (const p of h.results.heatmap) p.location.geohash = p.location.geohash.slice(0, 6); // a big county's ~2.4 km squares
        return { body: h };
      }
      if (isPlaces(c) && !c.params.get("filter.tags")) {
        const at = (c.params.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
        const lat = at ? +at[2] : AUSTIN.latitude, lon = at ? +at[1] : AUSTIN.longitude;
        // Inside the area's square but near its far edge: rounding instead of flooring would put it in the next one
        // (and with 2.4 km squares, it is in another 1 km square).
        const step = o.coarse ? 0.022 : 0.01, f = Math.floor(lat / step), edge = (f + (lat / step - f < 0.5 ? 0.97 : 0.03)) * step;
        const inside = Array.isArray(o.inside) ? o.inside : [o.inside ?? null];
        return { body: { results: { entities: [
          ...inside.map((n, i) => place(`in-${lat}-${i}`, `Inside ${i}`, n, edge, lon, [o.insideIs ?? "Cafe"], ["Morning"])),
          ...[1, 2, 3].map((i) => place(`out-${lat}-${i}`, `Across ${i}`, o.around ?? null, o.across === "east" ? lat : lat + 0.03, o.across === "east" ? lon + 0.03 : lon, ["Cocktail bar"], ["Evening"])),
        ] } } };
      }
      return standardQloo()(c);
    });
    try {
      const r = await matchNeighborhoods(ENV(o.kv ?? memoryKV().kv), new Budget(48), city, [{ name: "Phoebe Bridgers", kind: "artist" }]);
      return r.neighborhoods[0]?.name;
    } finally {
      m.restore();
    }
  };
  const tokyo = "Tokyo, Japan";
  assert.equal(await run({ inside: "East Austin", around: "Georgetown" }), "East Austin"); // one place inside beats three across
  assert.equal(await run({ around: "Georgetown" }), "Rosslyn");
  assert.equal(await run({ inside: "Ward 2", around: "Georgetown" }), "Rosslyn"); // a ward number says nothing
  assert.equal(await run({ around: "Williamsburg", osm: { district: "Austin" } }), "Williamsburg"); // nor OpenStreetMap naming the city
  assert.equal(await run({ around: "Williamsburg", osm: { district: "Austin", locality: "Dumbo" } }), "Dumbo"); // then its finer name (New York's district is the borough)
  assert.equal(await run({ inside: "Whitehall", around: "Georgetown", insideIs: "Ferry terminal" }), "Rosslyn"); // a place no one visits names nothing
  assert.equal(await run({ around: "Georgetown", osm: { district: "Clarendon", locality: "Lyon Village" } }), "Clarendon"); // the district before the finer locality (Arlington, live)
  assert.equal(await run({ inside: "East Austin", around: "Georgetown", across: "east" }), "East Austin"); // across to the east too
  assert.equal(await run({ inside: "East Austin", around: "Georgetown", coarse: true }), "East Austin"); // a 2.4 km square
  assert.equal(await run({ inside: "University\u2014Rosedale", around: "Georgetown" }), "Rosslyn"); // an electoral district, Qloo's in Toronto
  assert.equal(await run({ inside: "Ginza 8-chome", around: "Georgetown" }), "Ginza"); // a block number is an address (Tokyo, live)
  assert.equal(await run({ inside: "Ginza 8-chome", around: "Georgetown", city: tokyo }), "Ginza");
  assert.equal(await run({ inside: "Kabukichō 1-chōme", city: tokyo }), "Kabukichō"); // with its long vowel (live)
  assert.equal(await run({ inside: "Kabukichō 1-chōme" }), "Kabukichō");
  assert.equal(await run({ osm: { district: "Roppongi 7" }, city: tokyo }), "Roppongi");
  assert.equal(await run({ inside: "鉄鋼通り三丁目", city: tokyo }), "鉄鋼通り"); // Qloo's own, in kanji
  assert.equal(await run({ inside: "紀尾井町1", city: tokyo }), "紀尾井町");
  assert.equal(await run({ inside: ["Ebisu minami 1", "Ebisu nishi 1", "Ebisu nishi 2"], city: tokyo }), "Ebisu nishi"); // counted once cleaned
  assert.equal(await run({ osm: { district: "Zona 10" } }), "Zona 10"); // elsewhere a number can be the name (Guatemala City)
  const seoul = "Seoul, South Korea";
  // Seoul's own numbers (live), dropped the way Qloo writes the names ("Itaewon-dong"), so both merge.
  assert.equal(await run({ osm: { district: "Itaewon 2(i)-dong" }, city: seoul }), "Itaewon-dong");
  assert.equal(await run({ osm: { district: "Seongsu 1(il)-ga 1(il)-dong" }, city: seoul }), "Seongsu-dong");
  assert.equal(await run({ osm: { district: "Jongno 1(il)-ga" }, city: seoul }), "Jongno-ga");
  assert.equal(await run({ osm: { district: "Itaewon 2(i)-dong" } }), "Itaewon 2(i)-dong");
  assert.equal(await run({ around: "Ginza 8-chome", osm: { district: "Austin" } }), "Ginza"); // from the places around too
  // Most places inside filed under the city's own name, at the city's centre: the city centre (Melbourne's CBD is the
  // suburb "Melbourne", live; dropping that name let Fitzroy name it). Away from the centre, the next name.
  assert.equal(await run({ inside: ["Austin", "Austin", "Austin", "Hyde Park"] }), "Downtown Austin");
  assert.equal(await run({ inside: ["Austin", "Austin", "Austin", "Hyde Park"], city: "Austin, Victoria" }), "Austin city centre");
  // The country is the located city's own, not Qloo's (it is gone when Qloo's city is replaced by a circle).
  assert.equal(await run({ inside: ["Austin", "Austin", "Austin", "Hyde Park"], locality: "Austin, Victoria, Australia" }), "Downtown Austin");
  assert.equal(await run({ inside: ["Austin", "Austin", "Austin", "Hyde Park"], far: true }), "Hyde Park");
  assert.equal(await run({ inside: ["Hyde Park", "Hyde Park", "Austin"] }), "Hyde Park");
  assert.equal(await run({ inside: ["Austin", "Austin", "Austin", "Hyde Park"], city: "Austin, Ontario" }), "Downtown Austin"); // Canada too
  assert.equal(await run({ inside: ["Austin", "Austin", "Austin", "Hyde Park", "Hyde Park"], insideIs: "Courthouse" }), "Rosslyn"); // places no one visits don't vote
  // OpenStreetMap's spot itself: a neighbourhood is a name (Missoula's "Lower Rattlesnake", live); another kind of spot
  // is not, and a street comes from its street ("around Fair Way", not the fair office's own name).
  assert.equal(await run({ osm: { osm_key: "place", osm_value: "neighbourhood", name: "Lower Rattlesnake" } }), "Lower Rattlesnake");
  assert.equal(await run({ osm: { osm_key: "place", osm_value: "neighbourhood", name: "Lower Rattlesnake", suburb: "Rattlesnake Valley" } }), "Lower Rattlesnake"); // before the suburb
  assert.equal(await run({ osm: { osm_key: "place", osm_value: "neighbourhood", name: "Lower Rattlesnake", locality: "Downtown" } }), "Downtown"); // after the locality
  assert.equal(await run({ around: "Georgetown", osm: { osm_key: "place", osm_value: "square", name: "Pioneer Courthouse Square" } }), "Georgetown"); // a square isn't a neighborhood
  assert.equal(await run({ osm: { osm_key: "amenity", name: "Missoula County Fair Office", street: "Fair Way" } }), "around Fair Way");
  assert.equal(await run({ around: "Georgetown", osm: { osm_key: "amenity", name: "Missoula County Fair Office" } }), "Georgetown");
  // A lookup OpenStreetMap didn't answer is asked again by the next search (not kept as a spot without a name).
  const kv = memoryKV().kv;
  assert.equal(await run({ around: "Georgetown", photonStatus: 503, kv }), "Georgetown");
  assert.equal(await run({ around: "Georgetown", kv }), "Rosslyn");
});

test("one place under two ids is listed once, and is one stop of a weekend (Qloo's \"Big Ben\" and \"Big ben\", live)", async () => {
  const twice = (lat: number, lon: number) => [
    place("ben1", "Big Ben", "Westminster", lat, lon, ["Historical landmark", "Tourist attraction"], ["Afternoon"]),
    place("ben2", "Big ben", "Westminster", lat, lon, ["Tourist attraction"], ["Afternoon"]),
    place("cb1", "The Coffee Bean & Tea Leaf", "Westminster", lat, lon, ["Coffee shop", "Cafe"], ["Morning"]),
    place("cb2", "The Coffee Bean And Tea Leaf", "Westminster", lat, lon, ["Coffee shop", "Cafe"], ["Afternoon"]),
    place("top", "The Top CN Tower", "Westminster", lat, lon, ["Tourist attraction", "Observation deck"], ["Morning"]),
    place("tower", "CN Tower", "Westminster", lat, lon, ["Tourist attraction", "Observation deck", "Communications tower"], ["Afternoon"]),
  ];
  const m = mockFetch((c) => {
    if (isPlaces(c) && !c.params.get("filter.tags")) {
      const p = (c.params.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/)!;
      return { body: { results: { entities: twice(+p[2], +p[1]) } } };
    }
    return standardQloo()(c);
  });
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    for (const h of r.neighborhoods) assert.equal(h.evidence.length, 3, JSON.stringify(h.evidence.map((e) => e.name)));
  } finally {
    m.restore();
  }
  const entity = (id: string, name: string, tags: string[], times: string[]) => ({ id, name, types: ["urn:entity:place"], tags, times });
  const day = planDay([entity("cb1", "The Coffee Bean & Tea Leaf", ["Coffee shop", "Cafe"], ["Morning"]), entity("cb2", "The Coffee Bean And Tea Leaf", ["Coffee shop", "Cafe"], ["Afternoon"]), entity("g", "A Gallery", ["Art gallery"], ["Evening"])]);
  assert.equal(day.filter((s) => /Coffee Bean/.test(s.place)).length, 1, JSON.stringify(day)); // the weekend's chain rule (Seoul's Sunday, live)
});

test("one place under two records at one spot is one place, not a restaurant there (the CN Tower, live)", () => {
  const e = (id: string, name: string, lat: number, lon: number, tags: string[], times: string[]) => ({ id, name, types: ["urn:entity:place"], lat, lon, tags, times });
  const top = e("top", "The Top CN Tower", 43.64256, -79.38707, ["Tourist attraction", "Observation deck"], ["Morning"]);
  const tower = e("tower", "CN Tower", 43.64257, -79.38706, ["Tourist attraction", "Event venue", "Observation deck", "Communications tower"], ["Afternoon"]);
  const restaurant = e("360", "360 The Restaurant at the CN Tower", 43.64256, -79.3871, ["Restaurant", "American", "Canadian", "Seafood"], ["Evening"]);
  const elsewhere = { ...tower, id: "far", lat: 43.65, lon: -79.38 };
  assert.ok(samePlace(top, tower));
  assert.ok(!samePlace(tower, restaurant), "a restaurant in the tower is another place");
  assert.ok(!samePlace(top, elsewhere), "the same words far apart are two places");
  assert.ok(!samePlace(top, { ...tower, tags: ["Tourist attraction", "Communications tower"] }), "a tourist attraction alone is no shared category");
  assert.ok(!samePlace(e("a", "Ramen Nagi", 43.6, -79.4, ["Restaurant", "Ramen"], []), e("b", "Tacos Chiwas", 43.6, -79.4, ["Restaurant", "Mexican"], [])), "two restaurants of one food hall are two places");
  assert.ok(samePlace(tower, top), "either name may hold the other");
  // Two rooms or shops of one building (live): ACL Live and its 3TEN room 19 m apart, Tokyo Ramen Street and a shop in it 29 m.
  assert.ok(!samePlace(e("acl", "Austin City Limits Live (ACL Live & 3TEN ACL Live)", 30.2652627, -97.7469912, ["Tourist attraction", "Event venue", "Live music venue"], []), e("3ten", "3Ten Austin City Limits", 30.2652971, -97.7471929, ["Live music venue", "Tourist attraction"], [])));
  assert.ok(!samePlace(e("trs", "Tokyo Ramen Street", 35.6802935, 139.7679568, ["Restaurant", "Ramen restaurant", "Food court", "Tsukemen"], []), e("rok", "Rokurinsha Tokyo Ramen Street", 35.6800519, 139.7678455, ["Chinese", "Noodle shop", "Japanese", "Restaurant"], [])));
  // Two branches of one chain aren't two stops of one day (Brisbane, live); two landmarks sharing a first word are.
  const qut = e("qut", "Merlo Coffee Cafe QUT Gardens Point", -27.4771547, 153.0285813, ["Coffee shop", "Coffee store", "Breakfast restaurant", "Breakfast"], ["Morning"]);
  const uq = e("uq", "Merlo Coffee Cafe | UQ Saint Lucia Campus", -27.4965918, 153.0143439, ["Restaurant supply store", "Restaurant", "Breakfast restaurant", "Seafood"], ["Afternoon"]);
  assert.deepEqual(planDay([qut, uq] as any).map((s) => s.place), ["Merlo Coffee Cafe QUT Gardens Point"]);
  const park = e("park", "Golden Gate Park", 37.769, -122.483, ["Park", "Tourist attraction"], ["Morning"]);
  const bridge = e("bridge", "Golden Gate Bridge", 37.819, -122.478, ["Bridge", "Tourist attraction"], ["Afternoon"]);
  assert.equal(planDay([park, bridge] as any).length, 2);
  const moma = e("moma", "Museum of Modern Art", 40.761, -73.977, ["Art museum", "Museum"], ["Morning"]);
  const amnh = e("amnh", "Museum of Natural History", 40.781, -73.974, ["History museum", "Museum"], ["Afternoon"]);
  assert.equal(planDay([moma, amnh] as any).length, 2, "small words aside: two museums, not a chain");
  const philz1 = e("p1", "Philz Coffee Mission", 37.75, -122.42, ["Coffee shop"], ["Morning"]);
  const philz2 = e("p2", "Philz Coffee Castro", 37.76, -122.43, ["Coffee shop"], ["Afternoon"]);
  assert.equal(planDay([philz1, philz2] as any).length, 1);
  // Small words in other languages aside (Mexico City and Rome, live): two taquerías, two squares.
  const primos = e("tp", "Taquería Los Primos", 19.39, -99.15, ["Taco restaurant", "Mexican restaurant"], ["Afternoon"]);
  const hornillos = e("th", "Taquería Los Hornillos", 19.391, -99.151, ["Taco restaurant", "Mexican restaurant"], ["Evening"]);
  assert.equal(planDay([primos, hornillos] as any).length, 2);
  const popolo = e("pp", "Piazza del Popolo", 41.91, 12.476, ["Plaza", "Historical landmark"], ["Morning"]);
  const quirinale = e("pq", "Piazza del Quirinale", 41.899, 12.487, ["Plaza", "Historical landmark"], ["Afternoon"]);
  assert.equal(planDay([popolo, quirinale] as any).length, 2);
  const enzo = e("te", "Trattoria da Enzo", 41.888, 12.47, ["Italian restaurant", "Restaurant"], ["Midday"]);
  const mario = e("tm", "Trattoria da Mario", 41.889, 12.471, ["Italian restaurant", "Restaurant"], ["Evening"]);
  assert.equal(planDay([enzo, mario] as any).length, 2);
  // Two records 10 m apart are two places (one record of a place is within 5 m).
  assert.ok(!samePlace(e("x", "Ramen Shop", 40, -74, ["Ramen restaurant"], []), e("y", "Ramen Shop Annex", 40.00009, -74, ["Ramen restaurant"], [])));
  assert.deepEqual(planDay([top, tower, restaurant] as any).map((s) => s.place), ["The Top CN Tower", "360 The Restaurant at the CN Tower"]);
  // A wedding venue that is also a gallery or a garden is a stop (Denver Botanic Gardens, live); a wedding venue alone isn't.
  const gardens = e("dbg", "Denver Botanic Gardens", 39.7321, -104.96128, ["Tourist attraction", "Art gallery", "Wedding venue", "Botanical garden"], ["Afternoon"]);
  const hall = e("hall", "Polaris Hall", 39.7, -104.9, ["Wedding venue", "Event venue"], ["Afternoon"]);
  assert.deepEqual(planDay([hall, gardens] as any).map((s) => s.place), ["Denver Botanic Gardens"]);
});

test("Qloo's locality is named by its own name first: Montreal's is \"Island of Montreal\", disambiguated just \"Canada\" (live)", async () => {
  const m = mockFetch(standardQloo({ heat: () => ({ ...heatmap(AUSTIN.latitude, AUSTIN.longitude), query: { localities: { filter: [{ name: "Island of Montreal", disambiguation: "Canada", location: { lat: AUSTIN.latitude, lon: AUSTIN.longitude } }] } } }) }));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.equal(r.qlooCity, "Island of Montreal, Canada");
  } finally {
    m.restore();
  }
});

test("an area with an airport inside it is left out: a place filed as an airport, or a travel lounge at one; other lounges aren't airports", async () => {
  const at = (p: any, address: string) => ({ ...p, properties: { ...p.properties, address } });
  const cases: [string, (lat: number, lon: number) => any, boolean][] = [
    // Live: Sydney's Mascot square, lounges at the airport (Qloo files the lounges, not the airport, there).
    ["Sydney's airline lounge", (lat, lon) => at(place("lounge", "Singapore Airlines SilverKris Lounge", "Mascot", lat, lon, ["Tourist attraction", "Travel lounge"], ["Morning"]), "Terminal C Sydney Kingsford Smith Airport Sydney NSW 2020"), true],
    ["an airport", (lat, lon) => place("syd", "Sydney Airport", "Mascot", lat, lon, ["International airport"], ["Morning"]), true],
    // Live: Qloo files the Galeries Lafayette rooftop as a travel lounge, and a Vienna pension under an airport shuttle.
    ["the Paris rooftop", (lat, lon) => at(place("roof", "Galeries Lafayette | Rooftop", "Opéra", lat, lon, ["Observation deck", "Travel lounge", "Gift shop"], ["Afternoon"]), "40 Bd Haussmann 75009 Paris France"), false],
    ["the Vienna pension", (lat, lon) => place("pension", "Pension Neuer Markt", "Innere Stadt", lat, lon, ["Hotel", "Airport shuttle service"], ["Morning"]), false],
  ];
  for (const [what, special, dropped] of cases) {
    let first = true;
    const m = mockFetch((c) => {
      if (isPlaces(c) && !c.params.get("filter.tags") && first) {
        first = false;
        const p = (c.params.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/)!;
        return { body: { results: { entities: [special(+p[2], +p[1]), place("bistro", "The Bistro", "Mascot", +p[2], +p[1], ["Italian restaurant"], ["Midday"])] } } };
      }
      return standardQloo()(c);
    });
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
      assert.equal(r.trace.some((t) => t.step === "Filter" && t.detail === "Left out 1 area at an airport"), dropped, what);
      assert.equal(r.neighborhoods.some((h) => h.evidence.some((e) => e.name === "The Bistro")), !dropped, what);
      if (what === "the Paris rooftop") assert.ok(r.neighborhoods.some((h) => h.evidence.some((e) => e.name === "Galeries Lafayette | Rooftop")), "the rooftop is a place to go");
      if (what === "the Vienna pension") assert.ok(r.neighborhoods.some((h) => h.evidence.some((e) => e.name === "Pension Neuer Markt")), "a hotel with an airport shuttle is still listed");
    } finally {
      m.restore();
    }
  }
});

test("OpenStreetMap names cached in older forms are not read (they are kept under a new key)", async () => {
  const m = mockFetch(standardQloo({ hood: () => null }));
  try {
    const { kv, store } = memoryKV();
    const old: Record<string, string> = {};
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) old[`${(30.12 + i / 100).toFixed(2)},${(-97.89 + j / 100).toFixed(2)}`] = "Old Name";
    store.set("names:austin, texas", JSON.stringify(old));
    // names2 kept a spot of any kind (a square, a farm) between passes 33 and 34, under today's keys: not read either.
    const first = mockFetch(standardQloo({ hood: () => null }));
    let keys: string[] = [];
    try {
      await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
      keys = first.calls.filter((c) => c.host === "photon.komoot.io").map((c) => `${Number(c.params.get("lat")).toFixed(3)},${Number(c.params.get("lon")).toFixed(3)}`);
    } finally {
      first.restore();
    }
    assert.ok(keys.length);
    store.set("names2:austin, texas", JSON.stringify(Object.fromEntries(keys.map((k) => [k, ["Old Name"]]))));
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.neighborhoods.length && r.neighborhoods.every((h) => h.name.startsWith("OSM District")), JSON.stringify(r.neighborhoods.map((h) => h.name)));
  } finally {
    m.restore();
  }
});

test("OpenStreetMap is asked at the area itself, not at a corner of its square; its street, suburb and a street spot are used too", async () => {
  const photon: Record<string, unknown>[] = [{ district: "OSM District" }, { suburb: "Old North End" }, { street: "West Emerald Street" }, { osm_key: "highway", name: "West Emerald Street" }];
  const want = ["OSM District", "Old North End", "around West Emerald Street", "around West Emerald Street"];
  for (const [i, properties] of photon.entries()) {
    const m = mockFetch((c) => (c.host === "photon.komoot.io" ? { body: { features: [{ properties }] } } : standardQloo({ hood: () => null })(c)));
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
      assert.equal(r.neighborhoods[0].name, want[i]);
      const h = r.neighborhoods[0];
      const asked = m.calls.filter((c) => c.host === "photon.komoot.io").map((c) => [Number(c.params.get("lat")), Number(c.params.get("lon"))]);
      assert.ok(asked.some(([lat, lon]) => Math.abs(lat - h.lat) < 0.0006 && Math.abs(lon - h.lon) < 0.0006), JSON.stringify({ h: [h.lat, h.lon], asked }));
    } finally {
      m.restore();
    }
  }
});

test("a lookup OpenStreetMap didn't answer isn't taken for a spot without a name: the answer isn't cached, and dropped areas are counted", async () => {
  // Places inside each area have no Qloo neighborhood; the places around it do, so the areas are still named.
  const qloo = (c: Call) => {
    if (isPlaces(c) && !c.params.get("filter.tags")) {
      const at = (c.params.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
      const lat = at ? +at[2] : AUSTIN.latitude, lon = at ? +at[1] : AUSTIN.longitude;
      return { body: { results: { entities: [place(`in-${lat}`, "Inside", null, lat, lon, ["Cafe"], ["Morning"]), place(`out-${lat}`, "Around", "Georgetown", lat + 0.03, lon, ["Cocktail bar"], ["Evening"])] } } };
    }
    return standardQloo()(c);
  };
  for (const [status, degraded] of [[503, true], [0, true], [200, false]] as const) {
    const m = mockFetch((c) => (c.host === "photon.komoot.io" ? { status: status || 200, body: { features: [] } } : qloo(c)));
    const mocked = globalThis.fetch;
    // status 0: Photon timed out
    if (!status) globalThis.fetch = ((input: any, init?: RequestInit) => (new URL(String(input)).host === "photon.komoot.io" ? Promise.reject(new DOMException("timeout", "TimeoutError")) : mocked(input, init))) as typeof fetch;
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
      assert.equal(r.neighborhoods[0].name, "Georgetown");
      assert.equal(r.degraded, degraded, `Photon ${status}`);
    } finally {
      globalThis.fetch = mocked;
      m.restore();
    }
  }
  // Some lookups lost, as measured (2 to 4 of 6): the rest still name their areas, and the answer isn't cached.
  {
    const m = mockFetch((c) => {
      if (c.host === "photon.komoot.io") return Number(c.params.get("lat")) > AUSTIN.latitude + 0.011 ? { status: 503, body: {} } : { body: { features: [{ properties: { district: "OSM District" } }] } };
      return qloo(c);
    });
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
      assert.ok(r.neighborhoods.some((h) => h.name === "OSM District") && r.degraded);
    } finally {
      m.restore();
    }
  }
  const m = mockFetch((c) => {
    if (c.host === "photon.komoot.io") return Number(c.params.get("lat")) > AUSTIN.latitude + 0.011 ? { body: { features: [] } } : { body: { features: [{ properties: { district: "OSM District" } }] } };
    return standardQloo({ hood: () => null })(c);
  });
  // Lookups go three at a time (Photon lost 2 to 4 of 6 at once, measured).
  const mocked = globalThis.fetch;
  let inFlight = 0, most = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (new URL(String(input)).host !== "photon.komoot.io") return mocked(input, init);
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return mocked(input, init);
  }) as typeof fetch;
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.trace.some((t) => t.step === "Name" && /^\d+ areas? had no neighborhood name in Qloo or OpenStreetMap/.test(t.detail)), JSON.stringify(r.trace));
    assert.equal(r.degraded, false);
    assert.equal(most, 3);
  } finally {
    globalThis.fetch = mocked;
    m.restore();
  }
});

test("Qloo answering with a part of the city (Tokyo: the ward of Minato) is asked again around the city", async () => {
  // For "Paris" Qloo wrote "Paris, Paris, Paris, Paris Police Prefecture, ..." (2026-10-05): the city itself. A region
  // named after the city ("Região Geográfica Intermediária de São Paulo, São Paulo, ...") is bigger, not a part.
  for (const [locality, asked] of [["Hyde Park, Austin, Travis County, Texas, United States", 2], ["Austin, Travis County, Texas, United States", 1], ["Austin, Austin, Travis County, Texas, United States", 1], ["Greater Austin Region, Austin, Texas, United States", 1], ["Travis County, Texas, United States", 1]] as const) {
    const m = mockFetch(standardQloo({ heat: (c) => (c.params.get("filter.location.query") ? heatmap(AUSTIN.latitude, AUSTIN.longitude, 9, 8, locality) : undefined) }));
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
      assert.equal(m.calls.filter(isHeat).length, asked, locality);
      // Your kinds of places are looked for in the same place as the map (live: Tokyo's ramen was all in Minato).
      const cityWide = m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags"));
      assert.ok(cityWide.length && cityWide.every((c) => !!c.params.get("filter.location.radius") === (asked === 2)), locality);
      if (asked === 2) {
        assert.ok(m.calls.filter(isHeat)[1].params.get("filter.location.radius"));
        assert.ok(r.trace.some((t) => /was only Hyde Park, a part of it/.test(t.detail)));
      }
    } finally {
      m.restore();
    }
  }
});

test("an empty map whose area is only a part of the city says both (live: Tokyo's was empty and only Minato)", async () => {
  for (const [locality, said, lat, lon] of [
    ["Hyde Park, Austin, Travis County, Texas, United States", "was empty and only Hyde Park, a part of it;", AUSTIN.latitude, AUSTIN.longitude],
    ["Austin, Mower County, Minnesota, United States", "was empty and 1", 43.67, -92.97],
    ["Austin, Travis County, Texas, United States", "was empty;", AUSTIN.latitude, AUSTIN.longitude],
  ] as const) {
    const m = mockFetch(standardQloo({ heat: (c) => (c.params.get("filter.location.query") ? heatmap(lat, lon, 0, 8, locality) : undefined) }));
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "Dune", kind: "movie" }]);
      assert.ok(r.trace.some((t) => t.detail.includes(` ${said}`)), `${locality}: ${JSON.stringify(r.trace.map((t) => t.detail))}`);
      assert.match(r.trace.find((t) => t.step === "Understand")!.detail, /^2 of 2 interests matched/);
    } finally {
      m.restore();
    }
  }
  const m = mockFetch(standardQloo());
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.match(r.trace.find((t) => t.step === "Understand")!.detail, /^1 of 1 interest matched/, "one interest, said so (live: \"1 of 1 interests\")");
  } finally {
    m.restore();
  }
});

test("where Qloo's places have no neighborhood, OpenStreetMap names the area", async () => {
  const m = mockFetch(standardQloo({ hood: () => null }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.neighborhoods[0].name.startsWith("OSM District"));
    assert.ok(m.calls.some((c) => c.host === "photon.komoot.io"));
  } finally {
    m.restore();
  }
});

test("a place is listed once, under the best neighborhood that found it", async () => {
  const m = mockFetch((c) => (isPlaces(c) && !c.params.get("filter.tags") ? { body: { results: { entities: places("Same", null, 30.27, -97.74) } } } : standardQloo({ hood: () => null })(c)));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    const all = r.neighborhoods.flatMap((h) => h.evidence.map((e) => e.id));
    assert.equal(all.length, new Set(all).size);
  } finally {
    m.restore();
  }
});

test("only food and activity tastes: neighborhoods come from where matching places are", async () => {
  const m = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [
          place("a", "Ramen A", "Downtown", 30.27, -97.74, ["Ramen restaurant"], ["Evening"]),
          place("b", "Ramen B", "Downtown", 30.271, -97.741, ["Ramen restaurant"], ["Midday"]),
          place("c", "Gym C", "Hyde Park", 30.30, -97.73, ["Climbing gym"], ["Morning"]),
        ] } } }
      : standardQloo()(c),
  );
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }, { name: "bouldering", kind: "tag" }]);
    assert.equal(r.mode, "places");
    assert.equal(m.calls.filter(isHeat).length, 0, "no heatmap: Qloo's map doesn't use these tags");
    assert.deepEqual(r.neighborhoods.map((h) => [h.name, h.cells]), [["Downtown", 2], ["Hyde Park", 1]]);
  } finally {
    m.restore();
  }
});

test("a dish's joining word is part of its name: \"al pastor\" isn't the music genre \"pastor\"; \"live jazz\" is still Jazz", async () => {
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/v2/tags") {
      const q = c.params.get("filter.query");
      if (q === "al pastor") return { body: { results: { tags: [tag("urn:tag:genre:music:pastor", "pastor", ["urn:entity:artist"]), tag("urn:tag:keyword:media:pastor", "pastor", ["urn:entity:movie"])] } } };
      if (q === "live jazz") return { body: { results: { tags: [tag("urn:tag:genre:qloo:jazz", "Jazz", ["urn:entity:artist", "urn:entity:movie"])] } } };
    }
    return standardQloo()(c);
  });
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "al pastor", kind: "tag" }, { name: "live jazz", kind: "tag" }, { name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.unresolved.includes("al pastor"), JSON.stringify(r.resolved.map((x) => [x.input, x.as])));
    assert.ok(r.resolved.some((x) => x.input === "live jazz" && x.as === "Jazz"));
  } finally {
    m.restore();
  }
});

test("a dish's joining word may be left out only when two or more other words were typed", async () => {
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/v2/tags") {
      const q = c.params.get("filter.query");
      if (q === "al fresco dining") return { body: { results: { tags: [tag("urn:tag:activity_type:qloo:alfresco_dining", "Alfresco Dining", [PLACE])] } } };
      if (q === "pasta alla vodka") return { body: { results: { tags: [tag("urn:tag:specialty_dish:place:vodka_pasta", "Vodka Pasta", [PLACE])] } } };
      if (q === "cafe de olla") return { body: { results: { tags: [tag("urn:tag:category:place:cafe", "Cafe", [PLACE])] } } };
      if (q === "alla norma") return { body: { results: { tags: [tag("urn:tag:genre:qloo:norma", "Norma", ["urn:entity:movie"])] } } };
    }
    return standardQloo()(c);
  });
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "al fresco dining", kind: "tag" }, { name: "pasta alla vodka", kind: "tag" }, { name: "cafe de olla", kind: "tag" }, { name: "alla norma", kind: "tag" }, { name: "Phoebe Bridgers", kind: "artist" }]);
    const as = Object.fromEntries(r.resolved.map((x) => [x.input, x.as]));
    assert.equal(as["al fresco dining"], "Alfresco Dining"); // live: Qloo's own tag; "alfresco" holds "fresco"
    assert.equal(as["pasta alla vodka"], "Vodka Pasta");
    assert.ok(r.unresolved.includes("cafe de olla"), "a café is not café de olla"); // the tag lacks "olla"
    assert.ok(r.unresolved.includes("alla norma"), "one other word: not the opera Norma");
  } finally {
    m.restore();
  }
});

test("an empty map is asked again around the city, but the place searches stay on the city (Mexico City, live)", async () => {
  const m = mockFetch(standardQloo({ heat: (c) => (c.params.get("filter.location.query") ? { success: true, results: { heatmap: [] }, query: { localities: { filter: [{ name: "Austin", disambiguation: "Austin, Travis County, Texas, United States", location: { lat: AUSTIN.latitude, lon: AUSTIN.longitude } }] } } } : undefined) }));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    assert.equal(m.calls.filter(isHeat).length, 2);
    // One place, said so (live: "Qloo found 1 places ... 1 are in the neighborhoods shown").
    assert.ok(r.trace.some((t) => /^Qloo found 1 place in the city that is one of your food or activity tastes; 1 is in the neighborhoods shown$/.test(t.detail)), JSON.stringify(r.trace.filter((t) => t.step === "Your places")));
    const cityWide = m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags"));
    assert.ok(cityWide.length && cityWide.every((c) => !c.params.get("filter.location.radius") && c.params.get("filter.location.query")), "by the city's name");
  } finally {
    m.restore();
  }
});

test("an empty map with a wrong or partial city moves the place searches around the city too", async () => {
  for (const [locality, lat] of [["Hyde Park, Austin, Travis County, Texas, United States", AUSTIN.latitude], ["Paris, Ile-de-France, France", 48.86]] as const) {
    const m = mockFetch(standardQloo({ heat: (c) => (c.params.get("filter.location.query") ? { success: true, results: { heatmap: [] }, query: { localities: { filter: [{ name: locality.split(",")[0], disambiguation: locality, location: { lat, lon: AUSTIN.longitude } }] } } } : undefined) }));
    try {
      await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
      const cityWide = m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags"));
      assert.ok(cityWide.length && cityWide.every((c) => !!c.params.get("filter.location.radius")), locality);
    } finally {
      m.restore();
    }
  }
});

test("no taste map says what the map was asked with (live: \"le tigre\" and \"LA punk\" as music genres)", async () => {
  const m = mockFetch(standardQloo({ heat: () => ({ success: true, results: { heatmap: [] }, query: { localities: { filter: [{ name: "Austin", disambiguation: "Austin, Travis County, Texas, United States", location: { lat: AUSTIN.latitude, lon: AUSTIN.longitude } }] } } }) }));
  try {
    await assert.rejects(matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "Dune", kind: "movie" }]), (e: AppError) => e.status === 404 && /no taste map for Austin, Texas with Phoebe Bridgers, Dune \(as Dune \(2021\)\)\. Try an artist/.test(e.message));
  } finally {
    m.restore();
  }
});

test("with only food and activity tastes, a part of the city is asked again around it too", async () => {
  const m = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [place("a", "Ramen A", "Downtown", 30.27, -97.74, ["Ramen restaurant"], ["Evening"])] }, query: { localities: { filter: [{ name: "Hyde Park", disambiguation: "Hyde Park, Austin, Travis County, Texas, United States", location: { lat: 30.3, lon: -97.73 } }] } } } }
      : standardQloo()(c),
  );
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.equal(r.mode, "places");
    const cityWide = m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags"));
    assert.deepEqual(cityWide.map((c) => !!c.params.get("filter.location.radius")), [false, true]);
    assert.ok(r.trace.some((t) => /was only Hyde Park, a part of it/.test(t.detail)));
    assert.equal(r.qlooCity, undefined, "the part isn't shown as the city (live: Minato)");
    assert.ok(r.trace.some((t) => t.detail.startsWith("Qloo found 1 place that matches your food and activity tastes")), "one place, said so (Kyoto, live: \"1 places\")");
  } finally {
    m.restore();
  }
});

test("with only food and activity tastes, a city Qloo reads over 50 km away is asked again around it too, as the map's is", async () => {
  for (const [name, d, lat, lon, asked] of [["Austin", "Austin, Mower County, Minnesota, United States", 43.67, -92.97, 2], ["Round Rock", "Round Rock, Williamson County, Texas, United States", 30.51, -97.68, 1]] as const) {
    const m = mockFetch((c) =>
      isPlaces(c) && c.params.get("filter.tags")
        ? { body: { results: { entities: [place("a", "Ramen A", "Downtown", 30.27, -97.74, ["Ramen restaurant"], ["Evening"])] }, query: { localities: { filter: [{ name, disambiguation: d, location: { lat, lon } }] } } } }
        : standardQloo()(c),
    );
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
      const cityWide = m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags"));
      assert.equal(cityWide.length, asked, d);
      if (asked === 2) {
        assert.ok(cityWide[1].params.get("filter.location.radius"));
        assert.ok(r.trace.some((t) => /was 1\d{3} km from the located city; asked again for 25 km around/.test(t.detail)), JSON.stringify(r.trace));
        assert.equal(r.qlooCity, undefined);
      }
    } finally {
      m.restore();
    }
  }
});

test("a place search that finds nothing by the city's name is asked again around its centre (live: Moscow read as Trade Fair Moscow)", async () => {
  const FAIR = { filter: [{ name: "Trade Fair Austin, All-Texas Exhibition Centre", disambiguation: "Trade Fair Austin, All-Texas Exhibition Centre, Austin, Texas, United States", location: { lat: 30.33, lon: -97.7 } }] };
  const ramen = place("a", "Ramen A", "Downtown", 30.27, -97.74, ["Ramen restaurant"], ["Evening"]);
  // The map by name is read as the fair too (big enough not to be a part by its size alone).
  const fair = (c: Call) => (isPlaces(c) && c.params.get("filter.tags") ? { body: { results: { entities: c.params.get("filter.location.query") ? [] : [ramen] }, ...(c.params.get("filter.location.query") ? { query: { localities: FAIR } } : {}) } } : standardQloo({ heat: (h) => (h.params.get("filter.location.query") ? heatmap(AUSTIN.latitude, AUSTIN.longitude, 9, 8, FAIR.filter[0].disambiguation) : undefined) })(c));
  // Only food and activity tastes: the areas come from around the centre, and the fair isn't shown as the city.
  let m = mockFetch(fair);
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.equal(r.mode, "places");
    assert.deepEqual(m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags")).map((c) => !!c.params.get("filter.location.radius")), [false, true]);
    assert.ok(r.trace.some((t) => t.detail === `Qloo's area for "Austin, Texas" had none of these places (read as Trade Fair Austin); asked again for 25 km around the city centre`), JSON.stringify(r.trace));
    assert.equal(r.qlooCity, undefined);
    assert.ok(r.neighborhoods.length);
  } finally {
    m.restore();
  }
  // With an artist too: your kinds of places are asked again the same way.
  m = mockFetch(fair);
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    assert.equal(r.mode, "map");
    assert.deepEqual(m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags") && !c.params.get("filter.location.radius")?.match(/^1[0-9]{3}$/)).map((c) => c.params.get("filter.location.radius")), [null, "25000"]);
    assert.ok(r.trace.some((t) => t.detail === `Qloo found none of your kinds of places for "Austin, Texas" by its name; asked again for 25 km around the city centre`));
    assert.ok(r.trace.some((t) => /^Qloo found 1 place in the city that is one of your food or activity tastes/.test(t.detail)), JSON.stringify(r.trace));
  } finally {
    m.restore();
  }
});

test("a tiny map of a place inside the city named after it is a part too (live: Moscow's 4 cells at Trade Fair Moscow)", async () => {
  // Such names also come for the city or more (São Paulo's region, 541 cells), and small towns have small maps named as
  // themselves (Telluride, 14 cells): neither is asked again.
  for (const [locality, groups, per, asked] of [
    ["Trade Fair Austin, All-Texas Exhibition Centre, Austin, Travis County, Texas, United States", 1, 4, 2],
    ["Trade Fair Austin, All-Texas Exhibition Centre, Austin, Travis County, Texas, United States", 5, 6, 1],
    ["Greater Austin Region, Austin, Texas, United States", 9, 8, 1],
    ["Austin, Travis County, Texas, United States", 1, 4, 1],
    ["Austin, Austin, Travis County, Texas, United States", 1, 4, 1], // the city itself (Paris is written this way, live)
    ["Austin Bergstrom Airport, Travis County, Texas, United States", 1, 4, 1], // the city named only in its own name
  ] as const) {
    const m = mockFetch(standardQloo({ heat: (c) => (c.params.get("filter.location.query") ? heatmap(AUSTIN.latitude, AUSTIN.longitude, groups, per, locality) : undefined) }));
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
      assert.equal(m.calls.filter(isHeat).length, asked, `${locality} ${groups * per} cells`);
      if (asked === 2) assert.ok(r.trace.some((t) => t.detail.includes("was only Trade Fair Austin, a part of it; asked again")));
    } finally {
      m.restore();
    }
  }
});

test("an empty map says nothing about a place named after the city, and a circle already asked isn't asked again", async () => {
  const fair = "Trade Fair Austin, All-Texas Exhibition Centre, Austin, Travis County, Texas, United States";
  let m = mockFetch(standardQloo({ heat: (c) => (c.params.get("filter.location.query") ? heatmap(AUSTIN.latitude, AUSTIN.longitude, 0, 8, fair) : undefined) }));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.trace.some((t) => t.detail === `Qloo's area for "Austin, Texas" was empty; asked again for 25 km around the city centre`), JSON.stringify(r.trace.map((t) => t.detail)));
  } finally {
    m.restore();
  }
  // Qloo's city was a part, so everything is already asked around the centre: nothing found there isn't asked twice.
  const part = "Hyde Park, Austin, Travis County, Texas, United States";
  const noRamen = (empty: boolean) => (c: Call) =>
    isPlaces(c) && c.params.get("filter.tags") ? { body: { results: { entities: [] } } } : standardQloo({ heat: (h) => (h.params.get("filter.location.query") ? heatmap(AUSTIN.latitude, AUSTIN.longitude, 9, 8, part) : empty ? heatmap(AUSTIN.latitude, AUSTIN.longitude, 0, 8) : undefined) })(c);
  m = mockFetch(noRamen(false));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    assert.equal(r.mode, "map");
    assert.deepEqual(m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags") && c.params.get("filter.location.radius") !== "1200").map((c) => c.params.get("filter.location.radius")), ["25000"]);
    assert.ok(!r.trace.some((t) => /none of your kinds of places/.test(t.detail)));
  } finally {
    m.restore();
  }
  m = mockFetch(noRamen(true)); // the circle's map is empty too: only the ramen places could rank the areas
  try {
    await assert.rejects(matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]), /Qloo has no places in Austin/);
    assert.deepEqual(m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags")).map((c) => c.params.get("filter.location.radius")), ["25000"]);
  } finally {
    m.restore();
  }
});

test("a city read as itself with none of these places isn't widened into its neighbours (live: Hoboken listed Astoria)", async () => {
  const HOBOKEN = { filter: [{ name: "Austin", disambiguation: "Austin, Travis County, Texas, United States", location: { lat: 30.27, lon: -97.74 } }] };
  const none = (c: Call) => (isPlaces(c) && c.params.get("filter.tags") ? { body: { results: { entities: [] }, ...(c.params.get("filter.location.query") ? { query: { localities: HOBOKEN } } : {}) } } : standardQloo()(c));
  let m = mockFetch(none);
  try {
    await assert.rejects(matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "natural wine", kind: "tag", id: "urn:tag:cuisine:qloo:japanese_ramen", as: "Natural Wine" }]), /Qloo has no places in Austin, Texas/);
    assert.ok(m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags")).every((c) => !c.params.get("filter.location.radius")));
  } finally {
    m.restore();
  }
  m = mockFetch(none);
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    assert.ok(!r.trace.some((t) => /none of your kinds of places/.test(t.detail)));
    assert.ok(r.trace.some((t) => t.detail === "Qloo found no places in the city for Ramen; the areas come from the map alone"), "said, not dropped silently (live: Perth's coffee)");
    assert.ok(m.calls.filter((c) => isPlaces(c) && c.params.get("filter.tags") && c.params.get("filter.location.radius") !== "1200").every((c) => !c.params.get("filter.location.radius")));
  } finally {
    m.restore();
  }
});

test("a city read as its centre's council finds nothing by name and is asked again around its centre (live: Perth's coffee)", async () => {
  // Qloo reads Perth as "City of Perth, City of South Perth, ...": named after the city, not the city.
  const COUNCIL = { filter: [{ name: "City of Austin", disambiguation: "City of Austin, City of South Austin, Texas, United States", location: { lat: 30.27, lon: -97.74 } }] };
  const ramen = place("a", "Ramen A", "Hyde Park", 30.3, -97.73, ["Ramen restaurant"], ["Evening"]);
  const m = mockFetch((c) => (isPlaces(c) && c.params.get("filter.tags") ? { body: { results: { entities: c.params.get("filter.location.query") ? [] : [ramen] }, ...(c.params.get("filter.location.query") ? { query: { localities: COUNCIL } } : {}) } } : standardQloo()(c)));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.ok(r.neighborhoods.length);
    assert.ok(r.trace.some((t) => t.detail.startsWith(`Qloo's area for "Austin, Texas" had none of these places (read as City of Austin); asked again`)), JSON.stringify(r.trace.map((t) => t.detail)));
  } finally {
    m.restore();
  }
  // With an artist, the map read as the council (live: Perth's, 92 cells) and your kinds of places asked again around it.
  const map = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: c.params.get("filter.location.query") ? [] : [ramen] } } }
      : standardQloo({ heat: (h) => (h.params.get("filter.location.query") ? heatmap(AUSTIN.latitude, AUSTIN.longitude, 9, 8, COUNCIL.filter[0].disambiguation) : undefined) })(c),
  );
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    assert.ok(r.trace.some((t) => t.detail === `Qloo found none of your kinds of places for "Austin, Texas" by its name; asked again for 25 km around the city centre`), JSON.stringify(r.trace.map((t) => t.detail)));
  } finally {
    map.restore();
  }
});

test("Qloo's area far away is said by its distance, even when its description names the city", async () => {
  const far = "Hyde Park, Austin, Mower County, Minnesota, United States";
  const m = mockFetch(standardQloo({ heat: (c) => (c.params.get("filter.location.query") ? heatmap(43.67, -92.97, 9, 8, far) : undefined) }));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.trace.some((t) => /^Qloo's area for "Austin, Texas" was 1\d{3} km from the located city; asked again/.test(t.detail)), JSON.stringify(r.trace.map((t) => t.detail)));
    assert.ok(!r.trace.some((t) => t.step === "Your places"), "no food or activity tastes: nothing to say about them");
  } finally {
    m.restore();
  }
});

test("places matched to a place you named alone aren't called food and activity tastes", async () => {
  const m = mockFetch(standardQloo());
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Joe's Pizza", kind: "place", id: UUID(7) }]);
    assert.equal(r.mode, "places");
    const areas = r.trace.find((t) => t.step === "Areas")!.detail;
    assert.match(areas, /match the places you named; grouped/);
    assert.ok(r.ours.some((x) => x.includes("places matching the places you named")));
  } finally {
    m.restore();
  }
});

test("with only food and activity tastes, a place over 40 km from the centre makes no area", async () => {
  // 35 km out is kept (a city's edge), 45 km out isn't.
  const m = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [place("a", "Ramen A", "Downtown", 30.27, -97.74, ["Ramen restaurant"], ["Evening"]), place("b", "Ramen Edge", "Pflugerville", 30.585, -97.74, ["Ramen restaurant"], ["Evening"]), place("c", "Ramen Far", "Georgetown", 30.675, -97.74, ["Ramen restaurant"], ["Evening"])] } } }
      : standardQloo()(c),
  );
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    const shown = r.neighborhoods.flatMap((h) => [...h.matches, ...h.evidence].map((e) => e.name));
    assert.ok(shown.includes("Ramen Edge"), JSON.stringify(r.neighborhoods.map((h) => h.name)));
    assert.ok(!shown.includes("Ramen Far") && !r.neighborhoods.some((h) => h.name === "Georgetown"));
  } finally {
    m.restore();
  }
});

test("with only food and activity tastes, places filed under the city's own name at its centre are the city centre (Melbourne, live)", async () => {
  const m = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [
          place("a", "Dumplings A", "Austin", AUSTIN.latitude, AUSTIN.longitude, ["Dumpling restaurant"], ["Evening"]),
          place("b", "Dumplings B", "Austin", AUSTIN.latitude + 0.001, AUSTIN.longitude, ["Dumpling restaurant"], ["Midday"]),
          place("x", "CLOSED - Dumplings X", "Austin", AUSTIN.latitude, AUSTIN.longitude, ["Dumpling restaurant"], ["Midday"]),
          place("c", "Dumplings C", "Hyde Park", AUSTIN.latitude + 0.05, AUSTIN.longitude, ["Dumpling restaurant"], ["Midday"]),
        ] }, query: { localities: { filter: [{ name: "Austin", disambiguation: "Austin, Travis County, Texas, United States", location: { lat: AUSTIN.latitude, lon: AUSTIN.longitude } }] } } } }
      : standardQloo()(c),
  );
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.equal(r.mode, "places");
    assert.ok(r.neighborhoods.some((h) => h.name === "Downtown Austin"), JSON.stringify(r.neighborhoods.map((h) => h.name)));
    assert.equal(r.neighborhoods.find((h) => h.name === "Downtown Austin")!.cells, 2, "a closed place isn't counted");
    assert.ok(r.trace.some((t) => /^Qloo found 4 places that match/.test(t.detail)));
  } finally {
    m.restore();
  }
  // Filed under the city's name away from its centre: not the city centre (OpenStreetMap names it).
  const far = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [
          place("a", "Dumplings A", "Austin", AUSTIN.latitude + 0.05, AUSTIN.longitude, ["Dumpling restaurant"], ["Evening"]),
          place("b", "Dumplings B", "Austin", AUSTIN.latitude + 0.051, AUSTIN.longitude, ["Dumpling restaurant"], ["Midday"]),
        ] }, query: { localities: { filter: [{ name: "Austin", disambiguation: "Austin, Travis County, Texas, United States", location: { lat: AUSTIN.latitude, lon: AUSTIN.longitude } }] } } } }
      : standardQloo()(c),
  );
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.ok(r.neighborhoods.length && r.neighborhoods.every((h) => h.name !== "Downtown Austin"), JSON.stringify(r.neighborhoods.map((h) => h.name)));
    assert.ok(r.trace.some((t) => /^Qloo found 2 places that match/.test(t.detail)));
  } finally {
    far.restore();
  }
});

test("food or activity places that are all closed or can't be visited say so, not \"try again later\"", async () => {
  const m = mockFetch((c) => (isPlaces(c) && c.params.get("filter.tags") ? { body: { results: { entities: [place("a", "CLOSED - Ramen A", "Downtown", AUSTIN.latitude, AUSTIN.longitude, ["Ramen restaurant"], ["Evening"])] } } } : standardQloo()(c)));
  try {
    await assert.rejects(matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]), (e: AppError) => e.status === 404 && /are closed, can't be visited or are too far out/.test(e.message));
  } finally {
    m.restore();
  }
});

test("a food or activity taste with no places in the city says so, not \"try again later\" (Boston oysters, live)", async () => {
  const m = mockFetch((c) => (isPlaces(c) && c.params.get("filter.tags") ? { body: { results: { entities: [] } } } : standardQloo()(c)));
  try {
    await assert.rejects(matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]), (e: AppError) => e.status === 404 && /Qloo has no places in Austin, Texas for Ramen/.test(e.message) && !/try again later/i.test(e.message));
  } finally {
    m.restore();
  }
});

test("with only food and activity tastes too, a neighborhood named like the city says nothing, and a block number is dropped", async () => {
  const m = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [
          place("a", "Ramen A", "Austin", 30.27, -97.74, ["Ramen restaurant"], ["Evening"]),
          place("b", "Ramen B", "Austin", 30.271, -97.741, ["Ramen restaurant"], ["Midday"]),
          place("c", "Ramen C", "Ginza 8-chome", 30.30, -97.73, ["Ramen restaurant"], ["Evening"]),
        ] } } }
      : standardQloo()(c),
  );
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.equal(r.mode, "places");
    assert.ok(r.neighborhoods.length && r.neighborhoods.every((h) => h.name !== "Austin"), JSON.stringify(r.neighborhoods.map((h) => h.name)));
    assert.ok(r.neighborhoods.some((h) => h.name === "Ginza"), "a block number is dropped here too");
  } finally {
    m.restore();
  }
});

test("a picked Qloo ID is used as is: a cuisine filters places, an entity goes on the map", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [
      { name: "Dune", kind: "movie", id: UUID(2), as: "Dune (1984)" },
      { name: "ramen", kind: "tag", id: "urn:tag:cuisine:qloo:japanese_ramen", as: "Japanese Ramen" },
      { name: "cool jazz", kind: "tag", id: "urn:tag:genre:music:cool_jazz" }, // a genre goes on the map; no name sent: its own
    ]);
    assert.equal(m.calls.find(isHeat)!.params.get("signal.interests.tags"), "urn:tag:genre:music:cool_jazz");
    assert.equal(r.resolved.find((x) => x.input === "cool jazz")!.as, "cool jazz");
    assert.equal(r.resolved.find((x) => x.input === "ramen")!.as, "Japanese Ramen", "the name sent with a picked tag is kept");
    assert.ok(r.trace.some((t) => t.step === "Your places"), "tags were asked for");
    assert.equal(m.calls.filter((c) => c.path === "/search" || c.params.get("filter.query")).length, 0, "no search by name");
    // Each picked ID is looked up once, so its own type decides how it is used.
    assert.deepEqual(m.calls.filter((c) => c.path === "/entities").map((c) => c.params.get("entity_ids")), [UUID(2)]);
    // A picked tag isn't looked up: Qloo's lookup by tag ID finds nothing for whole families (live: Climbing Gym).
    assert.equal(m.calls.filter((c) => c.path === "/v2/tags").length, 0);
    assert.equal(m.calls.find(isHeat)!.params.get("signal.interests.entities"), UUID(2));
    assert.equal(m.calls.find((c) => isPlaces(c) && c.params.get("filter.tags"))!.params.get("filter.tags"), "urn:tag:cuisine:qloo:japanese_ramen");
    assert.ok(r.resolved.every((x) => x.match === "chosen"));
  } finally {
    m.restore();
  }
});

test("a picked place ID acts on the places, as the place found by name does (live: Joe's Pizza put Brooklyn on the map)", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [
      { name: "Joe's Pizza", kind: "place", id: UUID(7), as: "Joe's Pizza (216 Bedford Ave)" },
      { name: "ramen", kind: "tag", id: "urn:tag:cuisine:qloo:japanese_ramen", as: "Japanese Ramen" },
    ]);
    assert.equal(r.mode, "places");
    assert.equal(m.calls.filter(isHeat).length, 0, "no taste map");
    assert.deepEqual(r.resolved.find((x) => x.input === "Joe's Pizza")!.use, ["places"]);
    assert.equal(r.resolved.find((x) => x.input === "Joe's Pizza")!.as, "Joe's Pizza (216 Bedford Ave Brooklyn, NY 11249)", "named by Qloo's record, not what was sent");
    assert.equal(r.resolved.find((x) => x.input === "Joe's Pizza")!.placeTag, undefined, "a place isn't a filter tag");
    assert.ok(m.calls.find((c) => isPlaces(c) && c.params.get("filter.tags"))!.params.get("signal.interests.entities")!.split(",").includes(UUID(7)));
  } finally {
    m.restore();
  }
});

test("a picked ID's own type decides how it is used, whatever kind was typed (live: Blue Note the artist, picked under a place)", async () => {
  const m = mockFetch(standardQloo());
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Blue Note", kind: "place", id: UUID(8), as: "Blue Note" }]);
    assert.equal(r.mode, "map");
    assert.equal(m.calls.find(isHeat)!.params.get("signal.interests.entities"), UUID(8));
    assert.deepEqual(r.resolved[0].use, ["map"]);
    assert.equal(r.resolved[0].kind, "artist", "the re-run sends the kind it is");
  } finally {
    m.restore();
  }
});

test("a picked ID Qloo doesn't know is reported as not found; the rest is still searched (live: a made-up ID was a 400 for all)", async () => {
  const m = mockFetch(standardQloo());
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [
      { name: "Phoebe Bridgers", kind: "artist" },
      { name: "Dune", kind: "movie", id: UUID(99) },
      { name: "Arrival", kind: "movie", id: "12345678-1234-1234-1234-123456789abc" }, // not a valid UUID to Qloo: a 400
    ]);
    assert.deepEqual(r.unresolved, ["Dune", "Arrival"]);
    assert.equal(m.calls.find(isHeat)!.params.get("signal.interests.entities"), UUID(3));
  } finally {
    m.restore();
  }
});

test("the same interest twice is looked up once", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "phoebe bridgers", kind: "artist" }]);
    assert.equal(m.calls.filter((c) => c.path === "/search").length, 1);
    assert.equal(r.resolved.length, 1);
  } finally {
    m.restore();
  }
});

test("a video game is searched as Qloo's urn:entity:videogame (it answers 400 to video_game) and labeled a game", async () => {
  const std = standardQloo();
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/search" && c.params.get("query") === "Minecraft")
      return c.params.get("types") === "urn:entity:videogame"
        ? { body: { results: [
            { entity_id: UUID(7), name: "Minecraft", disambiguation: "2011-11-18, Mojang AB", types: ["urn:entity:videogame"] },
            { entity_id: UUID(8), name: "Minecraft Dungeons", disambiguation: "2020-05-26,   Mojang  AB", types: ["urn:entity:videogame"] },
          ] } }
        : { status: 400, body: { error: { message: "types/0: must be equal to one of the allowed values" } } };
    return std(c);
  });
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Minecraft", kind: "video_game" }, { name: "Phoebe Bridgers", kind: "artist" }]);
    const game = r.resolved.find((x) => x.input === "Minecraft")!;
    assert.equal(game?.match, "exact");
    assert.deepEqual(game.alternatives.map((a) => [a.name, a.type]), [["Minecraft Dungeons (2020-05-26, Mojang AB)", "game"]]); // Qloo's runs of spaces closed up
  } finally {
    m.restore();
  }
});

test("a refused key or a rate limit is reported as such, never as 'not found'", async () => {
  for (const [status, expect] of [[401, /refused this app's API key/], [429, /rate limit/]] as const) {
    const m = mockFetch((c) => (qloo(c) ? { status, body: {} } : undefined));
    try {
      const { kv } = memoryKV();
      await assert.rejects(matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]), (e: AppError) => expect.test(e.message));
    } finally {
      m.restore();
    }
  }
});

test("something Qloo doesn't know is listed as not found, and the rest still runs", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "zzqx", kind: "tag" }]);
    assert.deepEqual(r.unresolved, ["zzqx"]);
    assert.ok(r.neighborhoods.length > 0);
  } finally {
    m.restore();
  }
});

test("Qloo's locality is shown, and one far from the located city is asked again around the city", async () => {
  let n = 0;
  const m = mockFetch(standardQloo({ heat: () => (n++ === 0 ? heatmap(45.52, -122.68, 9, 8, "Portland, Multnomah County, Oregon") : heatmap(AUSTIN.latitude, AUSTIN.longitude)) }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, TX", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    const heat = m.calls.filter(isHeat);
    assert.equal(heat[0].params.get("filter.location.query"), "Austin, Texas");
    assert.equal(heat[1].params.get("filter.location"), `POINT(${AUSTIN.longitude} ${AUSTIN.latitude})`);
    assert.equal(heat[1].params.get("filter.location.radius"), "25000");
    assert.ok(r.trace.some((t) => t.step === "Check"));
    assert.equal(r.qlooCity, "Austin, Travis County, Texas, United States");
  } finally {
    m.restore();
  }
});

test("if Qloo's map is still far from the city after asking again, nothing is shown as that city", async () => {
  const m = mockFetch(standardQloo({ heat: () => heatmap(45.52, -122.68, 9, 8, "Portland, Oregon") }));
  try {
    const { kv } = memoryKV();
    await assert.rejects(matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]), /didn't line up with Austin, Texas/);
  } finally {
    m.restore();
  }
});

test("several map tags combine as union, set explicitly", () => {
  assert.equal(signalParams({ entities: [], tags: ["a", "b"] })["operator.signal.interests.tags"], "union");
  assert.equal(signalParams({ entities: ["x"], tags: ["a"] })["operator.signal.interests.tags"], undefined);
});

test("a cold worst-case search stays inside the free plan's 50 subrequests, and every call is counted", async () => {
  // 8 interests that each need two lookups; Qloo names nothing, so OpenStreetMap names every area.
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/search") return { body: { results: [] } };
    if (qloo(c) && c.path === "/v2/tags") {
      const q = c.params.get("filter.query")!;
      return { body: { results: { tags: [tag(`urn:tag:genre:qloo:${q}`, q, ["urn:entity:artist"]), tag(`urn:tag:cuisine:qloo:${q}`, q, [PLACE])] } } };
    }
    return standardQloo({ hood: () => null })(c);
  });
  try {
    const { kv, ops } = memoryKV();
    const budget = new Budget(48 - 4); // index.ts spends 1 cache read, 1 cache write and 2 for the rate limit
    const names = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"].map((name) => ({ name, kind: "artist" as const }));
    const r = await matchNeighborhoods(ENV(kv), budget, "Austin, Texas", names);
    const real = m.calls.length + ops.get + ops.put;
    assert.equal(real, budget.used, "every fetch and KV call is charged to the budget");
    assert.ok(real <= 44, `used ${real}`);
    assert.ok(r.neighborhoods.length > 0);
  } finally {
    m.restore();
  }
});

test("a failed cache write never fails a search", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV({ failPuts: true });
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.neighborhoods.length > 0);
  } finally {
    m.restore();
  }
});

test("when place calls fail the result is flagged degraded (shown, not cached) and has no empty days", async () => {
  const m = mockFetch((c) => (isPlaces(c) ? { status: 500, body: {} } : standardQloo()(c)));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.equal(r.degraded, true);
    assert.ok(r.weekend.every((d) => d.stops.length > 0));
  } finally {
    m.restore();
  }
  // A failed search for your kinds of places isn't reported as "found no places".
  const k = mockFetch((c) => (isPlaces(c) && c.params.get("filter.tags") ? { status: 500, body: {} } : standardQloo()(c)));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    assert.equal(r.degraded, true);
    assert.ok(!r.trace.some((t) => /found no places in the city/.test(t.detail)));
  } finally {
    k.restore();
  }
});

test("the weekend takes one place per part of the day from Qloo's time-of-day tags", () => {
  const ps = [
    { id: "1", name: "Bar", types: [], tags: ["Cocktail bar"], times: ["Evening", "Late night"] },
    { id: "2", name: "Cafe", types: [], tags: ["Coffee shop"], times: ["Morning"] },
    { id: "3", name: "Barbecue", types: [], tags: ["Barbecue restaurant"], times: ["Midday", "Afternoon"] },
    { id: "4", name: "Second cafe", types: [], tags: ["Coffee shop"], times: ["Morning"] },
  ];
  assert.deepEqual(planDay(ps), [
    { when: "Morning", place: "Cafe", why: "Coffee shop" },
    { when: "Afternoon", place: "Barbecue", why: "Barbecue restaurant" },
    { when: "Evening", place: "Bar", why: "Cocktail bar" },
  ]);
});

test("state abbreviations and names pick the right Portland", async () => {
  const both = [
    { name: "Portland", latitude: 45.52, longitude: -122.68, country_code: "US", admin1: "Oregon", country: "United States", population: 650000 },
    { name: "Portland", latitude: 43.66, longitude: -70.26, country_code: "US", admin1: "Maine", country: "United States", population: 68000 },
  ];
  const m = mockFetch((c) => (c.host === "geocoding-api.open-meteo.com" ? { body: { results: both } } : undefined));
  try {
    for (const [input, expect] of [["Portland, ME", "Portland, Maine"], ["Portland, Maine", "Portland, Maine"], ["Portland, OR", "Portland, Oregon"], ["Portland", "Portland, Oregon"]]) {
      const { kv } = memoryKV();
      assert.equal((await cityCenter(kv, new Budget(10), input))!.name, expect, input);
    }
  } finally {
    m.restore();
  }
});

test("a city service outage is a clear message, not a crash", async () => {
  const m = mockFetch((c) => (c.host === "geocoding-api.open-meteo.com" ? { status: 503, body: "down" } : undefined));
  try {
    const { kv } = memoryKV();
    await assert.rejects(cityCenter(kv, new Budget(10), "Austin, Texas"), (e: AppError) => e instanceof AppError && e.status === 502);
  } finally {
    m.restore();
  }
});

test("coarse cells (a big county) are grouped into ~2.4 km squares, not ranked one by one", () => {
  // 24 geohash-6 cells: one perfect cell alone, and a square of 4 good ones.
  const pts = [
    { lat: 34.001, lon: -118.001, geohash: "9q5aaa", affinity: 1 },
    ...[0, 1, 2, 3].map((i) => ({ lat: 34.101 + i * 0.004, lon: -118.101, geohash: `9q5b${i}x`, affinity: 0.95 })),
    ...Array.from({ length: 19 }, (_, i) => ({ lat: 34.3 + i * 0.03, lon: -118.4, geohash: `9q5c${i}y`, affinity: 0.1 })),
  ];
  const areas = rankAreas(pts);
  assert.equal(areas[0].cells, 4);
  assert.ok(Math.abs(areas[0].affinity - 0.95) < 1e-9);
});

test("the weekend skips tattoo shops, salons, hotels and RV parks, but keeps a hotel bar", () => {
  const ps = [
    { id: "1", name: "Fleur Noire Tattoo", types: [], tags: ["Personal care", "Tattoo shop"], times: ["Morning"] },
    { id: "2", name: "Pecan Grove RV Park", types: [], tags: ["RV park"], times: ["Afternoon"] },
    { id: "3", name: "Wythe Hotel", types: [], tags: ["Hotel", "Cocktail bar"], times: ["Evening"] },
    { id: "4", name: "Epoch", types: [], tags: ["Coffee shop"], times: ["Morning"] },
  ];
  assert.deepEqual(planDay(ps).map((s) => s.place), ["Epoch", "Wythe Hotel"]);
});

test("an area no one can name is left out without marking the result as failed", async () => {
  const m = mockFetch((c) => (c.host === "photon.komoot.io" ? { body: { features: [] } } : standardQloo({ hood: (c) => (String(c.params.get("filter.location")).includes("-97.743") ? null : "Downtown") })(c)));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.equal(r.degraded, false);
    assert.ok(r.neighborhoods.every((h) => h.name));
  } finally {
    m.restore();
  }
});

test("a near-miss counts only if it resembles what was typed", () => {
  assert.ok(resembles("Berghain", "Kantine am Berghain"));
  assert.ok(resembles("Phobe Bridgers", "Phoebe Bridgers"));
  assert.ok(resembles("The Baer", "The Bear"), "swapped letters count as one typo");
  assert.ok(resembles("natural wine", "Natural Wines"));
  assert.ok(!resembles("zzqx", "Zydeco"));
  assert.ok(!resembles("Dune", "Everything, Everything"));
});

test("nonsense is 'not found' (Qloo's semantic search returns something for anything)", async () => {
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/v2/tags") return { body: { results: { tags: [tag("urn:tag:genre:qloo:zydeco", "Zydeco", ["urn:entity:artist"]), tag("urn:tag:cuisine:qloo:quiche", "Quiche", [PLACE])] } } };
    if (qloo(c) && c.path === "/search") return { body: { results: [{ entity_id: UUID(7), name: "Queen", types: ["urn:entity:artist"] }] } };
    return standardQloo()(c);
  });
  try {
    const { kv } = memoryKV();
    await assert.rejects(matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "zzqx", kind: "tag" }, { name: "qqwwzz" }]), (e: AppError) => e.status === 422);
    assert.equal(m.calls.filter(isHeat).length, 0);
  } finally {
    m.restore();
  }
});

test("alternatives are only things that resemble the word (no 'Everything, Everything' for Dune)", async () => {
  const m = mockFetch((c) =>
    qloo(c) && c.path === "/search"
      ? { body: { results: [{ entity_id: UUID(1), name: "Dune", disambiguation: "2021", types: ["urn:entity:movie"] }, { entity_id: UUID(9), name: "Everything, Everything", disambiguation: "2017", types: ["urn:entity:movie"] }, { entity_id: UUID(5), name: "Dune: Part Two", disambiguation: "2024", types: ["urn:entity:movie"] }] } }
      : standardQloo()(c),
  );
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Dune", kind: "movie" }]);
    assert.deepEqual(r.resolved[0].alternatives.map((a) => a.name), ["Dune: Part Two (2024)"]);
  } finally {
    m.restore();
  }
});

test("an activity's music namesake stays off the map (yoga), a music genre goes on it (jazz)", async () => {
  const m = mockFetch((c) =>
    qloo(c) && c.path === "/v2/tags" && c.params.get("filter.query") === "yoga"
      ? { body: { results: { tags: [tag("urn:tag:subgenre:qloo:yoga", "Yoga", ["urn:entity:artist"]), tag("urn:tag:activity_type:qloo:yoga", "Yoga", [PLACE])] } } }
      : standardQloo()(c),
  );
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "yoga", kind: "tag" }, { name: "jazz", kind: "tag" }]);
    assert.deepEqual(r.resolved.find((x) => x.input === "yoga")!.use, ["places"]);
    assert.deepEqual(r.resolved.find((x) => x.input === "jazz")!.use, ["map", "places"]);
    assert.equal(m.calls.find(isHeat)!.params.get("signal.interests.tags"), "urn:tag:genre:qloo:jazz");
  } finally {
    m.restore();
  }
});

test("a tag that is neither a genre nor about places is not used", async () => {
  const m = mockFetch((c) =>
    qloo(c) && c.path === "/v2/tags" && c.params.get("filter.query") === "ramen"
      ? { body: { results: { tags: [tag("urn:tag:popular_food_item:qloo:ramen", "Ramen", ["urn:entity:locality"])] } } }
      : standardQloo()(c),
  );
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    assert.deepEqual(r.unresolved, ["ramen"]);
  } finally {
    m.restore();
  }
});

test("can't-visit places are judged by Qloo's categories, not names, and filtered before the lists are cut", async () => {
  const many = [
    place("s1", "Some High School", "Downtown", 30.27, -97.74, ["High school"], ["Morning"]),
    place("s2", "Piccadilly Circus", "Downtown", 30.27, -97.74, ["Subway station"], ["Morning"]),
    place("s3", "St. Somebody", "Downtown", 30.27, -97.74, ["Church"], ["Morning"]),
    place("s4", "DUMBO", "Downtown", 30.27, -97.74, ["Ferry terminal"], ["Morning"]), // live: a Sunday stop in Little Italy
    place("s5", "Chicago O'Hare International Airport", "Downtown", 30.27, -97.74, ["International airport"], ["Morning"]),
    place("s6", "Joint Base Myer Henderson Hall Garrison Headquarters", "Downtown", 30.27, -97.74, ["Military base"], ["Morning"]), // live: an Arlington Saturday stop
    // Live in Boston, Sydney, Tokyo and Mexico City: "think MIT Media Lab", a school's department, radio broadcasters, a film studio.
    place("s7", "MIT School of Engineering", "Downtown", 30.27, -97.74, ["Academic department"], ["Morning"]),
    place("s8", "MIT Media Lab", "Downtown", 30.27, -97.74, ["Research institute"], ["Afternoon"]),
    place("s9", "J-WAVE", "Downtown", 30.27, -97.74, ["Radio broadcaster"], ["Morning"]),
    place("s10", "Red Sky Studios", "Downtown", 30.27, -97.74, ["Movie studio"], ["Afternoon"]),
    place("s11", "Overlook Park", "Downtown", 30.27, -97.74, ["Light rail station"], ["Morning"]), // live, Portland
    place("s12", "Tulane Law School Library", "Downtown", 30.27, -97.74, ["Law library"], ["Morning"]), // live, New Orleans
    // Closed: the name says so though Qloo's is_closed is false (San Diego, live), or Qloo says so.
    place("s13", "CLOSED - Tacos el Cabron", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    { ...place("s14", "Old Diner", "Downtown", 30.27, -97.74, ["Diner"], ["Morning"]), properties: { address: "1 Main St", neighborhood: "Downtown", is_closed: true } },
    place("s15", "Tacos (Permanently Closed)", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    place("v6", "Closed Sessions Bar", "Downtown", 30.27, -97.74, ["Cocktail bar"], ["Evening"]), // open: its name only starts with the word
    place("s16", "Closed - Old Taqueria", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    place("s17", "CLOSED Tacos Uno", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    place("s18", "Closed \u2013 Tacos Dos", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    place("s19", "Closed \u2014 Tacos Tres", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    place("s20", "Closed: Tacos Cuatro", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    place("s21", "Closed | Tacos Cinco", "Downtown", 30.27, -97.74, ["Taco restaurant"], ["Evening"]),
    // Live: a wastewater plant (Brooklyn) and photographers' studios (Atlanta) as Sunday stops.
    place("s22", "Newtown Creek Wastewater Treatment Plant", "Downtown", 30.27, -97.74, ["Water treatment plant"], ["Morning"]),
    place("s23", "Cam Kirk Studios", "Downtown", 30.27, -97.74, ["Photography studio"], ["Afternoon"]),
    place("v1", "The Garage", "Downtown", 30.27, -97.74, ["Cocktail bar"], ["Evening"]),
    place("v2", "Temple Bar", "Downtown", 30.27, -97.74, ["Pub"], ["Evening"]),
    place("v3", "Bank & Bourbon", "Downtown", 30.27, -97.74, ["Restaurant"], ["Evening"]),
    place("v4", "Cafe One", "Downtown", 30.27, -97.74, ["Cafe"], ["Morning"]),
    place("v5", "Gallery Two", "Downtown", 30.27, -97.74, ["Art gallery"], ["Afternoon"]),
  ];
  const m = mockFetch((c) => (isPlaces(c) && !c.params.get("filter.tags") ? { body: { results: { entities: many } } } : standardQloo()(c)));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    const listed = r.neighborhoods.flatMap((h) => h.evidence.map((e) => e.name));
    // Six can be visited; a list holds five.
    assert.equal(listed.length, 5);
    assert.ok(listed.every((n) => ["Bank & Bourbon", "Cafe One", "Closed Sessions Bar", "Gallery Two", "Temple Bar", "The Garage"].includes(n)), JSON.stringify(listed));
    assert.ok(listed.includes("Closed Sessions Bar"), "a bar whose name only starts with \"Closed\" is open");
    assert.ok(r.trace.some((t) => t.step === "Filter" && /Left out 23 places/.test(t.detail)));
  } finally {
    m.restore();
  }
});

test("two branches of one chain aren't two stops on the same day", () => {
  const ps = [
    { id: "1", name: "Cocoro", types: [], tags: ["Ramen"], times: ["Afternoon"] },
    { id: "2", name: "Cocoro", types: [], tags: ["Bar"], times: ["Evening"] },
    { id: "3", name: "Night Bar", types: [], tags: ["Bar"], times: ["Evening"] },
  ];
  assert.deepEqual(planDay(ps).map((s) => s.place), ["Cocoro", "Night Bar"]);
});

test("when the guessed kind is uncertain, the same name in other kinds is offered (Dune the book -> the film)", async () => {
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/search" && c.params.get("types") === "urn:entity:book")
      return { body: { results: [{ entity_id: UUID(21), name: "Dune (Dune, #1)", disambiguation: "1965, Frank Herbert", types: ["urn:entity:book"] }, { entity_id: UUID(22), name: "Dune Messiah", types: ["urn:entity:book"] }] } };
    if (qloo(c) && c.path === "/search" && !c.params.get("types"))
      return { body: { results: [{ entity_id: UUID(1), name: "Dune", disambiguation: "2021", types: ["urn:entity:movie"] }, { entity_id: UUID(21), name: "Dune (Dune, #1)", types: ["urn:entity:book"] }] } };
    return standardQloo()(c);
  });
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Dune", kind: "book" }]);
    const d = r.resolved[0];
    assert.equal(d.match, "closest");
    assert.ok(d.alternatives.some((a) => a.name === "Dune (2021)" && a.type === "film"), JSON.stringify(d.alternatives));
  } finally {
    m.restore();
  }
});

test("your kinds of places are only listed within reach of the neighborhood (no Manhattan bar under Williamsburg)", async () => {
  const m = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [
          place("near", "Near Ramen", "Downtown", AUSTIN.latitude + 0.002, AUSTIN.longitude, ["Ramen restaurant"], ["Evening"]),
          place("far", "Far Ramen", "Elsewhere", AUSTIN.latitude + 0.017, AUSTIN.longitude, ["Ramen restaurant"], ["Evening"]), // ~1.7 km: inside the old 2 km rule
        ] } } }
      : standardQloo({ hood: () => "Downtown" })(c),
  );
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    const listed = r.neighborhoods.flatMap((h) => h.matches.map((e) => e.name));
    assert.ok(listed.includes("Near Ramen"));
    assert.ok(!listed.includes("Far Ramen"), JSON.stringify(r.neighborhoods.map((h) => [h.name, h.lat, h.lon])));
  } finally {
    m.restore();
  }
});

test("your kinds of places within reach lift an area (0.03 each, up to three)", async () => {
  // The best square (mean ~0.98) has no ramen nearby; the runner-up (~0.93, 0.05 behind) has three
  // ramen shops, so +0.09 puts it first. A square far behind would not move (the boost is small).
  // Squares placed inside the 0.01-degree grid, so none is split into sparse pieces.
  const lat0 = 30.2621;
  const heat = heatmap(lat0, AUSTIN.longitude, 20, 8);
  const cLat = lat0 + 0.012 + 0.00175, cLon = AUSTIN.longitude; // square g=1
  const m = mockFetch((c) =>
    isPlaces(c) && c.params.get("filter.tags")
      ? { body: { results: { entities: [0, 1, 2].map((i) => place(`r${i}`, `Ramen ${i}`, "Ramen Row", cLat + i * 0.001, cLon, ["Ramen restaurant"], ["Evening"])) } } }
      : isHeat(c) ? { body: heat } : standardQloo()(c),
  );
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    const order = JSON.stringify(r.neighborhoods.map((h) => [h.name, h.affinity.toFixed(3), h.matches.length]));
    assert.ok(r.neighborhoods[0].affinity < r.neighborhoods[1].affinity, `the boost lifted a lower map score to first: ${order}`);
    assert.equal(r.neighborhoods.reduce((n, h) => n + h.matches.length, 0), 3, order);
    assert.ok(r.ours.some((o) => /0\.03 for each of your kinds of places/.test(o)));
  } finally {
    m.restore();
  }
});

test("a city named like its state keeps the state, so Qloo reads the city, not the state", async () => {
  const m = mockFetch((c) => (c.host === "geocoding-api.open-meteo.com" ? { body: { results: [{ id: 5128581, name: "New York", latitude: 40.71, longitude: -74.0, country_code: "US", admin1: "New York", country: "United States", population: 8804190 }] } } : undefined));
  try {
    const { kv } = memoryKV();
    const c = await cityCenter(kv, new Budget(10), "NYC");
    assert.equal(c!.query, "New York, New York");
  } finally {
    m.restore();
  }
});

test("a city typed in Hebrew is found in Hebrew and asked about in English", async () => {
  const m = mockFetch((c) => {
    if (c.host !== "geocoding-api.open-meteo.com") return undefined;
    if (c.path === "/v1/get") return { body: { id: 293397, name: "Tel Aviv", latitude: 32.08, longitude: 34.78, country_code: "IL", admin1: "Tel Aviv", country: "Israel" } };
    if (c.params.get("language") === "he") return { body: { results: [{ id: 293397, name: "תל אביב-יפו", latitude: 32.08, longitude: 34.78, country_code: "IL", country: "ישראל", population: 432892 }] } };
    return { body: {} };
  });
  try {
    const { kv } = memoryKV();
    const c = await cityCenter(kv, new Budget(10), "תל אביב");
    assert.equal(c!.query, "Tel Aviv, Israel");
  } finally {
    m.restore();
  }
});

test("neighborhoods carry the score they are ordered by (percentile plus the boost)", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "ramen", kind: "tag" }]);
    for (let i = 1; i < r.neighborhoods.length; i++) assert.ok(r.neighborhoods[i - 1].score >= r.neighborhoods[i].score);
    assert.ok(r.neighborhoods.every((h) => h.score >= h.affinity));
    assert.ok(r.computedAt > 0);
  } finally {
    m.restore();
  }
});

test("Qloo is searched with the English name; the person sees what they wrote", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "פיבי ברידג'רס", query: "Phoebe Bridgers", kind: "artist" }]);
    assert.equal(m.calls.find((c) => c.path === "/search")!.params.get("query"), "Phoebe Bridgers");
    assert.equal(r.resolved[0].input, "פיבי ברידג'רס");
    assert.equal(r.resolved[0].query, "Phoebe Bridgers");
    assert.equal(r.resolved[0].match, "exact");
  } finally {
    m.restore();
  }
});

test("Qloo calls are paced: no more than 5 start within a second, the rate Qloo rejects (measured)", async () => {
  const m = mockFetch(standardQloo());
  const mocked = globalThis.fetch;
  const starts: number[] = [];
  let rejected = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (new URL(typeof input === "string" ? input : input.url).host !== "qloo.test") return mocked(input, init);
    const now = Date.now();
    starts.push(now);
    if (starts.filter((t) => now - t < 1000).length > 5) {
      rejected++;
      return new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), { status: 429 });
    }
    return mocked(input, init);
  }) as typeof fetch;
  try {
    const names = ["Phoebe Bridgers", "jazz", "ramen", "bouldering", "Dune", "Radiohead"];
    const { QLOO_MIN_GAP_MS, ...live } = ENV(memoryKV().kv); // the real pacing
    const r = await matchNeighborhoods(live, new Budget(48), "Austin, Texas", names.map((name) => ({ name })));
    assert.equal(rejected, 0);
    assert.ok(starts.length >= 8, `${starts.length} calls`);
    assert.ok(r.calls.every((c) => c.status === 200));
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    assert.ok(Math.min(...gaps) >= 330, `smallest gap ${Math.min(...gaps)} ms`);
  } finally {
    m.restore();
  }
});

test("a square with only a few cells (the city's edge) never outranks well-covered squares", async () => {
  const body = heatmap(AUSTIN.latitude, AUSTIN.longitude, 3, 8) as any;
  const edge = { lat: AUSTIN.latitude + 0.2, lon: AUSTIN.longitude + 0.2 };
  // Two cells alone in their square, hotter than any other cell.
  body.results.heatmap.unshift(
    { location: { latitude: edge.lat, longitude: edge.lon, geohash: "9v6zzzz" }, query: { affinity: 1 } },
    { location: { latitude: edge.lat + 0.0005, longitude: edge.lon, geohash: "9v6zzzy" }, query: { affinity: 0.999 } },
  );
  const m = mockFetch(standardQloo({ heat: () => body }));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(km(r.neighborhoods[0], edge) > 5, "the edge square is not first");
    assert.ok(r.neighborhoods.some((h) => km(h, edge) < 1), "it still fills in after the full squares");
  } finally {
    m.restore();
  }
});

test("a picked item keeps its English name in the answer", async () => {
  const m = mockFetch(standardQloo());
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "פאודה", query: "Fauda", kind: "tv_show", id: UUID(6), as: "Fauda (2015)" }]);
    assert.equal(r.resolved[0].match, "chosen");
    assert.equal(r.resolved[0].query, "Fauda");
    assert.equal(r.resolved[0].as, "Fauda (2015)", "named by Qloo's own record");
  } finally {
    m.restore();
  }
});

test("a taste whose exact name can't act falls back to a similar tag that can; 'Not it?' offers only tags that act, and a picked one acts the same way", async () => {
  const wine = (c: Call) =>
    qloo(c) && c.path === "/v2/tags" && c.params.get("filter.query") === "natural wine bars"
      ? { body: { results: { tags: [
          tag("urn:tag:keyword:media:natural_wine_bars", "Natural Wine Bars", ["urn:entity:movie"]),
          tag("urn:tag:lifestyle:qloo:natural_wine_bars", "Natural Wine Bars", ["urn:entity:brand"]),
          tag("urn:tag:cuisine:qloo:natural_wine", "Natural Wine", [PLACE]),
          tag("urn:tag:good_for:qloo:natural_wine_bar", "Natural Wine Bar", [PLACE]),
          tag("urn:tag:theme:qloo:wine", "Wine Bars", ["urn:entity:book"]),
        ] } } }
      : standardQloo()(c);
  const m = mockFetch(wine);
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }, { name: "natural wine bars", kind: "tag" }]);
    const w = r.resolved.find((x) => x.input === "natural wine bars")!;
    assert.ok(w, `resolved: ${JSON.stringify(r.unresolved)}`);
    assert.equal(w.match, "closest");
    assert.deepEqual(w.use, ["places"]);
    assert.deepEqual(w.alternatives.map((a) => a.id), ["urn:tag:good_for:qloo:natural_wine_bar"]);
  } finally {
    m.restore();
  }
  const again = mockFetch(standardQloo());
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [
      { name: "Phoebe Bridgers", kind: "artist" },
      { name: "natural wine bars", kind: "tag", id: "urn:tag:good_for:qloo:natural_wine_bar", as: "Natural Wine Bar" },
    ]);
    const w = r.resolved.find((x) => x.input === "natural wine bars")!;
    assert.deepEqual(w.use, ["places"]);
    assert.equal(w.placeTag, "urn:tag:good_for:qloo:natural_wine_bar");
  } finally {
    again.restore();
  }
});

test("squares Qloo names alike merge, and the entry states its best square's numbers, not a sum", async () => {
  const lat0 = 30.2621; // squares inside the 0.01-degree grid: 8 cells each
  const m = mockFetch(standardQloo({ heat: () => heatmap(lat0, AUSTIN.longitude, 9, 8), hood: () => "East Cesar Chavez" }));
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.equal(r.neighborhoods.length, 1);
    assert.equal(r.neighborhoods[0].cells, 8);
    assert.ok(Math.abs(r.neighborhoods[0].affinity - (1 - 3.5 / 71)) < 1e-9, String(r.neighborhoods[0].affinity));
  } finally {
    m.restore();
  }
});

test("interests are matched by Booker's name rules: near names ranked by closeness, no fragments offered, no one-word coincidences", async () => {
  const results: Record<string, any[]> = {
    "Tom Pety": [{ entity_id: UUID(1), name: "Tom Waits", types: ["urn:entity:artist"] }, { entity_id: UUID(2), name: "Tom Petty", types: ["urn:entity:artist"] }],
    "Shakey Graves": [{ entity_id: UUID(3), name: "Shakey Graves", types: ["urn:entity:artist"] }, { entity_id: UUID(4), name: "Graves", types: ["urn:entity:artist"] }],
    "Nobody Real Band Xyz": [{ entity_id: UUID(5), name: "The Band", types: ["urn:entity:artist"] }],
  };
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/search") return { body: { results: results[c.params.get("query") ?? ""] ?? [] } };
    if (qloo(c) && c.path === "/v2/tags") return { body: { results: { tags: [] } } };
    return standardQloo()(c);
  });
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", ["Tom Pety", "Shakey Graves", "Nobody Real Band Xyz"].map((name) => ({ name, kind: "artist" as const })));
    const got = Object.fromEntries(r.resolved.map((x) => [x.input, `${x.as} ${x.match} [${x.alternatives.map((a) => a.name)}]`]));
    assert.equal(got["Tom Pety"], "Tom Petty closest []", "Tom Waits shares one word of two: not offered");
    assert.equal(got["Shakey Graves"], "Shakey Graves exact []");
    assert.equal(got["Nobody Real Band Xyz"], undefined, "one shared word in a long name isn't a match");
  } finally {
    m.restore();
  }
});

test("a note in brackets: a subtitle, a year, or set aside, with the name searched alone when the whole text finds nothing like it (live: 'Scream: The TV Series'); never a genre", async () => {
  const results: Record<string, any[]> = {
    // What the live search answered for the whole text, and what it answers for the name.
    "Succession (TV series)": [{ entity_id: UUID(11), name: "Scream: The TV Series", disambiguation: "2015,2019", types: ["urn:entity:tv_show"] }],
    "Dune (2021 film)": [{ entity_id: UUID(13), name: "Dune", disambiguation: "1984", types: ["urn:entity:movie"] }],
    "Star Wars (The Empire Strikes Back)": [{ entity_id: UUID(15), name: "Star Wars: Episode V - The Empire Strikes Back", disambiguation: "1980", types: ["urn:entity:movie"] }],
    "Star Wars": [{ entity_id: UUID(16), name: "Star Wars", disambiguation: "1977", types: ["urn:entity:movie"] }],
    Succession: [{ entity_id: UUID(12), name: "Succession", disambiguation: "2018,2023", types: ["urn:entity:tv_show"] }],
    Dune: [
      { entity_id: UUID(13), name: "Dune", disambiguation: "1984", types: ["urn:entity:movie"] },
      { entity_id: UUID(14), name: "Dune", disambiguation: "2021", types: ["urn:entity:movie"] },
    ],
  };
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/search") return { body: { results: results[c.params.get("query") ?? ""] ?? [] } };
    // The genre search finds Indie Rock for any text holding "indie rock".
    if (qloo(c) && c.path === "/v2/tags")
      return { body: { results: { tags: /indie rock/i.test(c.params.get("filter.query") ?? "") ? [tag("urn:tag:genre:music:indie_rock", "Indie Rock", ["urn:entity:artist"])] : [] } } };
    return standardQloo()(c);
  });
  try {
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [
      { name: "Succession (TV series)", kind: "tv_show" as const },
      { name: "Dune (2021 film)", kind: "movie" as const },
      { name: "Star Wars (The Empire Strikes Back)", kind: "movie" as const },
      { name: "Moonsprout (indie rock band)", kind: "artist" as const },
    ]);
    const got = Object.fromEntries(r.resolved.map((x) => [x.input, `${x.as} ${x.match}`]));
    assert.deepEqual(got, {
      "Succession (TV series)": "Succession (2018,2023) closest",
      "Dune (2021 film)": "Dune (2021) closest",
      "Star Wars (The Empire Strikes Back)": "Star Wars: Episode V - The Empire Strikes Back (1980) closest", // the whole text's search found it
    });
    assert.deepEqual(r.unresolved, ["Moonsprout (indie rock band)"], "the note isn't a genre");
  } finally {
    m.restore();
  }
});

test("a noted name is searched a second time only while the request has calls to spare", async () => {
  const asked: string[] = [];
  const m = mockFetch((c) => {
    if (qloo(c) && c.path === "/search") {
      asked.push(c.params.get("query") ?? "");
      return { body: { results: c.params.get("query") === "Succession" ? [{ entity_id: UUID(12), name: "Succession", types: ["urn:entity:tv_show"] }] : [] } };
    }
    if (qloo(c) && c.path === "/v2/tags") return { body: { results: { tags: [] } } };
    return standardQloo()(c);
  });
  try {
    const run = async (left: number) => {
      asked.length = 0;
      const budget = new Budget(48);
      budget.used = 48 - left;
      return matchNeighborhoods(ENV(memoryKV().kv), budget, "Austin, Texas", [{ name: "Succession (TV series)", kind: "tv_show" as const }, { name: "jazz", kind: "tag" as const }]).catch((e) => e);
    };
    const fresh = await run(48);
    assert.equal(fresh.resolved?.[0]?.as, "Succession");
    assert.deepEqual(asked.slice(0, 2), ["Succession (TV series)", "Succession"]);
    await run(22);
    assert.deepEqual(asked.filter((a) => a.startsWith("Succession")), ["Succession (TV series)"], "nearly spent: no second search");
  } finally {
    m.restore();
  }
});
