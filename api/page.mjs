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
import { waitUntil } from "@vercel/functions";

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
  if (meta.image) {
    pairs.push(["og:image", meta.image]);
    pairs.push(["og:image:type", "image/jpeg"]);
    pairs.push(["og:image:width", "1200"]);
    pairs.push(["og:image:height", "900"]);
  }
  const lines = pairs.map(
    ([property, content]) =>
      `    <meta property="${property}" content="${escapeHtml(content)}" />`
  );
  lines.push(
    `    <meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}" />`
  );
  lines.push(
    `    <meta name="description" content="${escapeHtml(meta.description)}" />`
  );
  return lines.join("\n");
}

/**
 * @returns {Promise<{data: any, gone: boolean}>} `gone` is true only when a base
 * answered a definite 404: the link was killed by an agent, or never existed.
 * Every other failure (403, timeout, both bases down) leaves it false, because
 * those are indistinguishable from an infrastructure hiccup and must never be
 * allowed to hide a page that actually works.
 */
async function fetchJson(path) {
  let gone = false;
  for (const base of FUNCTIONS_BASES) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404) {
        gone = true;
        continue;
      }
      if (!res.ok) continue;
      return { data: await res.json(), gone: false };
    } catch {
      // try the fallback base
    }
  }
  return { data: null, gone };
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

function formatDate(local) {
  const d = parseLocalDate(local);
  return d ? `${MONTHS[d.month - 1]} ${d.day}` : "";
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

// Ticket price for one traveler. Sessions with no passengers on them
// have no per-traveler figure, and the preview then quotes no price.
function perPaxTicket(data) {
  const list = Array.isArray(data?.passenger_details) ? data.passenger_details : [];
  const pax = list.length || (Array.isArray(data?.passengers) ? data.passengers.length : 0);
  const ticket = Number(data?.quote?.ticket);
  if (pax < 1 || !Number.isFinite(ticket) || ticket <= 0) return "";
  return formatMoney(Math.round(ticket / pax), data?.currency);
}

// Journeys made ONLY of not-for-travel segments are ticket artifacts
// (fake return), not part of the trip the card describes.
function realJourneys(journeys) {
  const list = Array.isArray(journeys) ? journeys : [];
  const real = list.filter(
    (j) => Array.isArray(j?.segments) && j.segments.some((s) => !s?.not_for_travel)
  );
  return real.length > 0 ? real : list;
}

// The legs the traveler actually boards. Ghost legs buried inside an
// otherwise real journey are dropped here; whole ghost journeys are
// dropped by realJourneys above.
function flownSegments(j) {
  const segs = Array.isArray(j?.segments) ? j.segments : [];
  const flown = segs.filter((s) => !s?.not_for_travel);
  return flown.length > 0 ? flown : segs;
}

// One journey as the title names it: where it leaves from, where it
// lands, the day it departs. Flown legs only, so an ELR tail or a fake
// return can never name a direction the traveler does not take.
function journeyLeg(j) {
  const segs = flownSegments(j);
  if (segs.length === 0) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const from = first?.origin_city || first?.origin;
  const to = last?.destination_city || last?.destination;
  if (!from || !to) return null;
  const date = formatDate(first?.depart_local);
  return date ? `${from} to ${to}, ${date}` : `${from} to ${to}`;
}

// Beyond three directions the title would be truncated by the chat
// app, so the rest are counted instead of named.
const TITLE_LEGS = 3;

function sessionMeta(data, cardUrl) {
  const journeys = realJourneys(data?.journeys);
  if (journeys.length === 0) return null;

  const legs = journeys.map(journeyLeg).filter(Boolean);
  if (legs.length === 0) return null;

  const shown = legs.slice(0, TITLE_LEGS);
  const extra = legs.length - shown.length;
  const more = extra === 0 ? "" : extra === 1 ? " / + 1 more flight" : ` / + ${extra} more flights`;
  // Exchange (flight change) sessions are priced as a change, not a
  // ticket: the pay project marks them with an `exchange` block. The
  // figure is still the per-traveler ticket amount (the change total).
  const isExchange = Boolean(data?.exchange);
  const title = `${isExchange ? "Flight Change" : "Flight Quote"}: ${shown.join(" / ")}${more}`;

  // Always the ticket alone, per traveler: no service fee, no Travel
  // Care, no tip. api/card.mjs draws the same figure on the image.
  const price = perPaxTicket(data);
  const evenExchange = isExchange && Number(data?.quote?.ticket) === 0;

  return {
    siteName: "Business Airfare",
    title,
    description: evenExchange
      ? "No charge for this flight change."
      : price
        ? isExchange
          ? `Change price ${price} per traveler.`
          : `Priced at ${price} per traveler.`
        : "Click here to review full flight details.",
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

  // from_price_per_pax is the ticket alone per traveler; the same basis
  // the single-booking card quotes.
  const fromCents = options
    .map((o) => Number(o?.from_price_per_pax))
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

async function buildMeta(query, host) {
  const publicId = query.get("public_id");
  const previewId = query.get("preview");

  if (publicId) {
    const { data, gone } = await fetchJson(
      `/get_public_session?public_id=${encodeURIComponent(publicId)}`
    );
    if (gone) return { meta: GENERIC_META, gone: true };
    const meta = sessionMeta(
      data,
      `${PAGE_URL}?public_id=${encodeURIComponent(publicId)}`
    );
    if (meta) {
      // Card image served by api/card.mjs on the same deployment. Only
      // valid sessions get one; unknown ids stay text-only.
      meta.image = `https://${host}/api/card?public_id=${encodeURIComponent(publicId)}`;
    }
    return { meta: meta ?? GENERIC_META, gone: false };
  }
  if (previewId) {
    const { data, gone } = await fetchJson(
      `/get_public_preview?public_id=${encodeURIComponent(previewId)}`
    );
    if (gone) return { meta: GENERIC_META, gone: true };
    return {
      meta:
        previewMeta(data, `${PAGE_URL}?preview=${encodeURIComponent(previewId)}`) ??
        GENERIC_META,
      gone: false,
    };
  }
  return { meta: GENERIC_META, gone: false };
}

/*
 * Served instead of the app when the link is definitely dead, so a killed or
 * unknown link never loads the payment bundle at all.
 *
 * The app would otherwise paint its "Loading your trip" animation - a flight
 * arc, a plane - for the moment it takes to discover the session is gone, which
 * tells whoever is holding a killed link that there is a real booking page
 * behind it. Nothing here is branded, and there is no script.
 *
 * Wording matches the app's own unavailable screen exactly, so the two are
 * indistinguishable whichever path a visitor arrives by.
 */
const GONE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="robots" content="noindex" />
    <title>Not available</title>
    <style>
      html,body{margin:0;height:100%;background:#fff}
      body{display:flex;align-items:center;justify-content:center;padding:0 24px;
        font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        color:#414b57}
      p{max-width:420px;text-align:center;margin:0}
    </style>
  </head>
  <body>
    <p>This link has expired or is no longer valid.</p>
  </body>
</html>
`;

export default async function handler(req, res) {
  let html = TEMPLATE;

  try {
    let meta = GENERIC_META;
    try {
      const query = new URL(req.url ?? "/", "http://local").searchParams;
      const host =
        req.headers?.["x-forwarded-host"] ??
        req.headers?.host ??
        "booking.business-airfare.com";
      const built = (await buildMeta(query, host)) ?? { meta: GENERIC_META, gone: false };
      if (built.gone) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/html; charset=utf-8");
        // Never cached: an agent can kill a link at any moment, and a link
        // can equally be replaced, so this answer must not outlive the check.
        res.setHeader("cache-control", "no-store");
        res.end(GONE_HTML);
        return;
      }
      meta = built.meta;
      if (meta.image) {
        // Pre-warm the card image: crawlers always fetch the page first,
        // and their image fetch follows within seconds. Rendering starts
        // now so the image answers fast enough for the large preview
        // layout. waitUntil keeps the work alive past our response.
        try {
          waitUntil(fetch(meta.image).then((r) => r.arrayBuffer()).catch(() => {}));
        } catch {
          // pre-warm is best effort only
        }
      }
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
  // Browsers always revalidate; the CDN may serve the same per-URL HTML
  // for a few minutes so crawler fetches (Meta's server-side preview
  // path is latency-sensitive) get an instant first byte. The shell only
  // changes on deploy, which purges the CDN anyway; the injected tags
  // going up to 5 minutes stale is harmless.
  res.setHeader(
    "cache-control",
    "public, max-age=0, s-maxage=300, stale-while-revalidate=86400"
  );
  res.end(html);
}
