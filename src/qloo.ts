// Qloo hackathon API client. Parameter names follow Qloo's docs and the official
// @qloo/qloo-harness 0.1.26 workflows (where_popular: filter.type=urn:heatmap,
// signal.interests.entities, filter.location.query, take; results under results.heatmap).
// The key stays on the server (a Worker secret) and is never sent to a browser.

export interface QlooEnv {
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
}

export interface Entity {
  id: string;
  name: string;
  types: string[];
  disambiguation?: string;
  lat?: number;
  lon?: number;
  address?: string;
  priceLevel?: number;
  affinity?: number;
  tags?: string[];
}

export interface Tag {
  id: string;
  name: string;
  type?: string;
}

export interface HeatPoint {
  lat: number;
  lon: number;
  geohash?: string;
  name?: string;
  affinity: number;
  popularity?: number;
}

export interface Provenance {
  path: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  count: number;
}

export class QlooError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export class Qloo {
  calls: Provenance[] = [];
  constructor(private env: QlooEnv) {}

  get ready() {
    return !!this.env.QLOO_API_KEY;
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    if (!this.env.QLOO_API_KEY) throw new QlooError("The Qloo API key has not been configured yet.", 503);
    const base = this.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
    const t = Date.now();
    const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`, {
      headers: { "X-Api-Key": this.env.QLOO_API_KEY, accept: "application/json" },
    });
    const body: any = await res.json().catch(() => ({}));
    const count = Array.isArray(body?.results)
      ? body.results.length
      : (body?.results?.entities?.length ?? body?.results?.heatmap?.length ?? body?.results?.tags?.length ?? 0);
    this.calls.push({ path, params, status: res.status, ms: Date.now() - t, count });
    if (res.status === 429) throw new QlooError("Qloo rate limit reached. Try again in a minute.", 429);
    if (!res.ok) throw new QlooError(`Qloo answered ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}`, res.status);
    return body;
  }

  async search(query: string, type?: string, take = 3): Promise<Entity[]> {
    const body = await this.get("/search", { query, take: String(take), ...(type ? { types: type } : {}) });
    const list: any[] = Array.isArray(body?.results) ? body.results : (body?.results?.entities ?? []);
    return list.map(toEntity);
  }

  async tags(query: string, take = 5): Promise<Tag[]> {
    const body = await this.get("/v2/tags", { "filter.query": query, take: String(take) });
    const list: any[] = body?.results?.tags ?? (Array.isArray(body?.results) ? body.results : []);
    return list.map((t) => ({ id: String(t.id ?? t.tag_id ?? t.entity_id), name: String(t.name ?? t.id), type: t.type ?? t.subtype }));
  }

  async heatmap(signals: Signals, city: string, take = 60, boundary?: string): Promise<HeatPoint[]> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:heatmap",
      "filter.location.query": city,
      ...signalParams(signals),
      take: String(take),
      ...(boundary ? { "output.heatmap.boundary": boundary } : {}),
    });
    const list: any[] = body?.results?.heatmap ?? [];
    return list
      .map((p) => {
        const loc = p.location ?? p.geo ?? p;
        const lat = num(loc.latitude ?? loc.lat);
        const lon = num(loc.longitude ?? loc.lon ?? loc.lng);
        return {
          lat,
          lon,
          geohash: loc.geohash,
          name: p.name ?? loc.name,
          affinity: num(p.query?.affinity ?? p.affinity),
          popularity: num(p.query?.popularity ?? p.popularity),
        } as HeatPoint;
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.affinity));
  }

  async placesNear(signals: Signals, lat: number, lon: number, radiusM = 1200, take = 5): Promise<Entity[]> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:entity:place",
      "filter.location": `POINT(${lon} ${lat})`,
      "filter.location.radius": String(radiusM),
      ...signalParams(signals),
      take: String(take),
    });
    return (body?.results?.entities ?? []).map(toEntity);
  }
}

export interface Signals {
  entities: string[];
  tags: string[];
}

function signalParams(s: Signals): Record<string, string> {
  return {
    ...(s.entities.length ? { "signal.interests.entities": s.entities.join(",") } : {}),
    ...(s.tags.length ? { "signal.interests.tags": s.tags.join(",") } : {}),
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" ? n : NaN;
}

function toEntity(e: any): Entity {
  const loc = e.location ?? e.properties?.geocode ?? {};
  return {
    id: String(e.entity_id ?? e.id),
    name: String(e.name ?? ""),
    types: e.types ?? (e.type ? [e.type] : []),
    disambiguation: e.disambiguation,
    lat: Number.isFinite(num(loc.lat ?? loc.latitude)) ? num(loc.lat ?? loc.latitude) : undefined,
    lon: Number.isFinite(num(loc.lon ?? loc.longitude ?? loc.lng)) ? num(loc.lon ?? loc.longitude ?? loc.lng) : undefined,
    address: e.properties?.address,
    priceLevel: e.properties?.price_level,
    affinity: Number.isFinite(num(e.query?.affinity)) ? num(e.query?.affinity) : undefined,
    tags: (e.tags ?? []).slice(0, 6).map((t: any) => String(t.name ?? t)),
  };
}
