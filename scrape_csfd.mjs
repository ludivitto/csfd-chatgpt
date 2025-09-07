// CSFD → CSV + JSON (GitHub Actions + Playwright)
// Scraper that collects ratings from CSFD, enriches with IMDb links and original titles.

import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/";
const MAX_PAGES = 2000;
const DELAY_MS = 350;         // delay between paginated requests
const OUT_DIR = "data";
const OUT_CSV = `${OUT_DIR}/csfd_ratings.csv`;
const OUT_JSON = `${OUT_DIR}/csfd_ratings.json`;
const DEBUG_DIR = "debug";

const DETAIL_CONCURRENCY = 4; // number of concurrent detail-page fetches
const DETAIL_DELAY_MS = 250;  // short pause between detail requests

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageUrl = (n) => (n === 1 ? BASE : `${BASE}?page=${n}`);
const abs = (u) => new URL(u, BASE).href;

// Convert objects to CSV string
function toCsv(rows) {
  const header = ["title","year","type","rating","ratingDate","url","imdb_id","imdb_url","original_title"];
  const esc = (v="") => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
  return [header.join(","), ...rows.map(o => header.map(h => esc(o[h] ?? "")).join(","))].join("\n");
}

// Handle cookie banner if shown
async function acceptCookies(page) {
  try {
    const btnSel = 'button[id^="didomi-notice-agree-button"], #didomi-notice-agree-button';
    const iframeSel = 'iframe[src*="didomi"]';
    const btn = await page.$(btnSel);
    if (btn) { await btn.click({ timeout: 2000 }).catch(()=>{}); return; }
    const ifr = await page.$(iframeSel);
    if (ifr) {
      const frame = await ifr.contentFrame();
      const fbtn = await frame.$(btnSel);
      if (fbtn) await fbtn.click({ timeout: 2000 }).catch(()=>{});
    }
  } catch {}
}

// Save page content/screenshot for debugging
async function pageDump(page, tag) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: `${DEBUG_DIR}/screenshot_${tag}.png`, fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=>"<no content>");
    await fs.writeFile(`${DEBUG_DIR}/page_${tag}.html`, html, "utf8").catch(()=>{});
  } catch {}
}

// Parse a single rating page (list of movies/shows)
async function parseListPage(page, url, tag) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(()=>{});
  await acceptCookies(page);
  await page.waitForSelector('#snippet--ratings table.striped tbody tr', { timeout: 20_000 }).catch(()=>{});

  const items = await page.$$eval('#snippet--ratings table.striped tbody tr', (trs) => {
    const rows = [];
    for (const tr of trs) {
      const link = tr.querySelector(".name .film-title-name");
      if (!link) continue;

      const url = link.getAttribute("href") || "";
      const title = (link.textContent || "").trim().replace(/\s+/g, " ");

      const infoParts = Array.from(tr.querySelectorAll(".film-title-info .info"))
        .map(s => (s.textContent || "").trim());
      const infoText = infoParts.join(" ");

      let year = "";
      const ym = infoText.match(/\b(19\d{2}|20\d{2})\b/);
      if (ym) year = ym[1];

      let type = "film";
      const low = infoText.toLowerCase();
      if (low.includes("seriál")) type = "series";
      if (low.includes("epizoda")) type = "episode";
      if (low.includes("série"))  type = "season";

      let rating = "";
      const cls = (tr.querySelector(".star-rating .stars")?.className || "");
      const rm = cls.match(/stars-(\d)/);
      if (rm) rating = rm[1];

      const ratingDate = (tr.querySelector(".date-only")?.textContent || "").trim();

      rows.push({ title, year, type, rating, ratingDate, url });
    }
    return rows;
  }).catch(() => []);

  if (!items.length) await pageDump(page, tag || "noparse");

  for (const it of items) it.url = abs(it.url);
  return items;
}

// === IMDb + original title from detail page ===

// Find IMDb link on detail page
async function extractImdbOnPage(page) {
  try {
    const a = await page.$('a[href*="imdb.com/title/tt"]');
    if (!a) return { imdb_id: "", imdb_url: "" };
    const href = await a.getAttribute("href");
    if (!href) return { imdb_id: "", imdb_url: "" };
    const imdb_url = href.startsWith("http") ? href : new URL(href, page.url()).href;
    const m = imdb_url.match(/(tt\d+)/i);
    return { imdb_id: m ? m[1] : "", imdb_url };
  } catch {
    return { imdb_id: "", imdb_url: "" };
  }
}

// Try to extract original title (different selectors depending on CSFD layout)
async function extractOriginalTitleOnPage(page) {
  try {
    const selectors = [
      '.film-header-name .original',
      '.film-header-name .original-name',
      'span.original',
      'span.original-name',
      '.names .original',
      '.header .original-name',
      '[data-testid="original-title"]',
    ];
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        const t = (await el.textContent() || "").trim();
        if (t) return t.replace(/\s+/g, " ");
      }
    }
    const h1small = await page.$('h1 small');
    if (h1small) {
      const t = (await h1small.textContent() || "").trim();
      if (t) return t.replace(/\s+/g, " ");
    }
    const maybe = await page.$$eval('body *', nodes => {
      const cand = [];
      for (const n of nodes) {
        const txt = (n.textContent || "").trim().toLowerCase();
        if (!txt) continue;
        if (txt.includes("originální název")) cand.push(n.textContent.trim());
      }
      return cand;
    });
    if (maybe && maybe.length) {
      const m = maybe[0].match(/originální\s*n[áa]zev[:\s]*(.+)/i);
      if (m) return m[1].trim().replace(/\s+/g, " ");
    }
  } catch {}
  return "";
}

// For episodes: fall back to parent show URL
function parentTitleUrl(csfdUrl) {
  try {
    const u = new URL(csfdUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const ix = parts.findIndex(p => p === "film");
    if (ix >= 0 && parts.length > ix + 2) {
      const parent = `/${parts.slice(0, ix + 2).join("/")}/`;
      return `${u.origin}${parent}`;
    }
  } catch {}
  return "";
}

// Enrich items with IMDb + original title (visits detail pages)
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
        await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(()=>{});
        await acceptCookies(page);

        let { imdb_id, imdb_url } = await extractImdbOnPage(page);
        let original_title = await extractOriginalTitleOnPage(page);

        if ((!imdb_id || !original_title) && (it.type === "episode" || it.type === "season" || it.type === "series")) {
          const parentUrl = parentTitleUrl(it.url);
          if (parentUrl) {
            await page.goto(parentUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(()=>{});
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
      if (done % 50 === 0) console.log(`[details] processed ${done}/${items.length}`);
      await sleep(DETAIL_DELAY_MS);
    }
  }

  const workers = Array.from({ length: DETAIL_CONCURRENCY }, () => worker());
  await Promise.all(workers);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled"
    ],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125 Safari/537.36",
    locale: "cs-CZ",
  });
  const page = await context.newPage();

  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = pageUrl(p);
    console.log("Page:", url);

    let items = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      items = await parseListPage(page, url, `p${p}_a${attempt}`);
      if (items.length) break;
      await sleep(1200);
    }

    if (!items.length) {
      console.log("→ no items on page, stopping.");
      break;
    }

    let added = 0;
    for (const it of items) {
      const k = `${it.url}::${it.title}`;
      if (!seen.has(k)) {
        seen.add(k);
        it.imdb_id = "";
        it.imdb_url = "";
        it.original_title = "";
        all.push(it);
        added++;
      }
    }
    console.log(`→ added: ${added}, total: ${all.length}`);
    if (added === 0) break;

    await sleep(DELAY_MS);
  }

  console.log("[details] enrichment…");
  await enrichWithDetails(context, all);
  console.log("[details] done.");

  await browser.close();

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_CSV, toCsv(all), "utf8");
  await fs.writeFile(OUT_JSON, JSON.stringify(all, null, 2), "utf8");
  console.log(`OK: ${all.length} rows → ${OUT_CSV} & ${OUT_JSON}`);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await fs.mkdir(DEBUG_DIR, { recursive: true }); } catch {}
  try { await fs.writeFile(`${DEBUG_DIR}/error.txt`, String(e.stack || e), "utf8"); } catch {}
  process.exit(1);
});