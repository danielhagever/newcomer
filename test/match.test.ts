// The pipeline against a mock Qloo shaped like the live API. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchNeighborhoods, planDay, rankAreas, resembles } from "../src/match.ts";
import { Qloo, signalParams } from "../src/qloo.ts";
import { cityCenter, km } from "../src/geo.ts";
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

test("the heatmap waits 40 s for Qloo, its retry after a 429 too, every other Qloo call 12 s (live heatmaps took over 12 s and 20.9 s)", async () => {
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
    assert.deepEqual(asked.filter(([what]) => what === "urn:heatmap").map(([, ms]) => ms), [40000, 40000]);
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

test("a search's Qloo calls share 45 s: each waits at most what is left, and none starts with under a second left", async () => {
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

test("the 45 s are counted from the start of the search: 43 s in a call still starts, 44.5 s in none does", async () => {
  const m = mockFetch(standardQloo());
  const now = Date.now;
  let shift = 0;
  Date.now = () => now() + shift;
  try {
    for (const [at, starts] of [[43000, true], [44500, false]] as const) {
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
  const run = async (inside: string | null, around: string | null, osm: string, locality?: string, insideIs = "Cafe") => {
    const m = mockFetch((c) => {
      if (c.host === "photon.komoot.io") return { body: { features: [{ properties: { district: osm, ...(locality ? { locality } : {}) } }] } };
      if (isPlaces(c) && !c.params.get("filter.tags")) {
        const at = (c.params.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
        const lat = at ? +at[2] : AUSTIN.latitude, lon = at ? +at[1] : AUSTIN.longitude;
        return { body: { results: { entities: [
          place(`in-${lat}`, "Inside", inside, lat, lon, [insideIs], ["Morning"]),
          ...[1, 2, 3].map((i) => place(`out-${lat}-${i}`, `Across ${i}`, around, lat + 0.02, lon, ["Cocktail bar"], ["Evening"])),
        ] } } };
      }
      return standardQloo()(c);
    });
    try {
      const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
      return r.neighborhoods[0]?.name;
    } finally {
      m.restore();
    }
  };
  assert.equal(await run("East Austin", "Georgetown", "Rosslyn"), "East Austin"); // one place inside beats three across
  assert.equal(await run(null, "Georgetown", "Rosslyn"), "Rosslyn");
  assert.equal(await run("Ward 2", "Georgetown", "Rosslyn"), "Rosslyn"); // a ward number says nothing
  assert.equal(await run(null, "Williamsburg", "Austin"), "Williamsburg"); // nor OpenStreetMap naming the city
  assert.equal(await run(null, "Williamsburg", "Austin", "Dumbo"), "Dumbo"); // then its finer name (New York's district is the borough)
  assert.equal(await run("Whitehall", "Georgetown", "Rosslyn", undefined, "Ferry terminal"), "Rosslyn"); // a place no one visits names nothing
  assert.equal(await run(null, "Georgetown", "Clarendon", "Lyon Village"), "Clarendon"); // the district before the finer locality (Arlington, live)
});

test("OpenStreetMap names cached in the old one-name form are not read (they are kept under a new key)", async () => {
  const m = mockFetch(standardQloo({ hood: () => null }));
  try {
    const { kv, store } = memoryKV();
    const old: Record<string, string> = {};
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) old[`${(30.12 + i / 100).toFixed(2)},${(-97.89 + j / 100).toFixed(2)}`] = "Old Name";
    store.set("names:austin, texas", JSON.stringify(old));
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe Bridgers", kind: "artist" }]);
    assert.ok(r.neighborhoods.length && r.neighborhoods.every((h) => h.name.startsWith("OSM District")), JSON.stringify(r.neighborhoods.map((h) => h.name)));
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
    assert.ok(r.trace.some((t) => t.step === "Filter" && /Left out 5 places/.test(t.detail)));
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
    const r = await matchNeighborhoods(ENV(memoryKV().kv), new Budget(48), "Austin, Texas", [{ name: "פאודה", query: "Fauda", kind: "tv_show", id: UUID(3), as: "Fauda (2015)" }]);
    assert.equal(r.resolved[0].match, "chosen");
    assert.equal(r.resolved[0].query, "Fauda");
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
