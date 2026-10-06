// A stand-in for Qloo, Open-Meteo and Photon, plus a KV that counts its operations, so the tests can
// check every rule (and the 50-subrequest limit) without a real key. Shapes follow the live API as
// measured on 2026-10-03: /search -> results[] (entity_id, name, types, disambiguation);
// /v2/tags -> results.tags[] (id, name, type, parents[{type}]); heatmap -> results.heatmap[] of
// geohash-7 cells with query.affinity = percentile, plus query.localities.filter[0]; places ->
// results.entities[] with properties.neighborhood and typed tags (category, time_of_day_fit).

export interface Call {
  host: string;
  path: string;
  params: URLSearchParams;
}

export type Handler = (c: Call) => { status?: number; body: unknown } | undefined;

export function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const c = { host: u.host, path: u.pathname, params: u.searchParams };
    calls.push(c);
    const r = handler(c) ?? defaults(c);
    if (!r) return new Response("not mocked", { status: 599 });
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

export const AUSTIN = { name: "Austin", latitude: 30.267, longitude: -97.743, country_code: "US", admin1: "Texas", country: "United States", population: 960000 };

function defaults(c: Call): { status?: number; body: unknown } | undefined {
  if (c.host === "geocoding-api.open-meteo.com") return { body: { results: [AUSTIN] } };
  if (c.host === "photon.komoot.io") {
    const lat = Number(c.params.get("lat"));
    return { body: { features: [{ properties: { district: `OSM District ${Math.round(lat * 100) % 7}` } }] } };
  }
  return undefined;
}

const letter = (i: number) => "bcdefghjkmnpqrstuvwxyz"[i % 22];

// A heatmap: `groups` squares of `per` cells each around a point, hottest square first; affinity is
// the cell's percentile like the live API.
export function heatmap(lat: number, lon: number, groups = 9, per = 8, locality = "Austin, Travis County, Texas, United States") {
  const n = groups * per;
  const cells = Array.from({ length: n }, (_, i) => {
    const g = Math.floor(i / per);
    return {
      location: { latitude: lat + (g % 3) * 0.012 + (i % per) * 0.0005, longitude: lon + Math.floor(g / 3) * 0.012, geohash: `9v6s0${letter(g)}${letter(i)}` },
      query: { affinity: 1 - i / (n - 1), affinity_rank: 1 - i / n, popularity: 0.5 },
    };
  });
  return { success: true, results: { heatmap: cells }, query: { localities: { filter: [{ name: locality.split(",")[0], disambiguation: locality, location: { lat, lon } }] } } };
}

export function place(id: string, name: string, hood: string | null, lat: number, lon: number, categories: string[], times: string[]) {
  return {
    entity_id: id,
    name,
    location: { lat, lon, geohash: "9v6s0bb" },
    properties: { address: `${id} Main St`, ...(hood ? { neighborhood: hood } : {}) },
    tags: [...categories.map((n) => ({ name: n, type: "urn:tag:category:place" })), { name: "Mastercard", type: "urn:tag:payments:place" }, ...times.map((n) => ({ name: n, type: "urn:tag:time_of_day_fit:qloo" }))],
  };
}

// Places around a point, named after the neighborhood the caller chooses.
// hood: the Qloo neighborhood on each place, or null for places Qloo has no neighborhood for.
export function places(prefix: string, hood: string | null = "Downtown", lat = 30.27, lon = -97.74) {
  return [
    place(`${prefix}-1`, `${prefix} Coffee`, hood, lat, lon, ["Coffee shop"], ["Morning", "Midday"]),
    place(`${prefix}-2`, `${prefix} Barbecue`, hood, lat + 0.001, lon, ["Barbecue restaurant"], ["Midday", "Afternoon"]),
    place(`${prefix}-3`, `${prefix} Cocktail Bar`, hood, lat, lon + 0.001, ["Cocktail bar"], ["Evening", "Late night"]),
  ];
}

export const tag = (id: string, name: string, parents: string[]) => ({ id, name, type: id.split(":").slice(0, -1).join(":"), parents: parents.map((type) => ({ type })) });

export function memoryKV(opts: { failPuts?: boolean } = {}) {
  const store = new Map<string, string>();
  const ops = { get: 0, put: 0 };
  const kv = {
    async get(key: string, type?: string) {
      ops.get++;
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      ops.put++;
      if (opts.failPuts) throw new Error("KV put() limit exceeded for the day.");
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, ops };
}

// No pacing between Qloo calls in tests (one test checks the real pacing).
export const ENV = (kv: KVNamespace) => ({ QLOO_API_KEY: "test-key", QLOO_BASE_URL: "https://qloo.test", QLOO_MIN_GAP_MS: "0", CACHE: kv });
