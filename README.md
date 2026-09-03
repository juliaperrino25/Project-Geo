# World Map Quiz — 1940

A Seterra-style geography game: you are shown a name, you click the right
country on the map. The twist is that the map shows the political world as it
stood on **1 January 1940** — Greater Germany, a partitioned Poland, the Baltic
states still independent, Greater Romania, British India, French Indochina,
Manchukuo, Tannu Tuva, Italian East Africa, Newfoundland and the rest.

* 159 territories drawn, 130 of them in the default quiz (microstates and small
  islands are drawn but only asked when *Include small territories* is ticked).
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

`npm run bundle` writes `dist/play.html`: the whole game (styles, scripts, map
data and historical notes) inlined into a single self-contained page you can
open from disk, email, or host anywhere. Add no flag for a fragment without the
document skeleton, for hosts that supply their own.

```bash
npm run bundle          # dist/play.html, a complete HTML document
node tools/bundle.js    # same, as a fragment
```

## Tests

```bash
npm run test:unit   # game-engine rules (node --test)
npm run test:e2e    # Playwright: renders the map, plays a full 130-country game to 100 %, checks reveals and regions
npm test            # both
```

The e2e test needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`
if you do not already have it).

## Project layout

```
index.html            page shell
css/style.css         Seterra-like look (ocean, land, state colours)
js/map.js             SVG renderer: paths, hover, click, zoom/pan (window.GeoMap)
js/game.js            game rules, pure logic (window.GeoGame)
js/app.js             wiring: prompts, timer, score, results (window.GeoApp)
data/world1940.js     generated map data (pre-projected SVG paths + metadata)
data/notes1940.js     one-line historical note per territory
tools/entities_1940.json   the entity list: names, aliases, status, region, source units
tools/build_data.py        rebuilds data/world1940.js from the sources
tools/fetch_sources.sh     downloads the sources into tools/cache/
docs/SPEC.md          module interfaces
docs/HISTORY.md       what the 1940 snapshot contains and the simplifications made
```

## Rebuilding the map data

```bash
tools/fetch_sources.sh
pip install shapely topojson
python3 tools/build_data.py
```

The pipeline takes Natural Earth 1:50m units, dissolves them into 1940
entities, and cuts the interwar European borders that differ from modern ones
(Karelia and Petsamo, Bessarabia and Northern Bukovina, Southern Dobruja,
Istria and the Dodecanese, the Vienna Award strip, Carpathian Ruthenia, Memel,
the Molotov–Ribbentrop line through Poland, South Sakhalin and the Kurils,
Manchuria, Tibet, Tuva, Aden, Spanish Morocco, British Cameroons, Newfoundland).
It then simplifies with shared borders preserved and projects everything with
the Natural Earth projection into SVG units. See `docs/HISTORY.md` for the
choices and their limits.

## Data sources and licences

* Code: MIT.
* Base geometry: [Natural Earth](https://www.naturalearthdata.com/) 1:50m
  admin-0 map units and admin-1 (public domain).
* Interwar European borders: the 1938 layer of
  [historical-basemaps](https://github.com/aourednik/historical-basemaps) by
  A. Ourednik et al., GPL-3.0. Because `data/world1940.js` is derived in part
  from that dataset, treat the generated data file as GPL-3.0.
* Borders are drawn at world-map scale and are approximate; this is a game,
  not a reference atlas.
