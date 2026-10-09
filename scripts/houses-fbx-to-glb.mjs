// Convert a pack of house models (one object per house, e.g. LowPoly_House_20_Pack_fbx.fbx) into
// public/models/houses.glb: one node per house, metres, base at y=0, centred on its own plot.
//   node scripts/houses-fbx-to-glb.mjs pack.fbx /tmp/houses-raw.glb
//   npx gltf-transform weld /tmp/houses-raw.glb /tmp/w.glb && npx gltf-transform meshopt /tmp/w.glb public/models/houses.glb --level medium
// (Not simplified: the houses are coloured through a palette texture, so merging faces would scramble colours.)
import fs from 'node:fs';
// The pack's texture is an external file; stub image loading so the geometry can be read in Node.
globalThis.document = { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, style: {} }) };
const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
globalThis.FileReader = class { readAsArrayBuffer(b) { b.arrayBuffer().then((r) => { this.result = r; this.onloadend?.(); }); } readAsDataURL(b) { b.arrayBuffer().then((r) => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(r).toString('base64'); this.onloadend?.(); }); } };
const [, , inFile, outFile] = process.argv;
const buf = fs.readFileSync(inFile);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
root.updateMatrixWorld(true);
const out = new THREE.Group();
const mat = new THREE.MeshStandardMaterial({ name: 'HousePalette', color: 0xffffff, roughness: 0.85, metalness: 0 });
for (const ch of root.children) {
  if (!ch.isMesh) continue;
  const g = ch.geometry.clone().applyMatrix4(ch.matrixWorld);
  g.computeBoundingBox();
  const b = g.boundingBox; const c = b.getCenter(new THREE.Vector3());
  g.translate(-c.x, -b.min.y, -c.z).scale(0.01, 0.01, 0.01);
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  g.clearGroups();
  const m = new THREE.Mesh(g, mat); m.name = ch.name;
  out.add(m);
}
const glb = await new GLTFExporter().parseAsync(out, { binary: true });
fs.writeFileSync(outFile, Buffer.from(glb));
console.log('houses', out.children.length, 'wrote', (fs.statSync(outFile).size / 1e6).toFixed(2), 'MB');
