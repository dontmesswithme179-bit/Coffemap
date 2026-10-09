// Convert an FBX (e.g. a Blender export) into a raw GLB the app can load.
//   node scripts/fbx-to-glb.mjs input.fbx output.glb
// Then shrink it with: npm run model:optimize -- output.glb public/models/coffee-shop.glb
//
// - Flattens every mesh into world space and drops stray objects: anything far from the origin
//   or enormous (hidden duplicates, backdrops) and tiny-but-dense helpers.
// - Recentres on the footprint with the base at y=0 and converts centimetres to metres.
// - Names the cup parts "Cup"/"CupHandle" (the app fills the cup with coffee and adds steam).
import fs from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter needs FileReader for binary output; minimal Node polyfill.
globalThis.FileReader = class {
  readAsArrayBuffer(b) { b.arrayBuffer().then((r) => { this.result = r; this.onloadend?.(); }); }
  readAsDataURL(b) { b.arrayBuffer().then((r) => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(r).toString('base64'); this.onloadend?.(); }); }
};

const [, , inFile, outFile, cupNames = 'Circle:Cup,Circle004:CupHandle'] = process.argv;
if (!inFile || !outFile) {
  console.error('usage: node scripts/fbx-to-glb.mjs input.fbx output.glb [FbxName:Cup,...]');
  process.exit(1);
}
const rename = Object.fromEntries(cupNames.split(',').filter(Boolean).map((p) => p.split(':')));
const buf = fs.readFileSync(inFile);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
root.updateMatrixWorld(true);

const out = new THREE.Group();
const dropped = [];
root.traverse((o) => {
  if (!o.isMesh) return;
  const b = new THREE.Box3().setFromObject(o);
  const c = b.getCenter(new THREE.Vector3());
  const s = b.getSize(new THREE.Vector3());
  if (c.length() > 2000 || Math.max(s.x, s.y, s.z) > 2000 || Math.max(s.x, s.y, s.z) < 2) {
    dropped.push(o.name);
    return;
  }
  const mats = [].concat(o.material).map((m) => new THREE.MeshStandardMaterial({
    name: m.name, color: m.color, roughness: 0.7, metalness: 0, side: THREE.DoubleSide,
    transparent: m.opacity < 1, opacity: m.opacity,
  }));
  const mesh = new THREE.Mesh(o.geometry.clone().applyMatrix4(o.matrixWorld), Array.isArray(o.material) ? mats : mats[0]);
  mesh.name = rename[o.name] ?? o.name;
  if (mesh.name.startsWith('Cup')) mats.forEach((m) => (m.name = 'Cup'));
  out.add(mesh);
});

const box = new THREE.Box3().setFromObject(out);
const c = box.getCenter(new THREE.Vector3());
out.children.forEach((m) => m.geometry.translate(-c.x, -box.min.y, -c.z).scale(0.01, 0.01, 0.01));
const glb = await new GLTFExporter().parseAsync(out, { binary: true });
fs.writeFileSync(outFile, Buffer.from(glb));
console.log(`kept ${out.children.length} meshes, dropped ${dropped.length}: ${dropped.join(' ')}`);
console.log(`wrote ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
