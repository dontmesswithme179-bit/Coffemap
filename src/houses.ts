import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Low-poly houses that replace the plain extruded buildings around rated cafés.
 * public/models/houses.glb holds one node per house type: metres, base at y=0, centred on its plot.
 */
const HOUSES_URL = `${import.meta.env.BASE_URL}models/houses.glb`;

/** A real building outline near a café, in local metres (x east, z south) relative to the café. */
export interface Footprint {
  x: number;
  z: number;
  /** Extent along the footprint's long axis / perpendicular to it, in metres. */
  w: number;
  d: number;
  /** Rotation of the long axis around the vertical axis (radians). */
  angle: number;
  /** Stable per-building value in [0, 1) used to pick a house type and facing. */
  seed: number;
  /** Distance of the closest part of the building to the café, in metres. */
  dist: number;
}

interface HouseKind {
  geometry: THREE.BufferGeometry;
  /** Node transform from the file (includes dequantisation scale). */
  node: THREE.Matrix4;
  /** Footprint size in metres: long side, short side; and whether the long side is along local x. */
  long: number;
  short: number;
  longIsX: boolean;
}

/** Soft, sunny facade tints so a neighbourhood of identical-material houses still looks varied. */
const TINTS = ['#fff4e2', '#f6dcc4', '#e9efe0', '#f9e7b8', '#e3ecf2', '#f3d6cf', '#efe6d8', '#dfe9d2'];

let kitPromise: Promise<{ kinds: HouseKind[]; material: THREE.Material }> | null = null;

export function loadHouseKit() {
  kitPromise ??= new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      HOUSES_URL,
      (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const kinds: HouseKind[] = [];
        let material: THREE.Material | null = null;
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          material ??= mesh.material as THREE.Material;
          const box = new THREE.Box3().setFromObject(mesh);
          const size = box.getSize(new THREE.Vector3());
          kinds.push({
            geometry: mesh.geometry,
            node: mesh.matrixWorld.clone(),
            long: Math.max(size.x, size.z),
            short: Math.min(size.x, size.z),
            longIsX: size.x >= size.z,
          });
        });
        if (!kinds.length || !material) return reject(new Error('No houses in houses.glb'));
        resolve({ kinds, material });
      },
      undefined,
      reject,
    );
  });
  return kitPromise;
}

/**
 * Builds a neighbourhood of instanced houses for one café. Instances are sorted far-to-near per
 * house type so `setHiddenRadius` can hide the ones under the (exaggerated) café by lowering `count`.
 */
export class Neighbourhood {
  readonly group = new THREE.Group();
  private meshes: { mesh: THREE.InstancedMesh; dists: number[] }[] = [];

  constructor(kit: { kinds: HouseKind[]; material: THREE.Material }, footprints: Footprint[]) {
    const byKind = new Map<number, Footprint[]>();
    for (const f of footprints) {
      const k = Math.floor(f.seed * kit.kinds.length) % kit.kinds.length;
      (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(f);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    for (const [k, list] of byKind) {
      const kind = kit.kinds[k];
      list.sort((a, b) => b.dist - a.dist);
      const mesh = new THREE.InstancedMesh(kind.geometry, kit.material, list.length);
      list.forEach((f, i) => {
        // Fit the house inside the outline (uniform scale keeps it from looking stretched).
        const s = THREE.MathUtils.clamp(Math.min(f.w / kind.long, f.d / kind.short), 0.45, 2.6);
        // Line the house's long side up with the outline's long side; flip half of them for variety.
        const flip = Math.floor(f.seed * 997) % 2 ? Math.PI : 0;
        const yaw = -f.angle + (kind.longIsX ? 0 : Math.PI / 2) + flip;
        m.compose(new THREE.Vector3(f.x, 0, f.z), q.setFromAxisAngle(up, yaw), new THREE.Vector3(s, s, s)).multiply(kind.node);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, color.set(TINTS[Math.floor(f.seed * 7919) % TINTS.length]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      this.meshes.push({ mesh, dists: list.map((f) => f.dist) });
      this.group.add(mesh);
    }
  }

  get size() {
    return this.meshes.reduce((n, m) => n + m.dists.length, 0);
  }

  /** Hide houses whose closest part is within `r` metres of the café. */
  setHiddenRadius(r: number) {
    for (const { mesh, dists } of this.meshes) {
      let n = 0;
      while (n < dists.length && dists[n] > r) n++;
      mesh.count = n;
    }
  }

  dispose() {
    // Geometry and material belong to the shared kit; only the instance buffers are ours.
    this.meshes.forEach(({ mesh }) => mesh.dispose());
  }
}

/** Approximate local metres per degree at a latitude. */
function metresPerDegree(lat: number) {
  return { x: 111_320 * Math.cos((lat * Math.PI) / 180), y: 110_540 };
}

function hash01(a: number, b: number) {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function pointInRing(x: number, z: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Turns building polygons (GeoJSON, lng/lat) into house footprints around a café.
 * Skips the café's own building, tiny sheds, and anything farther than `radius`.
 */
export function footprintsAround(
  lng: number,
  lat: number,
  radius: number,
  polygons: GeoJSON.Position[][][],
): Footprint[] {
  const mpd = metresPerDegree(lat);
  const out: Footprint[] = [];
  const seen = new Set<string>();
  for (const poly of polygons) {
    const outer = poly[0];
    if (!outer || outer.length < 4) continue;
    const ring = outer.map(([x, y]) => [(x - lng) * mpd.x, -(y - lat) * mpd.y] as [number, number]);
    let cx = 0, cz = 0, dist = Infinity;
    for (const [x, z] of ring) {
      cx += x;
      cz += z;
      dist = Math.min(dist, Math.hypot(x, z));
    }
    cx /= ring.length;
    cz /= ring.length;
    if (dist > radius) continue;
    if (pointInRing(0, 0, ring) || Math.hypot(cx, cz) < 12) continue; // the café's own building
    // Tiles repeat buildings that cross their edges; keep one per spot.
    const key = `${Math.round(cx / 3)}:${Math.round(cz / 3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Orientation from the longest edge, extents measured along it.
    let angle = 0, longest = 0;
    for (let i = 1; i < ring.length; i++) {
      const dx = ring[i][0] - ring[i - 1][0], dz = ring[i][1] - ring[i - 1][1];
      const len = Math.hypot(dx, dz);
      if (len > longest) {
        longest = len;
        angle = Math.atan2(dz, dx);
      }
    }
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, z] of ring) {
      const u = (x - cx) * cos - (z - cz) * sin;
      const v = (x - cx) * sin + (z - cz) * cos;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const w = maxU - minU, d = maxV - minV;
    if (w * d < 30) continue; // sheds, kiosks, slivers
    // Centre of the oriented box (the vertex average drifts on irregular outlines).
    const mu = (minU + maxU) / 2, mv = (minV + maxV) / 2;
    const x = cx + mu * Math.cos(angle) - mv * Math.sin(angle);
    const z = cz + mu * Math.sin(angle) + mv * Math.cos(angle);
    out.push({
      x, z,
      w: Math.max(w, d), d: Math.min(w, d),
      angle: w >= d ? angle : angle + Math.PI / 2,
      seed: hash01(Math.round((lng + x / mpd.x) * 1e5), Math.round((lat - z / mpd.y) * 1e5)),
      dist,
    });
  }
  return out;
}
