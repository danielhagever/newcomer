// What OpenStreetMap calls each map cell (the free Photon reverse geocoder, photon.komoot.io). Caching is best
// effort: the free plan allows 1,000 KV writes a day, and a failed write must never fail a search.

import { Budget, UA, fetchWithTimeout } from "./limits.ts";
import { kvGet, kvPut } from "./city.ts";

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
