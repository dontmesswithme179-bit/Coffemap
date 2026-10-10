/**
 * Directory of known cafés in Israel (names + exact locations) from Overture Maps places,
 * bundled as public/data/cafes-il.json (rebuild with scripts/build-cafes.py).
 * Used for search, for snapping a tap to the café you meant, and for naming it.
 */

export interface KnownCafe {
  lng: number;
  lat: number;
  name: string;
  address: string;
  /** Overture's confidence that the place exists, 0-100. */
  confidence: number;
}

const URL_ = `${import.meta.env.BASE_URL}data/cafes-il.json`;

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
let loading: Promise<KnownCafe[]> | null = null;
let index: { cafe: KnownCafe; key: string }[] = [];

/** Lower-case, strip Hebrew vowel marks, punctuation and spacing so "קפה-לנדוור" ≈ "קפה לנדוור". */
export function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[֑-ׇ]/g, '') // Hebrew niqqud / cantillation
    .replace(/[̀-ͯ]/g, '') // Latin accents (café → cafe)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function loadCafes(): Promise<KnownCafe[]> {
  loading ??= fetch(URL_)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`cafés ${r.status}`))))
    .then((data: { cafes: [number, number, string, string, number][] }) => {
      const cafes = data.cafes.map(([lng, lat, name, address, confidence]) => ({ lng, lat, name, address, confidence }));
      index = cafes.map((cafe) => {
        const key = normalize(`${cafe.name} ${cafe.address}`);
        const aliases = CITY_ALIASES.filter(([he]) => key.includes(normalize(he))).map(([, en]) => en).join(' ');
        return { cafe, key: aliases ? `${key} ${aliases}` : key };
      });
      return cafes;
    })
    .catch((err) => {
      console.warn('Café directory unavailable', err);
      loading = null;
      return [];
    });
  return loading;
}

/** Cafés whose name/address contain every word of the query, best matches first (closer to `near` breaks ties). */
export async function searchCafes(query: string, near?: { lng: number; lat: number }, limit = 6): Promise<KnownCafe[]> {
  await loadCafes();
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored: { cafe: KnownCafe; score: number }[] = [];
  for (const { cafe, key } of index) {
    // Every word should match; with 3+ words, allow one miss (typos, extra words) if the name matches.
    const hits = words.filter((w) => key.includes(w)).length;
    const name = normalize(cafe.name);
    if (hits < words.length && !(words.length >= 3 && hits === words.length - 1 && name.includes(words[0]))) continue;
    // Prefer full matches, name matches, names starting with the query, then confidence.
    let score = cafe.confidence / 100 + (hits === words.length ? 3 : 0);
    if (words.every((w) => name.includes(w))) score += 2;
    if (name.startsWith(words[0])) score += 1;
    if (near) score += 0.9 / (1 + metres(near.lng, near.lat, cafe.lng, cafe.lat) / 3000);
    scored.push({ cafe, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.cafe);
}

function metres(aLng: number, aLat: number, bLng: number, bLat: number) {
  const x = (bLng - aLng) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  const y = (bLat - aLat) * 110_540;
  return Math.hypot(x, y);
}

/** The known café closest to a point, if one is within `maxMetres`. */
export function nearestCafe(lng: number, lat: number, maxMetres: number): KnownCafe | null {
  let best: KnownCafe | null = null;
  let bestD = maxMetres;
  for (const { cafe } of index) {
    if (Math.abs(cafe.lat - lat) > 0.01) continue;
    const d = metres(lng, lat, cafe.lng, cafe.lat);
    if (d < bestD) {
      bestD = d;
      best = cafe;
    }
  }
  return best;
}

/** GeoJSON of every known café, for the "tap a café" layer shown while choosing a spot. */
export async function cafesGeoJSON(): Promise<GeoJSON.FeatureCollection<GeoJSON.Point>> {
  const cafes = await loadCafes();
  return {
    type: 'FeatureCollection',
    features: cafes.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { name: c.name },
    })),
  };
}
