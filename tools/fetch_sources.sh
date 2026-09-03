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
[ -s cache/world_1938.geojson ] || curl -fsSL -o cache/world_1938.geojson "$HB/world_1938.geojson"
ls -la cache
echo "Now run: pip install shapely topojson && python3 tools/build_data.py"
