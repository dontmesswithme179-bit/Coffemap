# CoffeMap

A personal scrapbook map of Israel's cafés and restaurants. Saw a place in an ad, on Instagram or from a
friend? Pin it to the map instead of a note on your phone. When you finally go, rate it: the tracing paper
covering the map tears away there and the place gets a coffee-ring stain and a gold star.

## Features

- **Paper street map** of Israel (MapLibre GL + free [OpenFreeMap](https://openfreemap.org) tiles, recoloured
  like a printed map), with terrain shading.
- **Tracing paper over the unexplored** — a WebGL shader draws translucent paper with fibres over the map and
  tears ragged holes around places you've visited.
- **Pin to try** — save a place with where you saw it (Instagram, an ad, a friend…) and a note. Pins are taped-on
  clippings that stay above the paper at every zoom (a red pushpin far out, a name tag mid-way).
- **I went · rate it** — stars, notes and date per visit; visited places show a coffee-ring stain, a star sticker
  and a handwritten score. Rating a pinned place unpins it.
- **Pop-up 3D at street level** — zoom right in and the coffee-shop model (`public/models/coffee-shop.glb`) and
  low-poly houses around it rise up like a pop-up book.
- **Place directory** — ~17,000 cafés and eating places from Overture Maps for search, tappable dots and
  snapping a tap or your GPS position to the real place.
- **Export / import** your scrapbook as JSON (⋯ menu). Data is stored in your browser (`localStorage`), so
  export to back up or move to another device.
- Works on phones (bottom-sheet layout) and can be added to the home screen.

## Café 3D model

At street level (zoom ≥ 16.3) rated places pop up as `public/models/coffee-shop.glb` (glTF binary). The app
fills its cup with coffee and adds steam, a floating star ring for the rating and a chalkboard sign with the
place's name. If the file is missing
or fails to load, the hand-built café in `src/cafe-model.ts` is used instead.

To swap in another model (metres, base at y=0, shop front facing +Z):

```bash
npm run model:fbx -- MyShop.fbx /tmp/raw.glb          # FBX → GLB, drops stray/hidden objects, cm → m
npm run model:optimize -- /tmp/raw.glb public/models/coffee-shop.glb   # simplify + compress
```

Name the cup mesh `Cup` (or pass `FbxName:Cup` as a third argument to `model:fbx`) so coffee and steam line up.

## Neighbourhood houses

Around every rated café (within the cleared area, 230 m) the map's plain extruded buildings are hidden and each
building outline gets a random low-poly house from `public/models/houses.glb` (20 types), rotated and sized to
fit the outline. Houses are drawn with instancing and skipped where the enlarged café model would cover them.
Convert a new pack with `scripts/houses-fbx-to-glb.mjs` (instructions at the top of the file).

## Place directory

`public/data/places-il.json` lists ~17,000 cafés and eating places in Israel (cafés, restaurants, quick bites,
bakeries & dessert shops) with names and exact locations, from the free [Overture Maps](https://overturemaps.org)
places dataset (CDLA-Permissive-2.0). It powers search, the coloured dots shown while choosing a spot, and snapping
a tap (or your GPS position) to the place you meant. Refresh it with `scripts/build-places.py` (instructions at the
top of the file) when Overture publishes a new release.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`.
Enable it once in **Settings → Pages → Source: GitHub Actions**.

## Tips

- Right-drag (or two-finger drag on mobile) to tilt the map and see the buildings in 3D.
- While choosing a location the clouds thin out so you can see the streets.
