"""Build public/data/cafes-il.json from Overture Maps places (free, no sign-up).

    python3 -m venv .venv && .venv/bin/pip install pyarrow fsspec aiohttp
    .venv/bin/python scripts/build-cafes.py 2026-09-23.1 public/data/cafes-il.json

Reads only the parquet row groups overlapping Israel, keeps coffee shops / cafés in Israel with
confidence >= 0.4, and writes compact rows: [lng, lat, name, address, confidence%].
Release names: https://docs.overturemaps.org/release/latest/ (or list s3://overturemaps-us-west-2/release/).
"""
import json, re, sys
import fsspec, pyarrow as pa, pyarrow.compute as pc, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor

REL, OUT = sys.argv[1], sys.argv[2]
W, S, E, N = 34.2, 29.45, 35.95, 33.35
HOST = "https://overturemaps-us-west-2.s3.amazonaws.com/"
CATEGORIES = {"coffee_shop", "cafe", "coffee_roastery", "tea_room"}
COLS = ["names", "confidence", "taxonomy", "bbox", "addresses"]

fs = fsspec.filesystem("https", client_kwargs={"trust_env": True})
prefix = f"release/{REL}/theme=places/type=place/"
keys = re.findall(r"<Key>([^<]+\.parquet)</Key>", fs.cat(f"{HOST}?list-type=2&prefix={prefix}").decode())
if not keys:
    sys.exit(f"No files for release {REL}")


def read(key):
    with fs.open(HOST + key, "rb", block_size=2**20, cache_type="none") as f:
        pf = pq.ParquetFile(f)
        md = pf.metadata
        idx = {md.schema.column(i).path: i for i in range(md.num_columns)}
        groups = []
        for g in range(md.num_row_groups):
            st = lambda c: md.row_group(g).column(idx[c]).statistics
            if st("bbox.xmin").min > E or st("bbox.xmax").max < W or st("bbox.ymin").min > N or st("bbox.ymax").max < S:
                continue
            groups.append(g)
        if not groups:
            return None
        t = pf.read_row_groups(groups, columns=COLS)
    b = t.column("bbox").combine_chunks()
    x, y = b.field("xmin"), b.field("ymin")
    return t.filter(pc.and_(pc.and_(pc.greater_equal(x, W), pc.less_equal(x, E)), pc.and_(pc.greater_equal(y, S), pc.less_equal(y, N))))


with ThreadPoolExecutor(4) as ex:
    tables = [t for t in ex.map(read, keys) if t is not None and t.num_rows]

rows = []
for r in pa.concat_tables(tables).to_pylist():
    if (r["taxonomy"] or {}).get("primary") not in CATEGORIES or (r["confidence"] or 0) < 0.4:
        continue
    addr = (r["addresses"] or [{}])[0]
    if addr.get("country") != "IL":
        continue
    name = (r["names"] or {}).get("primary")
    if not name:
        continue
    street = (addr.get("freeform") or "").replace("\n", " ").strip()
    city = (addr.get("locality") or "").strip()
    address = ", ".join(p for p in (street, city) if p and p not in street) if street else city
    bb = r["bbox"]
    rows.append([round(bb["xmin"], 6), round(bb["ymin"], 6), name.strip(), address, round(r["confidence"] * 100)])

rows.sort(key=lambda r: (-r[4], r[2]))
with open(OUT, "w", encoding="utf-8") as f:
    json.dump({
        "source": f"Overture Maps Foundation places, release {REL}",
        "license": "CDLA-Permissive-2.0 (https://cdla.dev/permissive-2-0/); see https://docs.overturemaps.org/attribution/",
        "cafes": rows,
    }, f, ensure_ascii=False, separators=(",", ":"))
print(f"{len(rows)} cafés → {OUT}")
