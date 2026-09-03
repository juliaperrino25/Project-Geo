#!/usr/bin/env bash
# Downloads the public source datasets needed by tools/build_data.py into tools/cache/.
# Natural Earth (public domain): https://www.naturalearthdata.com/
# historical-basemaps (GPL-3.0): https://github.com/aourednik/historical-basemaps
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p cache
NE="https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
HB="https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson"
for f in ne_50m_admin_0_map_units ne_50m_admin_1_states_provinces ne_10m_admin_1_states_provinces; do
  [ -s "cache/$f.geojson" ] || curl -fsSL -o "cache/$f.geojson" "$NE/$f.geojson"
done
for y in 1914 1938; do
  [ -s "cache/world_$y.geojson" ] || curl -fsSL -o "cache/world_$y.geojson" "$HB/world_$y.geojson"
done
ls -la cache
echo "Now run: pip install shapely topojson && python3 tools/build_data.py --year all"
