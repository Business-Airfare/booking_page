// Per-booking preview card image (1200x630 PNG) for ?public_id=ps_...
// links. Renders the payment page flight-card design (owner approved
// 14 Aug 2026): up to three journey rows with big airport codes, city
// names, times, dates, layover arc and cabin chips; "+ N more flights"
// from the fourth journey.
//
// This endpoint is referenced from the og:image tag that api/page.mjs
// emits for valid sessions. On any failure it returns 404 with no
// body: messaging apps then simply show the text-only card. It can
// never affect the payment page itself.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";

// WhatsApp decides large vs small preview while the sender types, with a
// tight fetch timeout; a slow first byte demotes the card to the small
// layout and that decision is cached per URL. Rendered images are
// therefore cached in-memory (the page function pre-warms this endpoint
// on crawler hits) and on the CDN via s-maxage.
const IMAGE_CACHE = new Map(); // publicId -> { buf, at }
const IMAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const IMAGE_CACHE_MAX = 50;

// 4:3 rather than the classic 1.91:1: WhatsApp renders the image at
// full bubble width with height following the image's own aspect
// ratio, so the squarer canvas shows ~40% taller in the chat.
const W = 1200, H = 900;
const INK = "#0B1220", MUTED = "#64748B", SOFT = "#475569";
const CHIP_BG = "#EEF2F6", LINE = "#C4CFDC", BG = "#E9EEF3", CARD = "#FFFFFF";

const FUNCTIONS_BASES = [
  "https://ofyciacvdpwpkcbbmmxj.functions.supabase.co",
  "https://ofyciacvdpwpkcbbmmxj.supabase.co/functions/v1",
];
const FETCH_TIMEOUT_MS = 3500;

function loadFonts() {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [join(process.cwd(), "api", "_fonts"), join(here, "_fonts")];
  for (const root of roots) {
    try {
      return [400, 500, 600, 700, 800].map((w) => ({
        name: "Archivo",
        weight: w,
        style: "normal",
        data: readFileSync(join(root, `archivo-${w}.ttf`)),
      }));
    } catch {
      // try next root
    }
  }
  return null;
}

const FONTS = loadFonts();

const el = (type, style, children, extra = {}) => ({
  type,
  props: { style, children, ...extra },
});

/* ---------- data ---------- */

async function fetchJson(path) {
  for (const base of FUNCTIONS_BASES) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      return await res.json();
    } catch {
      // try the fallback base
    }
  }
  return null;
}

function realJourneys(journeys) {
  const list = Array.isArray(journeys) ? journeys : [];
  const real = list.filter(
    (j) => Array.isArray(j?.segments) && j.segments.some((s) => !s?.not_for_travel)
  );
  return real.length > 0 ? real : list;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function fmtTime(local) {
  const m = /(\d{2}):(\d{2})$/.exec(String(local ?? "").trim());
  if (!m) return ["", ""];
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return [`${h}:${m[2]}`, ap];
}

function fmtDate(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(local ?? ""));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[+m[2] - 1]} ${+m[3]}`;
}

function fmtDuration(mins) {
  if (!Number.isFinite(mins) || mins <= 0) return "";
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const CABIN_LABELS = {
  economy: "Economy Class",
  premium_economy: "Premium Economy",
  business: "Business Class",
  first: "First Class",
};

/* ---------- pieces ---------- */

function arcSvg(width, height, stops) {
  const x0 = 10, x1 = width - 10, y = height - 22, cy = 10;
  const path = `M ${x0} ${y} Q ${width / 2} ${cy} ${x1} ${y}`;
  const pt = (t) => {
    const bx = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * (width / 2) + t ** 2 * x1;
    const by = (1 - t) ** 2 * y + 2 * (1 - t) * t * cy + t ** 2 * y;
    return [bx, by];
  };
  const stopCircles = stops.map((_, i) => {
    const [sx, sy] = pt((i + 1) / (stops.length + 1));
    return `<circle cx="${sx}" cy="${sy}" r="6" fill="#fff" stroke="#94A3B8" stroke-width="2.5"/>`;
  }).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<path d="${path}" fill="none" stroke="${LINE}" stroke-width="3"/>` +
    `<circle cx="${x0}" cy="${y}" r="7" fill="${INK}"/>` +
    `<circle cx="${x1}" cy="${y}" r="7" fill="${INK}"/>` +
    stopCircles +
    `</svg>`;
  return { uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, pt };
}

function stopLabels(stops, pt, fontSize) {
  return stops.map((code, i) => {
    const [sx, sy] = pt((i + 1) / (stops.length + 1));
    return el("div", {
      position: "absolute",
      left: sx - 40,
      top: sy + 12,
      width: 80,
      display: "flex",
      justifyContent: "center",
      fontSize,
      fontWeight: 500,
      letterSpacing: 2,
      color: MUTED,
    }, code);
  });
}

function endpoint(align, city, code, timeLocal, s) {
  const [t, ap] = fmtTime(timeLocal);
  const alignItems = align === "left" ? "flex-start" : "flex-end";
  return el("div", { display: "flex", flexDirection: "column", alignItems, width: s.col ?? 250 }, [
    el("div", { fontSize: s.city, color: SOFT, marginBottom: -6 }, city ?? ""),
    el("div", { fontSize: s.code, fontWeight: 800, letterSpacing: -3, color: INK, lineHeight: 1.1 }, code ?? ""),
    el("div", { display: "flex", alignItems: "baseline", gap: 6, marginTop: -4 }, [
      el("div", { fontSize: s.time, fontWeight: 700, color: INK }, t),
      el("div", { fontSize: s.time - 9, fontWeight: 700, color: INK }, ap),
    ]),
    el("div", { fontSize: s.date, color: MUTED, marginTop: 2 }, fmtDate(timeLocal)),
  ]);
}

function chip(text, bg, color, size) {
  return el("div", {
    display: "flex", backgroundColor: bg, color, fontSize: size, fontWeight: 600,
    padding: `${Math.round(size * 0.36)}px ${size}px`, borderRadius: 999,
  }, text);
}

function journeyBlock(j, label, s) {
  const segs = j.segments ?? [];
  const first = segs[0] ?? {}, last = segs[segs.length - 1] ?? {};
  const stops = (j.layovers ?? []).map((l) => l.at).filter(Boolean);
  const arcW = s.arcW, arcH = s.arcH;
  const arc = arcSvg(arcW, arcH, stops);
  const cabin = CABIN_LABELS[first.cabin] ?? null;
  const stopsText = stops.length === 0 ? "Nonstop" : stops.length === 1 ? "1 stop" : `${stops.length} stops`;
  const dur = fmtDuration(j.total_travel_minutes);

  return el("div", { display: "flex", flexDirection: "column", width: "100%" }, [
    el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: s.headGap }, [
      el("div", { fontSize: s.label, fontWeight: 500, color: MUTED }, label),
      cabin ? chip(cabin, CHIP_BG, "#334155", s.chip) : el("div", {}, ""),
    ]),
    el("div", { display: "flex", alignItems: "flex-start", justifyContent: "space-between" }, [
      endpoint("left", first.origin_city, first.origin, first.depart_local, s),
      el("div", { display: "flex", flexDirection: "column", alignItems: "center", flexGrow: 1, paddingTop: s.arcPad }, [
        el("div", { display: "flex", position: "relative", width: arcW, height: arcH + 14 }, [
          el("img", { width: arcW, height: arcH }, undefined, { src: arc.uri, width: arcW, height: arcH }),
          ...stopLabels(stops, arc.pt, s.chip),
        ]),
        el("div", { display: "flex", alignItems: "center", gap: 14, marginTop: -6 }, [
          dur ? chip(dur, "#F1F5F9", SOFT, s.chip) : el("div", {}, ""),
          el("div", { fontSize: s.chip + 1, color: MUTED }, stopsText),
        ]),
      ]),
      endpoint("right", last.destination_city, last.destination, last.arrive_local ?? last.depart_local, s),
    ]),
  ]);
}

function tripCard(data) {
  const journeys = realJourneys(data?.journeys);
  if (journeys.length === 0) return null;
  const shown = journeys.slice(0, 3);
  const extra = journeys.length - shown.length;
  // "Outbound / Return" only when the trip really ends where it began;
  // open-jaw two-journey trips are numbered like multi city ones.
  const firstSeg = journeys[0]?.segments?.[0];
  const lastJ = journeys[journeys.length - 1];
  const lastSeg = lastJ?.segments?.[lastJ.segments.length - 1];
  const roundTrip = journeys.length === 2 && lastSeg?.destination === firstSeg?.origin;
  const labels = shown.map((_, i) => {
    if (journeys.length === 1) return "One way";
    if (roundTrip) return i === 0 ? "Outbound" : "Return";
    return `Flight ${i + 1}`;
  });

  const s =
    shown.length === 1
      ? { code: 124, city: 32, time: 34, date: 26, label: 28, chip: 26, arcH: 170, arcW: 470, arcPad: 12, headGap: 14, divider: 26, col: 310 }
      : shown.length === 2
      ? { code: 104, city: 28, time: 30, date: 23, label: 25, chip: 23, arcH: 138, arcW: 460, arcPad: 4, headGap: 8, divider: 84, col: 280 }
      : { code: 84, city: 24, time: 25, date: 20, label: 22, chip: 20, arcH: 104, arcW: 440, arcPad: 0, headGap: 6, divider: 30, col: 280 };

  const body = [];
  shown.forEach((j, i) => {
    if (i > 0) body.push(el("div", { height: 2, backgroundColor: "#EDF1F5", margin: `${s.divider}px 0` }, ""));
    body.push(el("div", { display: "flex" }, [journeyBlock(j, labels[i], s)]));
  });
  if (extra > 0) {
    body.push(el("div", { display: "flex", justifyContent: "center", fontSize: 19, color: MUTED, marginTop: 6 },
      extra === 1 ? "+ 1 more flight" : `+ ${extra} more flights`));
  }

  return el("div", {
    width: W, height: H, display: "flex", backgroundColor: BG, padding: 34,
  }, [
    el("div", {
      display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1,
      backgroundColor: CARD, borderRadius: 30, padding: "26px 52px",
    }, body),
  ]);
}

/* ---------- handler ---------- */

function notFound(res) {
  res.statusCode = 404;
  res.setHeader("cache-control", "public, max-age=0, s-maxage=300");
  res.end();
}

function sendJpeg(res, buf) {
  res.statusCode = 200;
  res.setHeader("content-type", "image/jpeg");
  res.setHeader("content-length", String(buf.length));
  res.setHeader("cache-control", "public, max-age=300, s-maxage=86400");
  res.end(buf);
}

async function renderCard(publicId) {
  const cached = IMAGE_CACHE.get(publicId);
  if (cached && Date.now() - cached.at < IMAGE_CACHE_TTL_MS) return cached.buf;

  const data = await fetchJson(
    `/get_public_session?public_id=${encodeURIComponent(publicId)}`
  );
  const tree = data ? tripCard(data) : null;
  if (!tree) return null;

  const svg = await satori(tree, { width: W, height: H, fonts: FONTS });
  const rendered = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render();
  const buf = jpeg.encode(
    { data: rendered.pixels, width: rendered.width, height: rendered.height },
    85
  ).data;

  if (IMAGE_CACHE.size >= IMAGE_CACHE_MAX) {
    const first = IMAGE_CACHE.keys().next().value;
    if (first) IMAGE_CACHE.delete(first);
  }
  IMAGE_CACHE.set(publicId, { buf, at: Date.now() });
  return buf;
}

export default async function handler(req, res) {
  try {
    if (!FONTS) return notFound(res);

    const query = new URL(req.url ?? "/", "http://local").searchParams;
    const publicId = query.get("public_id") ?? "";
    if (!/^ps_[A-Za-z0-9_-]+$/.test(publicId)) return notFound(res);

    const buf = await renderCard(publicId);
    if (!buf) return notFound(res);
    sendJpeg(res, buf);
  } catch {
    notFound(res);
  }
}
