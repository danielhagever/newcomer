// A stand-in for Qloo, Open-Meteo and Photon, plus a KV that counts its operations, so the tests can
// check every rule (and the 50-subrequest limit) without a real key. Response shapes follow Qloo's
// docs and the official harness: /search -> results[], /v2/tags -> results.tags[], heatmap ->
// results.heatmap[] with location.{latitude,longitude,geohash} and query.{affinity,affinity_rank},
// places -> results.entities[].

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
    return { body: { features: [{ properties: { district: `District ${Math.round(lat * 100) % 7}` } }] } };
  }
  return undefined;
}

// Heatmap cells around a point, hottest first.
export function cells(lat: number, lon: number, n: number, named = false) {
  return Array.from({ length: n }, (_, i) => ({
    ...(named ? { name: `Hood ${i}` } : {}),
    location: { latitude: lat + (i % 9) * 0.011, longitude: lon + Math.floor(i / 9) * 0.011, geohash: `g${i}` },
    query: { affinity: 0.95 - i * 0.01, affinity_rank: 1 - i / n, popularity: 0.5 },
  }));
}

export function places(prefix: string) {
  return [
    { entity_id: `${prefix}-1`, name: `${prefix} Coffee`, location: { lat: 30.27, lon: -97.74 }, properties: { address: "1 Main St" }, tags: [{ name: "Coffee Shop" }] },
    { entity_id: `${prefix}-2`, name: `${prefix} Barbecue`, location: { lat: 30.27, lon: -97.73 }, properties: { address: "2 Main St" }, tags: [{ name: "Barbecue" }] },
    { entity_id: `${prefix}-3`, name: `${prefix} Cocktail Bar`, location: { lat: 30.26, lon: -97.74 }, tags: [{ name: "Cocktail Bar" }] },
  ];
}

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

export const ENV = (kv: KVNamespace) => ({ QLOO_API_KEY: "test-key", QLOO_BASE_URL: "https://qloo.test", CACHE: kv });
