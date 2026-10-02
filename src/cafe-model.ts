import * as THREE from 'three';

/**
 * Procedural low-poly café. Units are metres, +Y is up and the shop front faces +Z.
 * Footprint is roughly 16 x 14 m including the terrace.
 */

export interface CafeModel {
  root: THREE.Group;
  /** Advances idle animations (steam, floating stars). `t` is seconds. */
  tick(t: number): void;
  dispose(): void;
  /** Approximate height in metres, used for hit-testing. */
  height: number;
}

const mat = (color: THREE.ColorRepresentation, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...opts });

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  return mesh;
}

function signTexture(name: string, bg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 192;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 8;
  ctx.strokeRect(14, 14, c.width - 28, c.height - 28);
  ctx.fillStyle = '#fffaf2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 112;
  const font = (s: number) => `800 ${s}px system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", sans-serif`;
  ctx.font = font(size);
  while (ctx.measureText(name).width > c.width - 90 && size > 36) ctx.font = font((size -= 4));
  ctx.fillText(name, c.width / 2, c.height / 2 + 4);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function starShape(outer: number, inner: number) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i) s.lineTo(x, y);
    else s.moveTo(x, y);
  }
  s.closePath();
  return s;
}

export function buildCafe(name: string, rating: number, accent: string): CafeModel {
  const root = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  const plaster = track(mat('#f3e6d0'));
  const trim = track(mat('#6b3f26'));
  const roof = track(mat('#9c6b4e', { roughness: 0.9 }));
  const paving = track(mat('#d8cdbd', { roughness: 0.95 }));
  const glass = track(mat('#ffd58a', { emissive: '#ffb347', emissiveIntensity: 0.55, roughness: 0.2 }));
  const frame = track(mat('#3b2418'));
  const accentM = track(mat(accent, { roughness: 0.6 }));
  const white = track(mat('#fffaf2', { roughness: 0.5 }));
  const wood = track(mat('#8a5a3b'));
  const metal = track(mat('#2d2a28', { metalness: 0.6, roughness: 0.4 }));
  const leaf = track(mat('#5f9a4a', { roughness: 0.9 }));
  const pot = track(mat('#b5653d'));

  // Soft contact shadow + paved plot.
  const shadow = new THREE.Mesh(
    track(new THREE.PlaneGeometry(26, 24)),
    track(new THREE.MeshBasicMaterial({ map: track(radialTexture('rgba(30,18,10,0.45)', 'rgba(30,18,10,0)')), transparent: true, depthWrite: false })),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  root.add(shadow);
  root.add(box(17, 0.25, 15, paving, 0, 0, 0.5));

  // Main building.
  const W = 12, D = 8, H = 4.6, front = D / 2 - 1.5;
  const body = new THREE.Group();
  body.add(box(W, H, D, plaster, 0, 0.25, -1.5));
  body.add(box(W + 0.4, 0.5, D + 0.4, trim, 0, 0.25 + H, -1.5)); // cornice
  body.add(box(W - 1, 0.25, D - 1, roof, 0, 0.75 + H, -1.5)); // roof deck
  // Parapet posts around the roof terrace.
  for (const x of [-W / 2 + 0.3, W / 2 - 0.3]) body.add(box(0.3, 0.8, D, trim, x, 0.75 + H, -1.5));

  // Shop front: two big lit windows and a door.
  const winY = 0.75, winH = 2.5;
  for (const x of [-3.6, 3.6]) {
    body.add(box(3.6, winH, 0.1, glass, x, winY, front + 0.02));
    body.add(box(3.9, 0.18, 0.25, frame, x, winY - 0.1, front + 0.05));
    body.add(box(3.9, 0.18, 0.25, frame, x, winY + winH, front + 0.05));
    body.add(box(0.15, winH, 0.2, frame, x, winY, front + 0.06));
  }
  body.add(box(2, 3, 0.15, wood, 0, 0.25, front + 0.04));
  body.add(box(1.4, 1.5, 0.05, glass, 0, 1.3, front + 0.13));
  body.add(box(2.3, 0.2, 0.25, frame, 0, 3.25, front + 0.06));
  // Side and back windows.
  for (const x of [-W / 2 - 0.02, W / 2 + 0.02]) {
    for (const z of [-4, -0.5]) body.add(box(0.1, 1.8, 2, glass, x, 1.3, z));
  }
  const back = -1.5 - D / 2 - 0.02;
  for (const x of [-3.5, 3.5]) body.add(box(2.2, 1.6, 0.1, glass, x, 1.6, back));
  body.add(box(1.4, 2.6, 0.12, wood, 0, 0.25, back));
  // Rooftop clutter: AC unit and a vent.
  const ac = track(mat('#d9d4cc', { roughness: 0.5, metalness: 0.2 }));
  body.add(box(1.6, 0.9, 1.1, ac, -4, 1 + H, -4));
  body.add(box(0.9, 0.12, 0.9, frame, -4, 1.9 + H, -4));
  const vent = new THREE.Mesh(track(new THREE.CylinderGeometry(0.25, 0.25, 1.2, 10)), ac);
  vent.position.set(4.2, 1.6 + H, -4.2);
  body.add(vent);
  // Corner pilasters frame the shop front.
  for (const x of [-W / 2, W / 2]) body.add(box(0.5, H, 0.5, trim, x, 0.25, front - 0.2));

  // Striped awning, tilted out over the terrace.
  const awning = new THREE.Group();
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    const s = box(W / stripes, 0.08, 2.4, i % 2 ? white : accentM, -W / 2 + (i + 0.5) * (W / stripes), 0, 1.2);
    awning.add(s);
    // Hanging valance flap at the front edge.
    const v = box(W / stripes, 0.45, 0.06, i % 2 ? white : accentM, -W / 2 + (i + 0.5) * (W / stripes), -0.45, 2.38);
    v.rotation.x = -0.38;
    awning.add(v);
  }
  // Awning side cheeks.
  for (const x of [-W / 2, W / 2]) awning.add(box(0.06, 0.3, 2.4, accentM, x, -0.3, 1.2));
  awning.position.set(0, 3.6, front);
  awning.rotation.x = 0.38;
  body.add(awning);

  // Name sign above the awning.
  const signM = track(new THREE.MeshStandardMaterial({ map: track(signTexture(name, '#3b2418')), roughness: 0.6 }));
  const sign = new THREE.Mesh(track(new THREE.BoxGeometry(9, 1.6, 0.25)), [trim, trim, trim, trim, signM, trim]);
  sign.position.set(0, H - 0.3 + 0.25, front + 0.2);
  body.add(sign);

  root.add(body);

  // Terrace: tables with parasols in the accent colour.
  const terrace = new THREE.Group();
  const tableGeo = track(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 16));
  const legGeo = track(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 6));
  const seatGeo = track(new THREE.BoxGeometry(0.45, 0.06, 0.45));
  const backGeo = track(new THREE.BoxGeometry(0.45, 0.5, 0.05));
  const poleGeo = track(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6));
  const canopyGeo = track(new THREE.ConeGeometry(1.5, 0.6, 8, 1, true));
  const cupGeo = track(new THREE.CylinderGeometry(0.07, 0.05, 0.1, 8));
  for (const [x, z] of [[-5.5, 6.2], [0, 7], [5.5, 6.2]] as const) {
    const t = new THREE.Group();
    const leg = new THREE.Mesh(legGeo, metal); leg.position.y = 0.6; t.add(leg);
    const top = new THREE.Mesh(tableGeo, white); top.position.y = 1; t.add(top);
    const cup = new THREE.Mesh(cupGeo, white); cup.position.set(0.2, 1.08, 0.1); t.add(cup);
    for (const a of [0, Math.PI]) {
      const chair = new THREE.Group();
      const seat = new THREE.Mesh(seatGeo, wood); seat.position.y = 0.7; chair.add(seat);
      const back = new THREE.Mesh(backGeo, wood); back.position.set(0, 0.95, -0.22); chair.add(back);
      const cl = new THREE.Mesh(legGeo, metal); cl.scale.y = 0.6; cl.position.y = 0.48; chair.add(cl);
      chair.position.set(Math.sin(a) * 0.95, 0, Math.cos(a) * 0.95);
      chair.rotation.y = a + Math.PI;
      t.add(chair);
    }
    const pole = new THREE.Mesh(poleGeo, metal); pole.position.y = 1.5; t.add(pole);
    const canopy = new THREE.Mesh(canopyGeo, accentM);
    canopy.material = accentM;
    canopy.position.y = 2.95;
    t.add(canopy);
    t.position.set(x, 0.25, z);
    terrace.add(t);
  }
  // Planters at the corners.
  const potGeo = track(new THREE.CylinderGeometry(0.5, 0.4, 0.8, 10));
  const bushGeo = track(new THREE.IcosahedronGeometry(0.75, 1));
  for (const [x, z] of [[-7.6, 3], [7.6, 3], [-7.6, 7.4], [7.6, 7.4]] as const) {
    const p = new THREE.Mesh(potGeo, pot); p.position.set(x, 0.65, z); terrace.add(p);
    const b = new THREE.Mesh(bushGeo, leaf); b.position.set(x, 1.5, z); terrace.add(b);
  }
  root.add(terrace);

  // Giant coffee cup on the roof - the café's landmark.
  const cupG = new THREE.Group();
  const profile = [
    new THREE.Vector2(0, 0), new THREE.Vector2(1.5, 0), new THREE.Vector2(1.65, 0.15),
    new THREE.Vector2(2.1, 2.6), new THREE.Vector2(2.2, 2.75), new THREE.Vector2(2.0, 2.75),
    new THREE.Vector2(1.9, 2.55), new THREE.Vector2(0, 2.55),
  ];
  cupG.add(new THREE.Mesh(track(new THREE.LatheGeometry(profile, 28)), white));
  const coffee = new THREE.Mesh(track(new THREE.CircleGeometry(1.92, 28)), track(mat('#4a2a17', { roughness: 0.3 })));
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = 2.45;
  cupG.add(coffee);
  // Latte-art heart.
  const heart = new THREE.Shape();
  heart.moveTo(0, -0.55);
  heart.bezierCurveTo(-0.9, 0.05, -0.45, 0.75, 0, 0.3);
  heart.bezierCurveTo(0.45, 0.75, 0.9, 0.05, 0, -0.55);
  const foam = new THREE.Mesh(track(new THREE.ShapeGeometry(heart)), track(mat('#f1dcc0', { roughness: 0.4 })));
  foam.rotation.x = -Math.PI / 2;
  foam.position.y = 2.47;
  cupG.add(foam);
  const band = new THREE.Mesh(track(new THREE.CylinderGeometry(1.86, 1.75, 0.5, 28, 1, true)), accentM);
  band.position.y = 1.15;
  band.scale.setScalar(1.035);
  cupG.add(band);
  const handle = new THREE.Mesh(track(new THREE.TorusGeometry(0.75, 0.2, 10, 20, Math.PI * 1.25)), white);
  handle.position.set(2.05, 1.35, 0);
  handle.rotation.z = -Math.PI * 0.62;
  cupG.add(handle);
  const saucer = new THREE.Mesh(track(new THREE.CylinderGeometry(2.9, 2.4, 0.3, 32)), white);
  saucer.position.y = -0.15;
  cupG.add(saucer);
  cupG.position.set(0, H + 1.15, -1.5);
  cupG.rotation.y = -0.5;
  root.add(cupG);

  // Steam puffs rising from the cup (soft spheres, so they read from any camera angle).
  const puffGeo = track(new THREE.IcosahedronGeometry(1, 2));
  const puffs: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshStandardMaterial>[] = [];
  for (let i = 0; i < 6; i++) {
    const m = track(mat('#ffffff', { transparent: true, opacity: 0.6, depthWrite: false, roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.35 }));
    const p = new THREE.Mesh(puffGeo, m);
    puffs.push(p);
    root.add(p);
  }
  const steamBase = new THREE.Vector3(0, H + 4, -1.5);

  // Floating ring of gold stars = the rating.
  const starsG = new THREE.Group();
  const full = Math.round(rating * 2) / 2;
  const goldM = track(mat('#f5b82e', { metalness: 0.5, roughness: 0.3, emissive: '#b97700', emissiveIntensity: 0.35 }));
  const dimM = track(mat('#efe6d8', { roughness: 0.6, emissive: '#8a7a68', emissiveIntensity: 0.15 }));
  const starGeo = track(new THREE.ExtrudeGeometry(starShape(0.9, 0.4), { depth: 0.25, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 1 }));
  const halfGeo = track(new THREE.ExtrudeGeometry(halfStarShape(0.9, 0.4), { depth: 0.27, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 1 }));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const filled = i + 1 <= full;
    const half = !filled && i + 0.5 === full;
    const s = new THREE.Mesh(starGeo, filled ? goldM : dimM);
    s.position.set(Math.sin(a) * 3.4, 0, Math.cos(a) * 3.4);
    s.rotation.y = a;
    starsG.add(s);
    if (half) {
      const hs = new THREE.Mesh(halfGeo, goldM);
      hs.position.copy(s.position);
      hs.rotation.y = a;
      hs.position.add(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(0.02));
      starsG.add(hs);
    }
  }
  starsG.position.set(0, H + 8.2, -1.5);
  root.add(starsG);

  return {
    root,
    height: H + 10,
    tick(t: number) {
      starsG.rotation.y = t * 0.5;
      starsG.position.y = H + 8.2 + Math.sin(t * 1.3) * 0.25;
      puffs.forEach((p, i) => {
        const k = (t * 0.35 + i / puffs.length) % 1;
        p.position.set(
          steamBase.x + Math.sin(t * 0.9 + i * 2.1) * 0.6 * k,
          steamBase.y + k * 4.2 - 1.3,
          steamBase.z + Math.cos(t * 0.7 + i) * 0.4 * k,
        );
        p.scale.setScalar(0.35 + k * 0.9);
        p.material.opacity = Math.sin(Math.PI * k) * 0.8;
      });
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      root.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.());
    },
  };
}

function halfStarShape(outer: number, inner: number) {
  // Left half of the star (points with x <= 0), so a half-rating shows half a gold star.
  const s = new THREE.Shape();
  const pts: [number, number][] = [];
  for (let i = 0; i <= 5; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  s.moveTo(0, outer);
  pts.slice(1).forEach(([x, y]) => s.lineTo(x, y));
  s.closePath();
  return s;
}
