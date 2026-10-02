// The Worker's front door (validation, rate limits, caching, MCP) and the page's escaping. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { cleanInterests, fallbackInterests } from "../src/input.ts";
import { ENV, memoryKV, mockFetch, places, heatmap, tag, AUSTIN } from "./mock.ts";

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function env(kv = memoryKV().kv, aiReply: unknown = { response: '{"interests":[{"name":"ramen","kind":"tag"}]}' }) {
  return { ...ENV(kv), AI: { run: async () => aiReply } as unknown as Ai, ASSETS: { fetch: async () => new Response("page") } as unknown as Fetcher };
}
const post = (path: string, body: unknown) =>
  new Request(`https://newcomer.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const qlooOk = (c: { host: string; path: string; params: URLSearchParams }) => {
  if (c.host !== "qloo.test") return undefined;
  if (c.path === "/v2/tags") return { body: { results: { tags: [tag("urn:tag:genre:qloo:jazz", "Jazz", ["urn:entity:artist"]), tag("urn:tag:cuisine:qloo:ramen", "Ramen", ["urn:entity:place"])] } } };
  if (c.path === "/search") return { body: { results: [{ entity_id: "00000000-0000-4000-8000-000000000009", name: "Phoebe Bridgers", types: ["urn:entity:artist"] }] } };
  if (c.params.get("filter.type") === "urn:heatmap") return { body: heatmap(AUSTIN.latitude, AUSTIN.longitude) };
  return { body: { results: { entities: places("P") } } };
};

test("bad interests from a client get a 400 with a plain message, not a crash", async () => {
  const r = await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: [{ name: 5 }] }), env());
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /city and at least one thing/);
});

test("interests are cleaned: names trimmed and capped, unknown kinds and fake IDs dropped, at most 8", () => {
  const c = cleanInterests([
    { name: "  Phoebe   Bridgers ", kind: "artist" },
    { name: "x".repeat(200), kind: "spaceship" },
    { name: "Dune", id: "not-an-id" },
    { name: "Dune", id: "00000000-0000-4000-8000-000000000001", as: "Dune (2021)" },
    ...Array.from({ length: 10 }, (_, i) => ({ name: `n${i}` })),
  ]);
  assert.equal(c.length, 8);
  assert.deepEqual(c[0], { name: "Phoebe Bridgers", kind: "artist" });
  assert.equal(c[1].name.length, 60);
  assert.equal(c[1].kind, undefined);
  assert.equal(c[2].id, undefined);
  assert.equal(c[3].id, "00000000-0000-4000-8000-000000000001");
});

test("the fallback parser keeps 'Simon and Garfunkel' and 'rock and roll' whole", () => {
  assert.deepEqual(fallbackInterests("Simon and Garfunkel, rock and roll; ramen").map((i) => i.name), ["Simon and Garfunkel", "rock and roll", "ramen"]);
});

test("parse never returns the model's raw output (it used to, with ?debug=1, from a shared global)", async () => {
  const r = await worker.fetch(post("/api/parse?debug=1", { text: "ramen" }), env());
  assert.deepEqual(Object.keys(await r.json()), ["interests"]);
});

test("a search with text but no usable interests is parsed on the server", async () => {
  const m = mockFetch(qlooOk);
  try {
    const r = await worker.fetch(post("/api/match", { city: "Austin, Texas", text: "Phoebe Bridgers", interests: [] }), env(undefined, { response: '{"interests":[{"name":"Phoebe Bridgers","kind":"artist"}]}' }));
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.resolved[0].as, "Phoebe Bridgers");
  } finally {
    m.restore();
  }
});

test("a result is cached for a day; a degraded one is not", async () => {
  const m = mockFetch(qlooOk);
  try {
    const { kv, store } = memoryKV();
    await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: [{ name: "Phoebe Bridgers", kind: "artist" }] }), env(kv));
    assert.equal([...store.keys()].filter((k) => k.startsWith("match4:")).length, 1);
  } finally {
    m.restore();
  }
  const broken = mockFetch((c) => (c.host === "qloo.test" && c.params.get("filter.type") === "urn:entity:place" ? { status: 500, body: {} } : qlooOk(c)));
  try {
    const { kv, store } = memoryKV();
    const r = await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: [{ name: "Phoebe Bridgers", kind: "artist" }] }), env(kv));
    assert.equal(r.status, 200);
    assert.equal([...store.keys()].filter((k) => k.startsWith("match4:")).length, 0);
  } finally {
    broken.restore();
  }
});

test("an unexpected error is a plain 500 message, not internals", async () => {
  // A heatmap that isn't a list makes the code throw a TypeError deep inside.
  const m = mockFetch((c) => (c.host === "qloo.test" && c.params.get("filter.type") === "urn:heatmap" ? { body: { results: { heatmap: { weird: true } } } } : qlooOk(c)));
  try {
    const r = await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: [{ name: "Phoebe Bridgers", kind: "artist" }] }), env());
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, "Something went wrong on our side. Please try again.");
  } finally {
    m.restore();
  }
});

test("MCP: a closest match tells the agent the alternatives and their IDs", async () => {
  const m = mockFetch((c) => {
    if (c.host === "qloo.test" && c.path === "/search")
      return { body: { results: [{ entity_id: "00000000-0000-4000-8000-000000000002", name: "Dune Messiah", types: ["urn:entity:book"] }, { entity_id: "00000000-0000-4000-8000-000000000003", name: "Dune: Part Two", types: ["urn:entity:movie"] }] } };
    return qlooOk(c);
  });
  try {
    const call = new Request("https://newcomer.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_neighborhoods", arguments: { city: "Austin, Texas", interests: [{ name: "Dune", kind: "book" }] } } }),
    });
    const text = await (await worker.fetch(call, env())).text();
    const data = JSON.parse(text.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
    const said = data.result.content[0].text as string;
    assert.match(said, /closest Qloo match/);
    assert.match(said, /Dune: Part Two \[id 00000000-0000-4000-8000-000000000003\]/);
  } finally {
    m.restore();
  }
});

test("the page escapes every map tooltip (Leaflet renders tooltip strings as HTML)", () => {
  const tooltips = [...page.matchAll(/bindTooltip\(([^)]*\)?)/g)].map((m) => m[1]);
  assert.ok(tooltips.length >= 2);
  for (const t of tooltips) assert.match(t, /^esc\(|^`[^`]*\$\{esc\(/, t);
});

test("the page loads Leaflet with integrity hashes and has an icon", () => {
  for (const tag of page.match(/<(script|link)[^>]+leaflet[^>]+>/g) ?? []) assert.match(tag, /integrity="sha512-/, tag);
  assert.match(page, /<link rel="icon"/);
});

test("the one-line summary names places worth going to, not a tattoo shop", async () => {
  const { summary } = await import("../src/index.ts");
  const hood = (evidence: any[]) => ({ name: "Williamsburg", lat: 0, lon: 0, affinity: 0.9, cells: 10, matches: [], evidence });
  const r: any = { city: "Brooklyn, New York", neighborhoods: [hood([{ id: "1", name: "Fleur Noire Tattoo", types: [], tags: ["Tattoo shop"] }, { id: "2", name: "Wythe Hotel", types: [], tags: ["Hotel", "Cocktail bar"] }, { id: "3", name: "Molasses Books", types: [], tags: ["Book store"] }])] };
  assert.equal(summary(r), "In Brooklyn, New York, Williamsburg fits your taste best: think Wythe Hotel and Molasses Books.");
});
