// The Worker's front door (validation, rate limits, caching, MCP) and the page's escaping. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { summary } from "../src/index.ts";
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
    assert.equal([...store.keys()].filter((k) => /^match\d+:/.test(k)).length, 1);
  } finally {
    m.restore();
  }
  const broken = mockFetch((c) => (c.host === "qloo.test" && c.params.get("filter.type") === "urn:entity:place" ? { status: 500, body: {} } : qlooOk(c)));
  try {
    const { kv, store } = memoryKV();
    const r = await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: [{ name: "Phoebe Bridgers", kind: "artist" }] }), env(kv));
    assert.equal(r.status, 200);
    assert.equal([...store.keys()].filter((k) => /^match\d+:/.test(k)).length, 0);
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
    assert.match(said, /was matched to Dune Messiah \[id 00000000-0000-4000-8000-000000000002\]/, "the pick's own Qloo id is given, so the agent can send it back");
    assert.match(said, /Dune: Part Two \(\w[\w ]*\) \[id 00000000-0000-4000-8000-000000000003\]|Dune: Part Two \[id 00000000-0000-4000-8000-000000000003\]/);
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

test("Qloo's own 400 message reaches the person", async () => {
  const m = mockFetch((c) => (c.host === "qloo.test" && c.params.get("filter.type") === "urn:heatmap" ? { status: 400, body: { errors: [{ message: "take must be an integer value between 1 and 50", path: "take" }] } } : qlooOk(c)));
  try {
    const r = await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: [{ name: "Phoebe Bridgers", kind: "artist" }] }), env());
    assert.match((await r.json()).error, /take must be an integer value between 1 and 50/);
  } finally {
    m.restore();
  }
});

test("past 8 interests, the extras are named as left out; a repeat search says it is a saved result", async () => {
  const m = mockFetch(qlooOk);
  try {
    const { kv } = memoryKV();
    const names = Array.from({ length: 10 }, (_, i) => ({ name: `Phoebe Bridgers ${i}`, kind: "artist" }));
    const first = await (await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: names }), env(kv))).json();
    assert.equal(first.interests.length, 8);
    assert.deepEqual(first.leftOut, ["Phoebe Bridgers 8", "Phoebe Bridgers 9"]);
    assert.equal(first.cached, undefined);
    const again = await (await worker.fetch(post("/api/match", { city: "Austin, Texas", interests: names }), env(kv))).json();
    assert.equal(again.cached, true);
    assert.equal(again.computedAt, first.computedAt);
  } finally {
    m.restore();
  }
});

test("the page labels a saved result, marks interests past 8, and asks for no personal details", () => {
  assert.match(page, /d\.cached \?/);
  assert.match(page, /not used \(up to 8\)/);
  assert.match(page, /No personal details/);
});

test("a name written in another language keeps its English lookup name (en), and an English one doesn't repeat it", () => {
  const c = cleanInterests([{ name: "פאודה", en: "Fauda", kind: "tv_show" }, { name: "ramen", en: "Ramen", kind: "tag" }]);
  assert.deepEqual(c[0], { name: "פאודה", query: "Fauda", kind: "tv_show" });
  assert.deepEqual(c[1], { name: "ramen", kind: "tag" });
});

test("an English name that only drops accents is not used: Qloo keeps the accents", () => {
  const c = cleanInterests([
    { name: "Björk", en: "Bjork", kind: "artist" },
    { name: "Sigur Rós", en: "sigur ros" },
    { name: "senderismo", en: "hiking", kind: "tag" },
  ]);
  assert.deepEqual(c[0], { name: "Björk", kind: "artist" });
  assert.deepEqual(c[1], { name: "Sigur Rós" });
  assert.deepEqual(c[2], { name: "senderismo", query: "hiking", kind: "tag" });
});

test("the MCP tool tells agents to pass English names with accents kept", async () => {
  const list = new Request("https://newcomer.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await (await worker.fetch(list, env())).text();
  assert.match(text, /English name as Qloo knows it/);
});

test("the page re-sends not-found items with their English name and kind, and labels the bar by mode", () => {
  assert.match(page, /d\.unresolved\.map\(\(name\) => \(d\.interests \|\| \[\]\)\.find\(\(x\) => x\.name === name\) \|\| \{ name \}\)/);
  assert.match(page, /\(d\.leftOut \|\| \[\]\)\.map\(\(name\) => asked\.find/);
  assert.match(page, /d\.mode === "map" \? "Ranking score/);
});

test("the one-line answer agrees in number: one runner-up comes next, two come next", () => {
  const hood = (name: string) => ({ name, lat: 0, lon: 0, affinity: 0.8, score: 0.8, cells: 6, evidence: [], matches: [] });
  const r = (n: number) => ({ city: "Austin, Texas", neighborhoods: ["Downtown", "Zilker", "Clarksville"].slice(0, n).map(hood) }) as any;
  assert.match(summary(r(2)), /Zilker comes next\.$/);
  assert.match(summary(r(3)), /Zilker and Clarksville come next\.$/);
  assert.doesNotMatch(summary(r(1)), /next/);
});

test("a failed search says Stopped, not Done", () => {
  assert.match(page, /failed \? "Stopped"/);
  assert.match(page, /if \(d\.error\) \{ progress\(1, true\)/);
});

test("only new searches count against the hourly limit; a saved answer is free", async () => {
  const store = new Map<string, string>();
  const fake = { match: async (k: Request) => (store.has(k.url) ? new Response(store.get(k.url)) : undefined), put: async (k: Request, v: Response) => void store.set(k.url, await v.text()) };
  (globalThis as any).caches = { default: fake };
  const m = mockFetch(qlooOk);
  try {
    const kv = memoryKV();
    const body = (i: number) => ({ city: "Austin, Texas", interests: [{ name: "Phoebe Bridgers", kind: "artist" }, { name: `n${i}`, kind: "tag" }] });
    for (let i = 0; i < 25; i++) assert.equal((await worker.fetch(post("/api/match", body(1)), env(kv.kv))).status, 200);
    assert.deepEqual([...store.values()], ["1"], "25 identical searches, one counted");
    for (let i = 2; i <= 20; i++) await worker.fetch(post("/api/match", body(i)), env(kv.kv));
    const over = await worker.fetch(post("/api/match", body(21)), env(kv.kv));
    assert.equal(over.status, 429);
    assert.match(((await over.json()) as any).error, /saved answers still work/);
    assert.equal((await worker.fetch(post("/api/match", body(1)), env(kv.kv))).status, 200, "a saved answer still works past the limit");
  } finally {
    m.restore();
    delete (globalThis as any).caches;
  }
});

test("MCP: one tool call per request, blank input refused before any count or lookup", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const call = (id: number, args: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "find_neighborhoods", arguments: args } });
  const m = mockFetch(qlooOk);
  try {
    const batch = await worker.fetch(new Request("https://newcomer.test/mcp", { method: "POST", headers, body: JSON.stringify([call(1, { city: "Austin, Texas", interests: [{ name: "jazz" }] }), call(2, { city: "Chicago, Illinois", interests: [{ name: "jazz" }] })]) }), env());
    assert.equal(batch.status, 400);
    assert.match(await batch.text(), /one tool call per request/);
    const counted = new Map<string, string>();
    (globalThis as any).caches = { default: { match: async (k: Request) => (counted.has(k.url) ? new Response(counted.get(k.url)) : undefined), put: async (k: Request, v: Response) => void counted.set(k.url, await v.text()) } };
    const blank = await (await worker.fetch(new Request("https://newcomer.test/mcp", { method: "POST", headers, body: JSON.stringify(call(3, { city: "   ", interests: [{ name: "jazz" }] })) }), env())).text();
    assert.equal(JSON.parse(blank.split("\n").find((l) => l.startsWith("data: "))!.slice(6)).result.isError, true);
    assert.equal(counted.size, 0, "a blank city is not counted against the hourly limit");
    assert.equal(m.calls.length, 0, "and nothing is looked up");
  } finally {
    m.restore();
    delete (globalThis as any).caches;
  }
});

test("MCP: a body over 256 KB is refused before it is read in full; a normal call still works", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const mcp = (body: BodyInit, more: Record<string, string> = {}) =>
    worker.fetch(new Request("https://newcomer.test/mcp", { method: "POST", headers: { ...headers, ...more }, body, duplex: "half" } as RequestInit), env());
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(300_000) } });
  assert.equal((await mcp(big)).status, 413);
  // Streamed, with no length given.
  assert.equal((await mcp(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(big)), c.close()) }))).status, 413);
  // A stated length over the cap is refused without reading at all (this body would fail if it were read).
  assert.equal((await mcp(new ReadableStream({ pull: () => { throw new Error("read"); } }), { "content-length": "50000000" })).status, 413);
  const list = await mcp(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  assert.equal(list.status, 200);
  assert.match(await list.text(), /"tools"/);
});
