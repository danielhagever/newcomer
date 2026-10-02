// Qloo hackathon API client. Parameter names follow Qloo's docs and the official
// @qloo/qloo-harness 0.1.26 workflows: where_popular (filter.type=urn:heatmap,
// signal.interests.entities, filter.location.query, take; points under results.heatmap with
// query.affinity), and its name resolution (/search with take 5, /v2/tags with
// feature.semantic_search and take 20, exact name match or a choice for the user).
// The key stays on the server (a Worker secret) and is never sent to a browser.

import { AppError, Budget, fetchWithTimeout } from "./limits.ts";

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
  affinityRank?: number; // Qloo's normalized rank, 0 to 1, when the API returns it
  popularity?: number;
}

export interface Provenance {
  path: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  count: number;
}

export class QlooError extends AppError {}

const TIMEOUT_MS = 9000;

// Same comparison as the harness's resolver (NFKC, trimmed, lower case).
export const normalizeName = (s: string) => s.normalize("NFKC").trim().toLocaleLowerCase("en-US");

export class Qloo {
  calls: Provenance[] = [];
  env: QlooEnv;
  budget: Budget;
  constructor(env: QlooEnv, budget: Budget) {
    this.env = env;
    this.budget = budget;
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    if (!this.env.QLOO_API_KEY) throw new QlooError("The Qloo API key has not been configured yet.", 503);
    if (!this.budget.take()) throw new QlooError("This search needs more Qloo calls than one request allows. Try fewer interests.", 503);
    const base = this.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
    const t = Date.now();
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `${base}${path}?${new URLSearchParams(params)}`,
        { headers: { "X-Api-Key": this.env.QLOO_API_KEY, accept: "application/json" } },
        TIMEOUT_MS,
      );
    } catch (e) {
      this.calls.push({ path, params, status: 0, ms: Date.now() - t, count: 0 });
      if ((e as Error)?.name === "TimeoutError") throw new QlooError("Qloo took too long to answer. Please try again.", 504);
      throw new QlooError("Couldn't reach Qloo. Please try again.", 502);
    }
    const body: any = await res.json().catch(() => ({}));
    const count = Array.isArray(body?.results)
      ? body.results.length
      : (body?.results?.entities?.length ?? body?.results?.heatmap?.length ?? body?.results?.tags?.length ?? 0);
    this.calls.push({ path, params, status: res.status, ms: Date.now() - t, count });
    if (res.status === 429) throw new QlooError("Qloo's rate limit was reached. Please try again in a minute.", 429);
    if (res.status === 401 || res.status === 403) throw new QlooError("Qloo refused this app's API key, so no search can run right now.", 503);
    if (!res.ok) {
      const detail = body?.error?.message ?? body?.message;
      throw new QlooError(`Qloo answered ${res.status}${detail ? `: ${String(detail).slice(0, 160)}` : ""}`, res.status >= 500 ? 502 : res.status);
    }
    return body;
  }

  async search(query: string, type?: string, take = 5): Promise<Entity[]> {
    const body = await this.get("/search", { query, take: String(take), ...(type ? { types: type } : {}) });
    const list: any[] = Array.isArray(body?.results) ? body.results : (body?.results?.entities ?? []);
    return list.map(toEntity).filter((e) => e.id && e.name);
  }

  async tags(query: string, take = 20): Promise<Tag[]> {
    const body = await this.get("/v2/tags", { "filter.query": query, "feature.semantic_search": "true", take: String(take) });
    const list: any[] = body?.results?.tags ?? (Array.isArray(body?.results) ? body.results : []);
    return list
      .map((t) => ({ id: String(t.id ?? t.tag_id ?? ""), name: String(t.name ?? ""), type: t.type ?? t.subtype }))
      .filter((t) => t.id && t.name);
  }

  // where: a named place (Qloo resolves it to a locality) or a point with a radius in meters.
  async heatmap(signals: Signals, where: Where, take = 80, boundary?: string): Promise<HeatPoint[]> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:heatmap",
      ...whereParams(where),
      ...signalParams(signals),
      take: String(take),
      ...(boundary ? { "output.heatmap.boundary": boundary } : {}),
    });
    const list: any[] = body?.results?.heatmap ?? [];
    return list
      .map((p) => {
        const loc = p.location ?? p.geo ?? p;
        const rank = num(p.query?.affinity_rank ?? p.affinity_rank);
        return {
          lat: num(loc.latitude ?? loc.lat),
          lon: num(loc.longitude ?? loc.lon ?? loc.lng),
          geohash: loc.geohash,
          name: p.name ?? loc.name,
          affinity: num(p.query?.affinity ?? p.affinity),
          ...(Number.isFinite(rank) ? { affinityRank: rank } : {}),
          popularity: num(p.query?.popularity ?? p.popularity),
        } as HeatPoint;
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.affinity));
  }

  async placesNear(signals: Signals, lat: number, lon: number, radiusM = 1200, take = 5): Promise<Entity[]> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:entity:place",
      ...whereParams({ lat, lon, radiusM }),
      ...signalParams(signals),
      take: String(take),
    });
    return (body?.results?.entities ?? []).map(toEntity).filter((e: Entity) => e.name);
  }
}

export interface Signals {
  entities: string[];
  tags: string[];
}

export type Where = { query: string } | { lat: number; lon: number; radiusM: number };

function whereParams(w: Where): Record<string, string> {
  return "query" in w
    ? { "filter.location.query": w.query }
    : { "filter.location": `POINT(${w.lon} ${w.lat})`, "filter.location.radius": String(Math.round(w.radiusM)) };
}

// Several tags combine as "union" (a place or area that carries any of your tastes). The API's
// default isn't documented and the harness always sets it, so it's set explicitly here too.
export function signalParams(s: Signals): Record<string, string> {
  return {
    ...(s.entities.length ? { "signal.interests.entities": s.entities.join(",") } : {}),
    ...(s.tags.length ? { "signal.interests.tags": s.tags.join(",") } : {}),
    ...(s.tags.length > 1 ? { "operator.signal.interests.tags": "union" } : {}),
  };
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" ? n : NaN;
}

function toEntity(e: any): Entity {
  const loc = e.location ?? e.properties?.geocode ?? {};
  const lat = num(loc.lat ?? loc.latitude);
  const lon = num(loc.lon ?? loc.longitude ?? loc.lng);
  const affinity = num(e.query?.affinity);
  return {
    id: String(e.entity_id ?? e.id ?? ""),
    name: String(e.name ?? ""),
    types: e.types ?? (e.type ? [e.type] : []),
    disambiguation: e.disambiguation,
    lat: Number.isFinite(lat) ? lat : undefined,
    lon: Number.isFinite(lon) ? lon : undefined,
    address: e.properties?.address,
    priceLevel: e.properties?.price_level,
    affinity: Number.isFinite(affinity) ? affinity : undefined,
    tags: (e.tags ?? []).slice(0, 6).map((t: any) => String(t.name ?? t)),
  };
}
