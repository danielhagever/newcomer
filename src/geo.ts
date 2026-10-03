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
const COUNTRY_WORDS: Record<string, string> = { usa: "us", "united states": "us", us: "us", uk: "gb", "united kingdom": "gb", england: "gb" };

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
export async function cityCenter(cache: KVNamespace, budget: Budget, city: string): Promise<Place | null> {
  const key = `city3:${city.toLowerCase()}`;
  const hit = await kvGet(cache, budget, key);
  if (hit) return hit as Place;
  const [name, ...rest] = city.split(",").map((x) => x.trim());
  if (!name) return null;
  const raw = rest.join(" ").toLowerCase().replace(/\./g, "").trim();
  const qualifier = US_STATES[raw]?.toLowerCase() ?? raw;
  const country = COUNTRY_WORDS[raw];
  let list = await geocode(budget, name, "en");
  // A city typed in Hebrew, Arabic or Cyrillic is only found in its own language; its English name
  // (what Qloo is asked about) then comes from the same place's record.
  const script = /[\u0590-\u05FF]/.test(name) ? "he" : /[\u0600-\u06FF]/.test(name) ? "ar" : /[\u0400-\u04FF]/.test(name) ? "ru" : "";
  if (!list.length && script) {
    const native = (await geocode(budget, name, script)).sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
    if (native?.id) list = await byId(budget, native.id);
  }
  if (!list.length) return null;
  const matches = country
    ? list.filter((r) => String(r.country_code ?? "").toLowerCase() === country)
    : qualifier
      ? list.filter((r) =>
          [r.admin1, r.country].some((v) => v && (String(v).toLowerCase() === qualifier || (qualifier.length > 3 && String(v).toLowerCase().includes(qualifier)))),
        )
      : [];
  const pool = matches.length ? matches : list;
  const r = [...pool].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
  // US and Canadian cities are named with their state or province; elsewhere with the country. The
  // region is kept even when it repeats the name: Qloo reads "New York" as the state and
  // "New York, New York" as the city (measured).
  const region = r.country_code === "US" || r.country_code === "CA" ? r.admin1 : r.country;
  const label = `${r.name}${region ? ", " + region : ""}`;
  const out: Place = { lat: r.latitude, lon: r.longitude, name: label, query: label };
  await kvPut(cache, budget, key, out, 60 * 60 * 24 * 30);
  return out;
}

async function geocode(budget: Budget, name: string, language: string): Promise<any[]> {
  if (!budget.take()) throw new AppError("This search needs more lookups than one request allows.", 503);
  try {
    const res = await fetchWithTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=${language}`,
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

const cellKey = (lat: number, lon: number) => `${lat.toFixed(2)},${lon.toFixed(2)}`; // about 1 km

async function reverseName(lat: number, lon: number): Promise<string> {
  try {
    const res = await fetchWithTimeout(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en`, { headers: UA }, 5000);
    const d: any = await res.json();
    const p = d.features?.[0]?.properties ?? {};
    // Prefer real neighborhood-level names; a street is labelled as such rather than passed off as a neighborhood.
    return p.district ?? p.locality ?? p.suburb ?? (p.street ? `around ${p.street}` : "");
  } catch {
    return "";
  }
}

// Names for many map cells with one KV read and one KV write per city. Lookups run a few at a time
// and stop when the request's budget runs low (keep `reserve` units for the steps after naming).
export async function namesFor(
  cache: KVNamespace,
  budget: Budget,
  cityKey: string,
  cells: { lat: number; lon: number }[],
  reserve: number,
): Promise<{ names: Map<string, string>; missing: number }> {
  const key = `names:${cityKey.toLowerCase()}`;
  const known: Record<string, string> = (await kvGet(cache, budget, key)) ?? {};
  const want = [...new Set(cells.map((c) => cellKey(c.lat, c.lon)))].filter((k) => !(k in known));
  const fresh: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 6) {
    const batch = want.slice(i, i + 6).filter(() => budget.left() > reserve + 1 && budget.take());
    if (!batch.length) break;
    const got = await Promise.all(batch.map((k) => reverseName(+k.split(",")[0], +k.split(",")[1])));
    batch.forEach((k, j) => {
      if (got[j]) fresh[k] = got[j];
    });
  }
  if (Object.keys(fresh).length) await kvPut(cache, budget, key, { ...known, ...fresh }, 60 * 60 * 24 * 30);
  const all = { ...known, ...fresh };
  const names = new Map<string, string>();
  let missing = 0;
  for (const c of cells) {
    const n = all[cellKey(c.lat, c.lon)];
    if (n) names.set(cellKey(c.lat, c.lon), n);
    else missing++;
  }
  return { names, missing };
}

export { cellKey };

export function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
