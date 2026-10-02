// Neighborhood names for map cells, from OpenStreetMap via the free Photon reverse geocoder
// (photon.komoot.io). Results are cached in KV for 30 days to stay well inside fair use.

export async function neighborhoodName(cache: KVNamespace, lat: number, lon: number): Promise<string> {
  const key = `rev:${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = await cache.get(key);
  if (hit) return hit;
  let name = "";
  try {
    const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en`, {
      headers: { "user-agent": "Newcomer/0.1 (Qloo hackathon demo; github.com/danielhagever/newcomer)" },
    });
    const d: any = await res.json();
    const p = d.features?.[0]?.properties ?? {};
    // Prefer real neighborhood-level names; a street is labelled as such rather than passed off as a neighborhood.
    name = p.district ?? p.locality ?? p.suburb ?? (p.street ? `around ${p.street}` : (p.city ?? ""));
  } catch {}
  if (name) await cache.put(key, name, { expirationTtl: 60 * 60 * 24 * 30 });
  return name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

export async function cityCenter(cache: KVNamespace, city: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const key = `city:${city.toLowerCase()}`;
  const hit = await cache.get(key, "json");
  if (hit) return hit as any;
  // "Portland, Maine" must not land on Portland, Oregon: fetch several candidates and prefer the one
  // whose state or country matches what came after the comma; otherwise take the most populous.
  const [name, ...rest] = city.split(",").map((x) => x.trim());
  const qualifier = rest.join(" ").toLowerCase();
  const d: any = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en`)).json();
  const list: any[] = d.results ?? [];
  if (!list.length) return null;
  const matches = qualifier
    ? list.filter((r) => [r.admin1, r.country, r.country_code].some((v) => v && (qualifier.includes(String(v).toLowerCase()) || String(v).toLowerCase().includes(qualifier))))
    : [];
  const pool = matches.length ? matches : list;
  const r = [...pool].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
  const out = { lat: r.latitude, lon: r.longitude, name: `${r.name}${r.admin1 ? ", " + r.admin1 : ""}` };
  await cache.put(key, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 30 });
  return out;
}
