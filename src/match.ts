// The Newcomer pipeline: from "here's what I love" to "here are the neighborhoods that already love
// it too, here's the evidence, and here's a weekend to test it". Every step is recorded so the page
// can show which Qloo calls produced which claim, and which parts are Newcomer's own rules.

import { Qloo, QlooError, normalizeName, type Entity, type HeatPoint, type Signals } from "./qloo.ts";
import { cityCenter, cellKey, km, namesFor } from "./geo.ts";
import { AppError, type Budget } from "./limits.ts";

export type Kind = "artist" | "movie" | "tv_show" | "book" | "podcast" | "video_game" | "brand" | "place" | "tag";
export const KINDS: Kind[] = ["artist", "movie", "tv_show", "book", "podcast", "video_game", "brand", "place", "tag"];

export interface Interest {
  name: string;
  kind?: Kind;
  id?: string; // a Qloo entity or tag ID the person picked from the alternatives of an earlier result
  as?: string; // that ID's name, for display
}

export interface Choice {
  id: string;
  name: string;
  type: string;
}

export interface Resolved {
  input: string; // what the person wrote
  as: string; // the Qloo name it matched
  id: string;
  type: string;
  signal: "entity" | "tag";
  match: "exact" | "closest" | "chosen";
  alternatives: Choice[];
  kind?: Kind;
}

export interface Neighborhood {
  name: string;
  lat: number;
  lon: number;
  affinity: number; // mean Qloo affinity of the cells (or the Qloo neighborhood) behind this name
  affinityRank?: number; // mean Qloo affinity_rank (0 to 1), when Qloo returns it
  cells: number;
  evidence: Entity[]; // places near the centre that Qloo ranks highly for the same signals
}

export interface MatchResult {
  city: string;
  center: { lat: number; lon: number };
  resolved: Resolved[];
  unresolved: string[];
  boundary: "neighborhood" | "geohash";
  neighborhoods: Neighborhood[];
  weekend: { day: string; neighborhood: string; stops: { when: string; place: string; why: string }[] }[];
  limits: string[];
  ours: string[]; // Newcomer's own rules, kept apart from what Qloo said
  degraded: boolean; // something optional failed (names, evidence): shown, but not cached
  trace: { step: string; detail: string }[];
  calls: { path: string; params: Record<string, string>; status: number; ms: number; count: number }[];
}

const ENTITY_TYPES: Record<string, string> = {
  artist: "urn:entity:artist",
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  book: "urn:entity:book",
  podcast: "urn:entity:podcast",
  video_game: "urn:entity:video_game",
  brand: "urn:entity:brand",
  place: "urn:entity:place",
};

const TAG_ID = /^urn:tag:[\w:.\-]+$/i;
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validQlooId = (id: string) => TAG_ID.test(id) || ENTITY_ID.test(id);

// Errors that mean "this one interest isn't in Qloo"; anything else (key refused, rate limit,
// timeouts) stops the search with its real message instead of turning into "not found".
const notFound = (e: unknown) => e instanceof AppError && (e.status === 400 || e.status === 404);

// Pick the exact name match if there is one; otherwise the top result, marked "closest" so the
// page (or the calling agent) can ask the person, with the other candidates as alternatives.
function choose<T extends { id: string; name: string }>(input: string, list: T[], typeOf: (x: T) => string) {
  if (!list.length) return null;
  const exact = list.filter((x) => normalizeName(x.name) === normalizeName(input));
  const pick = exact.length === 1 ? exact[0] : list[0];
  const alternatives = list
    .filter((x) => x.id !== pick.id)
    .slice(0, 4)
    .map((x) => ({ id: x.id, name: x.name, type: typeOf(x) }));
  return { pick, match: (exact.length === 1 ? "exact" : "closest") as "exact" | "closest", alternatives };
}

async function resolveOne(q: Qloo, it: Interest): Promise<Resolved | null> {
  if (it.id && validQlooId(it.id)) {
    const isTag = TAG_ID.test(it.id);
    return { input: it.name, as: it.as ?? it.name, id: it.id, type: isTag ? "tag" : "entity", signal: isTag ? "tag" : "entity", match: "chosen", alternatives: [], kind: it.kind };
  }
  const entityType = it.kind && it.kind !== "tag" ? ENTITY_TYPES[it.kind] : undefined;
  const asEntity = async (type?: string) => {
    const c = choose(it.name, await q.search(it.name, type, 5), (e) => e.types[0] ?? type ?? "entity");
    return c && ({ input: it.name, as: c.pick.name, id: c.pick.id, type: c.pick.types[0] ?? type ?? "entity", signal: "entity", match: c.match, alternatives: c.alternatives, kind: it.kind } as Resolved);
  };
  const asTag = async () => {
    const c = choose(it.name, await q.tags(it.name, 20), (t) => t.type ?? "tag");
    return c && ({ input: it.name, as: c.pick.name, id: c.pick.id, type: c.pick.type ?? "tag", signal: "tag", match: c.match, alternatives: c.alternatives, kind: it.kind } as Resolved);
  };
  // At most two lookups per interest: its own kind first, then the other kind.
  return entityType ? ((await asEntity(entityType)) ?? (await asTag())) : ((await asTag()) ?? (await asEntity()));
}

export async function matchNeighborhoods(
  env: { QLOO_API_KEY?: string; QLOO_BASE_URL?: string; QLOO_HEATMAP_BOUNDARY?: string; CACHE: KVNamespace },
  budget: Budget,
  city: string,
  interestsIn: Interest[],
): Promise<MatchResult> {
  const q = new Qloo(env, budget);
  const trace: MatchResult["trace"] = [];
  let degraded = false;
  if (!env.QLOO_API_KEY) throw new QlooError("The Qloo API key has not been configured yet.", 503);
  const center = await cityCenter(env.CACHE, budget, city);
  if (!center) throw new AppError(`I couldn't find "${city}". Try the city and its state or country, like "Austin, Texas".`, 400);
  trace.push({ step: "Locate", detail: `${center.name} (${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}) via Open-Meteo geocoding` });

  // 1. Each interest becomes a Qloo entity or tag. Same names are looked up once.
  const seen = new Set<string>();
  const interests = interestsIn.filter((i) => {
    const k = i.id ?? normalizeName(i.name);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
  const outcomes = await Promise.all(
    interests.map((it) =>
      resolveOne(q, it).catch((e) => {
        if (notFound(e)) return null;
        throw e;
      }),
    ),
  );
  const resolved: Resolved[] = [];
  const unresolved: string[] = [];
  outcomes.forEach((r, i) => {
    if (!r) unresolved.push(interests[i].name);
    else if (!resolved.some((x) => x.id === r.id)) resolved.push(r);
  });
  const closest = resolved.filter((r) => r.match === "closest");
  trace.push({
    step: "Understand",
    detail:
      `${resolved.length} of ${interests.length} interests matched in Qloo's taste graph` +
      (closest.length ? `; closest match, not an exact name: ${closest.map((r) => `${r.input} → ${r.as}`).join(", ")}` : "") +
      (unresolved.length ? `; not found: ${unresolved.join(", ")}` : ""),
  });
  if (!resolved.length)
    throw new AppError("None of those interests are in Qloo's graph. Try names of artists, shows, films, or kinds of food and activities.", 422);
  const signals: Signals = {
    entities: resolved.filter((r) => r.signal === "entity").map((r) => r.id),
    tags: resolved.filter((r) => r.signal === "tag").map((r) => r.id),
  };

  // 2. Where in the city do people who share these tastes concentrate? Qloo is asked about the
  // same city Newcomer located (not the raw text), and the answer is checked against it.
  const wanted = env.QLOO_HEATMAP_BOUNDARY ?? "neighborhood";
  let points: HeatPoint[] = [];
  let boundaryOk = true;
  try {
    points = await q.heatmap(signals, { query: center.query }, 80, wanted);
  } catch (e) {
    if (!notFound(e)) throw e;
    boundaryOk = false;
    points = await q.heatmap(signals, { query: center.query }, 80); // the boundary value was refused: map cells
  }
  const farOff = (ps: HeatPoint[]) => {
    const d = ps.slice(0, 10).map((p) => km(p, center)).sort((a, b) => a - b);
    return d.length > 0 && d[Math.floor(d.length / 2)] > 60;
  };
  if (!points.length || farOff(points)) {
    trace.push({ step: "Check", detail: `Qloo's area for "${center.query}" ${points.length ? "was far from the located city" : "was empty"}; asked again for 25 km around the city centre` });
    points = await q.heatmap(signals, { lat: center.lat, lon: center.lon, radiusM: 25000 }, 80, boundaryOk ? wanted : undefined);
    if (farOff(points))
      throw new AppError(`Qloo's map didn't line up with ${center.name}, so no neighborhoods are shown. Try the city with its state or country.`, 502);
  }
  const boundary: MatchResult["boundary"] = points.some((p) => p.name) ? "neighborhood" : "geohash";
  trace.push({
    step: "Heatmap",
    detail: `${points.length} ${boundary === "neighborhood" ? "neighborhoods" : "map cells"} scored by Qloo for this taste profile`,
  });
  if (!points.length) throw new AppError(`Qloo has no heatmap for ${center.name} with these interests.`, 404);

  // 3. Name the cells and group them into neighborhoods.
  const top = [...points].sort((a, b) => b.affinity - a.affinity).slice(0, 24);
  let names = new Map<string, string>();
  if (boundary === "geohash") {
    // Keep room for 3 place calls and the final cache write.
    const r = await namesFor(env.CACHE, budget, center.name, top.filter((p) => !p.name), 4);
    names = r.names;
    if (r.missing) degraded = true;
  }
  const nameOf = (p: HeatPoint): string | undefined => p.name ?? names.get(cellKey(p.lat, p.lon));
  const groups = new Map<string, { lat: number; lon: number; aff: number[]; rank: number[] }>();
  for (const p of top) {
    // A cell without a name joins the nearest named cell within 1.5 km, or is left out.
    let name = nameOf(p);
    if (!name) {
      const near = top.filter((o) => nameOf(o)).sort((a, b) => km(a, p) - km(b, p))[0];
      if (near && km(near, p) <= 1.5) name = nameOf(near);
    }
    if (!name) continue;
    const g = groups.get(name) ?? { lat: 0, lon: 0, aff: [], rank: [] };
    g.lat += p.lat;
    g.lon += p.lon;
    g.aff.push(p.affinity);
    if (p.affinityRank !== undefined) g.rank.push(p.affinityRank);
    groups.set(name, g);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let hoods: Neighborhood[] = [...groups.entries()].map(([name, g]) => ({
    name,
    lat: g.lat / g.aff.length,
    lon: g.lon / g.aff.length,
    affinity: mean(g.aff),
    ...(g.rank.length ? { affinityRank: mean(g.rank) } : {}),
    cells: g.aff.length,
    evidence: [],
  }));
  // Newcomer's rule: mean affinity, nudged up (at most 20%) for neighborhoods that hold several of
  // the top cells, since one hot block is weaker evidence than several.
  const score = (h: Neighborhood) => h.affinity * (1 + 0.05 * Math.min(h.cells, 4));
  hoods.sort((a, b) => score(b) - score(a));
  hoods = hoods.slice(0, 5);
  if (!hoods.length) throw new AppError(`Qloo scored ${center.name}, but none of the top areas could be named. Please try again later.`, 502);
  trace.push({
    step: "Name",
    detail:
      boundary === "neighborhood"
        ? `Qloo returned named neighborhoods; kept the top ${hoods.length}`
        : `Grouped the top map cells into ${hoods.length} neighborhoods using OpenStreetMap names (Photon reverse geocoding)`,
  });

  // 4. Evidence: the places in each top neighborhood that Qloo ranks highest for the same tastes.
  await Promise.all(
    hoods.slice(0, 3).map(async (h) => {
      try {
        h.evidence = await q.placesNear(signals, h.lat, h.lon, 1200, 5);
      } catch {
        degraded = true;
      }
    }),
  );
  trace.push({ step: "Evidence", detail: `Asked Qloo for the best-matching places within 1.2 km of each of the top 3 neighborhoods` });

  // 5. A weekend to test the move before signing a lease (Newcomer's plan, from Qloo's places).
  const order = ["Morning", "Afternoon", "Evening"];
  const weekend = hoods
    .slice(0, 2)
    .map((h, i) => ({
      day: i === 0 ? "Saturday" : "Sunday",
      neighborhood: h.name,
      stops: h.evidence
        .slice(0, 4)
        .map((e) => ({ when: slot(e), place: e.name, why: (e.tags ?? []).slice(0, 2).join(", ") }))
        .sort((a, b) => order.indexOf(a.when) - order.indexOf(b.when)),
    }))
    .filter((d) => d.stops.length);
  trace.push({ step: "Plan", detail: weekend.length ? `Built a scouting weekend from the evidence places` : `Not enough evidence places for a weekend plan` });

  return {
    city: center.name,
    center: { lat: center.lat, lon: center.lon },
    resolved,
    unresolved,
    boundary,
    neighborhoods: hoods,
    weekend,
    limits: [
      "Qloo affinities describe what groups of people in an area tend to like, not what any one person will do or feel.",
      "Taste fit is one input. Rent, commute, schools and safety are not part of this result.",
      "Neighborhood names come from " + (boundary === "neighborhood" ? "Qloo" : "OpenStreetMap") + " and may not match local usage exactly.",
    ],
    ours: [
      "Order of neighborhoods: Qloo's affinity, with a boost of up to 20% for a neighborhood that holds several of the top map cells (Newcomer's rule).",
      "Weekend times of day are Newcomer's guess from each place's Qloo tags.",
      ...(closest.length ? ["Where no Qloo name matched exactly, the closest match was used; you can pick another."] : []),
    ],
    degraded,
    trace,
    calls: q.calls,
  };
}

// Time of day for a place, from whole words in its tags and name.
export function slot(e: { name: string; tags?: string[] }): string {
  const t = (e.tags ?? []).join(" ").toLowerCase() + " " + e.name.toLowerCase();
  if (/\b(coffee|coffee shop|cafe|café|bakery|breakfast|brunch)\b/.test(t)) return "Morning";
  if (/\b(bar|bars|cocktail|cocktails|brewery|pub|live music|nightclub|club|music venue|wine bar|wine)\b/.test(t)) return "Evening";
  return "Afternoon";
}
