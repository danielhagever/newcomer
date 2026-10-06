// The Newcomer pipeline: from "here's what I love" to "here are the neighborhoods that already love
// it too, here's the evidence, and here's a weekend to test it". Every step is recorded so the page
// can show which Qloo calls produced which claim, and which parts are Newcomer's own rules.
//
// How the live API behaves (measured 2026-10-03, see submissions/newcomer-REVIEW.md R1-R12):
// - the heatmap returns every ~150 m cell of the city with `affinity` = the cell's percentile;
// - artists, shows, films and music/film genres move the heatmap; food and activity tags don't, but
//   they work as filters on places;
// - every place carries Qloo's own neighborhood name and time-of-day fit.

import { Qloo, QlooError, normalizeName, type Entity, type HeatPoint, type Locality, type QlooEnv, type Signals, type Tag, type Where } from "./qloo.ts";
import { forSearch, nameKey as typedName, rankNames, resembles, together, withoutNote } from "./names.ts";
export { resembles };
import { cityCenter, cellKey, km, namesFor } from "./geo.ts";
import { AppError, type Budget } from "./limits.ts";

export type Kind = "artist" | "movie" | "tv_show" | "book" | "podcast" | "video_game" | "brand" | "place" | "tag";
export const KINDS: Kind[] = ["artist", "movie", "tv_show", "book", "podcast", "video_game", "brand", "place", "tag"];

export interface Interest {
  name: string; // as the person wrote it (shown back to them)
  query?: string; // the English name to look up in Qloo, when what was written isn't English ("פאודה" -> "Fauda")
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
  query?: string; // the English name it was looked up by, when different
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
  score: number; // what the order is by: affinity plus Newcomer's boost for your kinds of places nearby
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
  computedAt: number; // when Qloo was asked (a cached result keeps its time)
}

const ENTITY_TYPES: Record<string, string> = {
  artist: "urn:entity:artist",
  movie: "urn:entity:movie",
  tv_show: "urn:entity:tv_show",
  book: "urn:entity:book",
  podcast: "urn:entity:podcast",
  video_game: "urn:entity:videogame", // Qloo answers 400 to "video_game" (measured 2026-10-05)
  brand: "urn:entity:brand",
  place: "urn:entity:place",
};
const KIND_OF = Object.fromEntries(Object.entries(ENTITY_TYPES).map(([k, t]) => [t, k as Kind]));
const MEDIA = ["urn:entity:artist", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:book", "urn:entity:podcast"];

const TAG_ID = /^urn:tag:[\w:.\-]+$/i;
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validQlooId = (id: string) => TAG_ID.test(id) || ENTITY_ID.test(id);

// Errors that mean "this one interest isn't in Qloo"; anything else (key refused, rate limit,
// timeouts) stops the search with its real message instead of turning into "not found".
const notFound = (e: unknown) => e instanceof AppError && (e.status === 400 || e.status === 404);

// Qloo's disambiguations can hold runs of spaces ("1986, Stephen        King").
const label = (e: Entity) => {
  const d = e.disambiguation?.replace(/\s+/g, " ").trim();
  return d && normalizeName(d) !== normalizeName(e.name) ? `${e.name} (${d})` : e.name;
};

// Qloo's search (semantic search above all) always returns something, even for "zzqx": names are matched
// and ranked by names.ts (an exact name first, else only a candidate that resembles what was typed).
// Tags that change the taste map: music genres (jazz), and film/TV/book genres when the word has no
// place meaning. Activities like bouldering also exist as film subgenres; those go to places only.
const genre = (t: Tag) => /^urn:tag:(genre|subgenre):/.test(t.id);
const musicTag = (t: Tag) => genre(t) && t.parents.includes("urn:entity:artist");
const mediaTag = (t: Tag) => genre(t) && t.parents.some((p) => MEDIA.includes(p));
const placeTag = (t: Tag) => t.parents.includes("urn:entity:place");
// A tag picked by the person is used by its ID's family: tags about places (cuisines, activities,
// settings, what a place is good for...) filter places; genres go on the map. Families measured
// 2026-10-03 on /v2/tags (farmers markets, brunch, bookstores, hiking, yoga, street art).
const placeFamily = (id: string) =>
  /^urn:tag:((cuisine|activity_type|specialty_dish|setting|amenity|interests|category|good_for|dining_option|view|decor|activities)[:]|[a-z_]+:place:)/.test(id);
// "Not it?" only offers a tag that can act, and acts the same way when picked by its ID.
const canAct = (t: Tag) => (placeFamily(t.id) ? placeTag(t) : musicTag(t) || mediaTag(t));

const TYPE_WORD: Record<string, string> = {
  "urn:entity:artist": "artist", "urn:entity:movie": "film", "urn:entity:tv_show": "TV show", "urn:entity:book": "book",
  "urn:entity:podcast": "podcast", "urn:entity:videogame": "game", "urn:entity:brand": "brand", "urn:entity:place": "place",
};
const choice = (e: Entity): Choice => ({ id: e.id, name: label(e), type: TYPE_WORD[e.types[0] ?? ""] ?? "entity" });

const term = (it: Interest) => it.query ?? it.name;

const SPARE_FOR_NAMES = 20;

async function resolveEntity(q: Qloo, it: Interest, type?: string): Promise<Resolved | null> {
  const found = await q.search(forSearch(term(it)), type, 5);
  let ranked = rankNames(found, term(it));
  // With a note in brackets, the name alone is searched too when that may find a better entry (see Ranked), but
  // only while the request has calls to spare for the map and the area names (measured: 8 films with a note
  // used 41 of 44 and left 3 areas unnamed).
  if (withoutNote(term(it)) !== term(it) && (!ranked || ranked.searchName) && q.budget.left() > SPARE_FOR_NAMES)
    ranked = rankNames(together(found, await q.search(withoutNote(term(it)), type, 5)), term(it));
  if (!ranked) return null;
  const { pick, match } = ranked;
  let others = ranked.list.filter((e) => e.id !== pick.id && ranked.offered(e));
  // The kind was the model's guess ("Dune" as a book): when the match is uncertain, offer the same
  // name in every kind too, so the person can pick the film.
  if (match !== "exact" && type && q.budget.left() > SPARE_FOR_NAMES) {
    const any = rankNames(await q.search(withoutNote(term(it)), undefined, 5).catch(() => []), term(it));
    const anyKind = (any?.list ?? []).filter((e) => e.id !== pick.id && any!.offered(e) && !others.some((o) => o.id === e.id));
    others = [...others.slice(0, 2), ...anyKind.slice(0, 3), ...others.slice(2)];
  }
  return {
    input: it.name,
    ...(it.query ? { query: it.query } : {}),
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
// (Accents are folded before the check: "à" is "a".)
const ROMANCE = new Set(["al", "alla", "alle", "allo", "del", "della", "delle", "dello", "de", "du", "des", "a", "au", "aux", "la", "le", "les", "el", "los", "las"]);
async function resolveTag(q: Qloo, it: Interest): Promise<Resolved | null> {
  // A note in brackets isn't a taste: "Moonsprout (indie rock band)" is not the Indie Rock genre.
  const text = withoutNote(term(it));
  // A dish's joining word is part of its name: "al pastor" is not the music genre "pastor" (live: Qloo's tag search for
  // "al pastor" finds only pastor tags, and the genre moved Mexico City's map to the suburbs). A tag may leave such a
  // word out only when two or more other words were typed, which it must then resemble ("al fresco dining" is Alfresco
  // Dining, live); English small words ("and", "the") may be left out as before.
  const typed = typedName(text).split(" ");
  const keeps = (t: Tag) => typed.filter((w) => !ROMANCE.has(w)).length >= 2 || typed.every((w) => !ROMANCE.has(w) || typedName(t.name).split(" ").includes(w));
  const list = (await q.tags(text, 20)).filter((t) => resembles(text, t.name) && keeps(t));
  if (!list.length) return null;
  // An exact name only counts if one of its tags can act (a media keyword alone can't); otherwise the
  // closest tag that can act is used, flagged as closest.
  const exact = list.filter((t) => typedName(t.name) === typedName(text) && (placeTag(t) || musicTag(t) || mediaTag(t)));
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
    .filter(canAct)
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
    ...(it.query ? { query: it.query } : {}),
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
    // A picked ID is looked up, so its own type decides what it acts on (live: "Blue Note" as a place offers the jazz
    // club, the label and the artist; the artist picked there went on the places), and an ID Qloo doesn't know is
    // reported as not found instead of failing the whole search (live: a made-up ID made the taste map a 400).
    const isTag = TAG_ID.test(it.id);
    const tag = isTag ? (await q.tagsByIds([it.id]))[0] : undefined;
    const entity = isTag ? undefined : (await q.byIds([it.id]))[0];
    if (!tag && !entity) return null;
    const onPlaces = tag ? placeFamily(tag.id) : entity!.types.includes("urn:entity:place");
    return {
      input: it.name,
      ...(it.query ? { query: it.query } : {}),
      as: tag ? tag.name : label(entity!),
      id: it.id,
      type: tag ? (tag.type ?? "tag") : (entity!.types[0] ?? "entity"),
      signal: isTag ? "tag" : "entity",
      match: "chosen",
      alternatives: [],
      kind: tag ? "tag" : (KIND_OF[entity!.types[0] ?? ""] ?? it.kind),
      use: onPlaces ? ["places"] : ["map"],
      ...(onPlaces && isTag ? { placeTag: it.id } : {}),
    };
  }
  const entityType = it.kind && it.kind !== "tag" ? ENTITY_TYPES[it.kind] : undefined;
  // At most two lookups per interest: its own kind first, then the other kind.
  return entityType ? ((await resolveEntity(q, it, entityType)) ?? (await resolveTag(q, it))) : ((await resolveTag(q, it)) ?? (await resolveEntity(q, it)));
}

export async function matchNeighborhoods(
  env: QlooEnv & { CACHE: KVNamespace },
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
      const k = i.id ?? normalizeName(term(i));
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
      `${resolved.length + same.length} of ${interests.length} ${interests.length === 1 ? "interest" : "interests"} matched in Qloo's taste graph` +
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
  // What the places are matched to, in words: a place named alone isn't a food or activity taste ("Joe's Pizza").
  const yours = [filterTags.length ? "your food and activity tastes" : "", resolved.some((r) => r.signal === "entity" && r.use.includes("places")) ? "the places you named" : ""].filter(Boolean).join(" and "); // places mode always has one or both (else a 422 or 404 above)
  let mode: MatchResult["mode"] = mapSignals.entities.length + mapSignals.tags.length > 0 ? "map" : "places";
  if (mode === "places" && !filterTags.length && !placeSignals.entities.length)
    throw new AppError("Qloo couldn't use these interests to compare neighborhoods. Add an artist, a show or a film you love.", 422);

  let hoods: Neighborhood[] = [];
  let qlooCity: string | undefined;

  let heat: Awaited<ReturnType<Qloo["heatmap"]>> = { points: [] };
  let cityMatches: Entity[] = [];
  let around: Where = { query: center.query }; // where the city is: asked by name, or around its centre once that proved wrong
  if (mode === "map") {
    // 2. Where in the city do people who share these tastes concentrate? Qloo is asked about the
    // same city Newcomer located, and the locality it used is checked against it.
    heat = await q.heatmap(mapSignals, around);
    const offBy = heat.locality ? km(heat.locality, center) : heat.points.length ? medianKm(heat.points, center) : 0;
    const part = partOfCity(heat.locality, center) ?? insideCity(heat.locality, center, heat.points.length);
    if (!heat.points.length || offBy > 50 || part) {
      // Live: for "Tokyo, Japan" the map was empty and its area only Minato; both are said, as the second moves the place
      // searches. A far area is said by its distance, even when its description names the city.
      const wrong = offBy > 50 ? `${Math.round(offBy)} km from the located city` : part ? `only ${part}, a part of it` : "";
      const why = !heat.points.length ? `was empty${wrong ? ` and ${wrong}` : ""}` : `was ${wrong}`;
      trace.push({ step: "Check", detail: `Qloo's area for "${center.query}" ${why}; asked again for 25 km around the city centre` });
      const circle = { lat: center.lat, lon: center.lon, radiusM: 25000 };
      // The city-wide place lookups below go there too when Qloo's city was wrong, not when only its map was empty
      // (an empty map says nothing about the city: Mexico City's places then came from 25 km around, live).
      if (part || offBy > 50) around = circle;
      heat = await q.heatmap(mapSignals, circle);
      if (heat.points.length && medianKm(heat.points, center) > 50)
        throw new AppError(`Qloo's map didn't line up with ${center.name}, so no neighborhoods are shown. Try the city with its state or country.`, 502);
    }
    qlooCity = heat.locality?.name;
    trace.push({ step: "Heatmap", detail: `Qloo scored ${heat.points.length} map cells${qlooCity ? ` in ${qlooCity}` : ""} for this taste profile` });
    // Say what the map was asked with, so the person or agent knows what to change (live: "le tigre" and "LA punk" were
    // music genres with no map there).
    const used = resolved.filter((r) => r.use.includes("map")).map((r) => (normalizeName(r.as) === normalizeName(r.input) ? r.as : `${r.input} (as ${r.as})`));
    if (!heat.points.length && !filterTags.length) throw new AppError(`Qloo has no taste map for ${center.name} with ${used.join(", ") || "these interests"}. Try an artist, show or film Qloo knows well.`, 404);
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
        let mine = await q.places(placeSignals, around, 50, filterTags);
        // Qloo can read a city as a place inside it whose name holds the city's, so the part rule can't see it (live:
        // "Moscow, Russia" is Trade Fair Moscow, with no coffee places; 25 km around the centre has 17). Nothing found
        // by the city's name is asked again around its centre.
        if (!mine.length && "query" in around) {
          trace.push({ step: "Check", detail: `Qloo found none of your kinds of places for "${center.query}" by its name; asked again for 25 km around the city centre` });
          mine = await q.places(placeSignals, { lat: center.lat, lon: center.lon, radiusM: 25000 }, 50, filterTags);
        }
        cityMatches = mine.filter((p) => p.lat !== undefined && p.lon !== undefined && visitable(p));
      } catch {
        degraded = true;
      }
    }
    const reach = Math.max(1.2, areaKm(heat.points) * 0.75);
    const nearby = new Map(candidates.map((h) => [h, cityMatches.filter((p) => km(h, { lat: p.lat!, lon: p.lon! }) <= reach).length]));
    const boosted = (h: Neighborhood) => h.affinity + 0.03 * Math.min(nearby.get(h) ?? 0, 3);
    for (const h of candidates) h.score = boosted(h);
    // Well-covered squares stay ahead of the sparse ones on the city's edge (as in rankAreas).
    const minCells = minCellsFor(heat.points);
    const full = (h: Neighborhood) => (h.cells >= minCells ? 1 : 0);
    hoods = [...candidates].sort((a, b) => full(b) - full(a) || b.score - a.score).slice(0, 7);
    trace.push({
      step: "Areas",
      detail:
        `Grouped the cells into areas of about ${areaKm(heat.points)} km and kept the 7 with the highest mean affinity` +
        (cityMatches.length ? `, plus 0.03 for each of your kinds of places within ${reach.toFixed(1)} km, up to three (Qloo found ${cityMatches.length} in the city)` : ""),
    });

    // 4. Evidence: the places Qloo ranks highest for the same tastes around each area, three calls at
    // a time (each Qloo call is also paced, see qloo.ts).
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
        : `Qloo's taste map was empty for these signals, so the areas come from the places that match ${yours} instead`,
    });
    let { places: found, locality } = await q.placesIn(placeSignals, around, 50, filterTags);
    qlooCity = locality?.name; // the city as Qloo read it, as the map's is (it says the country)
    // The same checks as the map's: Qloo's city is only a part of the city, or somewhere else.
    const part = partOfCity(locality, center);
    const offBy = locality ? km(locality, center) : 0;
    // Nothing found by the city's name is asked again around its centre too (live: "Moscow, Russia" is Trade Fair
    // Moscow, whose name holds the city's: no coffee places there, 17 within 25 km of the centre).
    if (part || offBy > 50 || (!found.length && "query" in around)) {
      const wrong = offBy > 50 ? `was ${Math.round(offBy)} km from the located city` : part ? `was only ${part}, a part of it` : `had none of these places${locality ? ` (read as ${locality.name.split(",")[0]})` : ""}`;
      trace.push({ step: "Check", detail: `Qloo's area for "${center.query}" ${wrong}; asked again for 25 km around the city centre` });
      around = { lat: center.lat, lon: center.lon, radiusM: 25000 };
      qlooCity = undefined; // the part isn't the city (live: "Qloo read the city as Minato, Tokyo, ...")
      found = await q.places(placeSignals, around, 50, filterTags);
    }
    // Qloo can know a taste and have no places for it in the city (live: "oysters" in Boston): say so, not "try again".
    if (!found.length) throw new AppError(`Qloo has no places in ${center.name} for ${resolved.filter((r) => r.placeTag).map((r) => r.as).join(", ") || "these tastes"}. Try a nearby city or another taste.`, 404);
    hoods = rankByPlaces(found.filter(visitable), center); // closed or unvisitable places don't make an area
    if (!hoods.length) throw new AppError(`Qloo's places in ${center.name} for ${resolved.filter((r) => r.placeTag).map((r) => r.as).join(", ") || "these tastes"} are closed, can't be visited or are too far out. Try another taste.`, 404);
    trace.push({ step: "Areas", detail: `Qloo found ${found.length} ${found.length === 1 ? "place that matches" : "places that match"} ${yours}; grouped them by Qloo neighborhood` });
  }

  // Name each area from Qloo's own neighborhood field, counting only the places inside the area's own square: the
  // places found within 1.2 km reach across a river or a park ("Georgetown" for Rosslyn, measured in Arlington).
  // Else OpenStreetMap (Photon) at the area; else the places around it. Places a newcomer can't visit don't name an area
  // (live: a ferry terminal Qloo files under Manhattan's "Whitehall" named a Brooklyn square). A neighborhood named like
  // the city itself ("Brooklyn" in Brooklyn) or a ward number ("Ward 2", Qloo's name for the National Mall) says
  // nothing; skip it.
  const cityWords = new Set([center.name.split(",")[0], qlooCity?.split(",")[0] ?? ""].map(nameKey).filter(Boolean));
  // Nor an electoral district ("University\u2014Rosedale", Qloo's names in Toronto, join two places with a dash).
  const says = (n: string | undefined): n is string => !!n && !cityWords.has(nameKey(n)) && !/^ward \d+$/i.test(n.trim()) && !/\S\u2014\S/.test(n);
  const step = areaStep(cellLength(heat.points));
  const inSquare = (h: Neighborhood, e: Entity) => !step || (e.lat !== undefined && e.lon !== undefined && Math.floor(e.lat / step) === Math.floor(h.lat / step) && Math.floor(e.lon / step) === Math.floor(h.lon / step));
  // A Japanese block number after a name is an address, not a neighborhood ("Ginza 8-chome" and "Ginza 2-chome" are
  // Ginza, "Roppongi 7" Roppongi: Tokyo's names, live), so such areas merge. Elsewhere a number can be the name ("Zona
  // 10" in Guatemala City), so only the "-chome" form is dropped.
  // Qloo writes some in Japanese, with the number in kanji or straight after the name ("鉄鋼通り三丁目", "紀尾井町1").
  const japan = /\bJapan\b/i.test(center.name);
  // "chōme" is written with or without its long vowel ("Kabukichō 1-chōme", live). Seoul's names carry their own
  // numbers ("Itaewon 2(i)-dong", "Seongsu 1(il)-ga 1(il)-dong", OpenStreetMap's, live): Itaewon-dong, Seongsu-dong,
  // the way Qloo writes them ("Itaewon-dong"), so the two merge.
  const korea = /\bKorea\b/i.test(center.name);
  const clean = (n: string) =>
    n.replace(japan ? /\s*\d+(?:-ch[oō]me)?$|[一二三四五六七八九十]+丁目$/ : /\s+\d+-ch[oō]me$/, "").replace(korea ? /(?:\s+\d+\([a-z]+\)-(ga|dong))+$/ : /$^/, (_, last: string) => `-${last}`);
  // Names are counted once cleaned: "Ebisu nishi 1" and "Ebisu nishi 2" outnumber "Ebisu minami 1" (Tokyo, live).
  const byPlaces = (ps: Entity[]) => mostCommon(ps.filter(visitable).map((e) => e.neighborhood).filter(says).map(clean)) ?? "";
  // An area with an airport inside it is the airport, not a neighborhood: a place Qloo files as an airport, or a travel
  // lounge at one (live: Sydney's Mascot square, lounges at "Sydney Airport", its Sunday a terminal bistro). Qloo also
  // files a Paris rooftop, Amsterdam restaurants and a Chicago station lounge as travel lounges, and a Vienna pension
  // under "Airport shuttle service": those are not airports.
  const atAirport = (e: Entity) => (e.tags ?? []).some((t) => /\bairport$/i.test(t)) || ((e.tags ?? []).some((t) => /^travel lounge$/i.test(t)) && /\bairport\b/i.test(e.address ?? ""));
  const airport = (h: Neighborhood) => h.evidence.some((e) => inSquare(h, e) && atAirport(e));
  const atAirports = hoods.filter(airport).length;
  if (atAirports) {
    hoods = hoods.filter((h) => !airport(h));
    trace.push({ step: "Filter", detail: `Left out ${atAirports} area${atAirports === 1 ? "" : "s"} at an airport` });
  }
  // Where Qloo files most places inside an area under the city's own name and the area is at the city's centre, it is
  // the city centre (live: Melbourne's suburb "Melbourne" is its CBD; dropping that name let Fitzroy name it).
  const cityName = center.name.split(",")[0].trim();
  // US and Canadian centres are "Downtown"; the country is the located city's own, kept when Qloo's city was replaced
  // by a circle around it.
  const northAmerica = center.country ? center.country === "US" || center.country === "CA" : /\b(United States|Canada)\b/.test(heat.locality?.name ?? qlooCity ?? "");
  const centreName = northAmerica ? `Downtown ${cityName}` : `${cityName} city centre`;
  const atCentre = (h: Neighborhood, ps: Entity[]) =>
    km(h, center) <= 1.5 && cityWords.has(nameKey(mostCommon(ps.filter(visitable).map((e) => e.neighborhood).filter((n): n is string => !!n).map(clean)) ?? ""));
  for (const h of hoods) {
    if (h.name) continue;
    const inside = [...h.evidence, ...h.matches].filter((e) => inSquare(h, e));
    h.name = atCentre(h, inside) ? centreName : byPlaces(inside);
  }
  // An area Qloo grouped under the city's own name at its centre is the city centre too (places mode: Melbourne's CBD).
  for (const h of hoods) h.name = says(h.name) ? clean(h.name) : h.name && cityWords.has(nameKey(clean(h.name))) && km(h, center) <= 1.5 ? centreName : "";
  const unnamed = hoods.filter((h) => !h.name);
  if (unnamed.length) {
    const r = await namesFor(env.CACHE, budget, center.name, unnamed, 3);
    for (const h of unnamed) {
      const osm = (r.names.get(cellKey(h.lat, h.lon)) ?? []).find(says);
      h.name = osm ? clean(osm) : byPlaces([...h.evidence, ...h.matches]);
    }
    // A lookup Photon didn't answer may name the area next time: the answer isn't cached.
    if (r.failed) degraded = true;
    const missing = unnamed.filter((h) => !h.name).length;
    if (missing) trace.push({ step: "Name", detail: `${missing} area${missing === 1 ? "" : "s"} had no neighborhood name in Qloo or OpenStreetMap and ${missing === 1 ? "was" : "were"} left out` });
  }
  hoods = mergeByName(hoods.filter((h) => h.name), mode).slice(0, 5);
  if (!hoods.length) throw new AppError(`Qloo scored ${center.name}, but none of the top areas could be named. Please try again later.`, 502);
  trace.push({ step: "Name", detail: `Named the areas from Qloo's place data (the neighborhood of the places inside each area)${unnamed.length ? `; OpenStreetMap for ${unnamed.length} without one` : ""}` });

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
    trace.push({ step: "Your places", detail: `Qloo found ${cityMatches.length} ${cityMatches.length === 1 ? "place" : "places"} in the city that ${cityMatches.length === 1 ? "is" : "are"} one of your food or activity tastes; ${kept} ${kept === 1 ? "is" : "are"} in the neighborhoods shown` });
  }
  const dropped = dedupeEvidence(hoods);
  if (dropped) trace.push({ step: "Filter", detail: `Left out ${dropped} ${dropped === 1 ? "place" : "places"} a newcomer can't visit (schools, offices, places of worship, stations, airports, studios, closed places and the like)` });

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
      "Food and activity tastes choose the places shown and give a small boost to areas near them; Qloo's taste map itself comes from artists, shows, films, books, podcasts and genres.",
      "Neighborhood names are Qloo's (from the places inside each area), or OpenStreetMap's where Qloo has none there, and may not match local usage exactly.",
    ],
    ours: [
      mode === "map"
        ? "Areas are squares of about 1 km (2.4 km where Qloo's cells are coarser) ranked by the mean Qloo percentile of all their map cells, so one hot block can't outrank a whole hot area, plus 0.03 for each of your kinds of places within reach, up to three (Newcomer's rules)."
        : `Neighborhoods are ranked by how many places matching ${yours} Qloo found there (Newcomer's rule).`,
      "Each weekend stop is the best-ranked place for that part of the day by Qloo's time-of-day tags; tattoo shops, salons and hotels are skipped unless they serve food or drink (Newcomer's rules).",
      "Schools, offices, places of worship, transit stations and airports, military bases, recording studios, closed places and similar places are left out of the lists, since a newcomer can't visit them (Newcomer's rule).",
      ...(unsure.length ? ["Where a name wasn't one exact match, the first Qloo candidate that resembles it was used; you can pick another."] : []),
    ],
    degraded,
    trace,
    calls: q.calls,
    computedAt: Date.now(),
  };
}

// Qloo can answer a city asked by name with a part of it: for "Tokyo, Japan" its locality is Minato ("Minato, Tokyo,
// ...", one ward, 6 km across; measured on 35 cities, the only one then; later "London, Ontario" as Wortley Village).
// A locality named after the city is the city or bigger ("Paris Police Prefecture", "Região Geográfica Intermediária de
// São Paulo, São Paulo, ..."), or a place inside it this rule can't tell apart (Trade Fair Moscow: the searches that
// find nothing by name ask again around the centre). The part's name, else null.
// A place inside the city named after it, which partOfCity can't tell from the city or a region named after it: live,
// "Moscow, Russia" is Trade Fair Moscow ("Trade Fair Moscow, All-Russia Exhibition Centre, Moscow, ..."), a map of 4
// cells. Such names also come for the city or more (São Paulo's region, 541 cells; Bogotá's capital district, 101;
// Hong Kong Island, 219, of 30 cities measured), so only a map of fewer than 30 cells counts (small towns named as
// themselves, Telluride's 14 cells, aren't affected). Asked after partOfCity, so its own name holds the city's. Its
// name, else null.
function insideCity(locality: Locality | undefined, center: { name: string }, cells: number): string | null {
  const [own, ...within] = (locality?.name ?? "").split(",").map((x) => nameKey(x));
  const city = nameKey(center.name.split(",")[0]);
  return cells > 0 && cells < 30 && own !== city && within.includes(city) ? locality!.name.split(",")[0].trim() : null;
}

function partOfCity(locality: Locality | undefined, center: { name: string }): string | null {
  const [own, ...within] = (locality?.name ?? "").split(",").map((x) => nameKey(x));
  const city = nameKey(center.name.split(",")[0]);
  return !own.includes(city) && within.includes(city) ? locality!.name.split(",")[0].trim() : null;
}

function medianKm(ps: { lat: number; lon: number }[], c: { lat: number; lon: number }): number {
  const d = ps
    .slice(0, 15)
    .map((p) => km(p, c))
    .sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 0;
}

function emptyHood(lat: number, lon: number, affinity: number, cells: number): Neighborhood {
  return { name: "", lat, lon, affinity, score: affinity, cells, evidence: [], matches: [] };
}

// Qloo's cells are geohash-7 (~150 m) in a city and geohash-6 (~1.2 x 0.6 km) over a big county.
function cellLength(points: HeatPoint[]): number {
  const n = new Map<number, number>();
  for (const p of points.slice(0, 200)) if (p.geohash) n.set(p.geohash.length, (n.get(p.geohash.length) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 7;
}
const areaStep = (len: number) => (len >= 7 ? 0.01 : len === 6 ? 0.022 : 0); // degrees: about 1 km, about 2.4 km, or the cell itself
export const areaKm = (points: HeatPoint[]) => (cellLength(points) >= 7 ? 1 : cellLength(points) === 6 ? 2.4 : 5);

// Squares with fewer cells sit on the city's edge: a full one needs about 40% of a square's cells.
const minCellsFor = (points: HeatPoint[]) => {
  const len = cellLength(points);
  return len >= 7 ? 6 : len === 6 ? 3 : 1;
};

// Group cells on a grid sized to the cells, and rank squares by the mean percentile of all their
// cells, well-covered squares first.
export function rankAreas(points: HeatPoint[], keep = 7): Neighborhood[] {
  const step = areaStep(cellLength(points));
  const minCells = minCellsFor(points);
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
// A place's name as spelled loosely: case, "&" for "and" and punctuation aside.
const placeKey = (s: string) => nameKey(s.replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim());
// The same place under two records: the same name spelled loosely, or one name holding the other's words at the same
// spot (within 5 m) with a category in common ("The Top CN Tower" and "CN Tower", 1.4 m apart, live; not "360 The
// Restaurant at the CN Tower", a restaurant there, nor two rooms or shops of one building: ACL Live and its 3TEN room,
// 19 m apart, Tokyo Ramen Street and a shop in it, 29 m).
export const samePlace = (a: Entity, b: Entity) => {
  if (placeKey(a.name) === placeKey(b.name)) return true;
  if (a.lat === undefined || a.lon === undefined || b.lat === undefined || b.lon === undefined || km({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }) > 0.005) return false;
  const [x, y] = [placeKey(a.name).split(" "), placeKey(b.name).split(" ")];
  const holds = x.every((w) => y.includes(w)) || y.every((w) => x.includes(w));
  return holds && (a.tags ?? []).some((t) => t !== "Tourist attraction" && (b.tags ?? []).includes(t));
};
// Two branches of one chain: the same first two words (small words aside) and a category in common ("Merlo Coffee Cafe
// QUT Gardens Point" and "Merlo Coffee Cafe | UQ Saint Lucia Campus", Brisbane, live; not "Golden Gate Park" and
// "Golden Gate Bridge", nor two museums of something).
// Small words in several languages aside ("Taquería Los Primos" and "Taquería Los Hornillos" are two taquerías, Mexico City
// live; "Piazza del Popolo" and "Piazza del Quirinale" two squares).
const BRAND_SMALL = new Set(["the", "of", "and", "a", "an", "at", "al", "de", "del", "della", "di", "da", "du", "des", "la", "le", "les", "el", "los", "las", "y", "et", "e"]);
const brand = (s: string) => placeKey(s).split(" ").filter((w) => !BRAND_SMALL.has(w)).slice(0, 2).join(" ");
const sameChain = (a: Entity, b: Entity) => brand(a.name) === brand(b.name) && (a.tags ?? []).some((t) => t !== "Tourist attraction" && (b.tags ?? []).includes(t));

function mostCommon(xs: string[]): string | undefined {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// Two areas that Qloo puts in the same neighborhood become one entry with all their places. In map
// mode its numbers stay those of its best square (what the page states: that square's mean over its
// cells); in places mode the matching places add up.
function mergeByName(hoods: Neighborhood[], mode: MatchResult["mode"]): Neighborhood[] {
  const out: Neighborhood[] = [];
  for (const h of hoods) {
    const same = out.find((o) => nameKey(o.name) === nameKey(h.name));
    if (!same) out.push(h);
    else {
      if (mode === "places") {
        same.cells += h.cells;
        same.affinity += h.affinity;
        same.score += h.score;
      }
      same.evidence.push(...h.evidence);
      same.matches.push(...h.matches);
    }
  }
  return mode === "places" ? out.sort((a, b) => b.cells - a.cells || b.affinity - a.affinity) : out;
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
    // Qloo can list one place twice under two ids ("Big Ben" and "Big ben", "The Coffee Bean & Tea Leaf" and "... And
    // ..."): an area lists it once.
    for (const h of hoods) h[field] = h[field].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).filter((e, i, a) => a.findIndex((x) => samePlace(x, e)) === i).slice(0, field === "matches" ? 4 : 5);
  }
  // A place that is one of your tastes isn't listed again among the taste places.
  for (const h of hoods) h.evidence = h.evidence.filter((e) => !h.matches.some((m) => m.id === e.id || samePlace(m, e)));
  return left;
}

// Judged on Qloo's categories only: a venue's name ("The Garage", "Temple Bar") says nothing.
const NOT_VISITABLE = /\b(schools?|high school|college|university|academy|training cent(er|re)|church|place of worship|mosque|synagogue|temple|hospital|clinic|medical|dentist|doctor|pharmacy|office|corporate|government|municipal|department of|city hall|courthouse|police|fire station|fire department|cemetery|funeral|apartment|condominium|housing|storage|parking|garage|bank|atm|gas station|car dealer|auto repair|insurance|real estate|lawyer|attorney|recording studio|post office|business center|senior citizen|(subway|train|railway|metro|bus|transit|light rail|tram) station|ferry terminal|airport(?=$| \|)|military|law library|photography studio|water treatment|academic department|research institute|radio broadcaster|movie studio)\b/i;
const visitable = (e: Entity) => !e.closed && !NOT_VISITABLE.test((e.tags ?? []).join(" | "));

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// A tattoo shop, a salon or a hotel can show the area's taste, but isn't a stop on a scouting
// weekend unless it also serves food or drink, or is a venue.
// A wedding venue may be a garden or a gallery too (Denver Botanic Gardens, live).
const NEVER_A_STOP = /\b(rv park|campground|motel|adult entertainment|strip club|sex shop)\b/i;
const NOT_A_STOP = /\b(personal care|tattoo|piercing|salon|nail|barber|spa|lash|eyelash|waxing|lodging|hotel|resort|wedding venue)\b/i;
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
  const used: Entity[] = []; // two branches of one chain, or one place under two records, aren't two stops
  const stops: { when: string; place: string; why: string }[] = [];
  for (const [slotName, fits] of SLOTS) {
    const p = places.find(
      (e) => weekendStop(e) && !used.some((u) => u.id === e.id || samePlace(u, e) || sameChain(u, e)) && ((e.times ?? []).some((t) => fits.includes(t)) || (slotName === "Afternoon" && !(e.times ?? []).length)),
    );
    if (!p) continue;
    used.push(p);
    stops.push({ when: slotName, place: p.name, why: (p.tags ?? []).slice(0, 2).join(", ") });
  }
  return stops;
}
