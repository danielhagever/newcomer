// Probe the Qloo hackathon API and print response SHAPES (never the key), so the client code in
// src/qloo.ts can be checked against reality the moment a key arrives.
// Usage: QLOO_API_KEY=... node scripts/probe.mjs [city]
const KEY = process.env.QLOO_API_KEY;
const BASE = process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
if (!KEY) throw new Error("set QLOO_API_KEY");
const city = process.argv[2] ?? "Austin";

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const t = Date.now();
  const res = await fetch(url, { headers: { "X-Api-Key": KEY, accept: "application/json" } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: res.status, ms: Date.now() - t, body };
}

function shape(v, depth = 0) {
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `(${v.length} items)`] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 18).map(([k, x]) => [k, shape(x, depth + 1)]));
  return typeof v === "string" ? (v.length > 60 ? v.slice(0, 60) + "…" : v) : v;
}

const out = {};
const s1 = await get("/search", { query: "Phoebe Bridgers", types: "urn:entity:artist", take: "3" });
out.search_artist = { status: s1.status, shape: shape(s1.body) };
const artistId = s1.body?.results?.[0]?.entity_id;
const s2 = await get("/search", { query: "The Bear", types: "urn:entity:tv_show", take: "3" });
out.search_tv = { status: s2.status, first: s2.body?.results?.slice(0, 3).map((r) => [r.name, r.entity_id, r.types]) };
const tvId = s2.body?.results?.[0]?.entity_id;
const t1 = await get("/v2/tags", { "filter.query": "ramen", take: "5" });
out.tags_ramen = { status: t1.status, shape: shape(t1.body) };
const tagId = t1.body?.results?.tags?.[0]?.id ?? t1.body?.results?.[0]?.id;
const signals = { "signal.interests.entities": [artistId, tvId].filter(Boolean).join(","), ...(tagId ? { "signal.interests.tags": tagId } : {}) };
for (const boundary of [undefined, "neighborhood", "urn:entity:locality", "city"]) {
  const h = await get("/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": city, ...signals, take: "15", ...(boundary ? { "output.heatmap.boundary": boundary } : {}) });
  out[`heatmap_${boundary ?? "default"}`] = { status: h.status, ms: h.ms, shape: shape(h.body) };
}
const p = await get("/v2/insights", { "filter.type": "urn:entity:place", "filter.location.query": city, ...signals, take: "5" });
out.places = { status: p.status, shape: shape(p.body), names: p.body?.results?.entities?.map((e) => e.name) };
const l = await get("/search", { query: city, types: "urn:entity:locality", take: "5" });
out.search_locality = { status: l.status, first: l.body?.results?.slice(0, 5).map((r) => [r.name, r.entity_id, r.properties?.geocode ?? r.location]) };
console.log(JSON.stringify(out, null, 1));
