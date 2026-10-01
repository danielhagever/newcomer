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
    name = p.district ?? p.locality ?? p.suburb ?? p.street ?? p.city ?? "";
  } catch {}
  if (name) await cache.put(key, name, { expirationTtl: 60 * 60 * 24 * 30 });
  return name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
}

export async function cityCenter(cache: KVNamespace, city: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const key = `city:${city.toLowerCase()}`;
  const hit = await cache.get(key, "json");
  if (hit) return hit as any;
  const d: any = await (
    await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city.split(",")[0])}&count=1&language=en`)
  ).json();
  const r = d.results?.[0];
  if (!r) return null;
  const out = { lat: r.latitude, lon: r.longitude, name: `${r.name}${r.admin1 ? ", " + r.admin1 : ""}` };
  await cache.put(key, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 * 30 });
  return out;
}
