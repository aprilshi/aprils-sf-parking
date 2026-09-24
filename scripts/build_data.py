#!/usr/bin/env python3
"""Download SF open data and write compact JSON bundles for the web app.

Sources (DataSF / SFMTA, all public, no key required):
  yhqp-riqs  Street Sweeping Schedule (Public Works) - the data behind the n8xs-xfw6 map
  qq7v-hds4  Meter Policies - per-meter daily schedules + hourly rates, refreshed daily
  8vzz-qzz9  Parking Meters - meter inventory with lat/lng
  SFMTA Holiday Street Parking Enforcement Schedule (sfmta.com/holiday) - which holidays suspend
             meters / nightly sweeping / daytime sweeping

Re-run whenever you want fresh data (SFMTA adjusts rates roughly quarterly):
  python3 scripts/build_data.py
"""
import datetime as dt
import html
import json
import os
import re
import urllib.parse
import urllib.request

BASE = "https://data.sf.gov/resource"
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "data")
PAGE = 50000


def soda(dataset, **params):
    rows, offset = [], 0
    while True:
        q = dict(params, **{"$limit": PAGE, "$offset": offset, "$order": ":id"})
        url = f"{BASE}/{dataset}.json?" + urllib.parse.urlencode(q)
        with urllib.request.urlopen(url, timeout=120) as r:
            batch = json.load(r)
        rows += batch
        print(f"  {dataset}: {len(rows)} rows", flush=True)
        if len(batch) < PAGE:
            return rows
        offset += PAGE


def hm(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


DAY_SWEEP = {"Sun": 0, "Mon": 1, "Tues": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6, "Holiday": 7}
DAY_METER = {"Su": 0, "Mo": 1, "Tu": 2, "We": 3, "Th": 4, "Fr": 5, "Sa": 6}


def build_sweeping():
    print("Street sweeping…")
    rows = soda("yhqp-riqs")
    blocks = {}  # cnn -> {street, limits, geom, sides: {L|R: {bs, rules}}}
    for r in rows:
        if "line" not in r or r.get("weekday") not in DAY_SWEEP:
            continue
        b = blocks.setdefault(r["cnn"], {
            "s": r["corridor"].strip(),
            "l": " ".join(r.get("limits", "").split()),
            "g": [[round(x, 5), round(y, 5)] for x, y in r["line"]["coordinates"]],
            "sd": {},
        })
        side = b["sd"].setdefault(r["cnnrightleft"], {"b": r.get("blockside") or "", "r": []})
        weeks = sum(1 << i for i in range(5) if r.get(f"week{i + 1}") == "1")
        # rule: [weekday(0-6, 7=holiday), fromHour, toHour, weekBitmask, sweptOnHolidays]
        rule = [DAY_SWEEP[r["weekday"]], int(r["fromhour"]), int(r["tohour"]), weeks, int(r.get("holidays") or 0)]
        if rule not in side["r"]:
            side["r"].append(rule)
    out = [{"c": cnn, **b} for cnn, b in blocks.items()]
    write("sweeping.json", out)


def build_meters():
    print("Meter inventory…")
    inv = soda("8vzz-qzz9", **{"$select": "post_id,street_num,street_name,cap_color,latitude,longitude,active_meter_flag"})
    loc = {}
    for m in inv:
        if m.get("latitude") and m.get("active_meter_flag") in ("M", "T"):
            loc[m["post_id"]] = m

    print("Meter policies…")
    today = dt.date.today().isoformat()
    pol = soda("qq7v-hds4", **{
        "$select": "postid,startdate,dayofweek,starttime,endtime,scheduletype,hourlyrate,timelimitminutes,capcolor",
        "$where": f"enddate >= '{today}' AND scheduletype != 'FREE'",
    })
    # keep only the policy version in effect today (latest startdate <= today) per meter
    by_post = {}
    for p in pol:
        by_post.setdefault(p["postid"], []).append(p)

    patterns, pat_idx, meters = [], {}, []
    for pid, ps in by_post.items():
        m = loc.get(pid)
        if not m:
            continue
        current = [p["startdate"] for p in ps if p["startdate"][:10] <= today]
        eff = max(current) if current else min(p["startdate"] for p in ps)
        segs = [[] for _ in range(7)]
        for p in ps:
            if p["startdate"] != eff:
                continue
            # segment: [startMin, endMin, type, rate, limitMin]
            segs[DAY_METER[p["dayofweek"]]].append([
                hm(p["starttime"]), hm(p["endtime"]), p["scheduletype"],
                float(p["hourlyrate"]) if p.get("hourlyrate") else None,
                int(p["timelimitminutes"]) if p.get("timelimitminutes") else None,
            ])
        for s in segs:
            s.sort()
        key = json.dumps(segs, separators=(",", ":"))
        if key not in pat_idx:
            pat_idx[key] = len(patterns)
            patterns.append(segs)
        cap = next((p.get("capcolor") for p in ps if p.get("capcolor")), None) or m.get("cap_color") or ""
        meters.append([
            pid, round(float(m["longitude"]), 6), round(float(m["latitude"]), 6),
            f"{m.get('street_num', '')} {m.get('street_name', '')}".strip(), cap, pat_idx[key],
        ])
    print(f"  {len(meters)} meters, {len(patterns)} unique schedules")
    write("meters.json", {"asOf": today, "patterns": patterns, "meters": meters})


HOLIDAY_URL = "https://www.sfmta.com/getting-around/drive-park/holiday-enforcement-schedule"


def build_holidays():
    """Scrape SFMTA's enforcement calendar table: Date | Holiday | Meters | Nightly sweeping | Other programs.
    'Other programs' covers daytime street sweeping (6am-2pm)."""
    print("Holidays…")
    req = urllib.request.Request(HOLIDAY_URL, headers={"User-Agent": "Mozilla/5.0 (aprils-sf-parking data build)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        page = r.read().decode("utf-8", "ignore")
    holidays = []
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S):
        cells = [" / ".join(filter(None, (" ".join(html.unescape(re.sub(r"<[^>]+>", " ", part)).split())
                                          for part in re.split(r"<br\s*/?>|</p>", c))))
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)]
        cells = [c for c in cells if c]
        if len(cells) < 5 or not re.match(r"\d{1,2}/\d{1,2}/\d{4}$", cells[0]):
            continue
        m, d, y = map(int, cells[0].split("/"))
        enforced = [c.lower().startswith("enforced") for c in cells[2:5]]
        holidays.append({"date": f"{y}-{m:02d}-{d:02d}", "name": cells[1],
                         "meters": enforced[0], "nightSweep": enforced[1], "daySweep": enforced[2]})
    if not holidays:
        raise RuntimeError("Couldn't parse SFMTA holiday table — page layout may have changed")
    print(f"  {len(holidays)} holidays through {holidays[-1]['date']}")
    write("holidays.json", {"source": HOLIDAY_URL, "fetched": dt.date.today().isoformat(), "holidays": holidays})


def write(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"  wrote {name} ({os.path.getsize(path) / 1e6:.1f} MB)")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    try:
        build_holidays()
    except Exception as e:  # keep the last good holidays.json; the app also falls back to computed holidays
        print(f"  WARNING: holiday refresh failed: {e}")
    build_sweeping()
    build_meters()
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump({"built": dt.datetime.now().isoformat(timespec="minutes")}, f)
