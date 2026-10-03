// The Newcomer pipeline: from "here's what I love" to "here are the neighborhoods that already love
// it too, here's the evidence, and here's a weekend to test it". Every step is recorded so the page
// can show which Qloo calls produced which claim, and which parts are Newcomer's own rules.
//
// How the live API behaves (measured 2026-10-03, see submissions/newcomer-REVIEW.md R1-R12):
// - the heatmap returns every ~150 m cell of the city with `affinity` = the cell's percentile;
// - artists, shows, films and music/film genres move the heatmap; food and activity tags don't, but
//   they work as filters on places;
// - every place carries Qloo's own neighborhood name and time-of-day fit.

import { Qloo, QlooError, normalizeName, type Entity, type HeatPoint, type Signals, type Tag } from "./qloo.ts";
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
  as: string; // the Qloo name it matched (with a year or similar when Qloo has several)
  id: string;
  type: string;
  signal: "entity" | "tag";
  // exact: one Qloo name matched; ambiguous: several things share that exact name (the first is
  // used); closest: no exact name, the top candidate is used; chosen: the person picked it.
  match: "exact" | "ambiguous" | "closest" | "chosen";
  alternatives: Choice[];
  kind?: Kind;
  use: ("map" | "places")[]; // where this signal acts: the taste map, the places, or both
  placeTag?: string; // for a taste: the tag variant that applies to places (ramen as a cuisine)
}

export interface Neighborhood {
  name: string;
  lat: number;
  lon: number;
  affinity: number; // map mode: mean percentile of its cells in the city (0 to 1); places mode: share of the matching places
  cells: number; // map mode: map cells; places mode: matching places
  evidence: Entity[]; // places here that Qloo ranks highly for the same tastes
  matches: Entity[]; // places here that ARE one of your food or activity tastes
}

export interface MatchResult {
  city: string;
  center: { lat: number; lon: number };
  qlooCity?: string; // the locality Qloo used, in Qloo's words
  mode: "map" | "places"; // map: Qloo's taste heatmap; places: only food/activity tastes, ranked by matching places
  resolved: Resolved[];
  unresolved: string[];
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
const MEDIA = ["urn:entity:artist", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:book", "urn:entity:podcast"];

const TAG_ID = /^urn:tag:[\w:.\-]+$/i;
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validQlooId = (id: string) => TAG_ID.test(id) || ENTITY_ID.test(id);

// Errors that mean "this one interest isn't in Qloo"; anything else (key refused, rate limit,
// timeouts) stops the search with its real message instead of turning into "not found".
const notFound = (e: unknown) => e instanceof AppError && (e.status === 400 || e.status === 404);

const label = (e: Entity) => (e.disambiguation && normalizeName(e.disambiguation) !== normalizeName(e.name) ? `${e.name} (${e.disambiguation})` : e.name);

// Qloo's search (semantic search above all) always returns something, even for "zzqx". A candidate
// that isn't the exact name is only accepted if it resembles what was typed: one contains the other,
// or at least half the typed words appear in it, allowing a typo or two (swapped letters count once).
const STOP = new Set(["the", "a", "an", "of", "and", "&"]);
const words = (s: string) => normalizeName(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
function typoDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
export function resembles(typed: string, name: string): boolean {
  const a = words(typed), b = words(name);
  if (!a.length || !b.length) return false;
  const A = a.join(" "), B = b.join(" ");
  if (A === B || B.includes(A) || A.includes(B)) return true;
  const close = (w: string) => b.some((x) => x === w || typoDistance(w, x) <= (w.length > 5 ? 2 : w.length > 3 ? 1 : 0));
  return a.filter(close).length / a.length >= 0.5;
}

// Tags that change the taste map: music genres (jazz), and film/TV/book genres when the word has no
// place meaning. Activities like bouldering also exist as film subgenres; those go to places only.
const genre = (t: Tag) => /^urn:tag:(genre|subgenre):/.test(t.id);
const musicTag = (t: Tag) => genre(t) && t.parents.includes("urn:entity:artist");
const mediaTag = (t: Tag) => genre(t) && t.parents.some((p) => MEDIA.includes(p));
const placeTag = (t: Tag) => t.parents.includes("urn:entity:place");
// A tag picked by the person: cuisines, activities and the like filter places; genres go on the map.
const placeFamily = (id: string) => /^urn:tag:(cuisine|activity_type|specialty_dish|setting|amenity|interests|category|genre:place)[:]/.test(id);

const TYPE_WORD: Record<string, string> = {
  "urn:entity:artist": "artist", "urn:entity:movie": "film", "urn:entity:tv_show": "TV show", "urn:entity:book": "book",
  "urn:entity:podcast": "podcast", "urn:entity:video_game": "game", "urn:entity:brand": "brand", "urn:entity:place": "place",
};
const choice = (e: Entity): Choice => ({ id: e.id, name: label(e), type: TYPE_WORD[e.types[0] ?? ""] ?? "entity" });

async function resolveEntity(q: Qloo, it: Interest, type?: string): Promise<Resolved | null> {
  const found = await q.search(it.name, type, 5);
  const exact = found.filter((e) => normalizeName(e.name) === normalizeName(it.name));
  const list = found.filter((e) => exact.includes(e) || resembles(it.name, e.name));
  if (!list.length) return null;
  const pick = exact[0] ?? list[0];
  const match: Resolved["match"] = exact.length === 1 ? "exact" : exact.length > 1 ? "ambiguous" : "closest";
  let others = list.filter((e) => e.id !== pick.id);
  // The kind was the model's guess ("Dune" as a book): when the match is uncertain, offer the same
  // name in every kind too, so the person can pick the film.
  if (match !== "exact" && type) {
    const anyKind = (await q.search(it.name, undefined, 5).catch(() => [])).filter((e) => e.id !== pick.id && resembles(it.name, e.name) && !others.some((o) => o.id === e.id));
    others = [...others.slice(0, 2), ...anyKind.slice(0, 3), ...others.slice(2)];
  }
  return {
    input: it.name,
    as: label(pick),
    id: pick.id,
    type: pick.types[0] ?? type ?? "entity",
    signal: "entity",
    match,
    alternatives: others.slice(0, 5).map(choice),
    kind: it.kind,
    use: pick.types.includes("urn:entity:place") ? ["places"] : ["map"],
  };
}

// A taste (ramen, bouldering, jazz) can have a map variant (a genre) and a place variant (a cuisine,
// an activity): Qloo lists the same name in many families, each with the entity types it applies to.
async function resolveTag(q: Qloo, it: Interest): Promise<Resolved | null> {
  const list = (await q.tags(it.name, 20)).filter((t) => resembles(it.name, t.name));
  if (!list.length) return null;
  const exact = list.filter((t) => normalizeName(t.name) === normalizeName(it.name));
  const pool = exact.length ? exact : list;
  const forPlaces = pool.find(placeTag);
  // Yoga and skateboarding are also music genres; when the word means an activity or a food, its
  // music namesake isn't what the person meant. Jazz and techno keep both (their place tag is a venue).
  const activityOrFood = forPlaces && /^urn:tag:(activity_type|cuisine|specialty_dish|popular_food_item):/.test(forPlaces.id);
  const forMap = activityOrFood ? undefined : (pool.find(musicTag) ?? (forPlaces ? undefined : pool.find(mediaTag)));
  // A tag that is neither a genre nor about places can't place anyone in a neighborhood.
  if (!forMap && !forPlaces) return null;
  const pick = forMap ?? forPlaces!;
  const names = new Set([normalizeName(pick.name)]);
  const alternatives = list
    .filter((t) => {
      const n = normalizeName(t.name);
      if (names.has(n)) return false;
      names.add(n);
      return true;
    })
    .slice(0, 4)
    .map((t) => ({ id: t.id, name: t.name, type: t.type ?? "tag" }));
  const use: Resolved["use"] = [];
  if (forMap) use.push("map");
  if (forPlaces) use.push("places");
  return {
    input: it.name,
    as: pick.name,
    id: pick.id,
    type: pick.type ?? "tag",
    signal: "tag",
    match: exact.length ? "exact" : "closest",
    alternatives,
    kind: it.kind,
    use,
    ...(forPlaces ? { placeTag: forPlaces.id } : {}),
  };
}

async function resolveOne(q: Qloo, it: Interest): Promise<Resolved | null> {
  if (it.id && validQlooId(it.id)) {
    const isTag = TAG_ID.test(it.id);
    const onPlaces = isTag && placeFamily(it.id);
    return {
      input: it.name,
      as: it.as ?? it.name,
      id: it.id,
      type: isTag ? "tag" : "entity",
      signal: isTag ? "tag" : "entity",
      match: "chosen",
      alternatives: [],
      kind: it.kind,
      use: onPlaces ? ["places"] : ["map"],
      ...(onPlaces ? { placeTag: it.id } : {}),
    };
  }
  const entityType = it.kind && it.kind !== "tag" ? ENTITY_TYPES[it.kind] : undefined;
  // At most two lookups per interest: its own kind first, then the other kind.
  return entityType ? ((await resolveEntity(q, it, entityType)) ?? (await resolveTag(q, it))) : ((await resolveTag(q, it)) ?? (await resolveEntity(q, it)));
}

export async function matchNeighborhoods(
  env: { QLOO_API_KEY?: string; QLOO_BASE_URL?: string; CACHE: KVNamespace },
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
  const interests = interestsIn
    .filter((i) => {
      const k = i.id ?? normalizeName(i.name);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);
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
  const same: string[] = []; // two of your words for one Qloo thing
  outcomes.forEach((r, i) => {
    if (!r) return void unresolved.push(interests[i].name);
    const first = resolved.find((x) => x.id === r.id);
    if (first) same.push(`${r.input} is the same as ${first.input}`);
    else resolved.push(r);
  });
  const unsure = resolved.filter((r) => r.match === "closest" || r.match === "ambiguous");
  trace.push({
    step: "Understand",
    detail:
      `${resolved.length + same.length} of ${interests.length} interests matched in Qloo's taste graph` +
      (same.length ? ` (${same.join("; ")})` : "") +
      (unsure.length ? `; worth checking: ${unsure.map((r) => `${r.input} → ${r.as} (${r.match === "closest" ? "closest name" : "several share this name"})`).join(", ")}` : "") +
      (unresolved.length ? `; not found: ${unresolved.join(", ")}` : ""),
  });
  if (!resolved.length)
    throw new AppError("None of those interests are in Qloo's graph. Try names of artists, shows, films, or kinds of food and activities.", 422);

  const mapSignals: Signals = {
    entities: resolved.filter((r) => r.signal === "entity" && r.use.includes("map")).map((r) => r.id),
    tags: resolved.filter((r) => r.signal === "tag" && r.use.includes("map")).map((r) => r.id),
  };
  // Places you named (a favorite restaurant) steer the place rankings too.
  const placeSignals: Signals = { entities: [...mapSignals.entities, ...resolved.filter((r) => r.signal === "entity" && r.use.includes("places")).map((r) => r.id)], tags: mapSignals.tags };
  const filterTags = [...new Set(resolved.map((r) => r.placeTag).filter((x): x is string => !!x))];
  let mode: MatchResult["mode"] = mapSignals.entities.length + mapSignals.tags.length > 0 ? "map" : "places";
  if (mode === "places" && !filterTags.length && !placeSignals.entities.length)
    throw new AppError("Qloo couldn't use these interests to compare neighborhoods. Add an artist, a show or a film you love.", 422);

  let hoods: Neighborhood[] = [];
  let qlooCity: string | undefined;

  let heat: Awaited<ReturnType<Qloo["heatmap"]>> = { points: [] };
  let cityMatches: Entity[] = [];
  if (mode === "map") {
    // 2. Where in the city do people who share these tastes concentrate? Qloo is asked about the
    // same city Newcomer located, and the locality it used is checked against it.
    heat = await q.heatmap(mapSignals, { query: center.query });
    const offBy = heat.locality ? km(heat.locality, center) : heat.points.length ? medianKm(heat.points, center) : 0;
    if (!heat.points.length || offBy > 50) {
      trace.push({
        step: "Check",
        detail: `Qloo's area for "${center.query}" ${heat.points.length ? `was ${Math.round(offBy)} km from the located city` : "was empty"}; asked again for 25 km around the city centre`,
      });
      heat = await q.heatmap(mapSignals, { lat: center.lat, lon: center.lon, radiusM: 25000 });
      if (heat.points.length && medianKm(heat.points, center) > 50)
        throw new AppError(`Qloo's map didn't line up with ${center.name}, so no neighborhoods are shown. Try the city with its state or country.`, 502);
    }
    qlooCity = heat.locality?.name;
    trace.push({ step: "Heatmap", detail: `Qloo scored ${heat.points.length} map cells${qlooCity ? ` in ${qlooCity}` : ""} for this taste profile` });
    if (!heat.points.length && !filterTags.length) throw new AppError(`Qloo has no taste map for ${center.name} with these interests.`, 404);
    if (!heat.points.length) mode = "places"; // no map for these signals, but the place tastes can still rank neighborhoods
  }
  if (mode === "map") {
    // 3. Areas: squares of about 1 km (2.4 km where Qloo's cells are coarser), ranked by the mean
    // percentile of all their cells (Newcomer's rule, labeled on the page), so one hot block doesn't
    // outrank a whole hot area.
    // Your kinds of places (one city-wide call) also count: an area with ramen shops and natural wine
    // bars within reach gets a small boost (Newcomer's rule, labeled), so the food and activity tastes
    // you typed change which neighborhoods are chosen, not only what is listed.
    const candidates = rankAreas(heat.points, 25);
    if (filterTags.length) {
      try {
        cityMatches = (await q.places(placeSignals, { query: center.query }, 50, filterTags)).filter((p) => p.lat !== undefined && p.lon !== undefined && visitable(p));
      } catch {
        degraded = true;
      }
    }
    const reach = Math.max(1.2, areaKm(heat.points) * 0.75);
    const nearby = new Map(candidates.map((h) => [h, cityMatches.filter((p) => km(h, { lat: p.lat!, lon: p.lon! }) <= reach).length]));
    const boosted = (h: Neighborhood) => h.affinity + 0.03 * Math.min(nearby.get(h) ?? 0, 3);
    hoods = [...candidates].sort((a, b) => boosted(b) - boosted(a)).slice(0, 7);
    trace.push({
      step: "Areas",
      detail:
        `Grouped the cells into areas of about ${areaKm(heat.points)} km and kept the 7 with the highest mean affinity` +
        (cityMatches.length ? `, counting your kinds of places within ${reach.toFixed(1)} km (Qloo found ${cityMatches.length} in the city)` : ""),
    });

    // 4. Evidence: the places Qloo ranks highest for the same tastes around each area, three calls at
    // a time (Qloo answers 429 to a burst of seven).
    await inBatches(hoods, 3, async (h) => {
      try {
        h.evidence = await q.places(placeSignals, { lat: h.lat, lon: h.lon, radiusM: 1200 }, 8);
      } catch {
        degraded = true;
      }
    });
  } else {
    // Only food and activity tastes: Qloo's heatmap doesn't use them, so the areas are where the
    // places that match them concentrate (one city-wide place search).
    trace.push({
      step: "Heatmap",
      detail: heat.points.length || !(mapSignals.entities.length + mapSignals.tags.length)
        ? "No artists, shows, films or genres to map; Qloo's taste map works from those, so the areas come from matching places instead"
        : "Qloo's taste map was empty for these signals, so the areas come from the places that match your food and activity tastes instead",
    });
    const found = await q.places(placeSignals, { query: center.query }, 50, filterTags);
    hoods = rankByPlaces(found, center);
    trace.push({ step: "Areas", detail: `Qloo found ${found.length} places that match your food and activity tastes; grouped them by Qloo neighborhood` });
  }

  // Name each area from Qloo's own neighborhood field; OpenStreetMap (Photon) only where Qloo has none.
  // A neighborhood named like the city itself ("Brooklyn" in Brooklyn) says nothing; skip it.
  const cityWords = new Set([center.name.split(",")[0], qlooCity?.split(",")[0] ?? ""].map(nameKey).filter(Boolean));
  for (const h of hoods)
    if (!h.name) h.name = mostCommon([...h.evidence, ...h.matches].map((e) => e.neighborhood).filter((n): n is string => !!n && !cityWords.has(nameKey(n)))) ?? "";
  for (const h of hoods) if (cityWords.has(nameKey(h.name))) h.name = "";
  const unnamed = hoods.filter((h) => !h.name);
  if (unnamed.length) {
    const r = await namesFor(env.CACHE, budget, center.name, unnamed, 3);
    for (const h of unnamed) h.name = r.names.get(cellKey(h.lat, h.lon)) ?? "";
    if (r.missing) trace.push({ step: "Name", detail: `${r.missing} area${r.missing === 1 ? "" : "s"} had no neighborhood name in Qloo or OpenStreetMap and ${r.missing === 1 ? "was" : "were"} left out` });
  }
  hoods = mergeByName(hoods.filter((h) => h.name)).slice(0, 5);
  if (!hoods.length) throw new AppError(`Qloo scored ${center.name}, but none of the top areas could be named. Please try again later.`, 502);
  trace.push({ step: "Name", detail: `Named the areas from Qloo's place data (the neighborhood of the places found there)${unnamed.length ? `; OpenStreetMap for ${unnamed.length} without one` : ""}` });

  // 5. Your kinds of places (found before the ranking) go under the neighborhood within reach. Qloo's
  // city filter reaches a bit past the city: a Manhattan bar must not be listed under Williamsburg.
  if (mode === "map" && cityMatches.length) {
    const reach = Math.max(1.2, areaKm(heat.points) * 0.75);
    let kept = 0;
    for (const p of cityMatches) {
      const at = { lat: p.lat!, lon: p.lon! };
      const near = [...hoods].sort((a, b) => km(a, at) - km(b, at))[0];
      if (near && km(near, at) <= reach) {
        near.matches.push(p);
        kept++;
      }
    }
    trace.push({ step: "Your places", detail: `Qloo found ${cityMatches.length} places in the city that are one of your food or activity tastes; ${kept} are in the neighborhoods shown` });
  }
  const dropped = dedupeEvidence(hoods);
  if (dropped) trace.push({ step: "Filter", detail: `Left out ${dropped} ${dropped === 1 ? "place" : "places"} a newcomer can't visit (schools, offices, places of worship, stations, studios and the like)` });

  // 6. A weekend to test the move before signing a lease: one place per part of the day, from
  // Qloo's time-of-day fit for each place.
  const weekend = hoods
    .slice(0, 2)
    .map((h, i) => ({ day: i === 0 ? "Saturday" : "Sunday", neighborhood: h.name, stops: planDay([...h.matches, ...h.evidence]) }))
    .filter((d) => d.stops.length);
  trace.push({ step: "Plan", detail: weekend.length ? `Built a scouting weekend from those places, by Qloo's time-of-day fit` : `Not enough places for a weekend plan` });

  return {
    city: center.name,
    center: { lat: center.lat, lon: center.lon },
    ...(qlooCity ? { qlooCity } : {}),
    mode,
    resolved,
    unresolved,
    neighborhoods: hoods,
    weekend,
    limits: [
      "Qloo affinities describe what groups of people in an area tend to like, not what any one person will do or feel.",
      "Taste fit is one input. Rent, commute, schools and safety are not part of this result.",
      "Food and activity tastes choose the places shown; Qloo's taste map itself comes from artists, shows, films, books, podcasts and genres.",
      "Neighborhood names are Qloo's (from its place data) and may not match local usage exactly.",
    ],
    ours: [
      mode === "map"
        ? "Areas are squares of about 1 km (2.4 km where Qloo's cells are coarser) ranked by the mean Qloo percentile of all their map cells, so one hot block can't outrank a whole hot area, plus 0.03 for each of your kinds of places within reach, up to three (Newcomer's rules)."
        : "With only food and activity tastes, neighborhoods are ranked by how many matching places Qloo found there (Newcomer's rule).",
      "Each weekend stop is the best-ranked place for that part of the day by Qloo's time-of-day tags; tattoo shops, salons and hotels are skipped unless they serve food or drink (Newcomer's rules).",
      "Schools, offices, places of worship, transit stations, recording studios and similar places are left out of the lists, since a newcomer can't visit them (Newcomer's rule).",
      ...(unsure.length ? ["Where a name wasn't one exact match, the first Qloo candidate was used; you can pick another."] : []),
    ],
    degraded,
    trace,
    calls: q.calls,
  };
}

function medianKm(ps: { lat: number; lon: number }[], c: { lat: number; lon: number }): number {
  const d = ps
    .slice(0, 15)
    .map((p) => km(p, c))
    .sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 0;
}

function emptyHood(lat: number, lon: number, affinity: number, cells: number): Neighborhood {
  return { name: "", lat, lon, affinity, cells, evidence: [], matches: [] };
}

// Qloo's cells are geohash-7 (~150 m) in a city and geohash-6 (~1.2 x 0.6 km) over a big county.
function cellLength(points: HeatPoint[]): number {
  const n = new Map<number, number>();
  for (const p of points.slice(0, 200)) if (p.geohash) n.set(p.geohash.length, (n.get(p.geohash.length) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 7;
}
const areaStep = (len: number) => (len >= 7 ? 0.01 : len === 6 ? 0.022 : 0); // degrees: about 1 km, about 2.4 km, or the cell itself
export const areaKm = (points: HeatPoint[]) => (cellLength(points) >= 7 ? 1 : cellLength(points) === 6 ? 2.4 : 5);

// Group cells on a grid sized to the cells, and rank squares by the mean percentile of all their
// cells. Squares with few cells sit on the city's edge: they need about 40% of a full square.
export function rankAreas(points: HeatPoint[], keep = 7): Neighborhood[] {
  const len = cellLength(points);
  const step = areaStep(len);
  const minCells = len >= 7 ? 6 : len === 6 ? 3 : 1;
  const groups = new Map<string, { lat: number; lon: number; sum: number; n: number }>();
  for (const p of points) {
    const key = step ? `${Math.floor(p.lat / step)},${Math.floor(p.lon / step)}` : (p.geohash ?? `${p.lat},${p.lon}`);
    const g = groups.get(key) ?? { lat: 0, lon: 0, sum: 0, n: 0 };
    g.lat += p.lat;
    g.lon += p.lon;
    g.sum += p.affinity;
    g.n++;
    groups.set(key, g);
  }
  const all = [...groups.values()].map((g) => ({ lat: g.lat / g.n, lon: g.lon / g.n, mean: g.sum / g.n, n: g.n }));
  // Well-covered squares first; sparse ones only fill in after them.
  const byMean = (a: { mean: number }, b: { mean: number }) => b.mean - a.mean;
  const full = all.filter((g) => g.n >= minCells).sort(byMean);
  const sparse = all.filter((g) => g.n < minCells).sort(byMean);
  return [...full, ...sparse].slice(0, keep).map((g) => emptyHood(g.lat, g.lon, g.mean, g.n));
}

// Places-only mode: neighborhoods by how many matching places Qloo found there.
function rankByPlaces(found: Entity[], center: { lat: number; lon: number }): Neighborhood[] {
  const groups = new Map<string, Entity[]>();
  for (const p of found) {
    if (p.lat === undefined || p.lon === undefined || km({ lat: p.lat, lon: p.lon }, center) > 40) continue;
    const key = p.neighborhood ?? `@${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const total = Math.max(1, found.length);
  return [...groups.entries()]
    .map(([key, ps]) => {
      const h = emptyHood(ps.reduce((a, p) => a + p.lat!, 0) / ps.length, ps.reduce((a, p) => a + p.lon!, 0) / ps.length, ps.length / total, ps.length);
      h.name = key.startsWith("@") ? "" : key;
      h.matches = ps;
      return h;
    })
    .sort((a, b) => b.cells - a.cells || b.affinity - a.affinity)
    .slice(0, 7);
}

const nameKey = (s: string) => normalizeName(s).replace(/^the\s+/, "");

function mostCommon(xs: string[]): string | undefined {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// Two squares that Qloo puts in the same neighborhood become one entry (the better score, all places).
function mergeByName(hoods: Neighborhood[]): Neighborhood[] {
  const out: Neighborhood[] = [];
  for (const h of hoods) {
    const same = out.find((o) => nameKey(o.name) === nameKey(h.name));
    if (!same) out.push(h);
    else {
      same.cells += h.cells;
      same.evidence.push(...h.evidence);
      same.matches.push(...h.matches);
    }
  }
  return out;
}

// A place is listed once, under the neighborhood nearest to it, best-ranked first; places a newcomer
// can't visit are left out before the lists are cut to size. Returns how many were left out.
function dedupeEvidence(hoods: Neighborhood[]): number {
  let left = 0;
  for (const field of ["matches", "evidence"] as const) {
    const all = new Map<string, Entity>();
    for (const h of hoods) for (const e of h[field]) if (!all.has(e.id)) all.set(e.id, e);
    for (const h of hoods) h[field] = [];
    for (const e of all.values()) {
      if (!visitable(e)) {
        left++;
        continue;
      }
      const at = e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : null;
      const home = at ? [...hoods].sort((a, b) => km(a, at) - km(b, at))[0] : hoods[0];
      home[field].push(e);
    }
    for (const h of hoods) h[field] = h[field].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).slice(0, field === "matches" ? 4 : 5);
  }
  // A place that is one of your tastes isn't listed again among the taste places.
  for (const h of hoods) h.evidence = h.evidence.filter((e) => !h.matches.some((m) => m.id === e.id));
  return left;
}

// Judged on Qloo's categories only: a venue's name ("The Garage", "Temple Bar") says nothing.
const NOT_VISITABLE = /\b(schools?|high school|college|university|academy|training cent(er|re)|church|place of worship|mosque|synagogue|temple|hospital|clinic|medical|dentist|doctor|pharmacy|office|corporate|government|municipal|department of|city hall|courthouse|police|fire station|fire department|cemetery|funeral|apartment|condominium|housing|storage|parking|garage|bank|atm|gas station|car dealer|auto repair|insurance|real estate|lawyer|attorney|recording studio|post office|business center|senior citizen|(subway|train|railway|metro|bus|transit) station)\b/i;
const visitable = (e: Entity) => !NOT_VISITABLE.test((e.tags ?? []).join(" | "));

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// A tattoo shop, a salon or a hotel can show the area's taste, but isn't a stop on a scouting
// weekend unless it also serves food or drink, or is a venue.
const NEVER_A_STOP = /\b(rv park|campground|motel|wedding venue|adult entertainment|strip club|sex shop)\b/i;
const NOT_A_STOP = /\b(personal care|tattoo|piercing|salon|nail|barber|spa|lash|eyelash|waxing|lodging|hotel|resort)\b/i;
const GO_TO = /\b(bar|pub|restaurant|cafe|café|coffee|bakery|brewery|winery|museum|gallery|park|beach|music venue|live music|concert|theater|theatre|cinema|book ?store|record store|market)\b/i;
export const weekendStop = (e: Entity) => {
  const t = (e.tags ?? []).join(" | ");
  if (NEVER_A_STOP.test(t)) return false;
  return !NOT_A_STOP.test(t) || GO_TO.test(t);
};

const SLOTS: [string, string[]][] = [
  ["Morning", ["Early morning", "Morning"]],
  ["Afternoon", ["Midday", "Afternoon", "All day"]],
  ["Evening", ["Evening", "Late night"]],
];

// One place per part of the day, best-ranked first, from Qloo's time-of-day fit. A place without
// time tags can fill the afternoon.
export function planDay(places: Entity[]): { when: string; place: string; why: string }[] {
  const used = new Set<string>(); // ids and names: two branches of one chain aren't two stops
  const stops: { when: string; place: string; why: string }[] = [];
  for (const [slotName, fits] of SLOTS) {
    const p = places.find(
      (e) => weekendStop(e) && !used.has(e.id) && !used.has(normalizeName(e.name)) && ((e.times ?? []).some((t) => fits.includes(t)) || (slotName === "Afternoon" && !(e.times ?? []).length)),
    );
    if (!p) continue;
    used.add(p.id);
    used.add(normalizeName(p.name));
    stops.push({ when: slotName, place: p.name, why: (p.tags ?? []).slice(0, 2).join(", ") });
  }
  return stops;
}
