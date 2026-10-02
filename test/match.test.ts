// The pipeline against a mock Qloo shaped like the live API. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchNeighborhoods, planDay, rankAreas, resembles } from "../src/match.ts";
import { signalParams } from "../src/qloo.ts";
import { cityCenter } from "../src/geo.ts";
import { AppError, Budget } from "../src/limits.ts";
import { AUSTIN, ENV, heatmap, memoryKV, mockFetch, place, places, tag, type Call } from "./mock.ts";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const qloo = (c: Call) => c.host === "qloo.test";
const isHeat = (c: Call) => qloo(c) && c.params.get("filter.type") === "urn:heatmap";
const isPlaces = (c: Call) => qloo(c) && c.params.get("filter.type") === "urn:entity:place";
const PLACE = "urn:entity:place";

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

test("a picked Qloo ID is used as is: a cuisine filters places, an entity goes on the map", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [
      { name: "Dune", kind: "movie", id: UUID(2), as: "Dune (1984)" },
      { name: "ramen", kind: "tag", id: "urn:tag:cuisine:qloo:japanese_ramen", as: "Japanese Ramen" },
    ]);
    assert.equal(m.calls.filter((c) => c.path === "/search" || c.path === "/v2/tags").length, 0);
    assert.equal(m.calls.find(isHeat)!.params.get("signal.interests.entities"), UUID(2));
    assert.equal(m.calls.find((c) => isPlaces(c) && c.params.get("filter.tags"))!.params.get("filter.tags"), "urn:tag:cuisine:qloo:japanese_ramen");
    assert.ok(r.resolved.every((x) => x.match === "chosen"));
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
    assert.deepEqual(listed.sort(), ["Bank & Bourbon", "Cafe One", "Gallery Two", "Temple Bar", "The Garage"]);
    assert.ok(r.trace.some((t) => t.step === "Filter" && /Left out 3 places/.test(t.detail)));
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
