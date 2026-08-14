// Serves the payment page HTML with social preview (Open Graph) tags
// injected into the <head>. Humans and crawlers receive the same HTML;
// the React app, assets and payment flow are untouched.
//
// Safety rule: any failure here must degrade to serving the unmodified
// index.html content, never to a broken payment page.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_URL = "https://booking.business-airfare.com/";

const GENERIC_META = {
  siteName: "Business Airfare",
  title: "Secure payment | Business Airfare",
  description: "Review your flights and book securely with Business Airfare.",
  url: PAGE_URL,
};

// index.html is bundled with the function via vercel.json includeFiles.
// Try the standard locations; keep whichever works.
function loadTemplate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "index.html"),
    join(here, "..", "index.html"),
    join(here, "index.html"),
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

export default function handler(req, res) {
  let html = TEMPLATE;

  try {
    if (html) {
      html = html.replace("</head>", `${metaTagBlock(GENERIC_META)}\n  </head>`);
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
