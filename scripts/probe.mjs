// Check the live Qloo hackathon API against the shapes src/qloo.ts expects, with exactly the
// queries the app sends. Prints shapes and counts, never the key.
// Usage: QLOO_API_KEY=... node scripts/probe.mjs ["Austin, Texas"]
const KEY = process.env.QLOO_API_KEY;
const BASE = process.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
if (!KEY) throw new Error("set QLOO_API_KEY");
const city = process.argv[2] ?? "Austin, Texas";

async function get(path, params) {
  const t = Date.now();
  const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, { headers: { "X-Api-Key": KEY, accept: "application/json" } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: res.status, ms: Date.now() - t, bytes: text.length, body };
}
const shape = (v, d = 0) => (d > 3 ? "…" : Array.isArray(v) ? (v.length ? [shape(v[0], d + 1), `(${v.length})`] : []) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).slice(0, 14).map(([k, x]) => [k, shape(x, d + 1)])) : typeof v === "string" ? v.slice(0, 50) : v);

const out = {};
const artist = await get("/search", { query: "Phoebe Bridgers", types: "urn:entity:artist", take: "5" });
out.search = { status: artist.status, ms: artist.ms, first: shape(artist.body?.results?.[0]) };
const ramen = await get("/v2/tags", { "filter.query": "ramen", "feature.semantic_search": "true", take: "20" });
out.tags = { status: ramen.status, ms: ramen.ms, top: (ramen.body?.results?.tags ?? []).slice(0, 5).map((t) => [t.name, t.id, (t.parents ?? []).map((p) => p.type ?? p).join("|")]) };
const ent = artist.body?.results?.[0]?.entity_id;
const placeTag = (ramen.body?.results?.tags ?? []).find((t) => (t.parents ?? []).some((p) => (p.type ?? p) === "urn:entity:place"))?.id;
const heat = await get("/v2/insights", { "filter.type": "urn:heatmap", "filter.location.query": city, "signal.interests.entities": ent });
const cells = heat.body?.results?.heatmap ?? [];
out.heatmap = { status: heat.status, ms: heat.ms, bytes: heat.bytes, cells: cells.length, geohashLength: cells[0]?.location?.geohash?.length, first: shape(cells[0]), locality: heat.body?.query?.localities?.filter?.[0]?.disambiguation };
const hot = cells[0]?.location;
if (hot) {
  const near = await get("/v2/insights", { "filter.type": "urn:entity:place", "filter.location": `POINT(${hot.longitude} ${hot.latitude})`, "filter.location.radius": "1200", "signal.interests.entities": ent, take: "8" });
  out.places_near = { status: near.status, ms: near.ms, places: (near.body?.results?.entities ?? []).map((e) => [e.name, e.properties?.neighborhood ?? null, (e.tags ?? []).filter((t) => t.type === "urn:tag:time_of_day_fit:qloo").map((t) => t.name).join("/")]) };
}
if (placeTag) {
  const mine = await get("/v2/insights", { "filter.type": "urn:entity:place", "filter.location.query": city, "filter.tags": placeTag, "operator.filter.tags": "union", "signal.interests.entities": ent, take: "50" });
  out.your_places = { status: mine.status, ms: mine.ms, count: mine.body?.results?.entities?.length, first: (mine.body?.results?.entities ?? []).slice(0, 5).map((e) => e.name) };
}
console.log(JSON.stringify(out, null, 1));
