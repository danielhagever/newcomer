// Where the city is (Open-Meteo geocoding) and what OpenStreetMap calls each map cell (the free
// Photon reverse geocoder, photon.komoot.io). Caching is best effort: the free plan allows 1,000
// KV writes a day, and a failed write must never fail a search.

import { AppError, Budget, fetchWithTimeout } from "./limits.ts";

const UA = { "user-agent": "Newcomer/0.2 (Qloo hackathon demo; github.com/danielhagever/newcomer)" };

export interface Place {
  lat: number;
  lon: number;
  name: string; // what the page shows, e.g. "Portland, Maine"
  query: string; // what Qloo is asked for: the same city, spelled out
  country?: string; // ISO code, e.g. "US"
  // Set when what came after the comma isn't this city's state or country ("Chicago, Austin"): the city
  // was then taken as the most populous of its name, and the answer says how it was read.
  unmatched?: string;
}

const US_STATES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado", ct: "Connecticut",
  de: "Delaware", dc: "District of Columbia", fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho", il: "Illinois",
  in: "Indiana", ia: "Iowa", ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland",
  ma: "Massachusetts", mi: "Michigan", mn: "Minnesota", ms: "Mississippi", mo: "Missouri", mt: "Montana",
  ne: "Nebraska", nv: "Nevada", nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico", ny: "New York",
  nc: "North Carolina", nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania",
  ri: "Rhode Island", sc: "South Carolina", sd: "South Dakota", tn: "Tennessee", tx: "Texas", ut: "Utah",
  vt: "Vermont", va: "Virginia", wa: "Washington", wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming",
};
// Province and state codes outside the US ("Toronto, ON", "Melbourne, VIC"); a code can name more than one
// region (NT: Northwest Territories or Northern Territory), and the city's own record decides which.
const OTHER_REGIONS: Record<string, string[]> = {
  on: ["Ontario"], qc: ["Quebec"], bc: ["British Columbia"], ab: ["Alberta"], mb: ["Manitoba"], sk: ["Saskatchewan"],
  ns: ["Nova Scotia"], nb: ["New Brunswick"], nl: ["Newfoundland and Labrador"], pe: ["Prince Edward Island"], yt: ["Yukon"],
  nu: ["Nunavut"], nt: ["Northwest Territories", "Northern Territory"], nsw: ["New South Wales"], vic: ["Victoria"],
  qld: ["Queensland"], wa: ["Western Australia"], sa: ["South Australia"], tas: ["Tasmania"], act: ["Australian Capital Territory"],
  nyc: ["New York"], // "Brooklyn, NYC"
};
// The UK's nations are regions (admin1), not the whole UK: "Bangor, Wales" isn't Bangor in Northern Ireland.
const COUNTRY_WORDS: Record<string, string> = { usa: "us", "united states": "us", us: "us", uk: "gb", "united kingdom": "gb" };

async function kvGet(cache: KVNamespace, budget: Budget, key: string): Promise<any> {
  if (!budget.take()) return null;
  try {
    return await cache.get(key, "json");
  } catch {
    return null;
  }
}

async function kvPut(cache: KVNamespace, budget: Budget, key: string, value: unknown, ttl: number): Promise<void> {
  if (!budget.take()) return;
  try {
    await cache.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    // Daily write limit or a hiccup: the search still succeeds, it just isn't cached.
  }
}

// "Portland, Maine", "Portland, ME" and "Portland, Oregon" must each land on the right Portland:
// fetch several candidates and prefer the one whose state or country matches what came after the
// comma; otherwise take the most populous.
// Typed forms that Open-Meteo doesn't know by that name.
const ALIASES: Record<string, string> = {
  dc: "Washington, DC", "washington dc": "Washington, DC", cdmx: "Mexico City", "ciudad de mexico": "Mexico City",
  "quebec city": "Quebec, QC", "tel aviv-yafo": "Tel Aviv", "tel aviv yafo": "Tel Aviv", bangalore: "Bengaluru", bombay: "Mumbai",
  "st pete": "St. Petersburg, Florida",
  // Nicknames a tour itinerary uses (the venue matcher knows them too).
  la: "Los Angeles, California", sf: "San Francisco, California", philly: "Philadelphia, Pennsylvania", nola: "New Orleans, Louisiana",
  vegas: "Las Vegas, Nevada", atx: "Austin, Texas", chi: "Chicago, Illinois", kc: "Kansas City, Missouri", slc: "Salt Lake City, Utah",
  pdx: "Portland, Oregon", mpls: "Minneapolis, Minnesota", stl: "St. Louis, Missouri",
  // Open-Meteo has no Newcastle upon Tyne under "Newcastle, UK"; islands are toured at their main town.
  ...Object.fromEntries(["uk", "gb", "england", "united kingdom", "great britain", "britain"].flatMap((r) => [`newcastle, ${r}`, `newcastle ${r}`]).map((k) => [k, "Newcastle upon Tyne, England"])),
  oahu: "Honolulu, Hawaii", kauai: "Lihue, Hawaii", "big island": "Hilo, Hawaii", // Maui is found as the island
};
// Newspaper (AP) state abbreviations, dots dropped ("Paris, Tex.", "Springfield, Ill.").
const US_AP: Record<string, string> = {
  ala: "Alabama", ariz: "Arizona", ark: "Arkansas", calif: "California", colo: "Colorado", conn: "Connecticut", del: "Delaware",
  fla: "Florida", ill: "Illinois", ind: "Indiana", kan: "Kansas", kans: "Kansas", mass: "Massachusetts", mich: "Michigan",
  minn: "Minnesota", miss: "Mississippi", mont: "Montana", neb: "Nebraska", nebr: "Nebraska", nev: "Nevada", okla: "Oklahoma",
  ore: "Oregon", oreg: "Oregon", penn: "Pennsylvania", tenn: "Tennessee", tex: "Texas", wash: "Washington", wis: "Wisconsin",
  wyo: "Wyoming", wva: "West Virginia", ont: "Ontario", que: "Quebec", alta: "Alberta", man: "Manitoba", sask: "Saskatchewan",
  pei: "Prince Edward Island",
};
// Countries as people write them in their own language.
const ENDONYMS: Record<string, string> = {
  brasil: "Brazil", deutschland: "Germany", espana: "Spain", italia: "Italy", osterreich: "Austria", schweiz: "Switzerland",
  suisse: "Switzerland", nederland: "Netherlands", sverige: "Sweden", norge: "Norway", danmark: "Denmark", polska: "Poland",
  eire: "Ireland", mexico: "Mexico", "great britain": "United Kingdom", britain: "United Kingdom", turkey: "Turkiye",
  uae: "United Arab Emirates", "czech republic": "Czechia", holland: "Netherlands",
};
// Typed words are looked up in these tables, so they must not inherit Object's own names ("constructor", "__proto__").
for (const t of [US_STATES, OTHER_REGIONS, COUNTRY_WORDS, ALIASES, US_AP, ENDONYMS]) Object.setPrototypeOf(t, null);
const fold = (s: unknown) => String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
// What a region word can mean: "tx" Texas, "on" Ontario, "wa" Washington or Western Australia.
const regionNames = (part: string) =>
  [part, US_STATES[part], US_AP[part], ...(OTHER_REGIONS[part] ?? []), ENDONYMS[part]].filter(Boolean).map((x) => fold(x));
const KNOWN_REGIONS = new Set([
  ...Object.keys(US_STATES), ...Object.values(US_STATES).map(fold), ...Object.keys(US_AP), ...Object.keys(OTHER_REGIONS),
  ...Object.values(OTHER_REGIONS).flat().map(fold), ...Object.keys(COUNTRY_WORDS), ...Object.keys(ENDONYMS),
  ...("canada,australia,germany,france,spain,italy,ireland,netherlands,the netherlands,japan,mexico,brazil,israel,portugal,norway," +
    "sweden,denmark,finland,iceland,austria,switzerland,belgium,luxembourg,poland,czechia,hungary,greece,turkiye,croatia,slovenia," +
    "serbia,romania,bulgaria,estonia,latvia,lithuania,ukraine,northern ireland,scotland,wales,england,new zealand,south africa," +
    "argentina,chile,colombia,peru,south korea,korea,china,taiwan,india,thailand,vietnam,indonesia,philippines,singapore,malaysia," +
    "united arab emirates,egypt,morocco,nigeria,kenya").split(","),
]);
// One form for comparing place names across spellings: "Saint-Étienne", "St Etienne" and "St. Etienne" are the
// same name; so are "St. John's" and "St Johns".
const canon = (s: unknown) =>
  fold(s).replace(/['\u2019]/g, "").replace(/-/g, " ").replace(/\b(saint|sainte|fort|mount)\b/g, (w) => ({ saint: "st", sainte: "ste", fort: "ft", mount: "mt" })[w] as string).replace(/\s+/g, " ");
// "St. Paul", "Saint Paul" and "St Paul" are one place to a person, but Open-Meteo knows one spelling,
// anywhere in the name ("Bay St. Louis", "Port St. Lucie"). The short and the long form are both looked up.
const SHORT_LONG: [RegExp, string, string][] = [
  [/\b(st|saint)\b\.?/gi, "St.", "Saint"],
  [/\b(ste|sainte)\b\.?/gi, "Ste.", "Sainte"],
  [/\b(ft|fort)\b\.?/gi, "Ft.", "Fort"],
  [/\b(mt|mount)\b\.?/gi, "Mt.", "Mount"],
];
function spellings(name: string): string[] {
  const out = [name];
  for (const [re, short, long] of SHORT_LONG) {
    if (!re.test(name)) continue;
    for (const form of [short, long]) {
      const v = name.replace(re, form).replace(/\.\s*\./g, ".");
      // Compared as typed (dots kept): Open-Meteo answers "St John's" and "St. John's" differently.
      if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
  }
  return out.slice(0, 3);
}

export async function cityCenter(cache: KVNamespace, budget: Budget, city: string): Promise<Place | null> {
  const key = `city18:${city.toLowerCase()}`; // city18: with the country code, 100 places asked for a region that fits none of 10
  const hit = await kvGet(cache, budget, key);
  if (hit) return hit as Place;
  // "Newcastle,UK" and "Newcastle , UK" are "Newcastle, UK".
  const typed = (ALIASES[fold(city).replace(/\s*,\s*/g, ", ")] ?? city).replace(/[\u2018\u2019]/g, "'");
  let [name, ...rest] = typed.split(",").map((x) => x.trim());
  if (!name) return null;
  // A nickname before the comma too: "Quebec City, QC", "Bangalore, India", "Washington DC, USA" (and, below,
  // before a region word without a comma: "Bangalore India").
  const unalias = () => {
    const alias = ALIASES[fold(name)];
    if (!alias) return;
    const [aliasName, ...aliasRest] = alias.split(",").map((x) => x.trim());
    name = aliasName;
    if (!rest.filter(Boolean).length) rest = aliasRest;
  };
  unalias();
  let whole: any[] | undefined; // the answer for the whole name, when it was already asked for
  // Without a comma the state or country may close the text ("Austin TX", "Portland Maine", "London
  // England"), but a city's own name may end in one too ("New Britain", "Port Washington", "West New York"):
  // the whole name is kept when Open-Meteo has a place with exactly that name.
  if (!rest.filter(Boolean).length) {
    const ws = name.split(/\s+/);
    const k = [3, 2, 1].find((k) => ws.length > k && KNOWN_REGIONS.has(fold(ws.slice(-k).join(" "))));
    if (k) {
      whole = await geocode(budget, name, "en");
      if (!whole.some((r) => fold(r.name) === fold(name))) {
        rest = [ws.slice(-k).join(" ")];
        name = ws.slice(0, -k).join(" ");
        whole = undefined;
        unalias();
      }
    }
  }
  // Each part after the name must fit the city: "Austin, TX, USA" is Texas and the United States.
  const parts = rest.map(fold).filter(Boolean);
  const seen = new Set<unknown>();
  let list: any[] = [];
  const idOf = (r: any) => r.id ?? [r.name, r.admin1, r.country_code, r.latitude, r.longitude].join("|");
  // Another spelling only adds places of exactly that name: "Saint George" would add Freetown (Sierra Leone)
  // to "St. George", and "St. John" would add St. John's to "Saint John".
  // A name that only starts with the other spelling ("St. Petersburg" for "St Pete") counts when the typed
  // spelling found no place of exactly its name.
  let exactTyped = false;
  for (const [i, n] of spellings(name).entries()) {
    const found = i === 0 && whole ? whole : await geocode(budget, n, "en");
    if (i === 0) exactTyped = found.some((r) => canon(r.name) === canon(n));
    // A longer name counts ("St. Pete" -> St. Petersburg, "St. Simons" -> Saint Simons Island, "Ft. Walton" ->
    // Fort Walton Beach), except a French village name that goes on with a connector ("St. Denis" isn't
    // Saint-Denis-sur-Coise, "St Malo" isn't Saint-Malo-en-Donziois).
    const longer = (r: any) => {
      const more = canon(r.name).startsWith(canon(n)) ? canon(r.name).slice(canon(n).length) : null;
      return more !== null && !/^ (sur|sous|en|de|des|du|la|le|les|aux|et|d|l)( |$)/.test(more);
    };
    const keep = (r: any) => i === 0 || canon(r.name) === canon(n) || (!exactTyped && longer(r));
    for (const r of found) if (keep(r) && !seen.has(idOf(r))) (seen.add(idOf(r)), list.push(r));
  }
  // A city typed in Hebrew, Arabic or Cyrillic is only found in its own language; its English name
  // (what Qloo is asked about) then comes from the same place's record.
  const script = /[\u0590-\u05FF]/.test(name) ? "he" : /[\u0600-\u06FF]/.test(name) ? "ar" : /[\u0400-\u04FF]/.test(name) ? "ru" : "";
  if (!list.length && script) {
    const native = (await geocode(budget, name, script)).sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
    if (native?.id) list = await byId(budget, native.id);
  }
  // A part fits by name (a state, province or country, or their codes) or, failing that, as an ISO
  // country code; a state wins over a country code ("Richmond, CA" is California, not Canada).
  const byName = (r: any, part: string) => {
    const own = [r.admin1, r.country].filter(Boolean).map(fold);
    return regionNames(part).some((n) => own.some((v) => v === n || (n.length > 3 && v.includes(n)))) || COUNTRY_WORDS[part] === fold(r.country_code);
  };
  const byCode = (r: any, part: string) => byName(r, part) || (part.length === 2 && part === fold(r.country_code));
  // French saints are filed with hyphens ("Saint-Étienne", "Saint-Malo"): asked for only when no spelling found
  // a place of exactly the typed name that fits what came after the comma.
  const saint = name.match(/^(st|saint)\.?\s+(.+)$/i);
  if (saint && !list.some((r) => canon(r.name) === canon(name) && parts.every((p) => byCode(r, p)))) {
    const hyphen = `Saint-${saint[2].trim().replace(/\s+/g, "-")}`;
    for (const r of await geocode(budget, hyphen, "en")) if (canon(r.name) === canon(hyphen) && !seen.has(idOf(r))) (seen.add(idOf(r)), list.push(r));
  }
  if (!list.length) return null;
  const fits = () => {
    const named = parts.length ? list.filter((r) => parts.every((p) => byName(r, p))) : [];
    return named.length ? named : parts.length ? list.filter((r) => parts.every((p) => byCode(r, p))) : [];
  };
  let matches = fits();
  // Open-Meteo lists the first 10 places of a name, and a smaller one that fits what came after the comma can be
  // further down (live: Newport, Rhode Island; Salem, Massachusetts; Jackson, Wyoming). Only then are 100 asked for,
  // keeping places of exactly the typed name that fit (asking for 100 every time made Porto Porto Alegre).
  if (parts.length && !matches.length) {
    const more = (await geocode(budget, name, "en", 100)).filter((r) => canon(r.name) === canon(name) && parts.every((p) => byCode(r, p)) && !seen.has(idOf(r)));
    if (more.length) (list.push(...more), (matches = fits()));
  }
  const pool = matches.length ? matches : list;
  // Towns and cities first (Open-Meteo lists Vancouver Island above the city of Vancouver), unless an island
  // or region is far bigger than any town of that name (Long Island, Maui).
  const pop = (r: any) => r.population ?? 0;
  const byPop = (xs: any[]) => [...xs].sort((a, b) => pop(b) - pop(a))[0];
  const town = byPop(pool.filter((r) => /^PPL/.test(String(r.feature_code ?? "PPL"))));
  const other = byPop(pool.filter((r) => !/^PPL/.test(String(r.feature_code ?? "PPL"))));
  const r = town && !(other && pop(other) > 10 * pop(town)) ? town : (other ?? town);
  // US and Canadian cities are named with their state or province; elsewhere with the country. The
  // region is kept even when it repeats the name: Qloo reads "New York" as the state and
  // "New York, New York" as the city (measured).
  // A few records carry no country name (Puerto Rico, Hong Kong): the code names it.
  const NO_COUNTRY: Record<string, string> = { PR: "Puerto Rico", HK: "Hong Kong", MO: "Macau" };
  // UK cities with their nation: Qloo reads "Bangor, United Kingdom" as Bangor in Northern Ireland and
  // "Bangor, Wales" right (measured). Québec with "City": "Québec, Quebec" is the province to Qloo.
  const region = r.country_code === "US" || r.country_code === "CA" || (r.country_code === "GB" && r.admin1) ? r.admin1 : (r.country ?? NO_COUNTRY[r.country_code] ?? r.admin1);
  const cityName = r.country_code === "CA" && fold(r.name) === "quebec" && fold(r.admin1) === "quebec" ? `${r.name} City` : r.name;
  const label = `${cityName}${region ? ", " + region : ""}`;
  const typedRegion = rest.filter(Boolean).join(", ");
  const out: Place = { lat: r.latitude, lon: r.longitude, name: label, query: label, ...(r.country_code ? { country: String(r.country_code) } : {}), ...(typedRegion && !matches.length ? { unmatched: typedRegion } : {}) };
  await kvPut(cache, budget, key, out, 60 * 60 * 24 * 30);
  return out;
}

async function geocode(budget: Budget, name: string, language: string, count = 10): Promise<any[]> {
  if (!budget.take()) throw new AppError("This search needs more lookups than one request allows.", 503);
  try {
    const res = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=${count}&language=${language}`,
      { headers: UA },
      6000,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    return ((await res.json()) as any)?.results ?? [];
  } catch {
    throw new AppError("The city lookup service didn't answer. Please try again.", 502);
  }
}

async function byId(budget: Budget, id: number): Promise<any[]> {
  if (!budget.take()) return [];
  try {
    const res = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/get?id=${id}&language=en`, { headers: UA }, 6000);
    const r: any = res.ok ? await res.json() : null;
    return r?.name ? [r] : [];
  } catch {
    return [];
  }
}

// About 100 m: OpenStreetMap is asked at the area itself. (At 0.01 degrees it was asked at a corner of the area's
// square, since squares are aligned to 0.01 degrees: Toronto's Kensington Market came back as a housing co-op.)
const cellKey = (lat: number, lon: number) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

// The names OpenStreetMap gives a spot, the neighborhood level first: its district, then the finer locality (in New
// York the district is the borough, "Brooklyn" for Dumbo; in Washington a ward, "Ward 1" for Adams Morgan, measured),
// then the suburb; a street is labelled as such rather than passed off as a neighborhood (when the spot is itself a
// street, its name is the street's; when it is itself a neighbourhood or a quarter, that name comes before the suburb:
// Missoula's "Lower Rattlesnake", live). null when Photon didn't answer (it loses some of several lookups at once).
async function reverseName(lat: number, lon: number): Promise<string[] | null> {
  try {
    const res = await fetchWithTimeout(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en`, { headers: UA }, 5000);
    if (!res.ok) return null;
    const d: any = await res.json();
    const p = d.features?.[0]?.properties ?? {};
    const street = p.street ?? (p.osm_key === "highway" ? p.name : undefined);
    const spot = p.osm_key === "place" && /^(neighbourhood|quarter|suburb)$/.test(p.osm_value) ? p.name : undefined;
    return [p.district, p.locality, spot, p.suburb, street ? `around ${street}` : undefined].filter((n): n is string => typeof n === "string" && !!n.trim());
  } catch {
    return null;
  }
}

// Names for many map cells with one KV read and one KV write per city. Lookups run three at a time (Photon lost 2 to 4
// of 6 at once, measured) and stop when the request's budget runs low (keep `reserve` units for the steps after
// naming). A lookup Photon didn't answer is counted as failed, not as a spot without a name, and isn't kept.
export async function namesFor(
  cache: KVNamespace,
  budget: Budget,
  cityKey: string,
  cells: { lat: number; lon: number }[],
  reserve: number,
): Promise<{ names: Map<string, string[]>; missing: number; failed: number }> {
  const key = `names3:${cityKey.toLowerCase()}`; // names3: every name OpenStreetMap gives a cell, spots read as of 2026-10-06
  const known: Record<string, string[]> = (await kvGet(cache, budget, key)) ?? {};
  const want = [...new Set(cells.map((c) => cellKey(c.lat, c.lon)))].filter((k) => !(k in known));
  const fresh: Record<string, string[]> = {};
  let failed = 0;
  for (let i = 0; i < want.length; i += 3) {
    const batch = want.slice(i, i + 3).filter(() => budget.left() > reserve + 1 && budget.take());
    if (!batch.length) break;
    const got = await Promise.all(batch.map((k) => reverseName(+k.split(",")[0], +k.split(",")[1])));
    batch.forEach((k, j) => {
      const g = got[j];
      if (g === null) failed++;
      else if (g.length) fresh[k] = g;
    });
  }
  if (Object.keys(fresh).length) await kvPut(cache, budget, key, { ...known, ...fresh }, 60 * 60 * 24 * 30);
  const all = { ...known, ...fresh };
  const names = new Map<string, string[]>();
  let missing = 0;
  for (const c of cells) {
    const n = all[cellKey(c.lat, c.lon)];
    if (n) names.set(cellKey(c.lat, c.lon), n);
    else missing++;
  }
  return { names, missing, failed };
}

export { cellKey };

export function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
