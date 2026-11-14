# Hometown

Any place on Earth as a little 3D diorama, built live from open map data: buildings with pitched roofs, real terrain,
aerial photos, trees, and cars and trains moving around. Swedish places get extra detail from Lantmäteriet:
1 m terrain and real, laser-measured trees.

Built with Next.js, React and three.js.

## Features

- **Search any place** (or `lat, lon`) and pick 1, 2 or 3 km; the place is kept in the URL (`/#Mala, Hässleholm`).
- **Terrain** from Lantmäteriet's 1 m terrain model in Sweden, or global ~30 m Terrarium tiles elsewhere, with adjustable relief.
- **Map styles:** illustrated, hybrid (aerial photo + drawn roads/water) or satellite.
- **Buildings** from OpenStreetMap with gabled/hipped roofs fitted to each footprint; roof colours measured from the aerial photo.
- **Trees:** real tree positions, heights and crown sizes detected from Lantmäteriet's forest laser scans (Sweden), otherwise scattered in mapped forests.
- **Bridges, railways and trains:** bridge decks over the bare-earth terrain, 3D track (ballast, sleepers, rails), passenger and freight trains.
- **Traffic:** cars drive the real road network on the right-hand side, ease through curves and keep their distance.
- Hover for street, building and lake names; compass, zoom, reset and screenshot controls; light/dark UI.

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000.

### Optional: Lantmäteriet data (Sweden)

Without this the app uses global elevation and estimated trees. To enable 1 m terrain and laser-measured trees:

1. Create a free account on [Geotorget](https://geotorget.lantmateriet.se/) and order the free products
   **Markhöjdmodell Nedladdning** and **Laserdata Nedladdning, skog**.
2. Copy `.env.example` to `.env.local` and fill in your Geotorget login:

   ```
   LM_USER=you@example.com
   LM_PASS=your-password
   ```

The login is only used by the server-side API routes (`/api/lm/*`) and is never sent to the browser.
Downloaded terrain and detected trees are cached in `.cache/` (git-ignored), so each area is only processed once.

## How it works

| Part | Where |
| --- | --- |
| Data sources (geocoding, OSM, elevation, imagery, laser trees) | `src/lib/map/sources.ts` |
| Scene: terrain, map texture, buildings, trees, labels, camera | `src/lib/map/engine.ts` |
| Roofs | `src/lib/map/roofs.ts` |
| Bridges | `src/lib/map/bridges.ts` |
| Railway track and trains | `src/lib/map/rail.ts` |
| Road traffic | `src/lib/map/traffic.ts` |
| 1 m terrain reader (server) | `src/lib/dtm.ts`, `src/app/api/lm/dtm` |
| Tree detection from laser point clouds (server) | `src/lib/trees.ts`, `src/app/api/lm/trees` |
| UI | `src/components/` |

## Data and credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), via the OSM API and Overpass;
  place search by [Nominatim](https://nominatim.org/).
- Global elevation: [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen / AWS Open Data).
- Aerial imagery: Esri World Imagery — © Esri, Maxar, Earthstar Geographics. Check
  [Esri's terms](https://www.esri.com/en-us/legal/terms/full-master-agreement) before any commercial use.
- Sweden: terrain model and forest laser data © [Lantmäteriet](https://www.lantmateriet.se/), open data under their
  terms for high-value datasets.

These services are free and shared: please keep requests reasonable (the app caches what it can).
