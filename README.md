# ☕ CoffeMap

A personal coffee map of Israel. The whole country starts hidden under animated clouds.
Every time you drink a coffee somewhere, rate it and add a note — the clouds part over
that spot and a 3D building rises there. Better coffee, taller (and greener) tower.

## Features

- **Map of Israel** (MapLibre GL + free [OpenFreeMap](https://openfreemap.org) tiles, no API key).
- **Cloud fog-of-war** — a WebGL shader draws a churning fog over the map; only places you've rated are revealed, with soft wispy edges. Puffy cumulus clouds sail across on the wind above it, casting shadows on the fog and the map.
- **Wish list** — tap **♥ Wish** (or switch the form to *Want to try*) to pin cafés you want to visit, with a note. Wish pins float above the clouds at every zoom. When you finally go, tap **Drank here — rate it** and the wish turns into a rated café.
- **3D cafés** — each rated place gets a detailed little café model (three.js): lit shop windows, a striped awning and parasols in the rating colour (red 1★ → green 5★), the place's name on the sign, terrace tables, planters and a giant steaming latte on the roof. A ring of gold stars floating above shows the rating. Models pop in with a bounce and are enlarged when zoomed out so they stay readable.
- **Detailed map** — streets, POIs and real OSM 3D buildings (shown slightly translucent so your café is never hidden), terrain hillshading of Israel's hills and wadis, and a hazy sky on the horizon when tilted.
- **Rate a coffee** — tap *Rate a coffee*, then tap the map, use *📍 Use my location*, or search a café/address. The pin is draggable. If you tap a café on the map its name is pre-filled.
- **Multiple cups per place** — rate the same place again; the building reflects the average. Each cup keeps its stars, notes and date.
- **Export / import** your ratings as JSON (⋯ menu). Data is stored in your browser (`localStorage`), so export to back up or move to another device.
- Works on phones (bottom-sheet layout) and can be added to the home screen.

## Café 3D model

Rated cafés use `public/models/coffee-shop.glb` (glTF binary). The app fills its cup with coffee and adds
steam, a floating star ring for the rating and a chalkboard sign with the café's name. If the file is missing
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
