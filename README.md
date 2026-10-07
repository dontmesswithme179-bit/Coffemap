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
