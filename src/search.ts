export interface SearchResult {
  name: string;
  detail: string;
  lng: number;
  lat: number;
}

interface NominatimItem {
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
}

/** Free-text place search limited to Israel, via OpenStreetMap Nominatim (called on submit only, per its usage policy). */
export async function searchPlaces(q: string): Promise<SearchResult[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({
    q,
    format: 'jsonv2',
    countrycodes: 'il',
    limit: '6',
    'accept-language': 'he,en',
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const items: NominatimItem[] = await res.json();
  return items.map((it) => {
    const parts = it.display_name.split(',').map((s) => s.trim());
    const name = it.name || parts[0];
    return {
      name,
      detail: parts.filter((p) => p !== name).slice(0, 3).join(', '),
      lng: Number(it.lon),
      lat: Number(it.lat),
    };
  });
}
