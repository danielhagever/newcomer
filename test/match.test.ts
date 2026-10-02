// The pipeline against a mock Qloo. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchNeighborhoods, slot } from "../src/match.ts";
import { signalParams } from "../src/qloo.ts";
import { cityCenter } from "../src/geo.ts";
import { AppError, Budget } from "../src/limits.ts";
import { AUSTIN, ENV, cells, memoryKV, mockFetch, places, type Call } from "./mock.ts";

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const qloo = (c: Call) => c.host === "qloo.test";

// A Qloo that knows a few things, answers heatmaps with named or unnamed cells, and has places.
function standardQloo(opts: { named?: boolean; heat?: (c: Call) => unknown } = {}) {
  return (c: Call) => {
    if (!qloo(c)) return undefined;
    if (c.path === "/search") {
      const q = c.params.get("query")!;
      if (q === "Dune") return { body: { results: [{ entity_id: UUID(2), name: "Dune Messiah", types: ["urn:entity:book"] }, { entity_id: UUID(1), name: "Dune", types: ["urn:entity:movie"] }] } };
      if (q === "Phoebe Bridgers") return { body: { results: [{ entity_id: UUID(3), name: "Phoebe Bridgers", types: ["urn:entity:artist"] }] } };
      if (q === "Phoebe") return { body: { results: [{ entity_id: UUID(3), name: "Phoebe Bridgers", types: ["urn:entity:artist"] }, { entity_id: UUID(4), name: "Phoebe Snow", types: ["urn:entity:artist"] }] } };
      return { body: { results: [] } };
    }
    if (c.path === "/v2/tags") {
      const q = c.params.get("filter.query")!;
      if (q === "ramen") return { body: { results: { tags: [{ id: "urn:tag:genre:place:restaurant:ramen", name: "Ramen", type: "urn:tag:genre:place" }] } } };
      if (q === "natural wine") return { body: { results: { tags: [{ id: "urn:tag:wine:natural", name: "Natural Wine Bar", type: "urn:tag:genre:place" }, { id: "urn:tag:wine", name: "Wine", type: "urn:tag:genre:place" }] } } };
      return { body: { results: { tags: [] } } };
    }
    if (c.path === "/v2/insights" && c.params.get("filter.type") === "urn:heatmap")
      return { body: opts.heat?.(c) ?? { results: { heatmap: cells(AUSTIN.latitude, AUSTIN.longitude, 30, opts.named) } } };
    if (c.path === "/v2/insights" && c.params.get("filter.type") === "urn:entity:place") return { body: { results: { entities: places("P") } } };
    return undefined;
  };
}

test("an exact Qloo name wins; otherwise the top hit is marked 'closest' with alternatives", async () => {
  const m = mockFetch(standardQloo({ named: true }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Dune", kind: "movie" }, { name: "Phoebe", kind: "artist" }]);
    const dune = r.resolved.find((x) => x.input === "Dune")!;
    assert.equal(dune.as, "Dune");
    assert.equal(dune.match, "exact");
    const phoebe = r.resolved.find((x) => x.input === "Phoebe")!;
    assert.equal(phoebe.match, "closest");
    assert.deepEqual(phoebe.alternatives.map((a) => a.name), ["Phoebe Snow"]);
    assert.ok(r.ours.some((o) => o.includes("closest match")));
    // Entity search asks for 5 candidates, tags for 20 with semantic search, like the official harness.
    assert.ok(m.calls.filter((c) => c.path === "/search").every((c) => c.params.get("take") === "5"));
  } finally {
    m.restore();
  }
});

test("a Qloo ID the person picked is used as is, with no lookup", async () => {
  const m = mockFetch(standardQloo({ named: true }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "Phoebe", kind: "artist", id: UUID(4), as: "Phoebe Snow" }]);
    assert.equal(m.calls.filter((c) => c.path === "/search" || c.path === "/v2/tags").length, 0);
    assert.equal(r.resolved[0].as, "Phoebe Snow");
    assert.equal(r.resolved[0].match, "chosen");
    assert.equal(m.calls.find((c) => c.params.get("filter.type") === "urn:heatmap")!.params.get("signal.interests.entities"), UUID(4));
  } finally {
    m.restore();
  }
});

test("the same interest twice is looked up once and sent once", async () => {
  const m = mockFetch(standardQloo({ named: true }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }, { name: "Ramen", kind: "tag" }]);
    assert.equal(m.calls.filter((c) => c.path === "/v2/tags").length, 1);
    assert.equal(r.resolved.length, 1);
    assert.equal(m.calls.find((c) => c.params.get("filter.type") === "urn:heatmap")!.params.get("signal.interests.tags"), "urn:tag:genre:place:restaurant:ramen");
  } finally {
    m.restore();
  }
});

test("a refused key or a rate limit is reported as such, never as 'not found'", async () => {
  for (const [status, expect] of [[401, /refused this app's API key/], [429, /rate limit/]] as const) {
    const m = mockFetch((c) => (qloo(c) ? { status, body: {} } : undefined));
    try {
      const { kv } = memoryKV();
      await assert.rejects(matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]), (e: AppError) => expect.test(e.message));
    } finally {
      m.restore();
    }
  }
});

test("something Qloo doesn't know is listed as not found, and the rest still runs", async () => {
  const m = mockFetch(standardQloo({ named: true }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }, { name: "zzqx", kind: "tag" }]);
    assert.deepEqual(r.unresolved, ["zzqx"]);
    assert.ok(r.neighborhoods.length > 0);
  } finally {
    m.restore();
  }
});

test("Qloo is asked about the city Newcomer located; an answer far away is asked again around the city", async () => {
  let heatCalls = 0;
  const m = mockFetch(
    standardQloo({
      heat: () => ({ results: { heatmap: cells(heatCalls++ === 0 ? 45.5 : AUSTIN.latitude, heatCalls === 1 ? -122.6 : AUSTIN.longitude, 20, true) } }),
    }),
  );
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, TX", [{ name: "ramen", kind: "tag" }]);
    const heat = m.calls.filter((c) => c.params.get("filter.type") === "urn:heatmap");
    assert.equal(heat[0].params.get("filter.location.query"), "Austin, Texas");
    assert.equal(heat[1].params.get("filter.location"), `POINT(${AUSTIN.longitude} ${AUSTIN.latitude})`);
    assert.equal(heat[1].params.get("filter.location.radius"), "25000");
    assert.ok(r.trace.some((t) => t.step === "Check"));
  } finally {
    m.restore();
  }
});

test("several tags combine as union, set explicitly", () => {
  assert.equal(signalParams({ entities: [], tags: ["a", "b"] })["operator.signal.interests.tags"], "union");
  assert.equal(signalParams({ entities: ["x"], tags: ["a"] })["operator.signal.interests.tags"], undefined);
});

test("a cold search on unnamed map cells stays inside the free plan's 50 subrequests, and every call is counted", async () => {
  // 8 interests that each need two lookups, 80 unnamed cells, nothing cached.
  const m = mockFetch((c) => {
    if (qloo(c) && c.params.get("filter.type") === "urn:heatmap") {
      const spread = Array.from({ length: 80 }, (_, i) => ({
        location: { latitude: 30.2 + (i % 10) * 0.02, longitude: -97.8 + Math.floor(i / 10) * 0.02 },
        query: { affinity: 0.99 - i * 0.005 },
      }));
      return { body: { results: { heatmap: spread } } };
    }
    if (qloo(c) && c.path === "/search") return { body: { results: [] } };
    if (qloo(c) && c.path === "/v2/tags") return { body: { results: { tags: [{ id: `urn:tag:t:${c.params.get("filter.query")}`, name: c.params.get("filter.query") }] } } };
    if (qloo(c) && c.params.get("filter.type") === "urn:entity:place") return { body: { results: { entities: places("P") } } };
    return undefined;
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
    assert.ok(r.neighborhoods[0].evidence.length > 0, "the place calls still fit");
  } finally {
    m.restore();
  }
});

test("a failed cache write never fails a search", async () => {
  const m = mockFetch(standardQloo());
  try {
    const { kv } = memoryKV({ failPuts: true });
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.ok(r.neighborhoods.length > 0);
  } finally {
    m.restore();
  }
});

test("when a place call fails the result is flagged degraded (shown, not cached)", async () => {
  const m = mockFetch((c) => (qloo(c) && c.params.get("filter.type") === "urn:entity:place" ? { status: 500, body: {} } : standardQloo({ named: true })(c)));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]);
    assert.equal(r.degraded, true);
    assert.equal(r.weekend.length, 0, "no empty weekend days");
  } finally {
    m.restore();
  }
});

test("Qloo's neighborhoods are used as named; the weekend skips empty days", async () => {
  const m = mockFetch(standardQloo({ named: true }));
  try {
    const { kv } = memoryKV();
    const r = await matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }, { name: "natural wine", kind: "tag" }]);
    assert.equal(r.boundary, "neighborhood");
    assert.equal(r.neighborhoods[0].name, "Hood 0");
    assert.ok(r.neighborhoods[0].affinityRank !== undefined);
    assert.equal(m.calls.filter((c) => c.host === "photon.komoot.io").length, 0);
    assert.ok(r.weekend.every((d) => d.stops.length > 0));
  } finally {
    m.restore();
  }
});

test("time of day uses whole words: barbecue is lunch, a cocktail bar is evening", () => {
  assert.equal(slot({ name: "Franklin Barbecue", tags: ["Barbecue"] }), "Afternoon");
  assert.equal(slot({ name: "Joe's Barber Shop" }), "Afternoon");
  assert.equal(slot({ name: "Small Victory", tags: ["Cocktail Bar"] }), "Evening");
  assert.equal(slot({ name: "Epoch", tags: ["Coffee Shop"] }), "Morning");
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

test("if Qloo's answer is still far from the city after asking again, nothing is shown as that city", async () => {
  const m = mockFetch(standardQloo({ heat: () => ({ results: { heatmap: cells(45.5, -122.6, 20, true) } }) }));
  try {
    const { kv } = memoryKV();
    await assert.rejects(matchNeighborhoods(ENV(kv), new Budget(48), "Austin, Texas", [{ name: "ramen", kind: "tag" }]), /didn't line up with Austin, Texas/);
    const heat = m.calls.filter((c) => c.params.get("filter.type") === "urn:heatmap");
    assert.equal(heat[1].params.get("output.heatmap.boundary"), "neighborhood", "the retry keeps the neighborhood naming");
  } finally {
    m.restore();
  }
});
