import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildCafe, buildGlbCafe, type CafeModel } from './cafe-model';

/** Imported café model; the hand-built café is used until it loads, or if it fails to. */
const CAFE_MODEL_URL = `${import.meta.env.BASE_URL}models/coffee-shop.glb`;

export interface CafeSpec {
  id: string;
  name: string;
  rating: number;
  accent: string;
  lng: number;
  lat: number;
}

interface Entry {
  spec: CafeSpec;
  key: string;
  model: CafeModel;
  mx: number;
  my: number;
  mPerMerc: number; // mercator units per metre at this latitude
}

const EARTH_CIRCUMFERENCE = 40_075_016.686;
const MIN_ZOOM = 12.8;

function toMercator(lng: number, lat: number) {
  const x = (lng + 180) / 360;
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
  return { x, y };
}

/** Models are exaggerated when zoomed out so a café stays readable instead of shrinking to a speck. */
export function cafeExaggeration(zoom: number) {
  return 2.6 * Math.max(1, Math.pow(2, (17.5 - zoom) * 0.75));
}

const easeOutBack = (t: number) => {
  const c1 = 1.5, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/**
 * MapLibre custom layer that draws a procedural three.js café at each rated place,
 * sharing the map's WebGL context and depth buffer so it sits among real 3D buildings.
 */
export class CafeLayer implements CustomLayerInterface {
  readonly id = 'cafes-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map!: MLMap;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private entries = new Map<string, Entry>();
  private lastMatrix = new THREE.Matrix4();
  private start = performance.now();
  private template: THREE.Object3D | null = null;

  constructor(private getGrow: (id: string) => number) {
    this.scene.add(new THREE.HemisphereLight(0xfff3df, 0x7d6a58, 2.1));
    const sun = new THREE.DirectionalLight(0xfff0d6, 2.6);
    sun.position.set(-0.6, 1, 0.9);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0xc9dcff, 0.8);
    rim.position.set(0.8, 0.6, -1);
    this.scene.add(rim);
  }

  onAdd(map: MLMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    new GLTFLoader().load(
      CAFE_MODEL_URL,
      (gltf) => {
        this.template = gltf.scene;
        // Rebuild every café with the imported model.
        const specs = [...this.entries.values()].map((e) => e.spec);
        this.entries.forEach((e) => (e.key = ''));
        this.setCafes(specs);
      },
      undefined,
      (err) => console.warn('Café model failed to load, using the built-in one', err),
    );
  }

  onRemove() {
    this.entries.forEach((e) => e.model.dispose());
    this.entries.clear();
  }

  setCafes(cafes: CafeSpec[]) {
    const seen = new Set<string>();
    for (const spec of cafes) {
      seen.add(spec.id);
      const key = `${this.template ? 'glb' : 'proc'}|${spec.name}|${spec.rating.toFixed(2)}|${spec.accent}`;
      const prev = this.entries.get(spec.id);
      const { x, y } = toMercator(spec.lng, spec.lat);
      const mPerMerc = 1 / (EARTH_CIRCUMFERENCE * Math.cos((spec.lat * Math.PI) / 180));
      if (prev && prev.key === key) {
        Object.assign(prev, { spec, mx: x, my: y, mPerMerc });
        continue;
      }
      if (prev) {
        this.scene.remove(prev.model.root);
        prev.model.dispose();
      }
      const model = this.template
        ? buildGlbCafe(this.template, spec.name, spec.rating, spec.accent)
        : buildCafe(spec.name, spec.rating, spec.accent);
      model.root.visible = false;
      this.scene.add(model.root);
      this.entries.set(spec.id, { spec, key, model, mx: x, my: y, mPerMerc });
    }
    for (const [id, e] of this.entries) {
      if (seen.has(id)) continue;
      this.scene.remove(e.model.root);
      e.model.dispose();
      this.entries.delete(id);
    }
    this.map?.triggerRepaint();
  }

  private modelMatrix(e: Entry, zoom: number) {
    const grow = Math.max(0, easeOutBack(Math.min(1, this.getGrow(e.spec.id))));
    const s = e.mPerMerc * cafeExaggeration(zoom) * Math.max(grow, 1e-4);
    return new THREE.Matrix4()
      .makeTranslation(e.mx, e.my, 0)
      .scale(new THREE.Vector3(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const zoom = this.map.getZoom();
    if (zoom < MIN_ZOOM || !this.entries.size) return;
    // mainMatrix maps web-mercator [0..1] coordinates (z in mercator units) to clip space.
    const vp = this.lastMatrix.fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
    const t = (performance.now() - this.start) / 1000;
    let animating = false;

    this.entries.forEach((e) => (e.model.root.visible = false));
    for (const e of this.entries.values()) {
      if (this.getGrow(e.spec.id) <= 0) {
        animating = true;
        continue;
      }
      if (this.getGrow(e.spec.id) < 1) animating = true;
      e.model.root.visible = true;
      e.model.tick(t + e.mx * 1e5);
      this.camera.projectionMatrix = vp.clone().multiply(this.modelMatrix(e, zoom));
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
      e.model.root.visible = false;
      animating = true; // steam & stars idle animation
    }
    this.renderer.resetState();
    if (animating) this.map.triggerRepaint();
  }

  /** Returns the id of the café drawn under a screen point, if any. */
  hitTest(x: number, y: number): string | null {
    const zoom = this.map.getZoom();
    if (zoom < MIN_ZOOM) return null;
    const canvas = this.map.getCanvas();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const toScreen = (v: THREE.Vector3) => {
      v.applyMatrix4(this.lastMatrix);
      return { x: (v.x + 1) * 0.5 * w, y: (1 - v.y) * 0.5 * h };
    };
    let best: { id: string; d: number } | null = null;
    for (const e of this.entries.values()) {
      const ex = cafeExaggeration(zoom) * e.mPerMerc;
      const ground = toScreen(new THREE.Vector3(e.mx, e.my, 0));
      const top = toScreen(new THREE.Vector3(e.mx, e.my, e.model.height * ex));
      const side = toScreen(new THREE.Vector3(e.mx + 9 * ex, e.my, 0));
      const radius = Math.max(14, Math.hypot(side.x - ground.x, side.y - ground.y));
      // Distance from the click to the ground→top segment.
      const sx = top.x - ground.x, sy = top.y - ground.y;
      const len2 = sx * sx + sy * sy || 1;
      const k = Math.max(0, Math.min(1, ((x - ground.x) * sx + (y - ground.y) * sy) / len2));
      const d = Math.hypot(x - (ground.x + sx * k), y - (ground.y + sy * k));
      if (d < radius && (!best || d < best.d)) best = { id: e.spec.id, d };
    }
    return best?.id ?? null;
  }
}
