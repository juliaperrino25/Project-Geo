# World Map Quiz — 1914 & 1940

A Seterra-style geography game: you are shown a name, you click the right
country on the map. Two snapshots of the political world are built in,
switched with a toggle in the top bar:

* **1 January 1940** — Greater Germany, a partitioned Poland, the Baltic
  states still independent, Greater Romania, British India, French Indochina,
  Manchukuo, Tannu Tuva, Italian East Africa, Newfoundland and the rest.
* **1 January 1914** — the eve of the First World War: Austria-Hungary and
  the Ottoman, German and Russian Empires still standing, the European
  colonial empires near their territorial peak.

See `docs/HISTORY.md` for what each snapshot contains and the simplifications
made.

* 159 territories drawn on the 1940 map, 130 of them in the default quiz
  (microstates and small islands are drawn but only asked when *Include small
  territories* is ticked); see `docs/HISTORY.md` for the 1914 map's coverage.
* Seterra scoring: green on the first try, yellow on the second, orange on the
  third; after three misses the answer is revealed in red. Score is the share
  of first-try answers. There is a timer, a region selector (World, Europe,
  Asia & Middle East, Africa, Americas, Oceania), zoom/pan, and a results
  screen listing what you missed.
* Pure static site: no build step, no framework, no network calls. Open
  `index.html` directly or serve the folder.

## Run it

```bash
# option 1: just open the file
xdg-open index.html        # or double-click it

# option 2: serve it
npm run serve              # http://localhost:8080
```

## One-file build

`npm run bundle` writes `dist/play.html`: the whole game (styles, scripts,
both years' map data and historical notes) inlined into a single
self-contained page you can open from disk, email, or host anywhere. Add no
flag for a fragment without the document skeleton, for hosts that supply
their own.

```bash
npm run bundle          # dist/play.html, a complete HTML document
node tools/bundle.js    # same, as a fragment
```

## Tests

```bash
npm run test:unit   # game-engine rules (node --test)
npm run test:e2e    # Playwright: renders the default (1940) map, plays a full 130-country game to 100 %, checks reveals, regions and the year toggle
npm test            # both
```

The e2e test needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`
if you do not already have it).

## Project layout

```
index.html                 page shell
css/style.css               Seterra-like look (ocean, land, state colours)
js/map.js                   SVG renderer: paths, hover, click, zoom/pan (window.GeoMap)
js/game.js                  game rules, pure logic (window.GeoGame)
js/app.js                   wiring: prompts, timer, score, results (window.GeoApp)
data/world1914.js           generated 1914 map data (pre-projected SVG paths + metadata)
data/world1940.js           generated 1940 map data (pre-projected SVG paths + metadata)
data/notes1914.js           one-line historical note per 1914 territory
data/notes1940.js           one-line historical note per 1940 territory
tools/entities_1914.json    the 1914 entity list: names, aliases, status, region, source units
tools/entities_1940.json    the 1940 entity list: names, aliases, status, region, source units
tools/build_data.py         rebuilds data/world<year>.js from the sources
tools/fetch_sources.sh      downloads the sources into tools/cache/
docs/SPEC.md                module interfaces
docs/HISTORY.md             what each snapshot contains and the simplifications made
```

## Rebuilding the map data

```bash
tools/fetch_sources.sh
pip install shapely topojson
python3 tools/build_data.py --year all     # or --year 1914 / --year 1940
```

The pipeline takes Natural Earth 1:50m units and dissolves them into that
year's entities, then simplifies with shared borders preserved and projects
everything with the Natural Earth projection into SVG units. `--year 1940`
additionally cuts the interwar European borders that differ from modern ones
(Karelia and Petsamo, Bessarabia and Northern Bukovina, Southern Dobruja,
Istria and the Dodecanese, the Vienna Award strip, Carpathian Ruthenia, Memel,
the Molotov–Ribbentrop line through Poland, South Sakhalin and the Kurils,
Manchuria, Tibet, Tuva, Aden, Spanish Morocco, British Cameroons,
Newfoundland); `--year 1914` cuts that earlier world's borders from the same
historical-basemaps source. `--year all` (the default) rebuilds every year's
`data/world<year>.js`. See `docs/HISTORY.md` for the choices behind each
snapshot and their limits.

## Data sources and licences

* Code: MIT.
* Base geometry: [Natural Earth](https://www.naturalearthdata.com/) 1:50m
  admin-0 map units and admin-1 (public domain).
* Historical borders:
  [historical-basemaps](https://github.com/aourednik/historical-basemaps) by
  A. Ourednik et al., GPL-3.0 — the 1938 layer for the 1940 snapshot's
  interwar European borders, and the `world_1914.geojson` layer for the 1914
  snapshot. Because `data/world1914.js` and `data/world1940.js` are each
  derived in part from that dataset, treat both generated data files as
  GPL-3.0.
* Borders are drawn at world-map scale and are approximate; this is a game,
  not a reference atlas.
