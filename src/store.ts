export interface Visit {
  id: string;
  rating: number; // 1..5, half steps allowed
  comment: string;
  date: string; // ISO timestamp
}

export interface Place {
  id: string;
  name: string;
  lng: number;
  lat: number;
  visits: Visit[];
}

/** A place you want to try but haven't rated yet. */
export interface Wish {
  id: string;
  name: string;
  lng: number;
  lat: number;
  note: string;
  addedAt: string; // ISO timestamp
  /** Where you came across it: "Instagram", "Bus-stop ad", "A friend"... */
  source?: string;
  /** Kind of place when picked from the directory: c café, r restaurant, q quick bite, b bakery. */
  kind?: 'c' | 'r' | 'q' | 'b';
}

const KEY = 'coffemap.places.v1';
const WISH_KEY = 'coffemap.wishes.v1';

type Listener = (places: Place[]) => void;

export const uid = () =>
  (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function avgRating(p: Place): number {
  if (!p.visits.length) return 0;
  return p.visits.reduce((s, v) => s + v.rating, 0) / p.visits.length;
}

export function lastVisit(p: Place): Visit | undefined {
  return [...p.visits].sort((a, b) => b.date.localeCompare(a.date))[0];
}

function isPlace(x: unknown): x is Place {
  const p = x as Place;
  return (
    !!p && typeof p.id === 'string' && typeof p.name === 'string' &&
    Number.isFinite(p.lng) && Number.isFinite(p.lat) && Array.isArray(p.visits)
  );
}

function isWish(x: unknown): x is Wish {
  const w = x as Wish;
  return !!w && typeof w.id === 'string' && typeof w.name === 'string' && Number.isFinite(w.lng) && Number.isFinite(w.lat);
}

function load<T>(key: string, guard: (x: unknown) => x is T): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

class Store {
  private places: Place[] = load(KEY, isPlace);
  private wishes: Wish[] = load(WISH_KEY, isWish).map((w) => ({ ...w, note: w.note ?? '', addedAt: w.addedAt ?? new Date().toISOString() }));
  private listeners = new Set<Listener>();

  all(): Place[] {
    return this.places;
  }

  get(id: string): Place | undefined {
    return this.places.find((p) => p.id === id);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  wishList(): Wish[] {
    return this.wishes;
  }

  getWish(id: string): Wish | undefined {
    return this.wishes.find((w) => w.id === id);
  }

  addWish(name: string, lng: number, lat: number, note: string, extra: Pick<Wish, 'source' | 'kind'> = {}): Wish {
    const wish: Wish = { id: uid(), name, lng, lat, note, addedAt: new Date().toISOString(), ...extra };
    this.wishes = [...this.wishes, wish];
    this.commit();
    return wish;
  }

  updateWish(id: string, patch: Partial<Pick<Wish, 'name' | 'note' | 'source'>>) {
    this.wishes = this.wishes.map((w) => (w.id === id ? { ...w, ...patch } : w));
    this.commit();
  }

  deleteWish(id: string) {
    this.wishes = this.wishes.filter((w) => w.id !== id);
    this.commit();
  }

  private commit() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.places));
      localStorage.setItem(WISH_KEY, JSON.stringify(this.wishes));
    } catch {
      // Storage full or unavailable - keep working in memory.
    }
    this.listeners.forEach((fn) => fn(this.places));
  }

  addPlace(name: string, lng: number, lat: number, visit: Omit<Visit, 'id'>): Place {
    const place: Place = { id: uid(), name, lng, lat, visits: [{ ...visit, id: uid() }] };
    this.places = [...this.places, place];
    this.commit();
    return place;
  }

  addVisit(placeId: string, visit: Omit<Visit, 'id'>) {
    this.places = this.places.map((p) =>
      p.id === placeId ? { ...p, visits: [...p.visits, { ...visit, id: uid() }] } : p,
    );
    this.commit();
  }

  renamePlace(placeId: string, name: string) {
    this.places = this.places.map((p) => (p.id === placeId ? { ...p, name } : p));
    this.commit();
  }

  deleteVisit(placeId: string, visitId: string) {
    this.places = this.places
      .map((p) => (p.id === placeId ? { ...p, visits: p.visits.filter((v) => v.id !== visitId) } : p))
      .filter((p) => p.visits.length > 0);
    this.commit();
  }

  deletePlace(placeId: string) {
    this.places = this.places.filter((p) => p.id !== placeId);
    this.commit();
  }

  exportJSON(): string {
    return JSON.stringify({ app: 'coffemap', version: 2, places: this.places, wishes: this.wishes }, null, 2);
  }

  /** Merges imported places and wishes; items with an existing id are replaced. Returns the counts imported. */
  importJSON(text: string): { places: number; wishes: number } {
    const data = JSON.parse(text);
    const incoming: unknown[] = Array.isArray(data) ? data : data?.places;
    const incomingWishes: unknown[] = Array.isArray(data?.wishes) ? data.wishes : [];
    if (!Array.isArray(incoming)) throw new Error('No places found in file');
    const valid = incoming.filter(isPlace);
    const byId = new Map(this.places.map((p) => [p.id, p]));
    valid.forEach((p) => byId.set(p.id, p));
    this.places = [...byId.values()];
    const validWishes = incomingWishes.filter(isWish).map((w) => ({ ...w, note: w.note ?? '', addedAt: w.addedAt ?? new Date().toISOString() }));
    const wishById = new Map(this.wishes.map((w) => [w.id, w]));
    validWishes.forEach((w) => wishById.set(w.id, w));
    this.wishes = [...wishById.values()];
    this.commit();
    return { places: valid.length, wishes: validWishes.length };
  }
}

export const store = new Store();
