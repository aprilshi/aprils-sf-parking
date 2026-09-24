/* global maplibregl, Sched */
const S = Sched;
const SF_CENTER = [-122.4194, 37.7749];
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CAP = {
  Grey: "General metered parking", Green: "Short-term (green cap)", Yellow: "Commercial loading only during hours (yellow cap)",
  Red: "Truck loading, 6+ wheels (red cap)", Black: "Motorcycle (black cap)", Brown: "Tour bus (brown cap)", Purple: "Accessible (purple cap)",
};
const STATE_LABEL = { OP: "Paid parking", ALT: "Alternate paid schedule", TOW: "TOW-AWAY — no parking", FREE: "Free" };
const SWEEP_COLORS = ["#dc2626", "#f59e0b", "#eab308", "#60a5fa"];

let map, blocks = [], meters = [], patterns = [], carMarker = null, meMarker = null;
let pending = null;      // parking spot being confirmed
let searchMarker = null, homeMarker = null;
let lastPicked = null;   // last search result, for "Set as home"
let timers = [];

// ---------- persistence ----------
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(k),
};
const prefs = () => ({ sweepOn: true, sweepLead: 60, nightBefore: true, meterOn: true, meterLead: 15, limitOn: true, limitLead: 10, ...store.get("prefs", {}) });

// ---------- UI helpers ----------
function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
// keep the point of interest above the bottom sheet on phones
const sheetOffset = () => (window.innerWidth < 700 ? [0, -window.innerHeight * 0.3] : [0, 0]);
function openSheet(html) { $("#sheet-body").innerHTML = html; $("#sheet").classList.remove("hidden"); $("#sheet").scrollTop = 0; }
function closeSheet() { $("#sheet").classList.add("hidden"); highlight(null); if (pending) cancelPending(); }
function highlight(i, side) {
  if (map?.getLayer("sweep-sel")) map.setFilter("sweep-sel", i == null ? ["==", ["get", "i"], -1] : ["all", ["==", ["get", "i"], i], ["==", ["get", "side"], side]]);
}

// ---------- home (saved on this device only, never in the code) ----------
const getHome = () => store.get("home", null);
function setHome(lngLat, label) {
  store.set("home", { lngLat, label });
  drawHome();
  toast(`🏠 Home set to ${label}`);
}
function drawHome() {
  const h = getHome();
  if (!h) { homeMarker?.remove(); homeMarker = null; return; }
  if (!homeMarker) {
    const el = document.createElement("div");
    el.className = "home-marker"; el.textContent = "🏠";
    homeMarker = new maplibregl.Marker({ element: el });
  }
  homeMarker.setLngLat(h.lngLat).addTo(map);
  homeMarker.getElement().title = h.label;
}

// ---------- geometry ----------
function toXY(lng, lat, lat0) { return [lng * Math.cos(lat0 * Math.PI / 180) * 111320, lat * 110540]; }

// distance (m) from point to a block's centerline and which side (L/R relative to line direction)
function blockDistance(b, lng, lat) {
  const [px, py] = toXY(lng, lat, lat);
  let best = { d: Infinity, side: "R" };
  for (let i = 0; i < b.g.length - 1; i++) {
    const [ax, ay] = toXY(b.g[i][0], b.g[i][1], lat), [bx, by] = toXY(b.g[i + 1][0], b.g[i + 1][1], lat);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.d) best = { d, side: dx * (py - ay) - dy * (px - ax) < 0 ? "R" : "L" };
  }
  return best;
}

function nearestBlocks(lng, lat, n = 3, maxM = 80) {
  const pad = 0.0012;
  const res = [];
  for (const b of blocks) {
    const bb = b.bb;
    if (lng < bb[0] - pad || lng > bb[2] + pad || lat < bb[1] - pad || lat > bb[3] + pad) continue;
    const r = blockDistance(b, lng, lat);
    if (r.d <= maxM) res.push({ b, ...r });
  }
  return res.sort((a, b) => a.d - b.d).slice(0, n);
}

function nearestMeters(lng, lat, n = 6, maxM = 60) {
  const res = [];
  for (const m of meters) {
    if (Math.abs(m.lng - lng) > 0.001 || Math.abs(m.lat - lat) > 0.001) continue;
    const [ax, ay] = toXY(lng, lat, lat), [bx, by] = toXY(m.lng, m.lat, lat);
    const d = Math.hypot(ax - bx, ay - by);
    if (d <= maxM) res.push({ m, d });
  }
  return res.sort((a, b) => a.d - b.d).slice(0, n);
}

// ---------- data -> map features ----------
function sweepCategory(rules, now) {
  const nx = S.nextSweep(rules, now, 8);
  if (!nx) return 3;
  const h = (nx.start - now) / 36e5;
  return h < 24 ? 0 : h < 72 ? 1 : h < 168 ? 2 : 3;
}

function sweepGeoJSON() {
  const now = new Date(), features = [];
  blocks.forEach((b, i) => {
    for (const side of Object.keys(b.sd)) {
      features.push({
        type: "Feature", geometry: { type: "LineString", coordinates: b.g },
        properties: { i, side, cat: sweepCategory(b.sd[side].r, now) },
      });
    }
  });
  return { type: "FeatureCollection", features };
}

function meterGeoJSON() {
  const now = new Date();
  return {
    type: "FeatureCollection",
    features: meters.map((m, k) => ({
      type: "Feature", geometry: { type: "Point", coordinates: [m.lng, m.lat] },
      properties: { k, st: S.meterStatus(patterns[m.p], now).state },
    })),
  };
}

function refreshLayers() {
  if (!map.getSource("sweep")) return;
  map.getSource("sweep").setData(sweepGeoJSON());
  map.getSource("meters").setData(meterGeoJSON());
}

// ---------- rendering pieces ----------
function sideLabel(b, side) { return (b.sd[side]?.b || (side === "R" ? "Right" : "Left")).replace(/([a-z])([A-Z])/g, "$1-$2") + " side"; }

function sweepSummaryHTML(b, side, now = new Date()) {
  const s = b.sd[side];
  if (!s) return `<div class="card">No street cleaning listed for this side.</div>`;
  const occ = S.sweepOccurrences(s.r, now, 62).slice(0, 3);
  const nx = occ[0];
  let head = `<div class="big">No sweeping in the next 2 months</div>`;
  if (nx) {
    const inProgress = nx.start <= now;
    const soon = nx.start - now < 24 * 36e5;
    head = `<div class="big ${soon || inProgress ? "warn" : ""}">${inProgress ? "Sweeping NOW until " + S.fmtTime(nx.end) : S.fmtWhen(nx.start) + "–" + S.fmtTime(nx.end)}</div>
      ${inProgress ? "" : `<div class="sub">in ${S.fmtDuration(nx.start - now)}</div>`}`;
  }
  const skipped = S.skippedSweeps(s.r, now, 21);
  return `<div class="card">${head}
    ${skipped.map((o) => `<div class="ok">🎉 No sweeping ${S.fmtWhen(o.start)} — ${esc(o.holiday.name)}</div>`).join("")}
    <ul class="rules">${s.r.map((r) => `<li>${esc(S.describeRule(r))}</li>`).join("")}</ul>
    ${occ.length > 1 ? `<div class="sub">Upcoming: ${occ.slice(1).map((o) => S.fmtWhen(o.start)).join(" · ")}</div>` : ""}
  </div>`;
}

function meterStatusHTML(m, now = new Date(), parkedAt = null) {
  const pat = patterns[m.p];
  const st = S.meterStatus(pat, now);
  const hol = S.holidayOn(now);
  let html = "";
  if (hol) html += `<div class="sub">Today is ${esc(hol.name)} — meters ${hol.meters ? "<b>are</b> enforced" : "are not enforced"}.</div>`;
  if (st.state === "FREE") {
    html += `<div class="big ok">Free now</div>`;
    if (st.next) {
      const n = st.next;
      html += `<div>${n.type === "TOW" ? '<span class="warn">Tow-away starts</span>' : "Meter starts"} <b>${S.fmtWhen(n.start)}</b>
        ${n.rate != null ? ` · $${n.rate.toFixed(2)}/hr` : ""}${n.limit ? ` · ${S.fmtLimit(n.limit)}` : ""}</div>
        <div class="sub">in ${S.fmtDuration(n.start - now)}</div>`;
    }
    if (st.prepay) html += `<div class="sub">You can pre-pay now for when the meter starts.</div>`;
  } else if (st.state === "TOW") {
    html += `<div class="big warn">TOW-AWAY until ${S.fmtTime(st.until)}</div>`;
  } else {
    html += `<div class="big">${STATE_LABEL[st.state]} until ${S.fmtTime(st.until)}</div>
      <div>${st.rate != null ? `$${st.rate.toFixed(2)}/hr` : ""}${st.limit ? ` · ${S.fmtLimit(st.limit)}` : ""}</div>`;
    const lim = limitDeadline(m, parkedAt || now);
    if (lim) html += `<div class="sub">${parkedAt ? "Move by" : "If you park now, move by"} <b>${S.fmtTime(lim)}</b> (time limit)</div>`;
  }
  return html;
}

// When the time limit runs out, counting from when you parked (only while meter is enforced).
function limitDeadline(m, parkedAt) {
  const st = S.meterStatus(patterns[m.p], parkedAt);
  if (!st.limit || !["OP", "ALT"].includes(st.state)) return null;
  const dl = new Date(+parkedAt + st.limit * 6e4);
  return dl < st.until ? dl : null;
}

function weekTableHTML(pat) {
  const today = new Date().getDay();
  const rows = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const segs = pat[d];
    const txt = segs.length ? segs.map((s) => {
      const t = `${S.fmtMin(s[0])}–${S.fmtMin(s[1])}`;
      if (s[2] === "TOW") return `<span class="warn">${t} tow-away</span>`;
      if (s[2] === "PRE") return `<span class="sub">${t} pre-pay</span>`;
      return `${t} <b>$${(s[3] ?? 0).toFixed(2)}</b>${s[2] === "ALT" ? " (alt)" : ""}${s[4] ? ` <span class="sub">${S.fmtLimit(s[4])}</span>` : ""}`;
    }).join("<br>") : '<span class="ok">Free all day</span>';
    return `<tr class="${d === today ? "today" : ""}"><td>${S.DAY[d]}</td><td>${txt}</td></tr>`;
  }).join("");
  const free = S.upcomingHolidays(new Date(), 120).filter((h) => !h.meters);
  return `<table class="sched">${rows}</table><div class="small">Meters are free on New Year's Day, Thanksgiving and Christmas${free.length ? ` (next: ${free.map((h) => h.day.toLocaleDateString([], { month: "short", day: "numeric" })).join(", ")})` : ""}.</div>`;
}

// ---------- sheets ----------
function showBlock(i, side, header = "") {
  const b = blocks[i];
  const sides = Object.keys(b.sd);
  if (!b.sd[side]) side = sides[0];
  highlight(i, side);
  openSheet(`
    ${header ? `<div class="sub">📍 ${esc(header)}</div>` : ""}
    <h2>${esc(b.s)}</h2><div class="sub">${esc(b.l)}</div>
    <h3>Street cleaning</h3>
    ${sides.length > 1 ? `<div class="seg">${sides.map((sd) => `<button data-side="${sd}" class="${sd === side ? "on" : ""}">${esc(sideLabel(b, sd))}</button>`).join("")}</div>` : `<div class="sub">${esc(sideLabel(b, side))}</div>`}
    ${sweepSummaryHTML(b, side)}
    ${header && lastPicked ? `<button class="btn" id="set-home">🏠 Set ${esc(header)} as home</button>` : ""}
    <button class="btn" id="cal-recurring">📅 Always-on weekly calendar reminder</button>
    <div class="small">For a spot you park at regularly. Unlike “I parked here” reminders, this repeats every week whether or not your car is here. It skips City holidays through ${holidayHorizon()}.</div>
  `);
  $("#sheet-body").querySelectorAll("[data-side]").forEach((btn) => btn.onclick = () => showBlock(i, btn.dataset.side, header));
  $("#set-home")?.addEventListener("click", () => setHome(lastPicked.lngLat, lastPicked.label));
  $("#cal-recurring").onclick = () => downloadICS(recurringSweepEvents(b, side), `sweeping-${b.s.replace(/\W+/g, "-")}.ics`);
}

function showMeter(k, side = null) {
  const m = meters[k];
  if (pending) { pending.meterK = k; renderPending(); return; }
  // meters sit on the curb, so the nearest block + side of centerline is the side this meter is on
  const near = nearestBlocks(m.lng, m.lat, 5, 40);
  const norm = (x) => x.toUpperCase().replace(/^0+/, "").replace(/\s+/g, " ").trim();
  const street = norm(m.addr.replace(/^\d+\s+/, ""));
  // near corners the cross street can be closer, so prefer the block named like the meter's address
  const nb = near.find((x) => norm(x.b.s) === street) || near[0];
  const b = nb?.b, meterSide = nb?.side;
  side = side || meterSide;
  if (b) highlight(blocks.indexOf(b), side);
  const sides = b ? Object.keys(b.sd) : [];
  openSheet(`
    <h2>${esc(m.addr)}</h2><div class="sub">Meter #${esc(m.id)} · ${esc(CAP[m.cap] || m.cap)}</div>
    <div class="card" id="meter-now">${meterStatusHTML(m)}</div>
    <h3>Street cleaning${b ? ` · ${esc(b.s)}` : ""}</h3>
    ${b ? `${sides.length > 1 ? `<div class="seg">${sides.map((sd) => `<button data-side="${sd}" class="${sd === side ? "on" : ""}">${esc(sideLabel(b, sd))}${sd === meterSide ? " (this meter)" : ""}</button>`).join("")}</div>` : ""}
      ${sweepSummaryHTML(b, side)}` : `<div class="card">No street-cleaning route found for this meter.</div>`}
    <h3>Weekly meter schedule & rates</h3>
    <div id="meter-week">${weekTableHTML(patterns[m.p])}</div>
    <button class="btn primary" id="park-at-meter">🚗 I'm parked at this meter</button>
  `);
  $("#sheet-body").querySelectorAll("[data-side]").forEach((btn) => btn.onclick = () => showMeter(k, btn.dataset.side));
  $("#park-at-meter").onclick = () => startParking([m.lng, m.lat], k);
  refreshMeterLive(m).then((changed) => {
    if (changed && $("#meter-now")) { $("#meter-now").innerHTML = meterStatusHTML(m); $("#meter-week").innerHTML = weekTableHTML(patterns[m.p]); }
  });
}

// Pull today's policy for one meter straight from DataSF so the bundled data can't go stale.
async function refreshMeterLive(m) {
  try {
    const today = S.startOfDay(new Date()).toISOString().slice(0, 10);
    const where = encodeURIComponent(`postid='${m.id}' AND enddate >= '${today}' AND scheduletype != 'FREE'`);
    const r = await fetch(`https://data.sf.gov/resource/qq7v-hds4.json?$where=${where}&$limit=500`);
    if (!r.ok) return false;
    const rows = await r.json();
    if (!rows.length) return false;
    const eff = rows.map((x) => x.startdate).filter((d) => d.slice(0, 10) <= today).sort().pop() || rows[0].startdate;
    const D = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
    const hm = (s) => { const [h, mm] = s.split(":").map(Number); return h * 60 + mm; };
    const pat = [[], [], [], [], [], [], []];
    for (const x of rows) {
      if (x.startdate !== eff) continue;
      pat[D[x.dayofweek]].push([hm(x.starttime), hm(x.endtime), x.scheduletype,
        x.hourlyrate != null ? +x.hourlyrate : null, x.timelimitminutes != null ? +x.timelimitminutes : null]);
    }
    pat.forEach((d) => d.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    if (JSON.stringify(pat) === JSON.stringify(patterns[m.p])) return false;
    m.p = patterns.push(pat) - 1;
    return true;
  } catch { return false; }
}

// ---------- parking flow ----------
function setCar(lngLat, draggable) {
  if (!carMarker) {
    const el = document.createElement("div");
    el.className = "car-marker"; el.textContent = "🚗";
    carMarker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lngLat).addTo(map);
    carMarker.on("dragend", () => {
      if (!pending) return;
      const ll = carMarker.getLngLat();
      pending.lngLat = [ll.lng, ll.lat];
      pending.meterK = null; pending.side = null; pending.blockI = null;
      renderPending();
    });
  }
  carMarker.setLngLat(lngLat).setDraggable(draggable);
  carClick();
}
// tapping the parked car opens the "your car" sheet
function carClick() {
  if (!carMarker || carMarker._clickBound) return;
  carMarker._clickBound = true;
  carMarker.getElement().addEventListener("click", (e) => { if (!pending && store.get("parked")) { e.stopPropagation(); showParked(); } });
}

async function startParking(lngLat, meterK = null) {
  if (!lngLat) {
    toast("Finding your location…", 8000);
    try {
      const pos = await getPosition();
      lngLat = [pos.coords.longitude, pos.coords.latitude];
      toast(`Located (±${Math.round(pos.coords.accuracy)} m). Drag the car if it's off.`);
    } catch (e) {
      lngLat = map.getCenter().toArray();
      toast("Couldn't get your location — drag the 🚗 to where you parked.", 5000);
    }
  }
  pending = { lngLat, meterK, side: null, blockI: null };
  setCar(lngLat, true);
  map.flyTo({ center: lngLat, zoom: Math.max(map.getZoom(), 17.5), offset: sheetOffset() });
  renderPending();
}

function cancelPending() {
  pending = null;
  const p = store.get("parked");
  if (p) setCar(p.lngLat, false);
  else if (carMarker) { carMarker.remove(); carMarker = null; }
}

function renderPending() {
  const [lng, lat] = pending.lngLat;
  const nb = nearestBlocks(lng, lat);
  if (pending.blockI == null && nb.length) { pending.blockI = blocks.indexOf(nb[0].b); pending.side = nb[0].side; }
  const nm = nearestMeters(lng, lat);
  if (pending.meterK == null && !pending.meterTouched && nm[0] && nm[0].d < 20) {
    pending.meterK = meters.indexOf(nm[0].m);
  }
  const b = blocks[pending.blockI];
  const meterOpts = [...nm];
  if (pending.meterK != null && !nm.some((x) => meters.indexOf(x.m) === pending.meterK)) meterOpts.unshift({ m: meters[pending.meterK], d: null });

  openSheet(`
    <h2>Confirm where you parked</h2>
    <div class="sub">Drag the 🚗 to adjust. GPS can be off by a few car lengths — double-check the side of the street.</div>
    ${b ? `
      <h3>Block</h3>
      ${nb.length > 1 ? `<div class="seg">${nb.map((x) => { const bi = blocks.indexOf(x.b); return `<button data-block="${bi}" data-side-guess="${x.side}" class="${bi === pending.blockI ? "on" : ""}">${esc(x.b.s)}<br><span class="sub">${esc(x.b.l)}</span></button>`; }).join("")}</div>` : `<div><b>${esc(b.s)}</b> <span class="sub">${esc(b.l)}</span></div>`}
      <h3>Side of the street</h3>
      <div class="seg">${Object.keys(b.sd).map((sd) => `<button data-side="${sd}" class="${sd === pending.side ? "on" : ""}">${esc(sideLabel(b, sd))}</button>`).join("")}</div>
      ${sweepSummaryHTML(b, pending.side)}
    ` : `<div class="card">No street-cleaning route found within 80 m of this spot.</div>`}
    <h3>Meter</h3>
    <div class="seg" style="flex-direction:column">
      ${meterOpts.map((x) => { const k = meters.indexOf(x.m); const st = S.meterStatus(patterns[x.m.p]).state; return `<button data-meter="${k}" class="${k === pending.meterK ? "on" : ""}" style="text-align:left">#${esc(x.m.id)} · ${esc(x.m.addr)} ${x.d != null ? `<span class="sub">${Math.round(x.d)} m</span>` : ""} <span class="pill">${st === "FREE" ? "free now" : st === "TOW" ? "tow-away" : "paid now"}</span></button>`; }).join("")}
      <button data-meter="none" class="${pending.meterK == null ? "on" : ""}">No meter / not listed</button>
    </div>
    <div class="small">Tip: the meter number is printed on the meter. You can also tap any meter on the map.</div>
    <div style="margin-top:12px"><button class="btn primary" id="save-spot">✅ Save parking spot</button><button class="btn" id="cancel-spot">Cancel</button></div>
  `);
  const body = $("#sheet-body");
  body.querySelectorAll("[data-block]").forEach((el) => el.onclick = () => { pending.blockI = +el.dataset.block; pending.side = el.dataset.sideGuess; renderPending(); });
  body.querySelectorAll("[data-side]").forEach((el) => el.onclick = () => { pending.side = el.dataset.side; renderPending(); });
  body.querySelectorAll("[data-meter]").forEach((el) => el.onclick = () => {
    pending.meterTouched = true;
    pending.meterK = el.dataset.meter === "none" ? null : +el.dataset.meter; renderPending();
  });
  $("#save-spot").onclick = savePending;
  $("#cancel-spot").onclick = closeSheet;
}

function savePending() {
  const b = blocks[pending.blockI];
  const m = pending.meterK != null ? meters[pending.meterK] : null;
  const parked = {
    lngLat: pending.lngLat, at: Date.now(),
    cnn: b?.c ?? null, side: pending.side, meterId: m?.id ?? null,
  };
  store.set("parked", parked);
  pending = null;
  setCar(parked.lngLat, false);
  scheduleNotifications();
  showParked();
  if (m) refreshMeterLive(m).then((ch) => { if (ch) { scheduleNotifications(); showParked(); } });
}

function parkedContext() {
  const p = store.get("parked");
  if (!p) return null;
  return {
    p,
    b: p.cnn ? blocks.find((x) => x.c === p.cnn) : null,
    m: p.meterId ? meters.find((x) => x.id === p.meterId) : null,
  };
}

// The reminder events for the current parking spot.
function parkedEvents() {
  const ctx = parkedContext();
  if (!ctx) return [];
  const { p, b, m } = ctx, pr = prefs(), now = new Date(), ev = [];
  const where = b ? `${b.s} (${b.l}), ${sideLabel(b, p.side)}` : "your car";
  if (pr.sweepOn && b?.sd[p.side]) {
    const nx = S.nextSweep(b.sd[p.side].r, now);
    if (nx && nx.start > now) {
      const alarms = [pr.sweepLead];
      if (pr.nightBefore) {
        const night = new Date(nx.start); night.setDate(night.getDate() - 1); night.setHours(20, 0, 0, 0);
        const mins = Math.round((nx.start - night) / 6e4);
        if (mins > pr.sweepLead && night > now) alarms.push(mins);
      }
      ev.push({ kind: "sweep", title: `🧹 Street cleaning — move car (${S.fmtTime(nx.start)}–${S.fmtTime(nx.end)})`, start: nx.start, end: nx.end, alarms, location: where });
    }
  }
  if (m) {
    const pat = patterns[m.p];
    const st = S.meterStatus(pat, now);
    const lim = limitDeadline(m, new Date(p.at));
    if (pr.limitOn && lim && lim > now) {
      ev.push({ kind: "limit", title: `⏱ Meter time limit up at ${S.fmtTime(lim)}`, start: lim, end: new Date(+lim + 15 * 6e4), alarms: [pr.limitLead], location: where });
    }
    const next = st.state === "FREE" ? st.next : S.nextEnforcedStart(pat, st.until);
    if (pr.meterOn && next && next.start > now && next.start - now < 7 * 864e5) {
      const what = next.type === "TOW" ? "🚨 Tow-away starts" : `🅿️ Meter starts${next.rate != null ? ` ($${next.rate.toFixed(2)}/hr)` : ""}`;
      ev.push({ kind: "meter", title: `${what} — meter #${m.id}`, start: next.start, end: new Date(+next.start + 15 * 6e4), alarms: [pr.meterLead], location: where });
    }
  }
  return ev;
}

function showParked() {
  const ctx = parkedContext();
  if (!ctx) { openSheet(`<h2>No saved spot</h2><p>Tap “I parked here” after you park.</p>`); return; }
  const { p, b, m } = ctx, pr = prefs();
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const [lng, lat] = p.lngLat;
  openSheet(`
    <h2>🚗 Your car</h2>
    <div class="sub">Parked ${S.fmtWhen(new Date(p.at))}${b ? ` · ${esc(b.s)}, ${esc(sideLabel(b, p.side))}` : ""}</div>
    <h3>Street cleaning</h3>
    ${b ? sweepSummaryHTML(b, p.side) : `<div class="card">No sweeping route found here.</div>`}
    <h3>Meter</h3>
    ${m ? `<div class="card"><div class="sub">#${esc(m.id)} · ${esc(m.addr)}</div>${meterStatusHTML(m, new Date(), new Date(p.at))}</div>
      <details><summary>Weekly schedule</summary>${weekTableHTML(patterns[m.p])}</details>` : `<div class="card">No meter saved.</div>`}
    <h3>Reminders for this spot</h3>
    <div class="sub">Only for where your car is now. They stop when you tap “I've left”.</div>
    <div class="checks">
      <label><input type="checkbox" data-pref="sweepOn" ${pr.sweepOn ? "checked" : ""}> 🧹 Street cleaning,
        ${leadSelect("sweepLead", [15, 30, 60, 120])}</label>
      <label class="indent"><input type="checkbox" data-pref="nightBefore" ${pr.nightBefore ? "checked" : ""}> …and at 8pm the night before</label>
      <label><input type="checkbox" data-pref="meterOn" ${pr.meterOn ? "checked" : ""}> 🅿️ Meter hours starting,
        ${leadSelect("meterLead", [5, 10, 15, 30, 60])}</label>
      <label><input type="checkbox" data-pref="limitOn" ${pr.limitOn ? "checked" : ""}> ⏱ Meter time limit running out,
        ${leadSelect("limitLead", [5, 10, 15, 30])}</label>
    </div>
    <div class="card" id="reminder-list">${reminderListHTML()}</div>
    <button class="btn primary" id="add-cal">📅 Add reminders to Calendar</button>
    ${perm === "granted" ? `<span class="small ok">Notifications on</span>` : perm !== "unsupported" && perm !== "denied" ? `<button class="btn" id="enable-notif">🔔 Enable notifications</button>` : ""}
    <div class="small">Calendar alerts are the most reliable — they fire even when this app is closed. App notifications only fire while the app is open or recently used.</div>
    <div style="margin-top:12px">
      <a class="btn" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking">🧭 Walk to car</a>
      <button class="btn" id="move-spot">✏️ Adjust spot</button>
      <button class="btn danger" id="clear-spot">I've left</button>
    </div>
  `);
  const savePref = (key, val) => { store.set("prefs", { ...prefs(), [key]: val }); scheduleNotifications(); $("#reminder-list").innerHTML = reminderListHTML(); };
  $("#sheet-body").querySelectorAll("[data-pref]").forEach((el) => el.onchange = () => savePref(el.dataset.pref, el.type === "checkbox" ? el.checked : +el.value));
  $("#add-cal").onclick = () => {
    const ev = parkedEvents();
    if (!ev.length) return toast("Nothing coming up to remind you about.");
    downloadICS(ev, "parking-reminders.ics");
    // remember what went into the calendar so "I've left" can tell you what to delete
    const q = store.get("parked");
    store.set("parked", { ...q, calEvents: ev.map((e) => ({ title: e.title, start: +e.start })) });
  };
  $("#enable-notif")?.addEventListener("click", async () => {
    const r = await Notification.requestPermission();
    if (r === "granted") { scheduleNotifications(); toast("Notifications enabled"); }
    showParked();
  });
  $("#move-spot").onclick = () => { const q = store.get("parked"); startParking(q.lngLat, m ? meters.indexOf(m) : null); pending.meterTouched = true; };
  $("#clear-spot").onclick = leaveSpot;
  updateParkButton();
}

const leadSelect = (key, opts) => `<select data-pref="${key}">${opts.map((v) => `<option ${v === prefs()[key] ? "selected" : ""} value="${v}">${v} min before</option>`).join("")}</select>`;

// "I've left": forget the spot and stop every app reminder for it.
async function leaveSpot() {
  const p = store.get("parked");
  if (!p || !confirm("Clear your parking spot and stop its reminders?")) return;
  store.del("parked"); clearTimers();
  const reg = await navigator.serviceWorker?.getRegistration();
  (await reg?.getNotifications?.() || []).forEach((n) => n.close());
  if (carMarker) { carMarker.remove(); carMarker = null; }
  updateParkButton();
  const cal = (p.calEvents || []).filter((e) => e.start > Date.now());
  if (!cal.length) { closeSheet(); toast("Spot cleared — reminders stopped"); return; }
  openSheet(`
    <h2>✅ Spot cleared</h2>
    <p>App reminders for this spot are stopped.</p>
    <div class="card"><b>You added these to your Calendar.</b> The app can't remove calendar events, so delete them in your Calendar app:
      <ul class="rules">${cal.map((e) => `<li>${esc(e.title)}<div class="sub">${S.fmtWhen(new Date(e.start))}</div></li>`).join("")}</ul></div>
  `);
}

function holidayHorizon() {
  const h = S.upcomingHolidays(new Date(), 460).filter((x) => !x.estimated).pop();
  return h ? h.day.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) + " (SFMTA list), then estimated" : "estimated dates";
}

function reminderListHTML() {
  const ev = parkedEvents();
  if (!ev.length) return `<span class="sub">Nothing to remind you about in the next week.</span>`;
  return ev.map((e) => `<div>${esc(e.title)}<div class="sub">${S.fmtWhen(e.start)} · alert ${e.alarms.map((a) => a > 120 ? "night before" : `${a} min before`).join(" + ")}</div></div>`).join("");
}

function recurringSweepEvents(b, side) {
  const pr = prefs(), now = new Date(), ev = [];
  for (const r of b.sd[side].r) {
    const rrule = S.sweepRRule(r);
    const first = S.sweepOccurrences([r], now, 62)[0];
    if (!rrule || !first) continue;
    const alarms = [pr.sweepLead];
    if (pr.nightBefore) alarms.push((24 - 20) * 60 + r[1] * 60);
    ev.push({ title: `🧹 Street cleaning: ${b.s} (${sideLabel(b, side)})`, start: first.start, end: first.end, rrule, alarms,
      exdates: S.holidayExdates(r, now),
      description: `${S.describeRule(r)}. ${b.l}. Source: SF Public Works via DataSF.`, location: `${b.s}, ${b.l}, San Francisco` });
  }
  return ev;
}

// ---------- reminders ----------
function downloadICS(events, filename) {
  const ics = S.buildICS(events);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast("Open the downloaded file to add it to your calendar.", 4000);
}

function clearTimers() { timers.forEach(clearTimeout); timers = []; }

async function notify(title, body) {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) reg.showNotification(title, { body, icon: "icon-192.png", tag: title });
  else new Notification(title, { body });
}

// In-app notifications (while the app is open/backgrounded briefly). Calendar export is the durable path.
function scheduleNotifications() {
  clearTimers();
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = Date.now();
  for (const e of parkedEvents()) {
    for (const a of e.alarms) {
      const at = +e.start - a * 6e4;
      if (at > now && at - now < 2 ** 31 - 1) timers.push(setTimeout(() => notify(e.title, `${S.fmtWhen(e.start)} · ${e.location}`), at - now));
    }
  }
}

function renderHolidayList(hol) {
  const up = S.upcomingHolidays(new Date(), 120);
  const what = (h) => h.meters ? "daytime sweeping off; meters & nightly sweeping still on" : "no meters, no sweeping";
  $("#holiday-list").innerHTML = (up.length ? up.map((h) =>
    `<div><b>${h.day.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</b> ${esc(h.name)}${h.estimated ? " (est.)" : ""}<div class="small" style="margin:0">${what(h)}</div></div>`).join("")
    : "<div>None in the next 4 months</div>") +
    `<div class="small">${hol ? `From <a href="${esc(hol.source)}" target="_blank" rel="noopener">SFMTA's holiday enforcement schedule</a>, checked ${esc(hol.fetched)}.` : "Estimated from the City's legal holidays."}</div>`;
}

// ---------- search: meter number or address ----------
const SUFFIX = { STREET: "ST", AVENUE: "AVE", BOULEVARD: "BLVD", DRIVE: "DR", PLACE: "PL", TERRACE: "TER", COURT: "CT", LANE: "LN", ROAD: "RD", ALLEY: "ALY", HIGHWAY: "HWY" };
function normStreet(s) {
  return s.toUpperCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => SUFFIX[w] || w.replace(/^(\d)(ST|ND|RD|TH)$/, "0$1$2")).join(" ");
}

async function searchAddresses(q) {
  const m = q.match(/^(\d+[A-Z]?)\s+(.+)$/i);
  if (!m) return [];
  const street = normStreet(m[2]).replace(/'/g, "''"), num = parseInt(m[1], 10);
  const query = async (where, order, limit) => {
    const url = `https://data.sf.gov/resource/3mea-di5p.json?$select=address,address_number,latitude,longitude,cnn,zip_code&$where=${encodeURIComponent(where)}&$order=${order}&$limit=${limit}`;
    return (await (await fetch(url)).json()).filter((r) => r.latitude);
  };
  const toResult = (r, sub) => ({ type: "addr", label: r.address, sub, lngLat: [+r.longitude, +r.latitude], cnn: r.cnn });
  try {
    const exact = await query(`upper(address) like '${m[1].toUpperCase()} ${street}%'`, "address", 6);
    if (exact.length) return exact.map((r) => toResult(r, `San Francisco ${r.zip_code || ""}`));
    // number doesn't exist (e.g. 100 3rd St) — offer the closest real addresses on that street
    const near = await query(`street_full_street_name like '${street}%' AND address_number::number between ${num - 80} and ${num + 80}`, "address_number", 50);
    return near.sort((a, b) => Math.abs(a.address_number - num) - Math.abs(b.address_number - num)).slice(0, 3)
      .map((r) => toResult(r, `Closest address to ${m[1]} ${m[2]}`));
  } catch { return []; }
}

function searchMeters(q) {
  const digits = q.replace(/[^0-9]/g, "");
  if (!/^[#\s]*\d{3}(-?\d{0,5})?\s*$/.test(q) || digits.length < 3) return [];
  return meters.filter((m) => m.id.replace("-", "").startsWith(digits)).slice(0, 6)
    .map((m) => ({ type: "meter", label: `Meter #${m.id}`, sub: m.addr, k: meters.indexOf(m) }));
}

async function searchPlaces(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&bounded=1&viewbox=-122.52,37.82,-122.35,37.70&q=${encodeURIComponent(q + ", San Francisco")}`;
  try {
    const rows = await (await fetch(url, { headers: { "Accept-Language": "en" } })).json();
    return rows.map((r) => ({ type: "place", label: r.display_name.split(",").slice(0, 2).join(","), sub: r.display_name.split(",").slice(2, 4).join(","), lngLat: [+r.lon, +r.lat] }));
  } catch { return []; }
}

let searchSeq = 0;
async function runSearch(q, includePlaces) {
  const seq = ++searchSeq;
  q = q.trim();
  const box = $("#search-results");
  if (q.length < 2) { box.classList.add("hidden"); return; }
  let results = searchMeters(q);
  if (!results.length) results = await searchAddresses(q);
  if (seq !== searchSeq) return;
  const showPlacesLink = !includePlaces && !searchMeters(q).length;
  if (includePlaces) {
    box.innerHTML = `<div class="sr-empty">Searching…</div>`; box.classList.remove("hidden");
    results = results.concat(await searchPlaces(q));
    if (seq !== searchSeq) return;
  }
  box.innerHTML = results.map((r, i) => `<button class="sr" data-i="${i}"><b>${r.type === "meter" ? "🅿️" : "📍"} ${esc(r.label)}</b><div class="sub">${esc(r.sub)}</div></button>`).join("") +
    (showPlacesLink ? `<button class="sr" id="sr-places">🔎 Search places & intersections for “${esc(q)}”</button>` : "") +
    (!results.length && (includePlaces || /^[#\s\d-]+$/.test(q)) ? `<div class="sr-empty">No results. Try an address like “1 Dr Carlton B Goodlett Pl” or the meter # printed on the meter (e.g. 666-00005).</div>` : "");
  box.classList.remove("hidden");
  box.querySelectorAll("[data-i]").forEach((el) => el.onclick = () => pickResult(results[+el.dataset.i]));
  $("#sr-places")?.addEventListener("click", () => runSearch(q, true));
}

function pickResult(r) {
  $("#search-results").classList.add("hidden");
  $("#search").value = r.label.replace(/^Meter /, "");
  $("#search").blur();
  if (r.type === "meter") {
    const m = meters[r.k];
    map.flyTo({ center: [m.lng, m.lat], zoom: 18, offset: sheetOffset() });
    return showMeter(r.k);
  }
  lastPicked = r;
  if (!searchMarker) { const el = document.createElement("div"); el.className = "search-marker"; el.textContent = "📍"; searchMarker = new maplibregl.Marker({ element: el, anchor: "bottom" }); }
  searchMarker.setLngLat(r.lngLat).addTo(map);
  map.flyTo({ center: r.lngLat, zoom: 17.5, offset: sheetOffset() });
  const [lng, lat] = r.lngLat;
  // prefer the block the address is officially on (EAS cnn), else the nearest one
  let bi = r.cnn ? blocks.findIndex((b) => b.c === r.cnn) : -1;
  if (bi < 0) { const nb = nearestBlocks(lng, lat, 1, 150); bi = nb.length ? blocks.indexOf(nb[0].b) : -1; }
  if (bi < 0) return openSheet(`<div class="sub">📍 ${esc(r.label)}</div><h2>No street-cleaning route nearby</h2>`);
  showBlock(bi, blockDistance(blocks[bi], lng, lat).side, r.label);
}

function getPosition() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("no geolocation"));
    navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
  });
}

function updateParkButton() {
  const btn = $("#park-btn");
  btn.textContent = store.get("parked") ? "🚗 My car" : "🚗 I parked here";
}

// ---------- init ----------
async function init() {
  map = new maplibregl.Map({
    container: "map", style: "https://tiles.openfreemap.org/styles/positron",
    center: getHome()?.lngLat || SF_CENTER, zoom: getHome() ? 16.5 : 13, maxBounds: [[-122.75, 37.60], [-122.25, 37.90]], attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  const [sw, mt, meta, hol] = await Promise.all([
    fetch("data/sweeping.json").then((r) => r.json()),
    fetch("data/meters.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
    fetch("data/holidays.json").then((r) => r.json()).catch(() => null),
  ]);
  if (hol) S.setHolidays(hol.holidays);
  renderHolidayList(hol);
  blocks = sw;
  for (const b of blocks) {
    const xs = b.g.map((c) => c[0]), ys = b.g.map((c) => c[1]);
    b.bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  patterns = mt.patterns;
  meters = mt.meters.map(([id, lng, lat, addr, cap, p]) => ({ id, lng, lat, addr, cap, p }));
  $("#data-asof").textContent = `Data: DataSF / SFMTA, built ${meta.built || mt.asOf}. Meter details refresh live when you tap one.`;

  const addLayers = () => {
    map.addSource("sweep", { type: "geojson", data: sweepGeoJSON() });
    map.addSource("meters", { type: "geojson", data: meterGeoJSON() });
    const offset = ["interpolate", ["linear"], ["zoom"], 12, ["case", ["==", ["get", "side"], "R"], 1, -1], 18, ["case", ["==", ["get", "side"], "R"], 7, -7]];
    map.addLayer({
      id: "sweep-line", type: "line", source: "sweep", layout: { "line-cap": "round" },
      paint: {
        "line-color": ["match", ["get", "cat"], 0, SWEEP_COLORS[0], 1, SWEEP_COLORS[1], 2, SWEEP_COLORS[2], SWEEP_COLORS[3]],
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 15, 3, 18, 6],
        "line-offset": offset,
        "line-opacity": ["match", ["get", "cat"], 3, 0.55, 0.95],
      },
    });
    map.addLayer({
      id: "sweep-sel", type: "line", source: "sweep", filter: ["==", ["get", "i"], -1], layout: { "line-cap": "round" },
      paint: { "line-color": "#111827", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 18, 10], "line-offset": offset },
    }, "sweep-line");
    map.addLayer({ id: "sweep-hit", type: "line", source: "sweep", paint: { "line-width": 18, "line-color": "#000", "line-opacity": 0.01, "line-offset": offset } });
    map.addLayer({
      id: "meter-dot", type: "circle", source: "meters", minzoom: 15,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 2.5, 18, 6],
        "circle-color": ["match", ["get", "st"], "FREE", "#9ca3af", "TOW", "#dc2626", "#7c3aed"],
        "circle-stroke-color": "#fff", "circle-stroke-width": 1,
      },
    });

    map.on("click", (e) => {
      const pad = 8, box = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
      const mf = map.getLayer("meter-dot") && map.getLayoutProperty("meter-dot", "visibility") !== "none" ? map.queryRenderedFeatures(box, { layers: ["meter-dot"] }) : [];
      if (mf.length) return showMeter(mf[0].properties.k);
      if (pending) return;
      const sf = map.getLayoutProperty("sweep-line", "visibility") !== "none" ? map.queryRenderedFeatures(box, { layers: ["sweep-hit"] }) : [];
      if (!sf.length) return;
      // pick the block closest to the tap, and the side of the street the tap is on
      const { lng, lat } = e.lngLat;
      const best = [...new Set(sf.map((f) => f.properties.i))]
        .map((i) => ({ i, ...blockDistance(blocks[i], lng, lat) })).sort((a, b) => a.d - b.d)[0];
      showBlock(best.i, best.side);
    });
    for (const l of ["meter-dot", "sweep-hit"]) {
      map.on("mouseenter", l, () => map.getCanvas().style.cursor = "pointer");
      map.on("mouseleave", l, () => map.getCanvas().style.cursor = "");
    }

    const p = store.get("parked");
    if (p) { setCar(p.lngLat, false); map.jumpTo({ center: p.lngLat, zoom: 16.5 }); }
    setInterval(refreshLayers, 5 * 60e3);
  };
  if (map.loaded()) addLayers(); else map.on("load", addLayers);

  $("#toggle-sweep").onchange = (e) => ["sweep-line", "sweep-hit"].forEach((l) => map.setLayoutProperty(l, "visibility", e.target.checked ? "visible" : "none"));
  $("#toggle-meters").onchange = (e) => map.setLayoutProperty("meter-dot", "visibility", e.target.checked ? "visible" : "none");
  let searchTimer;
  $("#search").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(e.target.value, false), 250); });
  $("#search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(searchTimer); runSearch(e.target.value, true); }
    if (e.key === "Escape") { $("#search-results").classList.add("hidden"); e.target.blur(); }
  });
  $("#search-clear").onclick = () => { $("#search").value = ""; $("#search-results").classList.add("hidden"); searchMarker?.remove(); };
  map.on("movestart", () => $("#search-results").classList.add("hidden"));
  $("#legend-btn").onclick = () => $("#legend").classList.toggle("collapsed");
  $("#sheet-close").onclick = closeSheet;
  $("#park-btn").onclick = () => {
    const p = store.get("parked");
    if (!p) return startParking(null);
    map.flyTo({ center: p.lngLat, zoom: Math.max(map.getZoom(), 17), offset: sheetOffset() });
    showParked();
  };
  drawHome();
  $("#home-btn").onclick = () => {
    const h = getHome();
    if (h) return map.flyTo({ center: h.lngLat, zoom: 16.5 });
    toast("Search your address above, then tap “Set as home”.", 4000);
    $("#search").focus();
  };
  $("#locate-btn").onclick = async () => {
    try {
      const pos = await getPosition();
      const ll = [pos.coords.longitude, pos.coords.latitude];
      if (!meMarker) { const el = document.createElement("div"); el.className = "me-marker"; meMarker = new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map); }
      meMarker.setLngLat(ll);
      map.flyTo({ center: ll, zoom: 17 });
    } catch { toast("Location unavailable — allow location access for this site."); }
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { refreshLayers(); scheduleNotifications(); } });

  updateParkButton();
  scheduleNotifications();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
