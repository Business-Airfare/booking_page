// Serves the payment page HTML with social preview (Open Graph) tags
// injected into the <head>. Humans and crawlers receive the same HTML;
// the React app, assets and payment flow are untouched.
//
// Per-booking cards: ?public_id=ps_... and ?preview=pv_... fetch route,
// dates and price from the pay project's public endpoints (the same
// ones the page itself calls, anonymously). Any failure, timeout or
// unknown id degrades to the generic Business Airfare card, and any
// failure beyond that degrades to serving the unmodified HTML. This
// function must never be the reason the payment page fails to load.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_URL = "https://booking.business-airfare.com/";

// Same bases the page bundle uses (src/lib/config.ts in payment-react).
const FUNCTIONS_BASES = [
  "https://ofyciacvdpwpkcbbmmxj.functions.supabase.co",
  "https://ofyciacvdpwpkcbbmmxj.supabase.co/functions/v1",
];
const FETCH_TIMEOUT_MS = 3500;

const GENERIC_META = {
  siteName: "Business Airfare",
  title: "Secure payment | Business Airfare",
  description: "Review your flights and book securely with Business Airfare.",
  url: PAGE_URL,
};

// app.html is the page shell (renamed from index.html so the static
// file no longer shadows the "/" rewrite; Vercel serves static matches
// before rewrites). Bundled with the function via vercel.json includeFiles.
function loadTemplate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "app.html"),
    join(here, "..", "app.html"),
    join(here, "app.html"),
  ];
  for (const p of candidates) {
    try {
      const html = readFileSync(p, "utf8");
      if (html && html.includes("</head>")) return html;
    } catch {
      // try next candidate
    }
  }
  return "";
}

const TEMPLATE = loadTemplate();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function metaTagBlock(meta) {
  const pairs = [
    ["og:site_name", meta.siteName],
    ["og:type", "website"],
    ["og:title", meta.title],
    ["og:description", meta.description],
    ["og:url", meta.url],
  ];
  const lines = pairs.map(
    ([property, content]) =>
      `    <meta property="${property}" content="${escapeHtml(content)}" />`
  );
  lines.push('    <meta name="twitter:card" content="summary" />');
  lines.push(
    `    <meta name="description" content="${escapeHtml(meta.description)}" />`
  );
  return lines.join("\n");
}

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

/* ---------- card text helpers ---------- */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// depart_local is "yyyy-MM-dd HH:mm" in the airport's own timezone.
function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ""));
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function formatDateRange(outbound, back) {
  const a = parseLocalDate(outbound);
  if (!a) return "";
  const first = `${MONTHS[a.month - 1]} ${a.day}`;
  const b = parseLocalDate(back);
  if (!b || (b.month === a.month && b.day === a.day)) return first;
  if (b.month === a.month) return `${first} to ${b.day}`;
  return `${first} to ${MONTHS[b.month - 1]} ${b.day}`;
}

function formatMoney(cents, currency) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return "";
  const symbol =
    String(currency ?? "usd").toLowerCase() === "usd" ? "$"
    : String(currency ?? "").toLowerCase() === "eur" ? "€"
    : `${String(currency).toUpperCase()} `;
  const whole = Math.floor(n / 100);
  const rem = Math.round(n % 100);
  const wholeStr = whole.toLocaleString("en-US");
  return rem === 0 ? `${symbol}${wholeStr}` : `${symbol}${wholeStr}.${String(rem).padStart(2, "0")}`;
}

const CABIN_LABELS = {
  economy: "economy",
  premium_economy: "premium economy",
  business: "business class",
  first: "first class",
};

// Journeys made ONLY of not-for-travel segments are ticket artifacts
// (fake return), not part of the trip the card describes.
function realJourneys(journeys) {
  const list = Array.isArray(journeys) ? journeys : [];
  const real = list.filter(
    (j) => Array.isArray(j?.segments) && j.segments.some((s) => !s?.not_for_travel)
  );
  return real.length > 0 ? real : list;
}

function sessionMeta(data, cardUrl) {
  const journeys = realJourneys(data?.journeys);
  if (journeys.length === 0) return null;

  const firstJourney = journeys[0];
  const lastJourney = journeys[journeys.length - 1];
  const firstSeg = firstJourney.segments[0];
  const destSeg = firstJourney.segments[firstJourney.segments.length - 1];

  const originCity = firstSeg?.origin_city || firstSeg?.origin;
  const destCity = destSeg?.destination_city || destSeg?.destination;
  if (!originCity || !destCity) return null;

  const range = formatDateRange(
    firstSeg?.depart_local,
    journeys.length > 1 ? lastJourney.segments[0]?.depart_local : null
  );
  const title = range ? `${originCity} to ${destCity}, ${range}` : `${originCity} to ${destCity}`;

  const returnsToStart =
    lastJourney.segments[lastJourney.segments.length - 1]?.destination === firstSeg?.origin;
  const tripType =
    journeys.length === 1 ? "One way" : returnsToStart ? "Round trip" : "Multi city trip";

  const paxCount =
    (Array.isArray(data?.passenger_details) && data.passenger_details.length) ||
    (Array.isArray(data?.passengers) && data.passengers.length) ||
    (Array.isArray(data?.suggested_passengers) && data.suggested_passengers.length) ||
    0;
  const travelers =
    paxCount === 1 ? " for 1 traveler" : paxCount > 1 ? ` for ${paxCount} travelers` : "";

  const cabinCounts = {};
  for (const j of journeys) {
    for (const s of j.segments) {
      if (s?.not_for_travel) continue;
      const label = CABIN_LABELS[s?.cabin];
      if (label) cabinCounts[label] = (cabinCounts[label] ?? 0) + 1;
    }
  }
  const cabin = Object.keys(cabinCounts).sort((x, y) => cabinCounts[y] - cabinCounts[x])[0];
  const cabinPart = cabin ? `, ${cabin}` : "";

  const price = formatMoney(data?.total_amount, data?.currency);
  const pricePart = price ? ` Total ${price}.` : "";

  return {
    siteName: "Business Airfare",
    title,
    description: `${tripType}${travelers}${cabinPart}.${pricePart} Review your flights and book securely.`,
    url: cardUrl,
  };
}

function previewMeta(data, cardUrl) {
  const options = Array.isArray(data?.options) ? data.options : [];
  if (options.length === 0) return null;

  const summary = options[0]?.summary ?? {};
  const originCity = summary.origin_city || summary.origin;
  const destCity = summary.destination_city || summary.destination;
  if (!originCity || !destCity) return null;

  const fromCents = options
    .map((o) => Number(o?.from_total_per_pax))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((x, y) => x - y)[0];
  const fromPrice = formatMoney(fromCents, options[0]?.currency ?? data?.currency);

  const count = options.length;
  const countPart = count === 1 ? "1 flight option" : `${count} flight options`;
  const pricePart = fromPrice ? ` from ${fromPrice} per traveler` : "";

  return {
    siteName: "Business Airfare",
    title: `Your flight options: ${originCity} to ${destCity}`,
    description: `${countPart}${pricePart}. Compare and choose the one that fits.`,
    url: cardUrl,
  };
}

async function buildMeta(query) {
  const publicId = query.get("public_id");
  const previewId = query.get("preview");

  if (publicId) {
    const data = await fetchJson(
      `/get_public_session?public_id=${encodeURIComponent(publicId)}`
    );
    return (
      sessionMeta(data, `${PAGE_URL}?public_id=${encodeURIComponent(publicId)}`) ??
      GENERIC_META
    );
  }
  if (previewId) {
    const data = await fetchJson(
      `/get_public_preview?public_id=${encodeURIComponent(previewId)}`
    );
    return (
      previewMeta(data, `${PAGE_URL}?preview=${encodeURIComponent(previewId)}`) ??
      GENERIC_META
    );
  }
  return GENERIC_META;
}

export default async function handler(req, res) {
  let html = TEMPLATE;

  try {
    let meta = GENERIC_META;
    try {
      const query = new URL(req.url ?? "/", "http://local").searchParams;
      meta = (await buildMeta(query)) ?? GENERIC_META;
    } catch {
      meta = GENERIC_META;
    }
    if (html) {
      html = html.replace("</head>", `${metaTagBlock(meta)}\n  </head>`);
    }
  } catch {
    html = TEMPLATE;
  }

  if (!html) {
    // Template missing from the bundle: this is caught on the preview
    // deployment before the rewrite ever reaches production.
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Temporarily unavailable");
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=0, must-revalidate");
  res.end(html);
}
