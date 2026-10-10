import { Map as MLMap, Marker, NavigationControl, setRTLTextPlugin, setWorkerUrl, type GeoJSONSource, type LayerSpecification, type LngLatLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre locates its worker relative to its own module URL, which bundling breaks, so bundle it explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { avgRating, type Place, type Wish } from './store';
import { Clouds, type Hole } from './clouds';
import { CafeLayer, POPUP_ZOOM } from './cafe-layer';
import { footprintsAround } from './houses';
import { placesGeoJSON, type PlaceKind } from './place-directory';

export const ISRAEL_BOUNDS: [[number, number], [number, number]] = [[34.2, 29.45], [35.95, 33.35]];
const MAX_BOUNDS: [[number, number], [number, number]] = [[32.6, 28.6], [37.6, 34.2]];
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** Free global elevation tiles (AWS Open Data / Mapzen Terrarium) for hillshading. */
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const REVEAL_METERS = 230;
/** Map buildings within this distance of a rated café are swapped for low-poly houses. */
const HOUSE_RADIUS = REVEAL_METERS;
const REVEAL_MIN_PX = 34;
const GROW_MS = 1400;
const REVEAL_MS = 1800;

const TAPE_COLORS = ['#a9d4cb', '#f2b6b0', '#f4d36b', '#c9c2ec', '#b9d99b'];
export const CLIP_COLORS: Record<PlaceKind, string> = { c: '#f4d8a8', r: '#f0c2b0', q: '#f6dc9c', b: '#e7cfe3' };
const icon = (paths: string) =>
  `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
export const KIND_ICONS: Record<PlaceKind, string> = {
  c: icon('<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 11h2a2 2 0 0 1 0 4h-2"/><path d="M8 3c0 2 2 2 2 4M12 3c0 2 2 2 2 4"/>'),
  r: icon('<circle cx="12" cy="13" r="6"/><path d="M4 3v6a2 2 0 0 0 2 2M4 3v18M20 3c-2 0-3 2-3 5s1 4 3 4v9"/>'),
  q: icon('<path d="M4 13c0-5 4-8 8-8s8 3 8 8H4z"/><path d="M3 13h18v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/>'),
  b: icon('<path d="M4 14c0-5 4-8 8-8s8 3 8 8H4z"/><path d="M4 14h16v3H4z"/>'),
};
export const STAR_SVG =
  '<svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3 6.5 7 .8-5.2 4.8 1.5 7L12 17.6 5.7 21.1l1.5-7L2 9.3l7-.8z" fill="#f2b630" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>';

/** MapLibre owns a marker element's transform/opacity, so our tilt, grow and hide go on a child. */
function markerWrap(child: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.className = 'marker-wrap';
  wrap.append(child);
  return wrap;
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Colour ramp from a disappointing cup to a perfect one. */
export const RATING_COLORS: [number, string][] = [
  [1, '#a8324a'],
  [2, '#d9653b'],
  [3, '#e8b23a'],
  [4, '#8db650'],
  [5, '#2e9a6b'],
];

export function ratingColor(r: number): string {
  for (let i = RATING_COLORS.length - 1; i >= 0; i--) if (r >= RATING_COLORS[i][0]) return RATING_COLORS[i][1];
  return RATING_COLORS[0][1];
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export interface CoffeeMapEvents {
  onPlaceClick: (id: string) => void;
  onMapClick: (lng: number, lat: number, suggestedName: string | null) => void;
  onWishClick: (id: string) => void;
}

export class CoffeeMap {
  readonly map: MLMap;
  private places: Place[] = [];
  /** Animation start times per place id, for the cloud reveal and building growth. */
  private appearAt = new Map<string, number>();
  private extraHole: { lng: number; lat: number } | null = null;
  private loaded = false;
  private animating = false;
  readonly clouds: Clouds;
  private cafes = new CafeLayer((id) => this.progress(id, GROW_MS));
  private wishMarkers = new Map<string, { marker: Marker; label: HTMLElement }>();
  private stainMarkers = new Map<string, { marker: Marker; label: HTMLElement; el: HTMLElement }>();
  /** The style's 3D building layers, with their original filters, so houses can replace them near cafés. */
  private buildingLayers: { id: string; source: string; sourceLayer: string; filter: unknown }[] = [];

  constructor(container: HTMLElement, private events: CoffeeMapEvents) {
    setWorkerUrl(workerUrl);
    setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js', true)
      .catch(() => { /* Hebrew labels will just render unshaped */ });

    this.map = new MLMap({
      container,
      style: STYLE_URL,
      bounds: ISRAEL_BOUNDS,
      fitBoundsOptions: { padding: 40 },
      maxBounds: MAX_BOUNDS,
      maxPitch: 75,
      attributionControl: {
        compact: true,
        customAttribution: 'Places: <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps</a>',
      },
    });
    this.map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

    this.clouds = new Clouds(container, () => this.cloudView(), () => this.holes());

    this.map.on('load', () => this.onLoad());
    this.map.on('click', (e) => {
      const id = this.placeAt(e.point.x, e.point.y);
      if (id) return this.events.onPlaceClick(id);
      this.events.onMapClick(e.lngLat.lng, e.lngLat.lat, this.poiNameAt(e.point.x, e.point.y));
    });
    // Markers change form with zoom: tiny far out, name tags mid-way, full clippings close up,
    // and stains step aside once the 3D café pops up at street level.
    const syncZoomClasses = () => {
      const z = this.map.getZoom();
      container.classList.toggle('zoom-far', z < 11);
      container.classList.toggle('zoom-near', z >= 14);
      container.classList.toggle('zoom-popup', z >= POPUP_ZOOM);
    };
    this.map.on('zoom', syncZoomClasses);
    syncZoomClasses();
    this.map.on('mousemove', (e) => {
      this.map.getCanvas().style.cursor = this.placeAt(e.point.x, e.point.y) ? 'pointer' : '';
    });
  }

  /** A 3D café under the point (stains and clippings are DOM markers with their own clicks). */
  private placeAt(x: number, y: number): string | null {
    return this.loaded ? this.cafes.hitTest(x, y) : null;
  }

  /** Extra detail on top of the base style: terrain shading, sky/haze, softer real buildings. */
  private enhanceStyle() {
    const map = this.map;
    const layers = map.getStyle().layers ?? [];
    map.addSource('dem', {
      type: 'raster-dem',
      tiles: [DEM_TILES],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen / AWS</a>',
    });
    // Draw hills under roads, water and labels so they stay crisp.
    const before = layers.find((l) => /water|road|highway|tunnel|bridge|building|boundary/.test(l.id) && l.type !== 'background')?.id;
    map.addLayer({
      id: 'hillshade',
      type: 'hillshade',
      source: 'dem',
      paint: {
        'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 6, 0.45, 12, 0.3, 15, 0.12],
        'hillshade-shadow-color': '#8a7258',
        'hillshade-highlight-color': '#fffaf0',
        'hillshade-accent-color': '#9c8468',
        'hillshade-illumination-anchor': 'map',
      },
    }, before);

    this.paperStyle(layers);

    // Real OSM buildings: warm, slightly translucent, so a café inside one stays visible.
    for (const l of layers) {
      if (l.type !== 'fill-extrusion') continue;
      map.setPaintProperty(l.id, 'fill-extrusion-color', ['interpolate', ['linear'], ['zoom'], 14, '#e9dfd2', 17, '#efe6da']);
      map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.62);
      if ('source' in l && typeof l.source === 'string') {
        this.buildingLayers.push({ id: l.id, source: l.source, sourceLayer: l['source-layer'] ?? '', filter: l.filter });
      }
    }

    map.setSky({
      'sky-color': '#e9e1cf',
      'horizon-color': '#f7f1e3',
      'fog-color': '#f4ecdc',
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.35,
      'atmosphere-blend': 0,
    });
  }

  private onLoad() {
    const map = this.map;
    map.setLight({ anchor: 'viewport', color: '#fff6e8', intensity: 0.4, position: [1.3, 210, 40] });
    try {
      this.enhanceStyle();
    } catch (err) {
      console.warn('Style enhancements skipped', err);
    }

    // Every known café and eating place (Overture Maps), shown while choosing a spot so you can just tap it.
    // Cafés appear from further out and are drawn on top; restaurants etc. join in when zoomed in.
    map.addSource('known-places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'known-place-dot',
      type: 'circle',
      source: 'known-places',
      minzoom: 12,
      filter: ['any', ['==', ['get', 'cafe'], 1], ['>=', ['zoom'], 14.5]],
      layout: { visibility: 'none', 'circle-sort-key': ['get', 'cafe'] },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, ['case', ['==', ['get', 'cafe'], 1], 7, 5.5]],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': '#fffaf2',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'known-place-label',
      type: 'symbol',
      source: 'known-places',
      minzoom: 15,
      layout: {
        visibility: 'none',
        'symbol-sort-key': ['-', 1, ['get', 'cafe']],
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 0.8],
        'text-max-width': 9,
      },
      paint: { 'text-color': '#3b2418', 'text-halo-color': '#fffaf2', 'text-halo-width': 1.5 },
    });
    placesGeoJSON().then((data) => (map.getSource('known-places') as GeoJSONSource | undefined)?.setData(data));
    map.addLayer(this.cafes);

    this.loaded = true;
    this.syncCafes();
    // The steam animation keeps the map repainting, so 'idle' rarely fires; react to tiles and moves instead.
    let pending = 0;
    const schedule = () => {
      clearTimeout(pending);
      pending = window.setTimeout(this.collectHouses, 350);
    };
    map.on('moveend', schedule);
    map.on('sourcedata', (e) => {
      if (e.isSourceLoaded && this.buildingLayers.some((l) => l.source === e.sourceId)) schedule();
    });
    this.render();
  }

  /** Name of a café / POI under the click, so the form can be pre-filled. */
  private poiNameAt(x: number, y: number): string | null {
    const feats = this.map
      .queryRenderedFeatures([[x - 14, y - 14], [x + 14, y + 14]])
      .filter((f) => f.sourceLayer === 'poi' && (f.properties?.['name:en'] || f.properties?.name));
    const cafe = feats.find((f) => f.properties?.class === 'cafe' || f.properties?.subclass === 'cafe');
    const f = cafe ?? feats[0];
    return f ? String(f.properties['name:he'] || f.properties.name || f.properties['name:en']) : null;
  }

  /** New places animate in; `stagger` makes a batch (e.g. on startup) appear one after another. */
  setPlaces(places: Place[], opts: { stagger?: boolean } = {}) {
    const now = performance.now();
    places.forEach((p, i) => {
      if (!this.appearAt.has(p.id)) this.appearAt.set(p.id, now + (opts.stagger ? 600 + i * 140 : 0));
    });
    this.places = places;
    this.syncCafes();
    this.render();
  }

  private syncCafes() {
    if (!this.loaded) return;
    this.cafes.setCafes(this.places.map((p) => {
      const rating = avgRating(p);
      return { id: p.id, name: p.name, rating, accent: ratingColor(rating), lng: p.lng, lat: p.lat };
    }));
    this.hideBuildingsNearCafes();
    this.collectHouses();
  }

  /**
   * Recolour the base map like a printed paper street map (scrapbook look): cream ground, pale
   * blue water, tan roads, muted parks and brown ink labels. Matches layers by id so it works
   * with any OpenMapTiles-style map; layers it doesn't recognise keep their colours.
   */
  private paperStyle(layers: LayerSpecification[]) {
    const set = (id: string, prop: string, value: unknown) => {
      try {
        this.map.setPaintProperty(id, prop as never, value as never);
      } catch {
        /* property not on this layer */
      }
    };
    for (const l of layers) {
      const id = l.id.toLowerCase();
      if (l.type === 'background') set(l.id, 'background-color', '#f7f1e3');
      else if (l.type === 'fill') {
        if (/water|ocean|sea|lake|river/.test(id)) set(l.id, 'fill-color', '#cfe3e6');
        else if (/park|grass|wood|forest|wetland|garden|cemetery|pitch|golf|landcover/.test(id)) set(l.id, 'fill-color', '#e4e8cf');
        else if (/sand|beach|desert/.test(id)) set(l.id, 'fill-color', '#f1e5c4');
        else if (/building/.test(id)) set(l.id, 'fill-color', '#ece2cf');
        else if (/landuse|residential|industrial|commercial|retail|school|hospital|aeroway/.test(id)) set(l.id, 'fill-color', '#f2eadb');
      } else if (l.type === 'line') {
        if (/water|river|stream|canal/.test(id)) set(l.id, 'line-color', '#a9cfd6');
        else if (/boundary|admin/.test(id)) set(l.id, 'line-color', '#c3ab88');
        else if (/rail|transit/.test(id)) set(l.id, 'line-color', '#c9bba5');
        else if (/road|highway|street|bridge|tunnel|path|motorway|trunk|primary|secondary|tertiary|minor|service/.test(id)) {
          if (/casing|outline/.test(id)) set(l.id, 'line-color', '#d8c19c');
          else if (/motorway|trunk|primary/.test(id)) set(l.id, 'line-color', '#e2bf8c');
          else if (/path|footway|track|cycle|pedestrian/.test(id)) set(l.id, 'line-color', '#d9c7a6');
          else set(l.id, 'line-color', '#fbf4e4');
        }
      } else if (l.type === 'symbol') {
        set(l.id, 'text-color', /water|ocean|sea|lake|river/.test(id) ? '#4f7f88' : '#4a3f35');
        set(l.id, 'text-halo-color', '#f7f1e3');
        set(l.id, 'icon-opacity', 0.75);
      }
    }
  }

  /** Drop the plain extruded buildings around cafés; houses are drawn there instead. */
  private hideBuildingsNearCafes() {
    const pts = this.places.map((p) => [p.lng, p.lat]);
    for (const l of this.buildingLayers) {
      const near = ['>', ['distance', { type: 'MultiPoint', coordinates: pts }], HOUSE_RADIUS];
      const filter = pts.length ? (l.filter ? ['all', l.filter, near] : near) : l.filter;
      try {
        this.map.setFilter(l.id, (filter ?? null) as never);
      } catch (err) {
        console.warn('Could not hide buildings near cafés', err);
      }
    }
  }

  /**
   * Read building outlines from the loaded map tiles and hand them to the café layer.
   * Tiles only hold buildings from zoom 14, and only for the area on screen, so this re-runs as
   * tiles load and keeps whichever result found more buildings.
   */
  private collectHouses = () => {
    const l = this.buildingLayers[0];
    if (!l || this.map.getZoom() < 14 || !this.places.length) return;
    const bounds = this.map.getBounds();
    const pad = 0.004; // ~400 m, so cafés just off-screen still get their neighbourhood
    const nearby = this.places.filter((p) =>
      p.lng > bounds.getWest() - pad && p.lng < bounds.getEast() + pad &&
      p.lat > bounds.getSouth() - pad && p.lat < bounds.getNorth() + pad);
    if (!nearby.length) return;
    let polygons: GeoJSON.Position[][][];
    try {
      polygons = this.map
        .querySourceFeatures(l.source, { sourceLayer: l.sourceLayer || undefined })
        .flatMap((f) =>
          f.geometry.type === 'Polygon' ? [f.geometry.coordinates] :
          f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
    } catch {
      return;
    }
    for (const p of nearby) {
      const list = footprintsAround(p.lng, p.lat, HOUSE_RADIUS, polygons);
      if (list.length > this.cafes.footprintCount(p.id)) this.cafes.setFootprints(p.id, list);
    }
  };

  /**
   * Wish-list places are taped-on clippings (DOM markers), so they sit above the tracing paper and
   * stay visible at every zoom. CSS shrinks them to a pin far out and a name tag mid-way.
   */
  setWishes(wishes: Wish[]) {
    const seen = new Set<string>();
    for (const w of wishes) {
      seen.add(w.id);
      const existing = this.wishMarkers.get(w.id);
      if (existing) {
        existing.marker.setLngLat([w.lng, w.lat]);
        existing.label.textContent = w.name;
        existing.marker.getElement().firstElementChild?.setAttribute('aria-label', `Wish list: ${w.name}`);
        continue;
      }
      const seed = hashString(w.id);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'clip';
      el.setAttribute('aria-label', `Wish list: ${w.name}`);
      el.style.setProperty('--rot', `${((seed % 140) / 10 - 7).toFixed(1)}deg`);
      el.style.setProperty('--tape', TAPE_COLORS[seed % TAPE_COLORS.length]);
      const kind = w.kind ?? 'c';
      el.style.setProperty('--photo', CLIP_COLORS[kind]);
      const tape = document.createElement('span');
      tape.className = 'clip__tape';
      const photo = document.createElement('span');
      photo.className = 'clip__photo';
      photo.innerHTML = KIND_ICONS[kind]; // static SVG markup, no user input
      const label = document.createElement('span');
      label.className = 'clip__name';
      label.textContent = w.name;
      el.append(tape, photo, label);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.events.onWishClick(w.id);
      });
      const marker = new Marker({ element: markerWrap(el), anchor: 'bottom' }).setLngLat([w.lng, w.lat]).addTo(this.map);
      this.wishMarkers.set(w.id, { marker, label });
    }
    for (const [id, m] of this.wishMarkers) {
      if (seen.has(id)) continue;
      m.marker.remove();
      this.wishMarkers.delete(id);
    }
  }

  /** Visited places: a coffee-ring stain, a gold star sticker and a handwritten name with the score. */
  private syncStains() {
    const seen = new Set<string>();
    for (const p of this.places) {
      seen.add(p.id);
      const text = `${p.name} — ${avgRating(p).toFixed(1)}!`;
      const existing = this.stainMarkers.get(p.id);
      if (existing) {
        existing.marker.setLngLat([p.lng, p.lat]);
        existing.label.textContent = text;
        continue;
      }
      const seed = hashString(p.id);
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'stain';
      el.setAttribute('aria-label', `Visited: ${p.name}`);
      el.style.setProperty('--rot', `${((seed % 90) / 10 - 4.5).toFixed(1)}deg`);
      el.style.setProperty('--ring-rot', `${seed % 360}deg`);
      const ring = document.createElement('span');
      ring.className = 'stain__ring';
      const star = document.createElement('span');
      star.className = 'stain__star';
      star.innerHTML = STAR_SVG; // static SVG markup, no user input
      const label = document.createElement('span');
      label.className = 'stain__name';
      label.textContent = text;
      el.append(ring, star, label);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.events.onPlaceClick(p.id);
      });
      const marker = new Marker({ element: markerWrap(el), anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(this.map);
      this.stainMarkers.set(p.id, { marker, label, el });
    }
    for (const [id, m] of this.stainMarkers) {
      if (seen.has(id)) continue;
      m.marker.remove();
      this.stainMarkers.delete(id);
    }
  }

  /** Show or hide the directory of known places (while choosing a spot). */
  setKnownPlacesVisible(on: boolean) {
    if (!this.loaded) return;
    for (const id of ['known-place-dot', 'known-place-label']) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /** Map metres covered by `px` screen pixels at a latitude (for tap tolerances). */
  pxToMetres(px: number, lat: number) {
    return (px * 78_271.517 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, this.map.getZoom());
  }

  /** Restart the grow animation for one place (e.g. after rating it again). */
  bump(id: string) {
    this.appearAt.set(id, performance.now());
    this.render();
    this.map.triggerRepaint();
  }

  setPickPoint(p: { lng: number; lat: number } | null) {
    this.extraHole = p;
  }

  private progress(id: string, ms: number): number {
    const t0 = this.appearAt.get(id) ?? 0;
    return clamp01((performance.now() - t0) / ms);
  }

  private render = () => {
    if (!this.loaded) return;
    this.syncStains();
    let pending = false;
    for (const p of this.places) {
      const raw = this.progress(p.id, GROW_MS);
      if (raw < 1) pending = true;
      // Stains soak in as the paper tears away.
      this.stainMarkers.get(p.id)?.el.style.setProperty('--grow', String(easeOutCubic(clamp01(raw * 1.3))));
    }
    if (pending && !this.animating) {
      this.animating = true;
      requestAnimationFrame(() => {
        this.animating = false;
        this.render();
      });
    }
  };

  private cloudView() {
    const anchor = this.map.project([35, 31.5]);
    const z = this.map.getZoom();
    return {
      anchorX: anchor.x,
      anchorY: anchor.y,
      scale: 260 * Math.pow(2, (z - 8) * 0.35),
    };
  }

  private holePx(lng: number, lat: number, meters: number) {
    const c = this.map.project([lng, lat]);
    const e = this.map.project([lng + meters / (111_320 * Math.cos((lat * Math.PI) / 180)), lat]);
    return { x: c.x, y: c.y, r: Math.max(REVEAL_MIN_PX, Math.hypot(e.x - c.x, e.y - c.y)) };
  }

  private holes(): Hole[] {
    const out: Hole[] = this.places.map((p) => ({
      ...this.holePx(p.lng, p.lat, REVEAL_METERS),
      a: easeOutCubic(this.progress(p.id, REVEAL_MS)),
    }));
    if (this.extraHole) out.push({ ...this.holePx(this.extraHole.lng, this.extraHole.lat, 120), a: 0.8 });
    return out;
  }

  flyTo(center: LngLatLike, zoom = 17.2) {
    this.map.flyTo({ center, zoom, pitch: 60, bearing: -18, speed: 1.4, essential: true });
  }

  showAll() {
    if (!this.places.length) {
      this.map.fitBounds(ISRAEL_BOUNDS, { padding: 40, pitch: 0, bearing: 0 });
      return;
    }
    const lngs = this.places.map((p) => p.lng);
    const lats = this.places.map((p) => p.lat);
    const pad = 0.02;
    this.map.fitBounds(
      [[Math.min(...lngs) - pad, Math.min(...lats) - pad], [Math.max(...lngs) + pad, Math.max(...lats) + pad]],
      { padding: 80, maxZoom: 15, pitch: 35, bearing: 0 },
    );
  }
}
