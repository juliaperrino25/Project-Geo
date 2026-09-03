#!/usr/bin/env python3
"""
Build the map data for the quiz: one data/world<year>.js per snapshot.

Geometry base: Natural Earth 1:50m admin-0 map units and admin-1 (public domain).
Historical borders that differ from modern ones are cut using the period layers
of the "historical-basemaps" project (github.com/aourednik/historical-basemaps,
GPL-3.0) plus a few hand-drawn lines where that source is absent or wrong.

Inputs (downloaded into tools/cache/ by tools/fetch_sources.sh):
  ne_50m_admin_0_map_units.geojson
  ne_50m_admin_1_states_provinces.geojson
  ne_10m_admin_1_states_provinces.geojson
  world_1914.geojson, world_1938.geojson
Config: tools/entities_<year>.json
Output: data/world<year>.js

Usage: python3 tools/build_data.py [--year 1914|1940|all]
"""
import argparse, json, math, os, time
from collections import OrderedDict

from shapely.geometry import shape, box, Polygon, MultiPolygon, mapping
from shapely.ops import unary_union, transform
from shapely.validation import make_valid
from shapely.algorithms.polylabel import polylabel
import shapely

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.environ.get("GEO_CACHE", os.path.join(HERE, "cache"))

WIDTH = 1000.0
LAT_MIN, LAT_MAX = -58.0, 84.0           # Antarctica is not drawn
SIMPLIFY_PX = float(os.environ.get("GEO_SIMPLIFY_PX", "0.12"))
MIN_PART_AREA = 0.008                     # deg², drop specks below this
SLIVER_AREA, SLIVER_RATIO = 0.05, 0.003   # thin-part filter
CUT_BUFFER = 0.03                         # deg, grows a period cutter just past
                                          # the modern border so no sliver survives

t0 = time.time()
def log(*a):
    print(f"[{time.time()-t0:6.1f}s]", *a, flush=True)

def fix(g):
    g = make_valid(g)
    if g.geom_type == "GeometryCollection":
        polys = [p for p in g.geoms if p.geom_type in ("Polygon", "MultiPolygon")]
        g = unary_union(polys) if polys else Polygon()
    return g

def load(name):
    with open(os.path.join(CACHE, name)) as f:
        return json.load(f)

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
log("loading sources")
UNITS = {}
for f in load("ne_50m_admin_0_map_units.geojson")["features"]:
    UNITS.setdefault(f["properties"]["GU_A3"], []).append(fix(shape(f["geometry"])))
UNITS = {k: unary_union(v) for k, v in UNITS.items()}

A50 = {}
for f in load("ne_50m_admin_1_states_provinces.geojson")["features"]:
    p = f["properties"]
    A50[(p["adm0_a3"], p["name"])] = fix(shape(f["geometry"]))

A10 = {}
for f in load("ne_10m_admin_1_states_provinces.geojson")["features"]:
    p = f["properties"]
    if p["adm0_a3"] in ("YEM", "MAR", "CMR", "UKR"):
        A10[(p["adm0_a3"], p["name"])] = fix(shape(f["geometry"]))

def load_period(filename, split_italy=False):
    """Dissolve a historical-basemaps layer by NAME."""
    H = {}
    for f in load(filename)["features"]:
        n = f["properties"].get("NAME")
        if not n:
            continue
        g = fix(shape(f["geometry"]))
        if split_italy and n == "Italy":
            n = "Italy_dodecanese" if g.bounds[0] > 25 else "Italy"
        H.setdefault(n, []).append(g)
    return {k: unary_union(v) for k, v in H.items()}

H38 = load_period("world_1938.geojson", split_italy=True)
H14 = load_period("world_1914.geojson")
log(f"loaded {len(UNITS)} map units, {len(A50)} admin-1 (50m), "
    f"{len(A10)} admin-1 (10m), {len(H38)}/{len(H14)} period polygons (1938/1914)")

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

def cutter(g):
    """A period polygon grown slightly, for use as a cutting mask."""
    return g.buffer(CUT_BUFFER)

# ---------------------------------------------------------------------------
# Geometry rules shared by every snapshot
# ---------------------------------------------------------------------------
log("computing shared geometry")
SHARED = {}

# Aden Protectorate vs the Yemeni highlands
south_yemen = A10u("YEM", "`Adan", "Abyan", "Lahij", "Al Dali'", "Shabwah",
                   "Hadramawt", "Al Mahrah").buffer(CUT_BUFFER)
SHARED["aden_protectorate"] = U("YEM").intersection(south_yemen)

# Morocco: French protectorate vs the Spanish zone
spanish_zone = unary_union([A10u("MAR", "Tanger - Tétouan"),
                            box(-4.6, 34.75, -2.2, 35.6)]).buffer(CUT_BUFFER)
SHARED["spanish_morocco"] = U("MAR").intersection(spanish_zone)
SHARED["french_morocco"] = U("MAR").difference(spanish_zone)

# Malaya vs British Borneo
SHARED["malaya_peninsular"] = U("MYS").intersection(box(99.0, 0.0, 105.5, 8.0))
SHARED["malaysia_borneo"] = U("MYS").intersection(box(108.0, 0.0, 120.0, 8.0))

# Newfoundland was a separate dominion until 1949
SHARED["newfoundland_labrador"] = A50u("CAN", "Newfoundland and Labrador")
SHARED["canada_without_newfoundland"] = A50_except("CAN", "Newfoundland and Labrador")

# Japanese South Sakhalin (Karafuto, from 1905) and the Kurils
SAKHALIN = A50[("RUS", "Sakhalin")]
SK_BOXES = unary_union([box(140.0, 45.0, 145.5, 50.0), box(145.5, 43.0, 157.0, 51.5)])
SHARED["south_sakhalin_kurils"] = SAKHALIN.intersection(SK_BOXES)

SHARED["tibet"] = A50u("CHN", "Xizang")
SHARED["tuva"] = A50u("RUS", "Tuva")

# Russia minus the pieces every snapshot assigns elsewhere
def russia_core(*extra_exclude):
    core = A50_except("RUS", "Kaliningrad", "Tuva", "Sakhalin", *extra_exclude)
    return unary_union([core, SAKHALIN.difference(SK_BOXES)])

DODECANESE = Polygon([(26.2, 35.45), (26.25, 37.0), (26.6, 37.4), (27.4, 37.4),
                      (29.8, 36.8), (29.8, 35.45)])

# ---------------------------------------------------------------------------
# 1940
# ---------------------------------------------------------------------------
def specials_1940():
    log("computing 1940 geometry")
    SP = dict(SHARED)

    # Carpathian Ruthenia went to Hungary in March 1939; compute it before the
    # Romanian cut so the two do not both claim it.
    ruthenia = U("UKR").intersection(A10u("UKR", "Transcarpathia").buffer(CUT_BUFFER))
    SP["carpathian_ruthenia"] = ruthenia

    # Finland still held the land it ceded in March 1940
    gulf_box = box(26.0, 60.10, 29.95, 61.6)      # Karelian Isthmus
    arctic_box = box(28.0, 69.3, 31.6, 70.5)      # Petsamo
    SP["finland_ceded_1940"] = U("RUS").intersection(
        unary_union([cutter(H38["Finland"]), gulf_box, arctic_box]))

    # Greater Romania: Bessarabia, Northern Bukovina, Southern Dobruja
    black_sea_box = box(28.5, 44.5, 30.3, 46.1)   # Budjak coast + Danube delta
    ro_cut = unary_union([cutter(H38["Romania"]), black_sea_box]).difference(ruthenia)
    SP["bessarabia_bukovina_dobruja"] = U("MDA", "UKR", "BGR").intersection(ro_cut)
    SP["bulgaria_without_south_dobruja"] = U("BGR").difference(ro_cut)

    # Italian Istria and Fiume; the Dodecanese
    istria_box = box(13.3, 44.6, 14.0, 45.75)
    it_cut = unary_union([cutter(H38["Italy"]), istria_box])
    SP["italian_istria_dalmatia"] = U("SVN", "HRV").intersection(it_cut)
    SP["yugoslavia_1940"] = U("SVN", "HRV", "BHF", "BIS", "SRS", "SRV", "MNE",
                              "MKD", "KOS").difference(it_cut)
    SP["dodecanese"] = U("GRC").intersection(DODECANESE)
    SP["greece_without_dodecanese"] = U("GRC").difference(DODECANESE)

    # Memel, ceded to Germany in March 1939
    memel = Polygon([(20.8, 54.9), (20.8, 55.87), (21.2, 55.86), (21.45, 55.75),
                     (21.65, 55.6), (21.9, 55.45), (22.2, 55.3), (22.55, 55.13),
                     (22.65, 54.9)])
    SP["memel"] = U("LTU").intersection(memel)
    SP["lithuania_without_memel"] = U("LTU").difference(memel)

    # Germany, and Poland partitioned on the Molotov-Ribbentrop line
    SP["east_prussia_kaliningrad"] = A50u("RUS", "Kaliningrad")
    SP["bohemia_moravia_sudetenland"] = U("CZE")
    pol_1938 = H38["Poland"]
    SP["former_german_east_from_poland"] = U("POL").difference(pol_1938)  # incl. Danzig
    mr_line = [(23.5, 54.5), (23.15, 53.98), (22.75, 53.95), (21.85, 53.6),
               (21.88, 53.22), (21.57, 53.08), (21.38, 52.89), (21.08, 52.70),
               (21.06, 52.51), (21.46, 52.59), (21.86, 52.70), (22.05, 52.70),
               (22.32, 52.67), (22.65, 52.40), (23.2, 52.2), (23.62, 52.09),
               (23.55, 51.55), (23.8, 51.17), (24.0, 50.8), (24.15, 50.45),
               (23.55, 50.35), (22.9, 50.15), (22.75, 49.95), (22.77, 49.78),
               (22.5, 49.65), (22.2, 49.56), (22.33, 49.47), (22.6, 49.25),
               (22.85, 49.0), (22.9, 48.5)]
    west_of_mr = Polygon(mr_line + [(22.9, 47.0), (13.0, 47.0), (13.0, 56.5), (23.5, 56.5)])
    occupied_pl = U("POL").intersection(pol_1938)
    SP["occupied_poland_west_of_mr_line"] = occupied_pl.intersection(west_of_mr)
    soviet_pl = occupied_pl.difference(west_of_mr)

    # Slovakia after the First Vienna Award
    hu_1938 = cutter(H38["Hungary"])
    SP["slovakia_1940"] = U("SVK").difference(hu_1938)
    SP["vienna_award_south_slovakia"] = U("SVK").intersection(hu_1938)

    SP["ussr_1940"] = unary_union([
        russia_core(),
        U("BLR", "GEG", "ARM", "AZE", "KAZ", "UZB", "TKM", "KGZ", "TJK"),
        U("UKR").difference(unary_union([ruthenia, ro_cut])),
        U("MDA").difference(ro_cut),
        soviet_pl,
    ]).difference(SP["finland_ceded_1940"])

    SP["manchuria"] = A50u("CHN", "Liaoning", "Jilin", "Heilongjiang")
    SP["china_proper"] = A50_except("CHN", "Liaoning", "Jilin", "Heilongjiang", "Xizang")
    SP["yemen_north"] = U("YEM").difference(south_yemen)

    # The British Cameroons, administered with Nigeria
    brit_cam = A10u("CMR", "Nord-Ouest", "Sud-Ouest").buffer(CUT_BUFFER)
    SP["british_cameroons"] = U("CMR").intersection(brit_cam)
    SP["french_cameroon"] = U("CMR").difference(brit_cam)
    return SP

# ---------------------------------------------------------------------------
# 1914
# ---------------------------------------------------------------------------
def specials_1914():
    log("computing 1914 geometry")
    SP = dict(SHARED)

    # The 1914 source layer puts Trieste and Gorizia in Italy, which is wrong —
    # they were Austrian until 1919 — so add them back to the Habsburg cutter.
    istria_trieste = box(13.3, 44.6, 14.6, 46.05)
    ah_cut = unary_union([cutter(H14["Austro-Hungarian Empire"]), istria_trieste])
    SP["austria_hungary"] = unary_union([
        U("AUT", "HUN", "CZE", "SVK", "SVN", "HRV", "BHF", "BIS", "SRV"),
        U("POL", "ROU", "ITA", "UKR").intersection(ah_cut),
    ])

    # The source layer's German coastline stops ~9 km short of the Vistula mouth,
    # which would hand Danzig and the West Prussian coast to Russia. All of this
    # box was German in 1914 (Congress Poland ended well to the south).
    west_prussia = box(18.0, 53.8, 19.8, 55.0)
    de_cut = unary_union([cutter(H14["German Empire"]), west_prussia])
    SP["german_empire"] = unary_union([
        U("DEU"),
        A50u("RUS", "Kaliningrad"),
        U("POL", "FXX", "DNK").intersection(de_cut),   # Posen/Silesia, Alsace-Lorraine, North Schleswig
    ]).difference(SP["austria_hungary"])                # the grown cutters both claim
                                                       # the strip where they meet
    SP["france_1914"] = U("FXX").difference(de_cut)
    SP["denmark_1914"] = U("DNK").difference(de_cut)

    # Italy: no Trieste or Trentino, but the Dodecanese, occupied in 1912
    SP["italy_1914"] = unary_union([
        U("ITA", "VAT").difference(ah_cut),            # no Vatican state until 1929
        U("GRC").intersection(DODECANESE),
    ])

    # Bulgaria held Western Thrace 1913-1919 but had just lost Southern Dobruja
    w_thrace = box(24.4, 40.75, 26.65, 41.8)
    ro_dobruja = cutter(H38["Romania"])                # 1938 Romania also held it
    SP["greece_1914"] = U("GRC").difference(DODECANESE).difference(w_thrace)
    SP["bulgaria_1914"] = unary_union([
        U("BGR").difference(ro_dobruja),
        U("GRC").intersection(w_thrace),
    ])
    SP["romania_1914"] = unary_union([
        U("ROU").difference(ah_cut),                   # no Transylvania, Banat or Bukovina
        U("BGR").intersection(ro_dobruja),
    ])
    # Serbia after the Balkan Wars: Vardar Macedonia and Kosovo, but not Vojvodina
    SP["serbia_1914"] = U("SRS", "KOS", "MKD")

    SP["russian_empire"] = unary_union([
        russia_core(),
        U("BLR", "EST", "LVA", "LTU", "MDA", "GEG", "ARM", "AZE",
          "KAZ", "UZB", "TKM", "KGZ", "TJK"),
        U("UKR").difference(ah_cut),
        U("POL").difference(unary_union([de_cut, ah_cut])),
    ])

    ot_cut = cutter(H14["Ottoman Empire"])
    SP["ottoman_empire"] = unary_union([
        U("TUR", "SYR", "LBN", "ISR", "GAZ", "WEB", "JOR", "IRQ"),
        U("SAU").intersection(ot_cut),                             # Hejaz, Asir, al-Hasa
        U("YEM").intersection(ot_cut).difference(south_yemen),     # Yemen vilayet, not Aden
    ])
    SP["nejd_1914"] = U("SAU").difference(ot_cut)

    SP["china_1914"] = A50_except("CHN", "Xizang")     # Manchuria and Xinjiang still Chinese

    # British Papua in the south-east, German New Guinea in the north-east.
    # The real border is a surveyed line; this is an approximation at map scale.
    papua = Polygon([(140.5, -5.6), (144.0, -6.6), (146.5, -7.6), (149.5, -9.4),
                     (152.5, -11.0), (152.5, -13.0), (140.5, -13.0)])
    SP["papua_south"] = U("PNX").intersection(papua)
    SP["german_new_guinea"] = unary_union([U("PNX").difference(papua), U("PNB")])
    return SP

SNAPSHOTS = OrderedDict([("1914", specials_1914), ("1940", specials_1940)])

# ---------------------------------------------------------------------------
# Projection (Natural Earth, Šavrič et al. 2011)
# ---------------------------------------------------------------------------
def ne_xy(lon, lat):
    lam = math.radians(lon); phi = math.radians(lat)
    p2 = phi * phi; p4 = p2 * p2
    x = lam * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)))
    y = phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)))
    return x, y

R = WIDTH / 2 / ne_xy(180, 0)[0]
Y_TOP = ne_xy(0, LAT_MAX)[1] * R
HEIGHT = math.ceil(Y_TOP - ne_xy(0, LAT_MIN)[1] * R)

def project(x, y, z=None):
    px, py = ne_xy(x, y)
    return (px * R + WIDTH / 2, Y_TOP - py * R)

REGION_VIEWS = [
    ("world", "World", None),
    ("europe", "Europe", (-25.0, 34.0, 45.0, 72.0)),
    ("asia", "Asia & Middle East", (25.0, -12.0, 150.0, 56.0)),
    ("africa", "Africa", (-20.0, -36.0, 55.0, 38.0)),
    ("americas", "Americas", (-170.0, -57.0, -20.0, 84.0)),
    ("oceania", "Oceania", (95.0, -48.0, 180.0, 22.0)),
]

def regions_json():
    out = []
    for rid, rname, view in REGION_VIEWS:
        r = OrderedDict([("id", rid), ("name", rname)])
        if view:
            x0, y0, x1, y1 = view
            pts = [project(lon, lat)
                   for lon in (x0, (x0 + x1) / 2, x1)
                   for lat in (y0, (y0 + y1) / 2, y1)]
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            r["bbox"] = [round(max(0, min(xs)), 1), round(max(0, min(ys)), 1),
                         round(min(WIDTH, max(xs)), 1), round(min(HEIGHT, max(ys)), 1)]
        out.append(r)
    return out

# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------
def clean(g):
    if g.is_empty:
        return g
    keep = []
    for p in (g.geoms if g.geom_type == "MultiPolygon" else [g]):
        a = p.area
        if a < MIN_PART_AREA:
            continue
        if a < SLIVER_AREA and a / (p.length ** 2) < SLIVER_RATIO:
            continue
        keep.append(p)
    return MultiPolygon(keep) if keep else Polygon()

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
        out += ["L", fmt(x), " ", fmt(y)]
    return "".join(out) + "Z"

def geom_to_path(g):
    d = []
    for p in (g.geoms if g.geom_type == "MultiPolygon" else [g]):
        d.append(ring_to_path(p.exterior.coords))
        for r in p.interiors:
            d.append(ring_to_path(r.coords))
    return "".join(d)

def build_year(yid):
    cfg = json.load(open(os.path.join(HERE, f"entities_{yid}.json")))
    used_units.clear()
    SP = SNAPSHOTS[yid]()

    log(f"[{yid}] assembling entities")
    entities = []
    for e in cfg["entities"]:
        parts = []
        for u in e["units"]:
            if u.startswith("@"):
                key = u[1:]
                if key not in SP:
                    raise SystemExit(f"{yid}: unknown geometry rule {u} for {e['id']}")
                parts.append(SP[key])
            elif u in UNITS:
                parts.append(UNITS[u]); used_units.add(u)
            else:
                log(f"  WARNING: {e['id']}: unit {u} missing in 50m data")
        g = clean(fix(unary_union(parts)) if parts else Polygon())
        if g.is_empty:
            log(f"  dropping {e['id']}: no geometry left after cleaning (too small at this scale)")
            continue
        entities.append((e, g))
    log(f"[{yid}] map units not drawn: {', '.join(sorted(set(UNITS) - used_units)) or 'none'}")

    log(f"[{yid}] checking overlaps")
    geoms = [g for _, g in entities]
    tree = shapely.STRtree(geoms)
    for i, (e, g) in enumerate(entities):
        for j in tree.query(g, predicate="intersects"):
            if j > i and g.intersection(geoms[j]).area > 0.02:
                log(f"  OVERLAP {e['id']} x {entities[j][0]['id']}: "
                    f"{g.intersection(geoms[j]).area:.3f} deg²")

    with open(os.path.join(CACHE, f"world{yid}_lonlat.geojson"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"id": e["id"], "name": e["name"]},
             "geometry": mapping(g)} for e, g in entities]}, f)

    log(f"[{yid}] projecting and simplifying ({SIMPLIFY_PX} px)")
    clip = box(-180, LAT_MIN, 180, LAT_MAX)
    projected = []
    for e, g in entities:
        g = g.intersection(clip)
        if g.is_empty:
            log(f"  dropping {e['id']}: outside latitude range")
            continue
        projected.append((e, transform(project, g)))

    import topojson
    topo = topojson.Topology(
        {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"id": e["id"]}, "geometry": mapping(gp)}
            for e, gp in projected]},
        prequantize=200000, toposimplify=SIMPLIFY_PX,
        simplify_algorithm="dp", prevent_oversimplify=True)
    by_id = {f["properties"]["id"]: shape(f["geometry"])
             for f in json.loads(topo.to_geojson())["features"]}

    out_entities, total_pts = [], 0
    for e, gp in projected:
        g = fix(by_id.get(e["id"]) or gp)
        polys = [p for p in (g.geoms if g.geom_type == "MultiPolygon" else [g])
                 if p.area > 0.0005]
        if not polys:
            log(f"  dropping {e['id']}: empty after simplification")
            continue
        # merge parts that now share an edge, so one country is one shape
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
        total_pts += sum(len(p.exterior.coords) + sum(len(r.coords) for r in p.interiors)
                         for p in polys)
        out_entities.append(OrderedDict([
            ("id", e["id"]), ("name", e["name"]), ("aliases", e.get("aliases", [])),
            ("sovereign", e.get("sovereign")), ("status", e.get("status", "sovereign")),
            ("region", e["region"]), ("quiz", bool(e.get("quiz", True))),
            ("label", [round(lab.x, 2), round(lab.y, 2)]),
            ("bbox", [round(minx, 2), round(miny, 2), round(maxx, 2), round(maxy, 2)]),
            ("area", round(g.area, 2)), ("path", geom_to_path(g)),
        ]))

    small = [(o["id"], o["area"]) for o in out_entities if o["quiz"] and o["area"] < 1.5]
    if small:
        log(f"  [{yid}] quiz entities with area < 1.5 px²: {small}")

    meta = OrderedDict(cfg["meta"])
    meta.update([("width", int(WIDTH)), ("height", int(HEIGHT)),
                 ("projection", "Natural Earth"),
                 ("sources", [
                     "Base geometry: Natural Earth 1:50m (public domain)",
                     f"Historical borders: historical-basemaps, A. Ourednik et al. (GPL-3.0)",
                     "Compilation and period adjustments: this project"])])
    snapshot = OrderedDict([("meta", meta), ("regions", regions_json()),
                            ("entities", out_entities)])

    dest = os.path.join(ROOT, "data", f"world{yid}.js")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w") as f:
        f.write("// Generated by tools/build_data.py — do not edit by hand.\n")
        f.write(f"// {meta['title']}. See docs/HISTORY.md for sources and caveats.\n")
        f.write("window.GEOMAPS = window.GEOMAPS || {};\n")
        f.write(f'window.GEOMAPS[{json.dumps(yid)}] = ')
        json.dump(snapshot, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    log(f"[{yid}] wrote data/world{yid}.js: {len(out_entities)} entities, "
        f"{total_pts} vertices, {os.path.getsize(dest)/1024:.0f} KB, "
        f"{sum(o['quiz'] for o in out_entities)} in quiz")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="all", choices=list(SNAPSHOTS) + ["all"])
    args = ap.parse_args()
    for yid in (list(SNAPSHOTS) if args.year == "all" else [args.year]):
        build_year(yid)
