// The Newcomer agent: from "here's what I love" to "here are the neighborhoods that already love it
// too, here's the evidence, and here's a weekend to test it". Every step is recorded so the page can
// show exactly which Qloo calls produced which claim.

import { Qloo, QlooError, type Entity, type HeatPoint, type Signals } from "./qloo";
import { neighborhoodName, cityCenter } from "./geo";

export type Kind = "artist" | "movie" | "tv_show" | "book" | "podcast" | "video_game" | "brand" | "place" | "tag";
export interface Interest {
  name: string;
  kind?: Kind;
}

export interface Neighborhood {
  name: string;
  lat: number;
  lon: number;
  affinity: number; // mean Qloo heatmap affinity of the cells that fall in this neighborhood
  cells: number;
  evidence: Entity[]; // places near the centroid that Qloo ranks highly for the same signals
}

export interface MatchResult {
  city: string;
  center: { lat: number; lon: number };
  resolved: { input: string; as: string; id: string; type: string }[];
  unresolved: string[];
  neighborhoods: Neighborhood[];
  weekend: { day: string; neighborhood: string; stops: { when: string; place: string; why: string }[] }[];
  limits: string[];
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

export async function matchNeighborhoods(
  env: { QLOO_API_KEY?: string; QLOO_BASE_URL?: string; CACHE: KVNamespace },
  city: string,
  interests: Interest[],
): Promise<MatchResult> {
  const q = new Qloo(env);
  const trace: MatchResult["trace"] = [];
  const center = await cityCenter(env.CACHE, city);
  if (!center) throw new QlooError(`I couldn't find ${city}.`, 400);
  trace.push({ step: "Locate", detail: `${center.name} (${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}) via Open-Meteo geocoding` });

  // 1. Turn each interest into a Qloo entity or tag.
  const resolved: MatchResult["resolved"] = [];
  const unresolved: string[] = [];
  const signals: Signals = { entities: [], tags: [] };
  for (const it of interests.slice(0, 8)) {
    try {
      if (it.kind && it.kind !== "tag" && ENTITY_TYPES[it.kind]) {
        const [e] = await q.search(it.name, ENTITY_TYPES[it.kind], 1);
        if (e) {
          resolved.push({ input: it.name, as: e.name, id: e.id, type: ENTITY_TYPES[it.kind] });
          signals.entities.push(e.id);
          continue;
        }
      }
      const [t] = await q.tags(it.name, 1);
      if (t) {
        resolved.push({ input: it.name, as: t.name, id: t.id, type: t.type ?? "tag" });
        signals.tags.push(t.id);
        continue;
      }
      const [e] = await q.search(it.name, undefined, 1);
      if (e) {
        resolved.push({ input: it.name, as: e.name, id: e.id, type: e.types[0] ?? "entity" });
        signals.entities.push(e.id);
      } else unresolved.push(it.name);
    } catch (err) {
      if (err instanceof QlooError && err.status === 503) throw err;
      unresolved.push(it.name);
    }
  }
  trace.push({
    step: "Understand",
    detail: `${resolved.length} of ${interests.length} interests matched in Qloo's taste graph${unresolved.length ? `; not found: ${unresolved.join(", ")}` : ""}`,
  });
  if (!resolved.length)
    throw new QlooError(
      "None of those interests are in Qloo's graph yet. Try names of artists, shows, films, or kinds of food and activities.",
      422,
    );

  // 2. Where in the city do people who share these tastes concentrate?
  let points: HeatPoint[] = [];
  let boundary = "neighborhood";
  try {
    points = await q.heatmap(signals, city, 80, "neighborhood");
  } catch {}
  if (!points.length || !points.some((p) => p.name)) {
    boundary = "geohash";
    points = await q.heatmap(signals, city, 80);
  }
  trace.push({
    step: "Heatmap",
    detail: `${points.length} ${boundary === "neighborhood" ? "neighborhoods" : "map cells"} scored by Qloo for this taste profile`,
  });
  if (!points.length) throw new QlooError(`Qloo has no heatmap for ${city} with these interests.`, 404);

  // 3. Name the cells and group them into neighborhoods.
  const top = [...points].sort((a, b) => b.affinity - a.affinity).slice(0, 24);
  const groups = new Map<string, { lat: number; lon: number; aff: number[] }>();
  for (const p of top) {
    const name = p.name ?? (await neighborhoodName(env.CACHE, p.lat, p.lon));
    const g = groups.get(name) ?? { lat: 0, lon: 0, aff: [] };
    g.lat += p.lat;
    g.lon += p.lon;
    g.aff.push(p.affinity);
    groups.set(name, g);
  }
  let hoods: Neighborhood[] = [...groups.entries()].map(([name, g]) => ({
    name,
    lat: g.lat / g.aff.length,
    lon: g.lon / g.aff.length,
    affinity: g.aff.reduce((a, b) => a + b, 0) / g.aff.length,
    cells: g.aff.length,
    evidence: [],
  }));
  // Mean affinity, nudged by how many top cells a neighborhood holds (a single hot block is weaker evidence).
  hoods.sort((a, b) => b.affinity * (1 + 0.05 * Math.min(b.cells, 4)) - a.affinity * (1 + 0.05 * Math.min(a.cells, 4)));
  hoods = hoods.slice(0, 5);
  trace.push({
    step: "Name",
    detail: `Grouped the top cells into ${hoods.length} neighborhoods using OpenStreetMap names (Photon reverse geocoding)`,
  });

  // 4. Evidence: the places in each top neighborhood that Qloo ranks highest for the same tastes.
  for (const h of hoods.slice(0, 3)) {
    try {
      h.evidence = (await q.placesNear(signals, h.lat, h.lon, 1200, 5)).filter((e) => e.name);
    } catch {}
  }
  trace.push({ step: "Evidence", detail: `Asked Qloo for the best-matching places within 1.2 km of each of the top 3 neighborhoods` });

  // 5. A weekend to test the move before signing a lease.
  const slot = (e: Entity): string => {
    const t = (e.tags ?? []).join(" ").toLowerCase() + " " + e.name.toLowerCase();
    if (/coffee|cafe|bakery|breakfast|brunch/.test(t)) return "Morning";
    if (/bar|cocktail|brewery|live music|club|music venue|wine/.test(t)) return "Evening";
    return "Afternoon";
  };
  const order = ["Morning", "Afternoon", "Evening"];
  const weekend = hoods.slice(0, 2).map((h, i) => ({
    day: i === 0 ? "Saturday" : "Sunday",
    neighborhood: h.name,
    stops: h.evidence
      .slice(0, 4)
      .map((e) => ({ when: slot(e), place: e.name, why: (e.tags ?? []).slice(0, 2).join(", ") }))
      .sort((a, b) => order.indexOf(a.when) - order.indexOf(b.when)),
  }));
  trace.push({ step: "Plan", detail: `Built a two-day scouting weekend from the evidence places` });

  return {
    city: center.name,
    center: { lat: center.lat, lon: center.lon },
    resolved,
    unresolved,
    neighborhoods: hoods,
    weekend,
    limits: [
      "Qloo affinities describe what groups of people in an area tend to like, not what any one person will do or feel.",
      "Taste fit is one input. Rent, commute, schools and safety are not part of this result.",
      "Neighborhood names come from OpenStreetMap and may not match local usage exactly.",
    ],
    trace,
    calls: q.calls,
  };
}
