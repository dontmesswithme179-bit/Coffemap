/**
 * Directory of known cafés and eating places in Israel (names + exact locations) from Overture Maps
 * places, bundled as public/data/places-il.json (rebuild with scripts/build-places.py).
 * Used for search, for snapping a tap to the place you meant, and for naming it.
 */

/** c = café, r = restaurant, q = quick bite (fast food, deli, food truck), b = bakery / dessert. */
export type PlaceKind = 'c' | 'r' | 'q' | 'b';

export const KIND_INFO: Record<PlaceKind, { icon: string; label: string; color: string }> = {
  c: { icon: '☕', label: 'Café', color: '#6b3f26' },
  r: { icon: '🍽️', label: 'Restaurant', color: '#c0533a' },
  q: { icon: '🥙', label: 'Quick bite', color: '#d98e2b' },
  b: { icon: '🥐', label: 'Bakery & dessert', color: '#b5739d' },
};

export interface KnownPlace {
  lng: number;
  lat: number;
  name: string;
  address: string;
  /** Overture's confidence that the place exists, 0-100. */
  confidence: number;
  kind: PlaceKind;
}

const URL_ = `${import.meta.env.BASE_URL}data/places-il.json`;

/** Addresses are mostly in Hebrew; let "arcaffe tel aviv" find them too. */
const CITY_ALIASES: [string, string][] = [
  ['תל אביב', 'tel aviv tlv yafo jaffa'], ['ירושלים', 'jerusalem'], ['חיפה', 'haifa'], ['רמת גן', 'ramat gan'],
  ['באר שבע', 'beer sheva beersheba'], ['נתניה', 'netanya'], ['ראשון לציון', 'rishon lezion'],
  ['פתח תקווה', 'petah tikva petach tikva'], ['הרצליה', 'herzliya'], ['אשקלון', 'ashkelon'], ['אשדוד', 'ashdod'],
  ['רעננה', 'raanana'], ['כפר סבא', 'kfar saba'], ['חולון', 'holon'], ['בת ים', 'bat yam'], ['רחובות', 'rehovot'],
  ['גבעתיים', 'givatayim'], ['הוד השרון', 'hod hasharon'], ['רמת השרון', 'ramat hasharon'], ['מודיעין', 'modiin'],
  ['אילת', 'eilat'], ['נצרת', 'nazareth'], ['עכו', 'akko acre'], ['נהריה', 'nahariya'], ['טבריה', 'tiberias'],
  ['חדרה', 'hadera'], ['זכרון יעקב', 'zichron yaakov'], ['קיסריה', 'caesarea'], ['כרמיאל', 'karmiel'], ['עפולה', 'afula'],
];
let loading: Promise<KnownPlace[]> | null = null;
let index: { place: KnownPlace; key: string }[] = [];

const KIND_WORDS: Record<PlaceKind, string> = {
  c: 'cafe coffee קפה בית קפה',
  r: 'restaurant food מסעדה אוכל',
  q: 'fast food quick bite אוכל מהיר',
  b: 'bakery dessert מאפייה קינוחים',
};

/** Lower-case, strip Hebrew vowel marks, punctuation and spacing so "קפה-לנדוור" ≈ "קפה לנדוור". */
export function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0591-\u05C7]/g, '') // Hebrew niqqud / cantillation
    .replace(/[\u0300-\u036f]/g, '') // Latin accents (café → cafe)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function loadPlaces(): Promise<KnownPlace[]> {
  loading ??= fetch(URL_)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`places ${r.status}`))))
    .then((data: { places: [number, number, string, string, number, PlaceKind][] }) => {
      const places = data.places.map(([lng, lat, name, address, confidence, kind]) => ({ lng, lat, name, address, confidence, kind }));
      // Pre-compute aliases once per city name rather than per place.
      const aliasKeys = CITY_ALIASES.map(([he, en]) => [normalize(he), en] as const);
      index = places.map((place) => {
        const key = normalize(`${place.name} ${place.address}`);
        const aliases = aliasKeys.filter(([he]) => key.includes(he)).map(([, en]) => en).join(' ');
        // Kind words too, so "bakery tel aviv" or "restaurant haifa" work.
        return { place, key: `${key} ${aliases} ${KIND_WORDS[place.kind]}` };
      });
      return places;
    })
    .catch((err) => {
      console.warn('Place directory unavailable', err);
      loading = null;
      return [];
    });
  return loading;
}

/** Places whose name/address/kind contain every word of the query, best matches first (closer to `near` breaks ties). */
export async function searchKnownPlaces(query: string, near?: { lng: number; lat: number }, limit = 8): Promise<KnownPlace[]> {
  await loadPlaces();
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored: { place: KnownPlace; score: number }[] = [];
  for (const { place, key } of index) {
    // Every word should match; with 3+ words, allow one miss (typos, extra words) if the name matches.
    const hits = words.filter((w) => key.includes(w)).length;
    const name = normalize(place.name);
    if (hits < words.length && !(words.length >= 3 && hits === words.length - 1 && name.includes(words[0]))) continue;
    // Prefer full matches, name matches, names starting with the query, then confidence.
    let score = place.confidence / 100 + (hits === words.length ? 3 : 0);
    if (words.every((w) => name.includes(w))) score += 2;
    if (name.startsWith(words[0])) score += 1;
    if (near) score += 0.9 / (1 + metres(near.lng, near.lat, place.lng, place.lat) / 3000);
    scored.push({ place, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.place);
}

function metres(aLng: number, aLat: number, bLng: number, bLat: number) {
  const x = (bLng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  const y = (bLat - aLat) * 110_540;
  return Math.hypot(x, y);
}

/** The known place closest to a point, if one is within `maxMetres` (cafés win near-ties). */
export function nearestPlace(lng: number, lat: number, maxMetres: number): KnownPlace | null {
  let best: KnownPlace | null = null;
  let bestD = maxMetres;
  for (const { place } of index) {
    if (Math.abs(place.lat - lat) > 0.01) continue;
    // This is a coffee app: count cafés as slightly closer than restaurants next door.
    const d = metres(lng, lat, place.lng, place.lat) * (place.kind === 'c' ? 0.8 : 1);
    if (d < bestD) {
      bestD = d;
      best = place;
    }
  }
  return best;
}

/** GeoJSON of every known place, for the "tap a place" layer shown while choosing a spot. */
export async function placesGeoJSON(): Promise<GeoJSON.FeatureCollection<GeoJSON.Point>> {
  const places = await loadPlaces();
  return {
    type: 'FeatureCollection',
    features: places.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { name: p.name, kind: p.kind, color: KIND_INFO[p.kind].color, cafe: p.kind === 'c' ? 1 : 0 },
    })),
  };
}
