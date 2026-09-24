// Pure schedule logic: street-sweeping occurrences, meter status, holidays, calendar (.ics) export.
// All times use the device's local clock (i.e. you're in SF).
(function (root) {
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ICS_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  const ORD = ["1st", "2nd", "3rd", "4th", "5th"];
  const MS_DAY = 864e5;

  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const atMinutes = (day, min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min);

  // nth weekday of month (n = 1..5), or last if n = -1
  function nthWeekday(year, month, weekday, n) {
    if (n === -1) {
      const last = new Date(year, month + 1, 0);
      return new Date(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7));
    }
    const first = new Date(year, month, 1);
    return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7);
  }

  // ---------- Holidays ----------
  // Official list comes from SFMTA's Holiday Street Parking Enforcement Schedule (loaded via setHolidays).
  // Each holiday says whether meters, nightly sweeping (12am-6am) and daytime sweeping are enforced.
  // Outside the official list's date range we fall back to computing the City's 12 legal holidays.
  let official = new Map(), officialRange = ["", ""];
  function setHolidays(list) {
    official = new Map(list.map((h) => [h.date, h]));
    const dates = list.map((h) => h.date).sort();
    officialRange = [dates[0] || "", dates[dates.length - 1] || ""];
  }

  const computedCache = {};
  function computedHolidays(year) {
    if (computedCache[year]) return computedCache[year];
    const obs = (d) => (d.getDay() === 6 ? addDays(d, -1) : d.getDay() === 0 ? addDays(d, 1) : d);
    const tg = nthWeekday(year, 10, 4, 4);
    // New Year's, Thanksgiving and Christmas suspend everything; other holidays only suspend daytime sweeping.
    const big = (date, name) => ({ date, name, meters: false, nightSweep: false, daySweep: false });
    const std = (date, name) => ({ date, name, meters: true, nightSweep: true, daySweep: false });
    const list = [
      big(new Date(year, 0, 1), "New Year's Day"), std(nthWeekday(year, 0, 1, 3), "Martin Luther King Jr. Day"),
      std(nthWeekday(year, 1, 1, 3), "Presidents' Day"), std(nthWeekday(year, 4, 1, -1), "Memorial Day"),
      std(obs(new Date(year, 5, 19)), "Juneteenth"), std(obs(new Date(year, 6, 4)), "Independence Day"),
      std(nthWeekday(year, 8, 1, 1), "Labor Day"), std(nthWeekday(year, 9, 1, 2), "Indigenous Peoples Day"),
      std(obs(new Date(year, 10, 11)), "Veterans Day"), big(tg, "Thanksgiving Day"),
      std(addDays(tg, 1), "Day After Thanksgiving"), big(new Date(year, 11, 25), "Christmas Day"),
    ];
    return (computedCache[year] = new Map(list.map((h) => [ymd(h.date), { ...h, date: ymd(h.date), estimated: true }])));
  }

  function holidayOn(d) {
    const k = ymd(d);
    if (k >= officialRange[0] && k <= officialRange[1]) return official.get(k) || null;
    return computedHolidays(d.getFullYear()).get(k) || null;
  }
  const isMeterHoliday = (d) => { const h = holidayOn(d); return !!h && !h.meters; };

  function upcomingHolidays(from = new Date(), days = 120) {
    const out = [], day0 = startOfDay(from);
    for (let i = 0; i < days; i++) { const h = holidayOn(addDays(day0, i)); if (h) out.push({ ...h, day: addDays(day0, i) }); }
    return out;
  }

  // ---------- Street sweeping ----------
  // rule = [weekday 0-6 | 7=holiday, fromHour, toHour, weekBitmask (bit0 = 1st week), sweptOnHolidays]
  const isNightly = (r) => r[1] < 6;

  // Rules that are in effect on day d. On holidays: use the block's holiday-specific rules if it has any,
  // otherwise its regular rules — then drop whichever category (nightly/daytime) SFMTA isn't enforcing.
  function rulesForDay(rules, d, useHolidays = true) {
    const nth = Math.ceil(d.getDate() / 7);
    const regular = rules.filter((r) => r[0] === d.getDay() && (r[3] & (1 << (nth - 1))));
    const h = useHolidays && holidayOn(d);
    if (!h) return regular;
    const holRules = rules.filter((r) => r[0] === 7);
    return (holRules.length ? holRules : regular).filter((r) => (isNightly(r) ? h.nightSweep : h.daySweep));
  }

  function sweepOccurrences(rules, from, days = 62, useHolidays = true) {
    const out = [];
    const day0 = startOfDay(from);
    for (let i = 0; i < days; i++) {
      const d = addDays(day0, i);
      for (const r of rulesForDay(rules, d, useHolidays)) {
        const start = atMinutes(d, r[1] * 60), end = atMinutes(d, r[2] * 60);
        if (end > from) out.push({ start, end, rule: r });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }
  // First upcoming (or in-progress) sweep, scanning day by day and stopping at the first hit.
  function nextSweep(rules, now = new Date(), days = 62) {
    const day0 = startOfDay(now);
    for (let i = 0; i < days; i++) {
      const hits = sweepOccurrences(rules, i === 0 ? now : addDays(day0, i), 1);
      if (hits.length) return hits[0];
    }
    return null;
  }
  // Regularly-scheduled sweeps that are cancelled because of a holiday.
  function skippedSweeps(rules, from = new Date(), days = 30) {
    const actual = new Set(sweepOccurrences(rules, from, days).map((o) => +o.start));
    return sweepOccurrences(rules, from, days, false)
      .filter((o) => !actual.has(+o.start))
      .map((o) => ({ ...o, holiday: holidayOn(o.start) }));
  }

  function fmtHour(h) {
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}${h < 12 || h === 24 ? "am" : "pm"}`;
  }
  function describeRule(rule) {
    const [wd, from, to, weeks] = rule;
    const hours = `${fmtHour(from)}–${fmtHour(to)}`;
    if (wd === 7) return `Holidays, ${hours}`;
    if (weeks === 31) return `Every ${DAY[wd]}, ${hours}`;
    const which = ORD.filter((_, i) => weeks & (1 << i));
    return `${which.join(" & ")} ${DAY[wd]} of the month, ${hours}`;
  }

  // ---------- Meters ----------
  // pattern = 7 arrays (Sun..Sat) of segments [startMin, endMin, type, rate, limitMin]
  // type: OP = paid, ALT = alternate paid (e.g. loading), TOW = tow-away, PRE = pre-pay window
  const PAID = new Set(["OP", "ALT"]);
  const ENFORCED = new Set(["OP", "ALT", "TOW"]);

  function segsForDay(pattern, d) {
    if (isMeterHoliday(d)) return [];
    return pattern[d.getDay()].map((s) => ({
      start: atMinutes(d, s[0]), end: atMinutes(d, s[1]), type: s[2], rate: s[3], limit: s[4],
    }));
  }

  // Current status + when it changes.
  function meterStatus(pattern, now = new Date()) {
    const today = startOfDay(now);
    const segs = segsForDay(pattern, today);
    // TOW trumps other segments that overlap
    const cur = segs.filter((s) => s.start <= now && now < s.end)
      .sort((a, b) => (b.type === "TOW") - (a.type === "TOW"))[0];
    if (cur && ENFORCED.has(cur.type)) {
      // merge contiguous enforced segments to find when paid parking ends
      let end = cur.end;
      for (let i = 0; i < 8; i++) {
        const nxt = segs.find((s) => +s.start === +end && ENFORCED.has(s.type));
        if (!nxt) break;
        end = nxt.end;
      }
      return { state: cur.type, rate: cur.rate, limit: cur.limit, until: end, seg: cur };
    }
    const next = nextEnforcedStart(pattern, now);
    return { state: "FREE", prepay: cur && cur.type === "PRE", next };
  }

  function nextEnforcedStart(pattern, now = new Date()) {
    const day0 = startOfDay(now);
    for (let i = 0; i < 8; i++) {
      const segs = segsForDay(pattern, addDays(day0, i)).filter((s) => ENFORCED.has(s.type) && s.start > now);
      if (segs.length) return segs.sort((a, b) => a.start - b.start)[0];
    }
    return null;
  }

  function fmtMin(m) {
    const h = Math.floor(m / 60), mm = m % 60;
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 || h === 24 ? "am" : "pm"}`;
  }
  const fmtLimit = (m) => (m == null ? "" : m === 0 ? "no parking" : m % 60 === 0 ? `${m / 60} hr limit` : `${m} min limit`);

  // ---------- Formatting ----------
  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "");
  }
  function fmtWhen(d, now = new Date()) {
    const diff = Math.round((startOfDay(d) - startOfDay(now)) / MS_DAY);
    const day = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return `${day} ${fmtTime(d)}`;
  }
  function fmtDuration(ms) {
    const m = Math.round(ms / 6e4);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} hr${m % 60 ? " " + (m % 60) + " min" : ""}`;
    return `${Math.round(h / 24)} days`;
  }

  // ---------- Calendar export ----------
  const VTIMEZONE = [
    "BEGIN:VTIMEZONE", "TZID:America/Los_Angeles",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0800", "TZOFFSETTO:-0700", "TZNAME:PDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:-0700", "TZOFFSETTO:-0800", "TZNAME:PST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
    "END:VTIMEZONE",
  ];
  const icsLocal = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}00`;
  const icsUtc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");

  // Recurrence rule for a sweeping rule (holiday-only rules can't be expressed; return null).
  function sweepRRule(rule) {
    const [wd, , , weeks] = rule;
    if (wd === 7) return null;
    if (weeks === 31) return `FREQ=WEEKLY;BYDAY=${ICS_DAY[wd]}`;
    const days = ORD.map((_, i) => i).filter((i) => weeks & (1 << i)).map((i) => `${i + 1}${ICS_DAY[wd]}`);
    return `FREQ=MONTHLY;BYDAY=${days.join(",")}`;
  }

  // events: [{ title, start, end, alarms: [minutesBefore], rrule?, description?, location? }]
  function buildICS(events) {
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//April's Guide to Parking in SF//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...VTIMEZONE];
    const stamp = icsUtc(new Date());
    events.forEach((e, i) => {
      lines.push("BEGIN:VEVENT", `UID:${stamp}-${i}-${Math.random().toString(36).slice(2)}@aprils-sf-parking`, `DTSTAMP:${stamp}`,
        `DTSTART;TZID=America/Los_Angeles:${icsLocal(e.start)}`, `DTEND;TZID=America/Los_Angeles:${icsLocal(e.end)}`,
        `SUMMARY:${esc(e.title)}`);
      if (e.rrule) lines.push(`RRULE:${e.rrule}`);
      if (e.exdates?.length) lines.push(`EXDATE;TZID=America/Los_Angeles:${e.exdates.map(icsLocal).join(",")}`);
      if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
      if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
      for (const m of e.alarms || []) {
        lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${m}M`, "END:VALARM");
      }
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.join("\r\n");
  }

  // Holiday cancellations of a recurring rule over the next ~15 months, for calendar EXDATEs.
  const holidayExdates = (rule, from = new Date()) => skippedSweeps([rule], from, 460).map((o) => o.start);

  const api = {
    DAY, setHolidays, holidayOn, isMeterHoliday, upcomingHolidays, rulesForDay, sweepOccurrences, nextSweep, skippedSweeps,
    holidayExdates, describeRule,
    meterStatus, nextEnforcedStart, segsForDay, fmtMin, fmtLimit, fmtTime, fmtWhen, fmtDuration,
    sweepRRule, buildICS, startOfDay, addDays,
  };
  if (typeof module !== "undefined") module.exports = api;
  else root.Sched = api;
})(this);
