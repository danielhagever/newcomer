// A local stand-in for the Qloo hackathon API, for trying the page without a key:
//   node test/mock-qloo-server.mjs            (port 8799)
//   .dev.vars: QLOO_API_KEY=mock  QLOO_BASE_URL=http://localhost:8799
// Every name it returns says "(mock)": it is not Qloo data.
import { createServer } from "node:http";

const HOODS = [["East Austin (mock)", 30.262, -97.722], ["South Congress (mock)", 30.248, -97.75], ["Hyde Park (mock)", 30.305, -97.73], ["Mueller (mock)", 30.298, -97.705], ["Zilker (mock)", 30.264, -97.772], ["North Loop (mock)", 30.318, -97.72]];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const send = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.searchParams;
  if (!req.headers["x-api-key"]) return send(res, { error: { message: "missing key" } }, 401);
  if (u.pathname === "/search") {
    const q = p.get("query") ?? "";
    if (/^dune/i.test(q)) return send(res, { results: [{ entity_id: uuid(11), name: "Dune (mock book)", types: ["urn:entity:book"] }, { entity_id: uuid(12), name: "Dune: Part Two (mock film)", types: ["urn:entity:movie"] }] });
    if (/zzz/i.test(q)) return send(res, { results: [] });
    return send(res, { results: [{ entity_id: uuid(q.length), name: q, types: [p.get("types") ?? "urn:entity:artist"] }] });
  }
  if (u.pathname === "/v2/tags") {
    const q = p.get("filter.query") ?? "";
    if (/zzz/i.test(q)) return send(res, { results: { tags: [] } });
    return send(res, { results: { tags: [{ id: `urn:tag:mock:${q.replace(/\W+/g, "_")}`, name: q.replace(/^\w/, (c) => c.toUpperCase()), type: "urn:tag:genre:place" }] } });
  }
  if (u.pathname === "/v2/insights" && p.get("filter.type") === "urn:heatmap") {
    const named = p.get("output.heatmap.boundary") === "neighborhood";
    const heat = HOODS.map(([name, lat, lon], i) => ({ ...(named ? { name } : {}), location: { latitude: lat, longitude: lon, geohash: `9v6k${i}` }, query: { affinity: 0.92 - i * 0.07, affinity_rank: 1 - i / HOODS.length, popularity: 0.6 } }));
    return send(res, { results: { heatmap: heat } });
  }
  if (u.pathname === "/v2/insights" && p.get("filter.type") === "urn:entity:place") {
    const [, lon, lat] = (p.get("filter.location") ?? "").match(/POINT\(([-\d.]+) ([-\d.]+)\)/) ?? [];
    const kinds = [["Coffee (mock)", "Coffee Shop"], ["Ramen (mock)", "Ramen"], ["Climbing Gym (mock)", "Bouldering"], ["Wine Bar (mock)", "Natural Wine Bar"]];
    return send(res, { results: { entities: kinds.map(([n, t], i) => ({ entity_id: uuid(100 + i), name: `${n} ${i + 1}`, location: { lat: +lat + (i - 1.5) * 0.003, lon: +lon + (i % 2 ? 0.003 : -0.003) }, properties: { address: `${100 + i} Example St (mock)` }, tags: [{ name: t }] })) } });
  }
  send(res, { error: { message: "not mocked" } }, 404);
}).listen(8799, () => console.log("mock Qloo on http://localhost:8799"));
