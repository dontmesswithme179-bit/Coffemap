import { Map as MLMap, Marker, NavigationControl, setRTLTextPlugin, setWorkerUrl, type GeoJSONSource, type LngLatLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre locates its worker relative to its own module URL, which bundling breaks, so bundle it explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection, Point } from 'geojson';
import { avgRating, type Place, type Wish } from './store';
import { Clouds, type Hole } from './clouds';
import { CafeLayer } from './cafe-layer';
import { footprintsAround } from './houses';
import { cafesGeoJSON } from './cafe-directory';

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

const colorExpr = (prop: string) => [
  'interpolate', ['linear'], ['get', prop],
  ...RATING_COLORS.flatMap(([r, c]) => [r, c]),
];

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
        customAttribution: 'Cafés: <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps</a>',
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
    // Wish-list pins show their names once you're zoomed in enough for them not to clutter.
    const syncWishLabels = () => container.classList.toggle('show-wish-labels', this.map.getZoom() >= 12.5);
    this.map.on('zoom', syncWishLabels);
    syncWishLabels();
    this.map.on('mousemove', (e) => {
      this.map.getCanvas().style.cursor = this.placeAt(e.point.x, e.point.y) ? 'pointer' : '';
    });
  }

  private placeAt(x: number, y: number): string | null {
    if (!this.loaded) return null;
    const cafe = this.cafes.hitTest(x, y);
    if (cafe) return cafe;
    const hit = this.map.queryRenderedFeatures([x, y], { layers: ['place-dot'] });
    return hit[0]?.properties?.id ? String(hit[0].properties.id) : null;
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
        'hillshade-shadow-color': '#6b5444',
        'hillshade-highlight-color': '#fff8ea',
        'hillshade-accent-color': '#8a6f5c',
        'hillshade-illumination-anchor': 'map',
      },
    }, before);

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
      'sky-color': '#a9cdea',
      'horizon-color': '#f6e9d6',
      'fog-color': '#f1e7da',
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

    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    map.addSource('places-pt', { type: 'geojson', data: empty });

    map.addLayer({
      id: 'place-glow',
      type: 'circle',
      source: 'places-pt',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 10, 12, 22, 16, 60],
        'circle-color': colorExpr('rating') as never,
        'circle-blur': 1,
        'circle-opacity': ['*', 0.45, ['get', 'grow']],
        'circle-pitch-alignment': 'map',
      },
    });
    map.addLayer({
      id: 'place-dot',
      type: 'circle',
      source: 'places-pt',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 5, 12, 7, 14.5, 4],
        'circle-color': colorExpr('rating') as never,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 1, 15, 0],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 1, 15, 0],
      },
    });
    map.addLayer({
      id: 'place-label',
      type: 'symbol',
      source: 'places-pt',
      layout: {
        'text-field': ['format', ['get', 'name'], {}, '\n', {}, ['get', 'stars'], { 'font-scale': 0.85 }],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 15, 14],
        'text-anchor': 'top',
        'text-offset': [0, 0.9],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#3b2418',
        'text-halo-color': '#fffaf2',
        'text-halo-width': 1.6,
        // The 3D café carries its own name sign once you're close.
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, ['get', 'grow'], 16.5, 0],
      },
    });
    // Every known café (Overture Maps), shown while choosing where you drank so you can just tap it.
    map.addSource('known-cafes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'known-cafe-dot',
      type: 'circle',
      source: 'known-cafes',
      minzoom: 12,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 7],
        'circle-color': '#6b3f26',
        'circle-stroke-color': '#fffaf2',
        'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'known-cafe-label',
      type: 'symbol',
      source: 'known-cafes',
      minzoom: 15,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 0.8],
        'text-max-width': 9,
      },
      paint: { 'text-color': '#3b2418', 'text-halo-color': '#fffaf2', 'text-halo-width': 1.5 },
    });
    cafesGeoJSON().then((data) => (map.getSource('known-cafes') as GeoJSONSource | undefined)?.setData(data));
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
   * Wish-list pins are DOM markers, so they sit above the clouds and stay visible at every zoom.
   */
  setWishes(wishes: Wish[]) {
    const seen = new Set<string>();
    for (const w of wishes) {
      seen.add(w.id);
      const existing = this.wishMarkers.get(w.id);
      if (existing) {
        existing.marker.setLngLat([w.lng, w.lat]);
        existing.label.textContent = w.name;
        continue;
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'wish-pin';
      el.setAttribute('aria-label', `Wish list: ${w.name}`);
      const bubble = document.createElement('span');
      bubble.className = 'wish-pin__bubble';
      const heart = document.createElement('i');
      heart.textContent = '♥';
      bubble.append(heart);
      const label = document.createElement('span');
      label.className = 'wish-pin__label';
      label.textContent = w.name;
      el.append(bubble, label);
      el.style.setProperty('--delay', `${(this.wishMarkers.size % 7) * -0.4}s`);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.events.onWishClick(w.id);
      });
      const marker = new Marker({ element: el, anchor: 'bottom' }).setLngLat([w.lng, w.lat]).addTo(this.map);
      this.wishMarkers.set(w.id, { marker, label });
    }
    for (const [id, m] of this.wishMarkers) {
      if (seen.has(id)) continue;
      m.marker.remove();
      this.wishMarkers.delete(id);
    }
  }

  /** Show or hide the directory of known cafés (while choosing a spot). */
  setKnownCafesVisible(on: boolean) {
    if (!this.loaded) return;
    for (const id of ['known-cafe-dot', 'known-cafe-label']) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
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
    const pts: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
    let pending = false;

    for (const p of this.places) {
      const rating = avgRating(p);
      const raw = this.progress(p.id, GROW_MS);
      if (raw < 1) pending = true;
      const props = { id: p.id, rating };
      pts.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          ...props,
          name: p.name,
          stars: `${rating.toFixed(1)} / 5`,
          grow: clamp01(raw * 1.5),
        },
      });
    }

    (this.map.getSource('places-pt') as GeoJSONSource | undefined)?.setData(pts);

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
      cloudScale: 300 * Math.pow(2, (z - 8) * 0.12),
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
