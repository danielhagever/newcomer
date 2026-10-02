// Probe the Qloo hackathon API and print response SHAPES (never the key), so the client in
// src/qloo.ts can be checked against reality the moment a key arrives. It sends exactly the
// queries the app sends, and answers the open questions in submissions/newcomer-REVIEW.md (K1-K4):
// real shapes, the spelling of the neighborhood boundary, union vs intersection for tags, and
// whether `take` returns the top cells by affinity.
// Usage: QLOO_API_KEY=... node scripts/probe.mjs ["Austin, Texas"]
const KEY = process.env.QLOO_API_KEY;
const BASE = process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
if (!KEY) throw new Error("set QLOO_API_KEY");
const city = process.argv[2] ?? "Austin, Texas";
let calls = 0;

async function get(path, params) {
  calls++;
  const t = Date.now();
  const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "X-Api-Key": KEY, accept: "application/json" } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: res.status, ms: Date.now() - t, body };
}

function shape(v, depth = 0) {
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(${v.length} items)`] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 20).map(([k, x]) => [k, shape(x, depth + 1)]));
  return typeof v === "string" ? (v.length > 60 ? v.slice(0, 60) + "…" : v) : v;
}
const heat = (r) => r.body?.results?.heatmap ?? [];
const aff = (p) => p?.query?.affinity ?? p?.affinity;

const out = {};
// K1: name resolution, as the app does it (entities take 5; tags semantic search take 20).
const s1 = await get("/search", { query: "Phoebe Bridgers", types: "urn:entity:artist", take: "5" });
out.search_artist = { status: s1.status, shape: shape(s1.body) };
const s2 = await get("/search", { query: "The Bear", types: "urn:entity:tv_show", take: "5" });
out.search_tv = { status: s2.status, top5: (s2.body?.results ?? []).slice(0, 5).map((r) => [r.name, r.entity_id, r.types ?? r.type]) };
const s3 = await get("/search", { query: "Dune", types: "urn:entity:movie", take: "5" });
out.search_dune = { status: s3.status, top5: (s3.body?.results ?? []).slice(0, 5).map((r) => r.name) };
const t1 = await get("/v2/tags", { "filter.query": "ramen", "feature.semantic_search": "true", take: "20" });
out.tags_ramen = { status: t1.status, shape: shape(t1.body), names: (t1.body?.results?.tags ?? []).slice(0, 8).map((t) => t.name) };
const t2 = await get("/v2/tags", { "filter.query": "natural wine", "feature.semantic_search": "true", take: "20" });
out.tags_wine = { status: t2.status, names: (t2.body?.results?.tags ?? []).slice(0, 8).map((t) => t.name) };

const ent = [s1.body?.results?.[0]?.entity_id, s2.body?.results?.[0]?.entity_id].filter(Boolean).join(",");
const tagIds = [t1.body?.results?.tags?.[0]?.id, t2.body?.results?.tags?.[0]?.id].filter(Boolean);
const signals = { ...(ent ? { "signal.interests.entities": ent } : {}), ...(tagIds.length ? { "signal.interests.tags": tagIds.join(",") } : {}) };

// K2: which spelling of the neighborhood boundary does the API accept?
for (const boundary of [undefined, "neighborhood", "urn:neighborhood", "city", "urn:geohash"]) {
  const h = await get("/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": city, ...signals, "operator.signal.interests.tags": "union", take: "15", ...(boundary ? { "output.heatmap.boundary": boundary } : {}) });
  out[`heatmap_${boundary ?? "default"}`] = { status: h.status, ms: h.ms, points: heat(h).length, named: heat(h).filter((p) => p.name).length, first: shape(heat(h)[0]) };
}

// K3: union vs intersection of two tags.
for (const op of ["union", "intersection"]) {
  const h = await get("/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": city, ...signals, "operator.signal.interests.tags": op, take: "15" });
  out[`operator_${op}`] = { status: h.status, points: heat(h).length, top3: heat(h).slice(0, 3).map((p) => [p.location?.geohash ?? p.geohash, aff(p)]) };
}

// K4: is take=15 the top 15 by affinity, or just the first 15?
const small = await get("/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": city, ...signals, "operator.signal.interests.tags": "union", take: "15" });
const big = await get("/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": city, ...signals, "operator.signal.interests.tags": "union", take: "200" });
const maxOf = (r) => Math.max(...heat(r).map(aff).filter((x) => typeof x === "number"));
out.take_sorting = { take15_max: maxOf(small), take200_max: maxOf(big), take15_sorted_desc: heat(small).every((p, i, a) => i === 0 || aff(a[i - 1]) >= aff(p)) };

// The app's exact place query: a point and a 1.2 km radius around the hottest cell.
const hot = [...heat(big)].sort((a, b) => aff(b) - aff(a))[0];
const lat = hot?.location?.latitude ?? hot?.latitude, lon = hot?.location?.longitude ?? hot?.longitude;
if (lat !== undefined) {
  const p = await get("/v2/insights", { "filter.type": "urn:entity:place", "filter.location": `POINT(${lon} ${lat})`, "filter.location.radius": "1200", ...signals, "operator.signal.interests.tags": "union", take: "5" });
  out.places_near_hot_cell = { status: p.status, shape: shape(p.body), names: p.body?.results?.entities?.map((e) => e.name) };
}
out.calls_made = calls;
console.log(JSON.stringify(out, null, 1));
