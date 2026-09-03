#!/usr/bin/env python3
"""
Build data/world1940.js — the world map as of 1 January 1940.

Geometry base: Natural Earth 1:50m admin-0 map units and admin-1 (public domain).
Interwar European borders that differ from modern ones are cut using the
polygons of the 1938 layer of the "historical-basemaps" project
(github.com/aourednik/historical-basemaps, GPL-3.0) plus a few hand-drawn lines
(Molotov–Ribbentrop line, Memel Territory, Dodecanese box, South Sakhalin).

Inputs (downloaded into tools/cache/ by tools/fetch_sources.sh):
  ne_50m_admin_0_map_units.geojson
  ne_50m_admin_1_states_provinces.geojson
  ne_10m_admin_1_states_provinces.geojson
  world_1938.geojson
Config: tools/entities_1940.json
Output: data/world1940.js
"""
import json, math, os, sys, time
from collections import OrderedDict

from shapely.geometry import shape, box, Polygon, MultiPolygon, GeometryCollection, mapping
from shapely.ops import unary_union, transform
from shapely.validation import make_valid
from shapely.algorithms.polylabel import polylabel
import shapely

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.environ.get("GEO_CACHE", os.path.join(HERE, "cache"))
OUT_JS = os.path.join(ROOT, "data", "world1940.js")
OUT_GEOJSON = os.path.join(HERE, "cache", "world1940_lonlat.geojson")

WIDTH = 1000.0
LAT_MIN, LAT_MAX = -58.0, 84.0          # Antarctica is not drawn
SIMPLIFY_PX = float(os.environ.get("GEO_SIMPLIFY_PX", "0.12"))
MIN_PART_AREA = 0.008                    # deg², drop specks below this
SLIVER_AREA, SLIVER_RATIO = 0.05, 0.003  # thin-part filter

t0 = time.time()
def log(*a):
    print(f"[{time.time()-t0:6.1f}s]", *a, flush=True)

def load(name):
    p = os.path.join(CACHE, name)
    with open(p) as f:
        return json.load(f)

# ----------------------------------------------------------------------------
# Load sources
# ----------------------------------------------------------------------------
log("loading sources")
mu = load("ne_50m_admin_0_map_units.geojson")
a50 = load("ne_50m_admin_1_states_provinces.geojson")
a10 = load("ne_10m_admin_1_states_provinces.geojson")
h38 = load("world_1938.geojson")
cfg = json.load(open(os.path.join(HERE, "entities_1940.json")))

def fix(g):
    g = make_valid(g)
    if g.geom_type == "GeometryCollection":
        polys = [p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
        g = unary_union(polys) if polys else Polygon()
    return g

UNITS = {}
for f in mu["features"]:
    code = f["properties"]["GU_A3"]
    UNITS.setdefault(code, []).append(fix(shape(f["geometry"])))
UNITS = {k: unary_union(v) for k, v in UNITS.items()}

A50 = {}
for f in a50["features"]:
    p = f["properties"]
    A50[(p["adm0_a3"], p["name"])] = fix(shape(f["geometry"]))
A10 = {}
for f in a10["features"]:
    p = f["properties"]
    if p["adm0_a3"] in ("YEM", "MAR", "CMR", "UKR"):
        A10[(p["adm0_a3"], p["name"])] = fix(shape(f["geometry"]))
del a10

H = {}
for f in h38["features"]:
    n = f["properties"].get("NAME")
    if not n:
        continue
    g = fix(shape(f["geometry"]))
    if n == "Italy":
        n = "Italy_dodecanese" if g.bounds[0] > 25 else "Italy"
    H.setdefault(n, []).append(g)
H = {k: unary_union(v) for k, v in H.items()}
log(f"loaded {len(UNITS)} map units, {len(A50)} admin-1 (50m), {len(A10)} admin-1 (10m), {len(H)} 1938 polygons")

used_units = set()
def U(*codes):
    gs = []
    for c in codes:
        if c not in UNITS:
            log(f"  WARNING: map unit {c} not found")
            continue
        used_units.add(c)
        gs.append(UNITS[c])
    return unary_union(gs) if gs else Polygon()

def A50u(adm0, *names):
    return unary_union([A50[(adm0, n)] for n in names])

def A50_except(adm0, *exclude):
    return unary_union([g for (a, n), g in A50.items() if a == adm0 and n not in exclude])

def A10u(adm0, *names):
    return unary_union([A10[(adm0, n)] for n in names])

# ----------------------------------------------------------------------------
# Special geometries
# ----------------------------------------------------------------------------
log("computing special geometries")
SP = {}

# --- Finland: territory ceded in March 1940 was still Finnish on 1 Jan 1940
gulf_box = box(26.0, 60.10, 29.95, 61.6)          # Karelian Isthmus coast
arctic_box = box(28.0, 69.3, 31.6, 70.5)          # Petsamo coast
SP["finland_ceded_1940"] = U("RUS").intersection(unary_union([H["Finland"].buffer(0.03), gulf_box, arctic_box]))

# --- Carpathian Ruthenia (to Hungary, March 1939) — needed before the Romania cut
ruthenia = U("UKR").intersection(A10u("UKR", "Transcarpathia").buffer(0.03))
SP["carpathian_ruthenia"] = ruthenia

# --- Romania: Bessarabia, Northern Bukovina, Hertsa, Southern Dobruja
black_sea_box = box(28.5, 44.5, 30.3, 46.1)       # Budjak coast + Danube delta
ro_cutter = unary_union([H["Romania"].buffer(0.03), black_sea_box]).difference(ruthenia)
SP["bessarabia_bukovina_dobruja"] = U("MDA", "UKR", "BGR").intersection(ro_cutter)
SP["bulgaria_without_south_dobruja"] = U("BGR").difference(ro_cutter)

# --- Italy: Istria, Fiume, Dodecanese
istria_box = box(13.3, 44.6, 14.0, 45.75)
it_cutter = unary_union([H["Italy"].buffer(0.03), istria_box])
yu_units = U("SVN", "HRV", "BHF", "BIS", "SRS", "SRV", "MNE", "MKD", "KOS")
SP["italian_istria_dalmatia"] = U("SVN", "HRV").intersection(it_cutter)
SP["yugoslavia_1940"] = yu_units.difference(it_cutter)
dodecanese_poly = Polygon([(26.2, 35.45), (26.25, 37.0), (26.6, 37.4), (27.4, 37.4),
                           (29.8, 36.8), (29.8, 35.45)])
SP["dodecanese"] = U("GRC").intersection(dodecanese_poly)
SP["greece_without_dodecanese"] = U("GRC").difference(dodecanese_poly)

# --- Memel Territory (to Germany, March 1939)
memel_poly = Polygon([(20.8, 54.9), (20.8, 55.87), (21.2, 55.86), (21.45, 55.75), (21.65, 55.6),
                      (21.9, 55.45), (22.2, 55.3), (22.55, 55.13), (22.65, 54.9)])
SP["memel"] = U("LTU").intersection(memel_poly)
SP["lithuania_without_memel"] = U("LTU").difference(memel_poly)

# --- Germany / Poland / USSR
SP["east_prussia_kaliningrad"] = A50u("RUS", "Kaliningrad")
SP["bohemia_moravia_sudetenland"] = U("CZE")
pol_1938 = H["Poland"]
# Former German territory east of the Oder–Neisse (Silesia, Pomerania, southern East Prussia)
# plus the Free City of Danzig; the rest of modern Poland is split along the Molotov–Ribbentrop line.
danzig_box = box(18.4, 54.2, 19.45, 54.9)
german_east = U("POL").intersection(unary_union([H["Germany"].buffer(0.03), danzig_box]))
SP["former_german_east_from_poland"] = german_east
MR_LINE = [(23.5, 54.5), (23.15, 53.98), (22.75, 53.95), (21.85, 53.6), (21.88, 53.22), (21.57, 53.08),
           (21.38, 52.89), (21.08, 52.70), (21.06, 52.51), (21.46, 52.59), (21.86, 52.70), (22.05, 52.70),
           (22.32, 52.67), (22.65, 52.40), (23.2, 52.2), (23.62, 52.09), (23.55, 51.55), (23.8, 51.17),
           (24.0, 50.8), (24.15, 50.45), (23.55, 50.35), (22.9, 50.15), (22.75, 49.95), (22.77, 49.78),
           (22.5, 49.65), (22.2, 49.56), (22.33, 49.47), (22.6, 49.25), (22.85, 49.0), (22.9, 48.5)]
west_of_mr = Polygon(MR_LINE + [(22.9, 47.0), (13.0, 47.0), (13.0, 56.5), (23.5, 56.5)])
occupied_pl = U("POL").difference(german_east)
SP["occupied_poland_west_of_mr_line"] = occupied_pl.intersection(west_of_mr)
soviet_pl = occupied_pl.difference(west_of_mr)

# --- Slovakia / Hungary
hu_1938 = H["Hungary"].buffer(0.03)
SP["slovakia_1940"] = U("SVK").difference(hu_1938)
SP["vienna_award_south_slovakia"] = U("SVK").intersection(hu_1938)

# --- USSR
sakhalin = A50[("RUS", "Sakhalin")]
sk_boxes = unary_union([box(140.0, 45.0, 145.5, 50.0), box(145.5, 43.0, 157.0, 51.5)])
SP["south_sakhalin_kurils"] = sakhalin.intersection(sk_boxes)
SP["tuva"] = A50u("RUS", "Tuva")
rus_core = A50_except("RUS", "Kaliningrad", "Tuva", "Sakhalin")
rus_core = unary_union([rus_core, sakhalin.difference(sk_boxes)])
ussr = unary_union([
    rus_core, U("BLR", "GEG", "ARM", "AZE", "KAZ", "UZB", "TKM", "KGZ", "TJK"),
    U("UKR").difference(unary_union([ruthenia, ro_cutter])),
    U("MDA").difference(ro_cutter),
    soviet_pl,
]).difference(SP["finland_ceded_1940"])
SP["ussr_1940"] = ussr

# --- China / Manchukuo / Tibet
SP["manchuria"] = A50u("CHN", "Liaoning", "Jilin", "Heilongjiang")
SP["tibet"] = A50u("CHN", "Xizang")
SP["china_proper"] = A50_except("CHN", "Liaoning", "Jilin", "Heilongjiang", "Xizang")

# --- Yemen / Aden
south_yemen = A10u("YEM", "`Adan", "Abyan", "Lahij", "Al Dali'", "Shabwah", "Hadramawt", "Al Mahrah").buffer(0.03)
SP["aden_protectorate"] = U("YEM").intersection(south_yemen)
SP["yemen_north"] = U("YEM").difference(south_yemen)

# --- Morocco
spanish_zone = unary_union([A10u("MAR", "Tanger - Tétouan"), box(-4.6, 34.75, -2.2, 35.6)]).buffer(0.03)
SP["spanish_morocco"] = U("MAR").intersection(spanish_zone)
SP["french_morocco"] = U("MAR").difference(spanish_zone)

# --- Cameroon
brit_cam = A10u("CMR", "Nord-Ouest", "Sud-Ouest").buffer(0.03)
SP["british_cameroons"] = U("CMR").intersection(brit_cam)
SP["french_cameroon"] = U("CMR").difference(brit_cam)

# --- Malaysia
SP["malaya_peninsular"] = U("MYS").intersection(box(99.0, 0.0, 105.5, 8.0))
SP["malaysia_borneo"] = U("MYS").intersection(box(108.0, 0.0, 120.0, 8.0))

# --- Canada / Newfoundland
SP["newfoundland_labrador"] = A50u("CAN", "Newfoundland and Labrador")
SP["canada_without_newfoundland"] = A50_except("CAN", "Newfoundland and Labrador")

# ----------------------------------------------------------------------------
# Assemble entities
# ----------------------------------------------------------------------------
log("assembling entities")
entities = []
for e in cfg["entities"]:
    parts = []
    for u in e["units"]:
        if u.startswith("@"):
            key = u[1:]
            if key not in SP:
                raise SystemExit(f"unknown special rule {u} for {e['id']}")
            parts.append(SP[key])
        else:
            if u in UNITS:
                parts.append(UNITS[u]); used_units.add(u)
            else:
                log(f"  WARNING: {e['id']}: unit {u} missing in 50m data")
    g = fix(unary_union(parts)) if parts else Polygon()
    entities.append((e, g))

unassigned = sorted(set(UNITS) - used_units)
log("map units not assigned to any entity (not drawn):", ", ".join(unassigned))

# ----------------------------------------------------------------------------
# Clean: drop specks and slivers
# ----------------------------------------------------------------------------
def clean(g):
    if g.is_empty:
        return g
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    keep = []
    for p in polys:
        a = p.area
        if a < MIN_PART_AREA:
            continue
        if a < SLIVER_AREA and a / (p.length ** 2) < SLIVER_RATIO:
            continue
        keep.append(p)
    return MultiPolygon(keep) if keep else Polygon()

cleaned = []
for e, g in entities:
    g2 = clean(g)
    if g2.is_empty:
        log(f"  dropping {e['id']}: no geometry left after cleaning (too small at this scale)")
        continue
    cleaned.append((e, g2))
entities = cleaned
log(f"{len(entities)} entities with geometry")

# Sanity: overlaps between entities (should be ~0)
log("checking overlaps")
tree_geoms = [g for _, g in entities]
tree = shapely.STRtree(tree_geoms)
for i, (e, g) in enumerate(entities):
    for j in tree.query(g, predicate="intersects"):
        if j <= i:
            continue
        inter = g.intersection(tree_geoms[j]).area
        if inter > 0.02:
            log(f"  OVERLAP {e['id']} x {entities[j][0]['id']}: {inter:.3f} deg²")

# lon/lat GeoJSON for reference
os.makedirs(os.path.dirname(OUT_GEOJSON), exist_ok=True)
with open(OUT_GEOJSON, "w") as f:
    json.dump({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"id": e["id"], "name": e["name"]}, "geometry": mapping(g)}
        for e, g in entities]}, f)

# ----------------------------------------------------------------------------
# Project (Natural Earth projection, Šavrič et al. 2011)
# ----------------------------------------------------------------------------
def ne_xy(lon, lat):
    lam = math.radians(lon); phi = math.radians(lat)
    p2 = phi * phi; p4 = p2 * p2
    x = lam * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)))
    y = phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)))
    return x, y

X_HALF = ne_xy(180, 0)[0]
R = WIDTH / 2 / X_HALF
Y_TOP = ne_xy(0, LAT_MAX)[1] * R
Y_BOT = ne_xy(0, LAT_MIN)[1] * R
HEIGHT = math.ceil(Y_TOP - Y_BOT)

def project(x, y, z=None):
    px, py = ne_xy(x, y)
    return (px * R + WIDTH / 2, Y_TOP - py * R)

def project_arr(coords):
    # coords: ndarray (n, 2)
    out = coords.copy()
    for i in range(len(coords)):
        out[i, 0], out[i, 1] = project(coords[i, 0], coords[i, 1])
    return out

log(f"projecting (viewBox 0 0 {WIDTH:.0f} {HEIGHT})")
clip = box(-180, LAT_MIN, 180, LAT_MAX)
projected = []
for e, g in entities:
    g = g.intersection(clip)
    if g.is_empty:
        log(f"  dropping {e['id']}: outside latitude range")
        continue
    gp = transform(project, g)
    projected.append((e, gp))

# ----------------------------------------------------------------------------
# Topology-preserving simplification
# ----------------------------------------------------------------------------
log(f"simplifying (topojson, {SIMPLIFY_PX} px)")
import topojson
fc = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "properties": {"id": e["id"]}, "geometry": mapping(gp)} for e, gp in projected]}
topo = topojson.Topology(fc, prequantize=200000, toposimplify=SIMPLIFY_PX,
                         simplify_algorithm="dp", prevent_oversimplify=True)
simplified = json.loads(topo.to_geojson())
by_id = {f["properties"]["id"]: shape(f["geometry"]) for f in simplified["features"]}
log("simplified")

# ----------------------------------------------------------------------------
# Emit
# ----------------------------------------------------------------------------
def fmt(v):
    s = f"{v:.2f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s if s != "-0" else "0"

def ring_to_path(coords):
    pts = list(coords)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) < 3:
        return ""
    out = ["M", fmt(pts[0][0]), " ", fmt(pts[0][1])]
    for x, y in pts[1:]:
        out.append("L"); out.append(fmt(x)); out.append(" "); out.append(fmt(y))
    out.append("Z")
    return "".join(out)

def geom_to_path(g):
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    d = []
    for p in polys:
        d.append(ring_to_path(p.exterior.coords))
        for r in p.interiors:
            d.append(ring_to_path(r.coords))
    return "".join(d)

out_entities = []
total_pts = 0
for e, gp in projected:
    g = by_id.get(e["id"])
    if g is None or g.is_empty:
        g = gp
    g = fix(g)
    if g.is_empty:
        log(f"  dropping {e['id']}: empty after simplification")
        continue
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    polys = [p for p in polys if p.area > 0.0005]
    if not polys:
        log(f"  dropping {e['id']}: empty after simplification")
        continue
    g = fix(unary_union(polys))
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    g = MultiPolygon(polys)
    largest = max(polys, key=lambda p: p.area)
    try:
        lab = polylabel(largest, 0.05)
    except Exception:
        lab = largest.representative_point()
    if not largest.contains(lab):
        lab = largest.representative_point()
    minx, miny, maxx, maxy = g.bounds
    path = geom_to_path(g)
    total_pts += sum(len(p.exterior.coords) + sum(len(r.coords) for r in p.interiors) for p in polys)
    out_entities.append(OrderedDict([
        ("id", e["id"]), ("name", e["name"]), ("aliases", e.get("aliases", [])),
        ("sovereign", e.get("sovereign")), ("status", e.get("status", "sovereign")),
        ("region", e["region"]), ("quiz", bool(e.get("quiz", True))),
        ("label", [round(lab.x, 2), round(lab.y, 2)]),
        ("bbox", [round(minx, 2), round(miny, 2), round(maxx, 2), round(maxy, 2)]),
        ("area", round(g.area, 2)),
        ("path", path),
    ]))

small_quiz = [(o["id"], o["area"]) for o in out_entities if o["quiz"] and o["area"] < 1.5]
if small_quiz:
    log("quiz entities with area < 1.5 px²:", small_quiz)

# Region view boxes (lon/lat) → projected bbox, so the map can zoom to a region without
# being dragged out by continent-spanning entities such as the USSR.
REGION_VIEWS = [
    ("world", "World", None),
    ("europe", "Europe", (-25.0, 34.0, 45.0, 72.0)),
    ("asia", "Asia & Middle East", (25.0, -12.0, 150.0, 56.0)),
    ("africa", "Africa", (-20.0, -36.0, 55.0, 38.0)),
    ("americas", "Americas", (-170.0, -57.0, -20.0, 84.0)),
    ("oceania", "Oceania", (95.0, -48.0, 180.0, 22.0)),
]
def project_bbox(lonlat):
    x0, y0, x1, y1 = lonlat
    pts = []
    for lon in (x0, (x0 + x1) / 2, x1):
        for lat in (y0, (y0 + y1) / 2, y1):
            pts.append(project(lon, lat))
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return [round(max(0, min(xs)), 1), round(max(0, min(ys)), 1),
            round(min(WIDTH, max(xs)), 1), round(min(HEIGHT, max(ys)), 1)]
regions_out = []
for rid, rname, view in REGION_VIEWS:
    r = OrderedDict([("id", rid), ("name", rname)])
    if view:
        r["bbox"] = project_bbox(view)
    regions_out.append(r)

data = OrderedDict([
    ("meta", OrderedDict([
        ("title", "World, 1 January 1940"),
        ("date", "1940-01-01"),
        ("width", int(WIDTH)), ("height", int(HEIGHT)),
        ("projection", "Natural Earth"),
        ("sources", [
            "Base geometry: Natural Earth 1:50m (public domain)",
            "Interwar European borders: historical-basemaps 1938 layer, A. Ourednik et al. (GPL-3.0)",
            "Compilation and 1940 adjustments: this project"
        ]),
    ])),
    ("regions", regions_out),
    ("entities", out_entities),
])

os.makedirs(os.path.dirname(OUT_JS), exist_ok=True)
with open(OUT_JS, "w") as f:
    f.write("// Generated by tools/build_data.py — do not edit by hand.\n")
    f.write("// World political map as of 1 January 1940. See docs/HISTORY.md for sources and caveats.\n")
    f.write("window.WORLD1940 = ")
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")
size = os.path.getsize(OUT_JS)
log(f"wrote {OUT_JS}: {len(out_entities)} entities, {total_pts} vertices, {size/1024:.0f} KB, "
    f"{sum(o['quiz'] for o in out_entities)} in quiz")
