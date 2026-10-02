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

const KEY = 'coffemap.places.v1';

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

class Store {
  private places: Place[] = [];
  private listeners = new Set<Listener>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) this.places = parsed.filter(isPlace);
    } catch {
      this.places = [];
    }
  }

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

  private commit() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.places));
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
    return JSON.stringify({ app: 'coffemap', version: 1, places: this.places }, null, 2);
  }

  /** Merges imported places; places with an existing id are replaced. Returns the count imported. */
  importJSON(text: string): number {
    const data = JSON.parse(text);
    const incoming: unknown[] = Array.isArray(data) ? data : data?.places;
    if (!Array.isArray(incoming)) throw new Error('No places found in file');
    const valid = incoming.filter(isPlace);
    const byId = new Map(this.places.map((p) => [p.id, p]));
    valid.forEach((p) => byId.set(p.id, p));
    this.places = [...byId.values()];
    this.commit();
    return valid.length;
  }
}

export const store = new Store();
