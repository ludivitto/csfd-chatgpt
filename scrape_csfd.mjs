// CSFD → CSV + JSON (GitHub Actions + Playwright)
// Scraper that collects ratings from CSFD, enriches with IMDb links and original titles.

import { chromium } from "playwright";
import fs from "node:fs/promises";

/** ────────────────────────────────
 *  CONFIG
 *  ──────────────────────────────── */
const BASE = "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/";
const MAX_PAGES = 2000;

const PAGINATION_DELAY_MS = 350;     // pause between paginated list requests
const DETAIL_CONCURRENCY = 4;        // number of concurrent detail fetchers
const DETAIL_DELAY_MS = 250;         // short pause between detail requests

const OUT_DIR = "data";
const OUT_CSV = `${OUT_DIR}/csfd_ratings.csv`;
const OUT_JSON = `${OUT_DIR}/csfd_ratings.json`;

const DEBUG_DIR = "debug";

/** ────────────────────────────────
 *  HELPERS
 *  ──────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageUrl = (n) => (n === 1 ? BASE : `${BASE}?page=${n}`);
const abs = (u) => new URL(u, BASE).href;

/** Convert array of objects to CSV string */
function toCsv(rows) {
  const header = [
    "title",
    "year",
    "type",
    "rating",
    "ratingDate",
    "url",
    "imdb_id",
    "imdb_url",
    "original_title",
  ];
  const esc = (v = "") =>
    /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [
    header.join(","),
    ...rows.map((o) => header.map((h) => esc(o[h] ?? "")).join(",")),
  ].join("\n");
}

/** Save page content/screenshot for debugging */
async function pageDump(page, tag) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await page
      .screenshot({ path: `${DEBUG_DIR}/screenshot_${tag}.png`, fullPage: true })
      .catch(() => {});
    const html = (await page.content().catch(() => "")) || "<no content>";
    await fs
      .writeFile(`${DEBUG_DIR}/page_${tag}.html`, html, "utf8")
      .catch(() => {});
  } catch {}
}

/** Cookie consent (Didomi) if present */
async function acceptCookies(page) {
  try {
    const btnSel =
      'button[id^="didomi-notice-agree-button"], #didomi-notice-agree-button';
    const iframeSel = 'iframe[src*="didomi"]';

    const btn = await page.$(btnSel);
    if (btn) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      return;
    }
    const ifr = await page.$(iframeSel);
    if (ifr) {
      const frame = await ifr.contentFrame();
      const fbtn = await frame.$(btnSel);
      if (fbtn) await fbtn.click({ timeout: 2000 }).catch(() => {});
    }
  } catch {}
}

/** Parse a single ratings page (list of titles) */
async function parseListPage(page, url, tag) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
  await acceptCookies(page);
  await page.waitForSelector('#snippet--ratings table.striped tbody tr', {
    timeout: 20_000,
  }).catch(() => {});

  const items = await page
    .$$eval('#snippet--ratings table.striped tbody tr', (trs) => {
      const out = [];
      for (const tr of trs) {
        const link = tr.querySelector(".name .film-title-name");
        if (!link) continue;

        const url = link.getAttribute("href") || "";
        const title = (link.textContent || "").trim().replace(/\s+/g, " ");

        const infoParts = Array.from(
          tr.querySelectorAll(".film-title-info .info")
        ).map((s) => (s.textContent || "").trim());
        const infoText = infoParts.join(" ");

        // Year
        let year = "";
        const ym = infoText.match(/\b(19\d{2}|20\d{2})\b/);
        if (ym) year = ym[1];

        // Type (normalize to English to keep data language-agnostic)
        let type = "film";
        const low = infoText.toLowerCase();
        if (low.includes("seriál")) type = "series";
        if (low.includes("epizoda")) type = "episode";
        if (low.includes("série")) type = "season";

        // Star rating (0–5) from class name like "stars stars-4"
        let rating = "";
        const cls = (tr.querySelector(".star-rating .stars")?.className || "");
        const rm = cls.match(/stars-(\d)/);
        if (rm) rating = rm[1];

        // Rating date (dd.mm.yyyy)
        const ratingDate = (tr.querySelector(".date-only")?.textContent || "")
          .trim();

        out.push({ title, year, type, rating, ratingDate, url });
      }
      return out;
    })
    .catch(() => []);

  if (!items.length) await pageDump(page, tag || "noparse");

  for (const it of items) it.url = abs(it.url);
  return items;
}

/** Extract IMDb (robust: several selectors + HTML regex fallback) */
async function extractImdbOnPage(page) {
  try {
    // 1) Obvious selectors
    const selectors = [
      'a[href*="imdb.com/title/tt"]',
      'a[href*="imdb.com/title/"]',
      'a[href*="://www.imdb.com/title/"]',
      'a.imdb',
      '.imdb a',
      'a[href*="imdb"]',
    ];
    for (const sel of selectors) {
      const a = await page.$(sel);
      if (a) {
        const href = await a.getAttribute("href");
        if (href) {
          const full = href.startsWith("http")
            ? href
            : new URL(href, page.url()).href;
          const m = full.match(/(tt\d+)/i);
          if (m)
            return {
              imdb_id: m[1],
              imdb_url: `https://www.imdb.com/title/${m[1]}/`,
            };
        }
      }
    }

    // 2) Search whole HTML for imdb link
    const html = await page.content();
    const m = html.match(
      /https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)/i
    );
    if (m) {
      return {
        imdb_id: m[1],
        imdb_url: `https://www.imdb.com/title/${m[1]}/`,
      };
    }

    // 3) Last resort: find ttXXXXXX and construct URL
    const m2 = html.match(/\b(tt\d{6,})\b/i);
    if (m2) {
      return {
        imdb_id: m2[1],
        imdb_url: `https://www.imdb.com/title/${m2[1]}/`,
      };
    }
  } catch {}
  return { imdb_id: "", imdb_url: "" };
}

/** Extract original title (multiple selectors + JSON-LD + text fallback) */
async function extractOriginalTitleOnPage(page) {
  try {
    const selectors = [
      ".film-header-name .original",
      ".film-header-name .original-name",
      ".names .original",
      "span.original, span.original-name",
      "h1 small",
      '[data-testid="original-title"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        const t = (await el.textContent())?.trim();
        if (t) return t.replace(/\s+/g, " ");
      }
    }

    // JSON-LD fallback
    const ldNodes = await page.$$eval(
      'script[type="application/ld+json"]',
      (ns) => ns.map((n) => n.textContent || "").filter(Boolean)
    );
    for (const raw of ldNodes) {
      try {
        const j = JSON.parse(raw);
        const cand =
          j.alternateName ||
          j.originalTitle ||
          (Array.isArray(j.name) ? j.name[1] : null);
        if (typeof cand === "string" && cand.trim()) {
          return cand.trim().replace(/\s+/g, " ");
        }
      } catch {}
    }

    // Text fallback: lines containing "Originální název:"
    const maybe = await page.$$eval("body *", (nodes) => {
      const out = [];
      for (const n of nodes) {
        const txt = (n.textContent || "").trim();
        if (!txt) continue;
        if (/Originální\s*n[áa]zev/i.test(txt)) out.push(txt);
      }
      return out;
    });
    if (maybe.length) {
      const m = maybe[0].match(/Originální\s*n[áa]zev[:\s]*(.+)/i);
      if (m) return m[1].trim().replace(/\s+/g, " ");
    }
  } catch {}
  return "";
}

/** For episodes/seasons/series: fall back to parent title page */
function parentTitleUrl(csfdUrl) {
  try {
    const u = new URL(csfdUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const ix = parts.findIndex((p) => p === "film");
    if (ix >= 0 && parts.length > ix + 2) {
      const parent = `/${parts.slice(0, ix + 2).join("/")}/`;
      return `${u.origin}${parent}`;
    }
  } catch {}
  return "";
}

/** Visit detail pages to enrich items with IMDb + original title */
async function enrichWithDetails(context, items) {
  let idx = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const it = items[i];

      try {
        const page = await context.newPage();

        // Go to detail + cookie + small settle time
        await page
          .goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 })
          .catch(() => {});
        await acceptCookies(page);
        await page.waitForTimeout(400);

        // First attempt
        let { imdb_id, imdb_url } = await extractImdbOnPage(page);
        let original_title = await extractOriginalTitleOnPage(page);

        // Quick retry if both are empty (page might still be settling)
        if (!imdb_id && !original_title) {
          await page.waitForTimeout(800);
          const again = await extractImdbOnPage(page);
          imdb_id = imdb_id || again.imdb_id;
          imdb_url = imdb_url || again.imdb_url;
          if (!original_title)
            original_title = await extractOriginalTitleOnPage(page);
        }

        // For episodes/seasons/series, try parent page as a fallback
        if (
          (!imdb_id || !original_title) &&
          (it.type === "episode" || it.type === "season" || it.type === "series")
        ) {
          const parentUrl = parentTitleUrl(it.url);
          if (parentUrl) {
            await page
              .goto(parentUrl, {
                waitUntil: "domcontentloaded",
                timeout: 60_000,
              })
              .catch(() => {});
            await page.waitForTimeout(400);

            if (!imdb_id) {
              const r = await extractImdbOnPage(page);
              imdb_id = imdb_id || r.imdb_id;
              imdb_url = imdb_url || r.imdb_url;
            }
            if (!original_title) {
              original_title = await extractOriginalTitleOnPage(page);
            }
          }
        }

        it.imdb_id = imdb_id || "";
        it.imdb_url = imdb_url || "";
        it.original_title = original_title || "";

        await page.close();
      } catch {
        it.imdb_id = it.imdb_id || "";
        it.imdb_url = it.imdb_url || "";
        it.original_title = it.original_title || "";
      }

      done++;
      if (done % 50 === 0)
        console.log(`[details] processed ${done}/${items.length}`);
      await sleep(DETAIL_DELAY_MS);
    }
  }

  const workers = Array.from({ length: DETAIL_CONCURRENCY }, () => worker());
  await Promise.all(workers);
}

/** ────────────────────────────────
 *  MAIN
 *  ──────────────────────────────── */
async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125 Safari/537.36",
    locale: "cs-CZ",
  });

  const page = await context.newPage();

  // 1) Crawl paginated rating pages
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = pageUrl(p);
    console.log("Page:", url);

    // small retry loop for the list page
    let items = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      items = await parseListPage(page, url, `p${p}_a${attempt}`);
      if (items.length) break;
      await sleep(1200);
    }

    if (!items.length) {
      console.log("→ no items on page (see debug/ if needed). Stopping.");
      break;
    }

    let added = 0;
    for (const it of items) {
      const k = `${it.url}::${it.title}`;
      if (!seen.has(k)) {
        seen.add(k);
        // placeholders for enrichment
        it.imdb_id = "";
        it.imdb_url = "";
        it.original_title = "";
        all.push(it);
        added++;
      }
    }
    console.log(`→ added: ${added}, total: ${all.length}`);
    if (added === 0) break;

    await sleep(PAGINATION_DELAY_MS);
  }

  // 2) Enrich with IMDb and original title
  console.log("[details] enrichment…");
  await enrichWithDetails(context, all);
  console.log("[details] done.");

  await browser.close();

  // 3) Save CSV + JSON
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_CSV, toCsv(all), "utf8");
  await fs.writeFile(OUT_JSON, JSON.stringify(all, null, 2), "utf8");

  // 4) Small summary in logs
  const withImdb = all.filter((x) => x.imdb_id).length;
  const withOrig = all.filter((x) => x.original_title).length;
  console.log(`[summary] IMDb IDs: ${withImdb}/${all.length}, original titles: ${withOrig}/${all.length}`);
  console.log(`OK: ${all.length} rows → ${OUT_CSV} & ${OUT_JSON}`);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(`${DEBUG_DIR}/error.txt`, String(e.stack || e), "utf8");
  } catch {}
  process.exit(1);
});