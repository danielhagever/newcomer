// A local stand-in for the Qloo hackathon API, for trying the page without a key:
//   node test/mock-qloo-server.mjs            (port 8799)
//   .dev.vars: QLOO_API_KEY=mock  QLOO_BASE_URL=http://localhost:8799
// It answers in the live API's shapes (measured 2026-10-03): heatmap cells (geohash-7, affinity =
// percentile) plus the locality used; tags with the entity types they apply to; places with a
// neighborhood, categories and time-of-day tags. Every name it returns says "(mock)": it is not Qloo data.
import { createServer } from "node:http";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const send = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const HOODS = ["East Side (mock)", "South Side (mock)", "Old Town (mock)", "University (mock)", "Riverside (mock)", "Uptown (mock)"];
const letters = "bcdefghjkmnpqrstuvwxyz";
const hoodAt = (lat, lon) => HOODS[Math.abs(Math.round(lat * 50) + Math.round(lon * 50)) % HOODS.length];

function heatmap(lat, lon) {
  // 6 x 6 squares of 8 cells, hotter towards the north-east.
  const cells = [];
  for (let gy = 0; gy < 6; gy++)
    for (let gx = 0; gx < 6; gx++)
      for (let i = 0; i < 8; i++)
        cells.push({ lat: lat - 0.03 + gy * 0.011 + (i % 4) * 0.002, lon: lon - 0.03 + gx * 0.011 + Math.floor(i / 4) * 0.002, heat: gy + gx + i * 0.05 });
  cells.sort((a, b) => b.heat - a.heat);
  return cells.map((c, i) => ({
    location: { latitude: c.lat, longitude: c.lon, geohash: `9v6s${letters[i % 22]}${letters[(i >> 2) % 22]}${letters[(i >> 4) % 22]}` },
    query: { affinity: 1 - i / (cells.length - 1), affinity_rank: 1 - i / cells.length, popularity: 0.5 },
  }));
}

function place(id, name, lat, lon, categories, times) {
  return {
    entity_id: uuid(id), name, location: { lat, lon, geohash: "9v6s0bb" },
    properties: { address: `${id} Example St (mock)`, neighborhood: hoodAt(lat, lon) },
    tags: [...categories.map((n) => ({ name: n, type: "urn:tag:category:place" })), ...times.map((n) => ({ name: n, type: "urn:tag:time_of_day_fit:qloo" }))],
  };
}

createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.searchParams;
  if (!req.headers["x-api-key"]) return send(res, { errors: [{ message: "missing key" }] }, 401);
  if (Number(p.get("take") ?? 0) > 50) return send(res, { errors: [{ message: "take must be an integer value between 1 and 50", path: "take" }] }, 400);
  if (u.pathname === "/search") {
    const q = p.get("query") ?? "";
    if (/^dune$/i.test(q)) return send(res, { results: [{ entity_id: uuid(11), name: "Dune", disambiguation: "2021, mock", types: ["urn:entity:movie"] }, { entity_id: uuid(12), name: "Dune", disambiguation: "1984, mock", types: ["urn:entity:movie"] }] });
    if (/^zzz/i.test(q)) return send(res, { results: [] }); // "zzz..." stands for a name Qloo doesn't know
    return send(res, { results: [{ entity_id: uuid(q.length + 100), name: q, disambiguation: "mock", types: [p.get("types") ?? "urn:entity:artist"] }] });
  }
  if (u.pathname === "/v2/tags") {
    const q = (p.get("filter.query") ?? "").toLowerCase();
    if (/^zzz/.test(q)) return send(res, { results: { tags: [] } });
    const slug = q.replace(/\W+/g, "_");
    const name = q.replace(/^\w/, (c) => c.toUpperCase());
    const music = /jazz|techno|punk|hip hop|indie/.test(q);
    return send(res, { results: { tags: [
      ...(music ? [{ id: `urn:tag:genre:qloo:${slug}`, name, type: "urn:tag:genre:qloo", parents: [{ type: "urn:entity:artist" }] }] : []),
      { id: `urn:tag:${music ? "interests" : "cuisine"}:qloo:${slug}`, name, type: "urn:tag:cuisine:qloo", parents: [{ type: "urn:entity:place" }] },
    ] } });
  }
  if (u.pathname === "/v2/insights" && p.get("filter.type") === "urn:heatmap") {
    if (!p.get("signal.interests.entities") && !(p.get("signal.interests.tags") ?? "").includes("genre")) return send(res, { success: true, results: { heatmap: [] } });
    const [lat, lon] = [30.27, -97.74];
    return send(res, { success: true, results: { heatmap: heatmap(lat, lon) }, query: { localities: { filter: [{ name: "Mock City", disambiguation: `${p.get("filter.location.query") ?? "Mock City"} (mock)`, location: { lat, lon } }] } } });
  }
  if (u.pathname === "/v2/insights" && p.get("filter.type") === "urn:entity:place") {
    const at = (p.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
    const lat = at ? +at[2] : 30.27, lon = at ? +at[1] : -97.74;
    if (p.get("filter.tags")) {
      return send(res, { results: { entities: [0, 1, 2, 3, 4, 5].map((i) => place(200 + i, `Your Kind of Place ${i + 1} (mock)`, lat - 0.02 + i * 0.008, lon - 0.02 + i * 0.008, ["Restaurant"], ["Evening", "Midday"])) } });
    }
    const kinds = [["Coffee (mock)", "Coffee shop", ["Morning"]], ["Gallery (mock)", "Art gallery", ["Afternoon"]], ["Record Store (mock)", "Record store", ["Midday", "Afternoon"]], ["Music Venue (mock)", "Live music venue", ["Evening"]]];
    return send(res, { results: { entities: kinds.map(([n, c, t], i) => place(100 + i + Math.round(lat * 1000) % 50, `${n} ${100 + i + Math.round(lat * 1000) % 50}`, lat + (i - 1.5) * 0.002, lon + (i % 2 ? 0.002 : -0.002), [c], t)) } });
  }
  send(res, { errors: [{ message: "not mocked" }] }, 404);
}).listen(8799, () => console.log("mock Qloo on http://localhost:8799"));
