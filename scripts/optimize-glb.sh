#!/usr/bin/env sh
# Shrink a GLB for the web: weld vertices, simplify dense meshes, merge duplicates, quantize.
#   npm run model:optimize -- input.glb output.glb
set -e
in="$1"; out="$2"; tmp="$(mktemp -d)"
npx gltf-transform weld "$in" "$tmp/w.glb"
npx gltf-transform simplify "$tmp/w.glb" "$tmp/s.glb" --ratio 0.04 --error 0.0005
npx gltf-transform dedup "$tmp/s.glb" "$tmp/d.glb"
npx gltf-transform quantize "$tmp/d.glb" "$out"
rm -rf "$tmp"
