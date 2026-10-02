# ☕ CoffeMap

A personal coffee map of Israel. The whole country starts hidden under animated clouds.
Every time you drink a coffee somewhere, rate it and add a note — the clouds part over
that spot and a 3D building rises there. Better coffee, taller (and greener) tower.

## Features

- **Map of Israel** (MapLibre GL + free [OpenFreeMap](https://openfreemap.org) tiles, no API key).
- **Cloud fog-of-war** — a WebGL shader draws drifting, churning clouds over the map; only places you've rated are revealed, with soft wispy edges.
- **3D buildings** — each rated place gets an extruded tower. Height and colour come from the average rating (red 1★ → green 5★). They grow in with a bounce when you rate.
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
