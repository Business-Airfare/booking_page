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

// ELR / fake-return legs sit on the ticket but are never boarded, so
// this card never shows them: not their airports, not their stops, not
// their hours. Journeys made only of them are dropped by realJourneys;
// this drops the ones buried inside a real journey. Falls back to every
// segment if somehow all of them are marked.
function flownSegments(j) {
  const segs = Array.isArray(j?.segments) ? j.segments : [];
  const flown = segs.filter((s) => !s?.not_for_travel);
  return flown.length > 0 ? flown : segs;
}

// Same basis as the journey's own total_travel_minutes (first departure
// to last arrival), recomputed whenever a ghost leg was dropped so the
// card never quotes time the traveler does not spend travelling.
function travelMinutes(j, segs) {
  const all = Array.isArray(j?.segments) ? j.segments : [];
  if (segs.length === all.length) return j?.total_travel_minutes;
  const from = Date.parse(segs[0]?.depart_utc ?? "");
  const to = Date.parse(segs[segs.length - 1]?.arrive_utc ?? "");
  return Number.isFinite(from) && Number.isFinite(to) ? Math.round((to - from) / 60000) : null;
}

/* ---------- airline logos ---------- */

// Square carrier icons from the pay project's public bucket (the same
// ones the payment page shows). Each is a couple of KB, they repeat
// across bookings, and satori needs bytes rather than a URL, so they
// are fetched once and kept as data URIs for the life of the instance.
// A logo that will not load simply leaves the airline's name to stand
// on its own: this card never shows a broken image.
const LOGO_BASE =
  "https://ofyciacvdpwpkcbbmmxj.supabase.co/storage/v1/object/public/airline-logos/airline-icons";
const LOGO_TIMEOUT_MS = 2000;
const LOGO_CACHE = new Map(); // carrier code -> data URI or "" when unavailable

async function logoDataUri(code) {
  if (LOGO_CACHE.has(code)) return LOGO_CACHE.get(code);
  let uri = "";
  try {
    const res = await fetch(`${LOGO_BASE}/${code}.png`, {
      signal: AbortSignal.timeout(LOGO_TIMEOUT_MS),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0) uri = `data:image/png;base64,${buf.toString("base64")}`;
    }
  } catch {
    // leave "" — the name renders alone
  }
  LOGO_CACHE.set(code, uri);
  return uri;
}

// Live sessions carry server-resolved airline names; this mirrors the
// payment page's offline fallback (payment-react/src/lib/airlines.ts)
// so an older session without them still names common carriers rather
// than printing a bare code beside the logo.
const FALLBACK_NAMES = {
  AA: "American Airlines", AC: "Air Canada", AF: "Air France", AS: "Alaska Airlines",
  AV: "Avianca", AY: "Finnair", AZ: "ITA Airways", A3: "Aegean Airlines",
  BA: "British Airways", BR: "EVA Air", B6: "JetBlue", CA: "Air China",
  CI: "China Airlines", CX: "Cathay Pacific", DL: "Delta Air Lines", EI: "Aer Lingus",
  EK: "Emirates", ET: "Ethiopian Airlines", EY: "Etihad Airways", FI: "Icelandair",
  IB: "Iberia", JL: "Japan Airlines", KE: "Korean Air", KL: "KLM",
  LH: "Lufthansa", LO: "LOT Polish Airlines", LX: "Swiss", MS: "EgyptAir",
  MU: "China Eastern", NH: "ANA", NZ: "Air New Zealand", OS: "Austrian Airlines",
  OZ: "Asiana Airlines", QF: "Qantas", QR: "Qatar Airways", RO: "TAROM",
  SK: "SAS", SN: "Brussels Airlines", SQ: "Singapore Airlines", SV: "Saudia",
  TG: "Thai Airways", TK: "Turkish Airlines", TP: "TAP Air Portugal",
  UA: "United Airlines", UX: "Air Europa", VN: "Vietnam Airlines",
  VS: "Virgin Atlantic", WN: "Southwest Airlines",
};

/** Marketing carriers of the legs actually flown, in order, deduped. */
function journeyCarriers(segs) {
  const out = [];
  for (const s of segs) {
    const code = String(s?.marketing_carrier ?? "").trim().toUpperCase();
    if (code.length === 2 && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Fetches every logo the card will draw, in parallel, once per render. */
async function loadLogos(journeys) {
  const codes = new Set();
  for (const j of journeys) for (const c of journeyCarriers(flownSegments(j))) codes.add(c);
  const list = [...codes];
  const uris = await Promise.all(list.map(logoDataUri));
  return new Map(list.map((code, i) => [code, uris[i]]));
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

// Matches the money formatting in api/page.mjs, so the amount drawn on
// the card and the one in the link's text preview always agree.
function fmtMoney(cents, currency) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return "";
  const cur = String(currency ?? "usd").toLowerCase();
  const symbol = cur === "usd" ? "$" : cur === "eur" ? "€" : `${cur.toUpperCase()} `;
  const whole = Math.floor(n / 100).toLocaleString("en-US");
  const rem = Math.round(n % 100);
  return rem === 0 ? `${symbol}${whole}` : `${symbol}${whole}.${String(rem).padStart(2, "0")}`;
}

// The advertised price is always the ticket alone, per traveler: no
// service fee, no Travel Care, no tip. Same rule in api/page.mjs. With
// no passengers on the session there is no per-traveler figure to show,
// and the card simply leaves the price line out.
function perPaxTicket(data) {
  const list = Array.isArray(data?.passenger_details) ? data.passenger_details : [];
  const pax = list.length || (Array.isArray(data?.passengers) ? data.passengers.length : 0);
  const ticket = Number(data?.quote?.ticket);
  if (pax < 1 || !Number.isFinite(ticket) || ticket <= 0) return "";
  return fmtMoney(Math.round(ticket / pax), data?.currency);
}

const CABIN_LABELS = {
  economy: "Economy Class",
  premium_economy: "Premium Economy",
  business: "Business Class",
  first: "First Class",
};

// One chip stands for the whole journey, so it may only name a cabin
// the traveler holds on every leg of it. Two legs in different cabins
// read as "Mixed cabin" rather than the first leg's. Legs with a cabin
// we cannot name are ignored: they can neither label the journey nor
// make it look mixed.
function cabinLabel(segs) {
  const named = new Set(
    segs.map((s) => CABIN_LABELS[s?.cabin]).filter(Boolean)
  );
  if (named.size === 0) return null;
  return named.size === 1 ? [...named][0] : "Mixed cabin";
}

/* ---------- pieces ---------- */

// The box is drawn tight around the curve: 8px of air above the apex,
// 10px below the end dots. Anything looser leaves invisible padding
// that the layout would then have to compensate for.
const ARC_TOP = 8, ARC_BOTTOM = 10;
const arcBoxHeight = (rise) => rise + ARC_TOP + ARC_BOTTOM;

function arcSvg(width, rise, stops) {
  const height = arcBoxHeight(rise);
  // Quadratic midpoint is halfway between the ends and the control
  // point, so the control point sits twice the rise above the ends.
  const x0 = 10, x1 = width - 10, y = height - ARC_BOTTOM, cy = y - rise * 2;
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

// Line heights are pinned so the arc can be positioned against the
// airport code's own centre line (see arcShift).
const CITY_LH = 1.2, CODE_LH = 1.1, CHIP_LH = 1.2, CITY_GAP = -6;
// Clearance between the cabin chip and the apex of the arc below it.
const CHIP_GAP = 6;

function endpoint(align, city, code, timeLocal, s) {
  const [t, ap] = fmtTime(timeLocal);
  const alignItems = align === "left" ? "flex-start" : "flex-end";
  return el("div", { display: "flex", flexDirection: "column", alignItems, width: s.col ?? 250 }, [
    el("div", { fontSize: s.city, color: SOFT, marginBottom: CITY_GAP, lineHeight: CITY_LH }, city ?? ""),
    el("div", { fontSize: s.code, fontWeight: 800, letterSpacing: -3, color: INK, lineHeight: CODE_LH }, code ?? ""),
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
    lineHeight: CHIP_LH,
    padding: `${chipPad(size)}px ${size}px`, borderRadius: 999,
  }, text);
}

const chipPad = (size) => Math.round(size * 0.36);
const chipHeight = (size) => size * CHIP_LH + chipPad(size) * 2;

// The arc reads as the line joining the two airport codes, so its end
// dots sit on the codes' own centre line rather than below the block.
// Returns the offset to apply to the middle column: everything in it
// (cabin chip, arc, duration) moves with the dots.
function arcShift(s, hasCabin) {
  const codeCentre = s.city * CITY_LH + CITY_GAP + (s.code * CODE_LH) / 2;
  const chipBlock = hasCabin ? chipHeight(s.chip) + CHIP_GAP : 0;
  const dotsInBox = arcBoxHeight(s.rise) - ARC_BOTTOM;
  return Math.round(codeCentre - (chipBlock + dotsInBox));
}

// Who flies the journey, set below the duration and stops line: the
// carrier's square icon and, when a single airline covers the whole
// journey, its name. Two airlines read as "A + B"; beyond that the
// icons carry it and the names would crowd the row.
function airlineMark(segs, s, ctx) {
  const codes = journeyCarriers(segs);
  if (codes.length === 0) return el("div", {}, "");

  // A carrier we cannot name is left to its logo; printing the raw
  // two-letter code next to that same airline's mark reads as noise.
  // With neither name nor logo the code is all there is.
  const nameOf = (c) => ctx.names[c] || FALLBACK_NAMES[c] || "";
  const icons = codes.slice(0, 3).map((c) => ctx.logos.get(c) || "");
  const named = codes.map(nameOf);

  const text =
    codes.length === 1
      ? named[0] || (icons[0] ? "" : codes[0])
      : codes.length === 2 && named[0] && named[1]
      ? `${named[0]} + ${named[1]}`
      : codes.length === 2
      ? ""
      : `${codes.length} airlines`;

  const marks = icons
    .filter(Boolean)
    .map((uri) => el("img", {}, undefined, { src: uri, width: s.logo, height: s.logo }));

  return el("div", { display: "flex", alignItems: "center", gap: 10 }, [
    ...(marks.length
      ? [el("div", { display: "flex", alignItems: "center", gap: 6 }, marks)]
      : []),
    ...(text
      ? [el("div", { fontSize: s.label, fontWeight: 500, color: SOFT }, text)]
      : []),
  ]);
}

function journeyBlock(j, label, s, ctx) {
  const segs = flownSegments(j);
  const first = segs[0] ?? {}, last = segs[segs.length - 1] ?? {};
  // Connection airports of the flown legs only.
  const stops = segs
    .slice(0, -1)
    .filter((seg, i) => seg?.destination && seg.destination === segs[i + 1]?.origin)
    .map((seg) => seg.destination);
  const arcW = s.arcW, arcH = arcBoxHeight(s.rise);
  const arc = arcSvg(arcW, s.rise, stops);
  const cabin = cabinLabel(segs);
  const stopsText = stops.length === 0 ? "Nonstop" : stops.length === 1 ? "1 stop" : `${stops.length} stops`;
  const dur = fmtDuration(travelMinutes(j, segs));

  return el("div", { display: "flex", flexDirection: "column", width: "100%" }, [
    el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: s.headGap }, [
      el("div", { fontSize: s.label, fontWeight: 500, color: MUTED }, label),
    ]),
    el("div", { display: "flex", alignItems: "flex-start", justifyContent: "space-between" }, [
      endpoint("left", first.origin_city, first.origin, first.depart_local, s),
      el("div", { display: "flex", flexDirection: "column", alignItems: "center", flexGrow: 1, marginTop: arcShift(s, Boolean(cabin)) }, [
        cabin ? el("div", { display: "flex", marginBottom: CHIP_GAP }, [chip(cabin, CHIP_BG, "#334155", s.chip)]) : el("div", {}, ""),
        el("div", { display: "flex", position: "relative", width: arcW, height: arcH + 14 }, [
          el("img", { width: arcW, height: arcH }, undefined, { src: arc.uri, width: arcW, height: arcH }),
          ...stopLabels(stops, arc.pt, s.chip),
        ]),
        el("div", { display: "flex", alignItems: "center", gap: 14, marginTop: -6 }, [
          dur ? chip(dur, "#F1F5F9", SOFT, s.chip) : el("div", {}, ""),
          el("div", { fontSize: s.chip + 1, color: MUTED }, stopsText),
        ]),
        // Who flies it, set apart from the timing line above it.
        el("div", { display: "flex", marginTop: s.airlineGap }, [airlineMark(segs, s, ctx)]),
      ]),
      endpoint("right", last.destination_city, last.destination, last.arrive_local ?? last.depart_local, s),
    ]),
  ]);
}

function tripCard(data, ctx) {
  const journeys = realJourneys(data?.journeys);
  if (journeys.length === 0) return null;
  const shown = journeys.slice(0, 3);
  const extra = journeys.length - shown.length;
  // "Outbound / Return" only when the trip really ends where it began;
  // open-jaw two-journey trips are numbered like multi city ones.
  const firstFlown = flownSegments(journeys[0]);
  const lastFlown = flownSegments(journeys[journeys.length - 1]);
  const firstSeg = firstFlown[0];
  const lastSeg = lastFlown[lastFlown.length - 1];
  const roundTrip = journeys.length === 2 && lastSeg?.destination === firstSeg?.origin;
  const labels = shown.map((_, i) => {
    if (journeys.length === 1) return "One way";
    if (roundTrip) return i === 0 ? "Outbound" : "Return";
    return `Flight ${i + 1}`;
  });

  const s =
    shown.length === 1
      // Columns + arc must stay within the card's 1028px content box:
      // wider than that and the outer code runs off the card edge.
      ? { code: 116, city: 32, time: 34, date: 26, label: 28, chip: 26, rise: 62, arcW: 388, headGap: 14, divider: 26, col: 320, price: 58, priceGap: 40, logo: 40, airlineGap: 34 }
      : shown.length === 2
      ? { code: 104, city: 28, time: 30, date: 23, label: 25, chip: 23, rise: 53, arcW: 460, headGap: 8, divider: 60, col: 280, price: 48, priceGap: 30, logo: 34, airlineGap: 28 }
      // Three rows plus the price line is the tallest the card gets;
      // the row gap is what pays for the price line's height here.
      : { code: 84, city: 24, time: 25, date: 20, label: 22, chip: 20, rise: 36, arcW: 440, headGap: 4, divider: 10, col: 280, price: 40, priceGap: 18, logo: 28, airlineGap: 18 };

  const body = [];
  shown.forEach((j, i) => {
    if (i > 0) body.push(el("div", { height: 2, backgroundColor: "#EDF1F5", margin: `${s.divider}px 0` }, ""));
    body.push(el("div", { display: "flex" }, [journeyBlock(j, labels[i], s, ctx)]));
  });
  if (extra > 0) {
    body.push(el("div", { display: "flex", justifyContent: "center", fontSize: 19, color: MUTED, marginTop: 6 },
      extra === 1 ? "+ 1 more flight" : `+ ${extra} more flights`));
  }

  // Price line, the same figure the link's text preview quotes.
  const price = perPaxTicket(data);
  if (price) {
    body.push(el("div", { height: 2, backgroundColor: "#EDF1F5", margin: `${s.priceGap}px 0 0` }, ""));
    body.push(el("div", {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginTop: s.priceGap,
    }, [
      el("div", { fontSize: s.label, color: MUTED }, "Price per traveler"),
      el("div", { fontSize: s.price, fontWeight: 800, letterSpacing: -1, color: INK, lineHeight: 1.1 }, price),
    ]));
  }

  return el("div", {
    width: W, height: H, display: "flex", backgroundColor: BG, padding: 34, position: "relative",
  }, [
    el("div", {
      display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1,
      backgroundColor: CARD, borderRadius: 30, padding: "26px 52px",
    }, body),
    // Open affordance perched on the card corner, clear of all content:
    // tells the viewer the card is a link to the full details. The one
    // accent element on the surface (--ba-accent).
    el("div", {
      position: "absolute", top: 10, right: 14, width: 62, height: 62,
      borderRadius: 999, backgroundColor: "#4653E8", color: "#FFFFFF",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 42, fontWeight: 500, paddingBottom: 5,
    }, "+"),
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
  if (!data) return null;

  // Airline names come resolved on the session; logos are fetched (and
  // cached) before the render, since satori draws from bytes.
  const ctx = {
    names: data.summary?.airline_names ?? {},
    logos: await loadLogos(realJourneys(data.journeys)),
  };

  const tree = tripCard(data, ctx);
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
