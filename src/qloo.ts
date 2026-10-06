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
  QLOO_MIN_GAP_MS?: string; // tests set "0"
  QLOO_TOTAL_MS?: string; // tests set a short one
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
  closed?: boolean; // Qloo says the place is closed, or its name does ("CLOSED - Tacos el Cabron": is_closed false, live)
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

// Measured: tag searches take 3-4 s. A city's heatmap took 1.8-6.3 s alone (2026-10-05), 8-10 s while other
// searches ran, over 12 s once and 20.9 s once (four books, a podcast and two games; the same call again also took
// over 20 s, so waiting helps more than asking again).
const TIMEOUT_MS = 12000;
// All of a search's Qloo calls share 40 s: each waits at most what is left (the heatmap all of it), so a slow
// heatmap, the 25 km one after it and a retry can't keep an agent waiting past a client's usual 60 s limit.
// OpenStreetMap's area names come after, three at a time, 5 s a round at most (three rounds for the seven areas); a
// live search takes 10 to 22 s in all.
const TOTAL_MS = 40000;

// Qloo answers 429 to the sixth call within about a second (measured 2026-10-03 after a quiet minute:
// 5 at once all 200, 6 at once lose one, 8 lose three; a steady 4 a second loses the sixth call every
// time, a steady 3 a second lost none of 24). A search starts one call at most every 340 ms.
const MIN_GAP_MS = 340;

// Same comparison as the harness's resolver (NFKC, trimmed, lower case).
export const normalizeName = (s: string) => s.normalize("NFKC").trim().toLocaleLowerCase("en-US");

export class Qloo {
  calls: Provenance[] = [];
  env: QlooEnv;
  budget: Budget;
  private gap: number;
  private last = -Infinity;
  private queue: Promise<void> = Promise.resolve();
  private deadline: number;
  constructor(env: QlooEnv, budget: Budget) {
    this.env = env;
    this.budget = budget;
    const total = Number(env.QLOO_TOTAL_MS);
    this.deadline = Date.now() + (env.QLOO_TOTAL_MS !== undefined && Number.isFinite(total) ? total : TOTAL_MS);
    const g = Number(env.QLOO_MIN_GAP_MS);
    this.gap = env.QLOO_MIN_GAP_MS !== undefined && Number.isFinite(g) && g >= 0 ? g : MIN_GAP_MS;
  }

  // Calls take turns: each goes out at least `gap` after the previous one was sent (`last` is set at the
  // send, in get()). The clock is checked again after each wait, because a timer can fire a few ms early
  // or late (Node times it from a cached loop clock); three checks at most. (Booking start times ahead let
  // calls go out under 340 ms apart, which Qloo's limit can refuse.)
  private turn(): Promise<void> {
    const mine = this.queue.then(async () => {
      for (let i = 0; i < 3; i++) {
        const wait = this.last + this.gap - Date.now();
        if (wait <= 0) break;
        await new Promise((r) => setTimeout(r, wait));
      }
    });
    this.queue = mine;
    return mine;
  }

  // One bounded retry: a call from another search at the same moment can still meet a 429.
  private async get(path: string, params: Record<string, string>, retry = true, timeoutMs = TIMEOUT_MS): Promise<any> {
    if (!this.env.QLOO_API_KEY) throw new QlooError("The Qloo API key has not been configured yet.", 503);
    if (!this.budget.take()) throw new QlooError("This search needs more Qloo calls than one request allows. Try fewer interests.", 503);
    const base = this.env.QLOO_BASE_URL ?? "https://hackathon.api.qloo.com";
    await this.turn();
    const t = Date.now(); // the time Qloo took, not the wait for a turn
    const left = this.deadline - t;
    if (left < 1000) throw new QlooError("Qloo took too long to answer. Please try again.", 504);
    let res: Response;
    try {
      const sent = fetchWithTimeout(
        `${base}${path}?${new URLSearchParams(params)}`,
        { headers: { "X-Api-Key": this.env.QLOO_API_KEY, accept: "application/json" } },
        Math.min(timeoutMs, left),
      );
      this.last = Date.now(); // before the next call's turn runs: it was queued after this one
      res = await sent;
    } catch (e) {
      this.calls.push({ path, params, status: 0, ms: Date.now() - t, count: 0 });
      if ((e as Error)?.name === "TimeoutError") throw new QlooError("Qloo took too long to answer. Please try again.", 504);
      throw new QlooError("Couldn't reach Qloo. Please try again.", 502);
    }
    // The time limit covers reading the answer too: an answer cut off by it is a timeout, not an empty one.
    const body: any = await res.json().catch((e) => {
      if ((e as Error)?.name !== "TimeoutError") return {};
      this.calls.push({ path, params, status: 0, ms: Date.now() - t, count: 0 });
      throw new QlooError("Qloo took too long to answer. Please try again.", 504);
    });
    const count = Array.isArray(body?.results)
      ? body.results.length
      : (body?.results?.entities?.length ?? body?.results?.heatmap?.length ?? body?.results?.tags?.length ?? 0);
    this.calls.push({ path, params, status: res.status, ms: Date.now() - t, count });
    if (res.status === 429 && retry && this.budget.left() > 1) {
      await new Promise((r) => setTimeout(r, 800));
      return this.get(path, params, false, timeoutMs);
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
    return toTags(await this.get("/v2/tags", { "filter.query": query, "feature.semantic_search": "true", take: String(take) }));
  }

  // Records for IDs a person or an agent picked, so their own type decides what they act on. Measured 2026-10-06: an
  // unknown ID is left out of the answer (GET /entities?entity_ids=..., and /v2/tags?filter.results.tags=... for
  // tags), and an entity ID that isn't a valid UUID is a 400.
  async byIds(ids: string[]): Promise<Entity[]> {
    const body = await this.get("/entities", { entity_ids: ids.join(",") });
    const list: any[] = Array.isArray(body?.results) ? body.results : (body?.results?.entities ?? []);
    return list.map(toEntity).filter((e) => e.id && e.name);
  }

  async tagsByIds(ids: string[]): Promise<Tag[]> {
    return toTags(await this.get("/v2/tags", { "filter.results.tags": ids.join(","), take: String(ids.length) }));
  }

  // The heatmap of a city: every cell Qloo has (geohash-7, ~150 m, in a city; geohash-6 over a big
  // county), sorted by affinity. Measured
  // 2026-10-03: there is no neighborhood boundary (only urn:geohash or urn:entity:locality), `take`
  // and `page` are ignored for heatmaps (and take > 50 is a 400), and `affinity` is the cell's
  // percentile within the city (1 = best cell). The answer also names the locality Qloo used.
  async heatmap(signals: Signals, where: Where): Promise<{ points: HeatPoint[]; locality?: Locality }> {
    const body = await this.get("/v2/insights", { "filter.type": "urn:heatmap", ...whereParams(where), ...signalParams(signals) }, true, Infinity);
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
    const locality = localityOf(body);
    return { points, ...(locality ? { locality } : {}) };
  }

  // Places that Qloo ranks for these tastes, near a point or in a city. `filterTags` keeps only
  // places that carry at least one of the tags (ramen, bouldering, natural wine...): measured, food
  // and activity tags work as filters on places but do nothing as heatmap signals.
  async places(signals: Signals, where: Where, take = 8, filterTags: string[] = []): Promise<Entity[]> {
    return (await this.placesIn(signals, where, take, filterTags)).places;
  }

  // The same, with the locality Qloo used for a city asked by name (it answers "Tokyo, Japan" with Minato, as for maps).
  async placesIn(signals: Signals, where: Where, take = 8, filterTags: string[] = []): Promise<{ places: Entity[]; locality?: Locality }> {
    const body = await this.get("/v2/insights", {
      "filter.type": "urn:entity:place",
      ...whereParams(where),
      ...signalParams(signals),
      ...(filterTags.length ? { "filter.tags": filterTags.join(","), "operator.filter.tags": "union" } : {}),
      take: String(Math.min(50, take)),
    });
    const locality = localityOf(body);
    return { places: (body?.results?.entities ?? []).map(toEntity).filter((e: Entity) => e.name), ...(locality ? { locality } : {}) };
  }
}

function toTags(body: any): Tag[] {
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

function localityOf(body: any): Locality | undefined {
  const l = body?.query?.localities?.filter?.[0];
  const lat = num(l?.location?.lat), lon = num(l?.location?.lon);
  // The disambiguation usually starts with the locality's own name ("Minato, Tokyo, ..."), but not always: Montreal's
  // is "Island of Montreal" with the disambiguation "Canada" (live), which read as "Qloo used Canada".
  const own = String(l?.name ?? "").trim(), d = String(l?.disambiguation ?? "").trim();
  const name = !d ? own : !own || d.toLowerCase().startsWith(own.toLowerCase()) ? d : `${own}, ${d}`;
  return l && Number.isFinite(lat) && Number.isFinite(lon) ? { name, lat, lon } : undefined;
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
    ...(e.properties?.is_closed === true || closedName(String(e.name ?? "")) ? { closed: true } : {}),
  };
}

// "CLOSED - Tacos el Cabron", "Tacos (Permanently Closed)"; not a bar named "Closed Sessions".
const closedName = (n: string) => /^\W*CLOSED\b/.test(n) || /^\W*(permanently\s+)?closed\s*[-\u2013\u2014:|]|\((permanently\s+)?closed\)\s*$/i.test(n);
const CATEGORY = new Set(["urn:tag:category:place", "urn:tag:genre:place", "urn:tag:cuisine:qloo"]);
