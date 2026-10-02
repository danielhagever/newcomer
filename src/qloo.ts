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
  disambiguation?: string; // e.g. a film's year
  lat?: number;
  lon?: number;
  address?: string;
  neighborhood?: string; // Qloo's own neighborhood name for a place
  priceLevel?: number;
  affinity?: number;
  popularity?: number;
  tags?: string[]; // a place's categories (Barbecue restaurant, Cocktail bar)
  times?: string[]; // Qloo's time-of-day fit for a place (Morning, Midday, Evening...)
}

export interface Tag {
  id: string;
  name: string;
  type?: string;
  parents: string[]; // entity types the tag applies to, e.g. urn:entity:place or urn:entity:artist
}

export interface HeatPoint {
  lat: number;
  lon: number;
  geohash?: string;
  affinity: number; // the cell's percentile within the city, 0 to 1
  affinityRank?: number;
}

export interface Provenance {
  path: string;
  params: Record<string, string>;
  status: number;
  ms: number;
  count: number;
}

export class QlooError extends AppError {}

// Measured: tag searches take 3-4 s and heatmaps up to 5.4 s under load.
const TIMEOUT_MS = 12000;

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

  // One bounded retry: Qloo answers 429 to bursts (seen with 7 place calls at once).
  private async get(path: string, params: Record<string, string>, retry = true): Promise<any> {
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
    if (res.status === 429 && retry && this.budget.left() > 1) {
      await new Promise((r) => setTimeout(r, 800));
      return this.get(path, params, false);
    }
    if (res.status === 429) throw new QlooError("Qloo's rate limit was reached. Please try again in a minute.", 429);
    if (res.status === 401 || res.status === 403) throw new QlooError("Qloo refused this app's API key, so no search can run right now.", 503);
    if (!res.ok) {
      const detail = body?.errors?.[0]?.message ?? body?.error?.message ?? body?.message;
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
      .map((t) => ({
        id: String(t.id ?? t.tag_id ?? ""),
        name: String(t.name ?? "").trim(),
        type: t.type ?? t.subtype,
        parents: (Array.isArray(t.parents) ? t.parents : []).map((p: any) => String(p?.type ?? p)),
      }))
      .filter((t) => t.id && t.name);
  }

  // The heatmap of a city: every cell Qloo has (geohash-7, ~150 m, in a city; geohash-6 over a big
  // county), sorted by affinity. Measured
  // 2026-10-03: there is no neighborhood boundary (only urn:geohash or urn:entity:locality), `take`
  // and `page` are ignored for heatmaps (and take > 50 is a 400), and `affinity` is the cell's
  // percentile within the city (1 = best cell). The answer also names the locality Qloo used.
  async heatmap(signals: Signals, where: Where): Promise<{ points: HeatPoint[]; locality?: Locality }> {
    const body = await this.get("/v2/insights", { "filter.type": "urn:heatmap", ...whereParams(where), ...signalParams(signals) });
    const list: any[] = body?.results?.heatmap ?? [];
    const points = list
      .map((p) => {
        const loc = p.location ?? p.geo ?? p;
        const rank = num(p.query?.affinity_rank ?? p.affinity_rank);
        return {
          lat: num(loc.latitude ?? loc.lat),
          lon: num(loc.longitude ?? loc.lon ?? loc.lng),
          geohash: loc.geohash,
          affinity: num(p.query?.affinity ?? p.affinity),
          ...(Number.isFinite(rank) ? { affinityRank: rank } : {}),
        } as HeatPoint;
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.affinity));
    const l = body?.query?.localities?.filter?.[0];
    const lat = num(l?.location?.lat), lon = num(l?.location?.lon);
    const locality = l && Number.isFinite(lat) && Number.isFinite(lon) ? { name: String(l.disambiguation ?? l.name ?? ""), lat, lon } : undefined;
    return { points, ...(locality ? { locality } : {}) };
  }

  // Places that Qloo ranks for these tastes, near a point or in a city. `filterTags` keeps only
  // places that carry at least one of the tags (ramen, bouldering, natural wine...): measured, food
  // and activity tags work as filters on places but do nothing as heatmap signals.
  async places(signals: Signals, where: Where, take = 8, filterTags: string[] = []): Promise<Entity[]> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:entity:place",
      ...whereParams(where),
      ...signalParams(signals),
      ...(filterTags.length ? { "filter.tags": filterTags.join(","), "operator.filter.tags": "union" } : {}),
      take: String(Math.min(50, take)),
    });
    return (body?.results?.entities ?? []).map(toEntity).filter((e: Entity) => e.name);
  }
}

export interface Locality {
  name: string; // e.g. "Portland, Cumberland County, Maine, United States"
  lat: number;
  lon: number;
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
  const tags: { name: string; type: string }[] = (Array.isArray(e.tags) ? e.tags : []).map((t: any) => ({ name: String(t?.name ?? t ?? "").trim(), type: String(t?.type ?? "") }));
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
    popularity: typeof e.popularity === "number" ? e.popularity : undefined,
    neighborhood: typeof e.properties?.neighborhood === "string" && e.properties.neighborhood.trim() ? e.properties.neighborhood.trim() : undefined,
    tags: [...new Set(tags.filter((t) => CATEGORY.has(t.type) && t.name !== "Place").map((t) => t.name))].slice(0, 4),
    times: [...new Set(tags.filter((t) => t.type === "urn:tag:time_of_day_fit:qloo").map((t) => t.name))],
  };
}

const CATEGORY = new Set(["urn:tag:category:place", "urn:tag:genre:place", "urn:tag:cuisine:qloo"]);
