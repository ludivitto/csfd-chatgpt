// CSFD → CSV (GitHub Actions + Playwright, s IMDb enrichmentem)
import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/";
const MAX_PAGES = 2000;
const DELAY_MS = 350;         // pauza mezi stránkovými requesty
const OUT_DIR = "data";
const OUT_FILE = `${OUT_DIR}/csfd_ratings.csv`;
const DEBUG_DIR = "debug";

const DETAIL_CONCURRENCY = 4; // souběžné prohlížení detailů
const DETAIL_DELAY_MS = 250;  // krátká pauza mezi detaily

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageUrl = (n) => (n === 1 ? BASE : `${BASE}?page=${n}`);
const abs = (u) => new URL(u, BASE).href;

function toCsv(rows) {
  const header = ["title","year","type","rating","ratingDate","url","imdb_id","imdb_url"];
  const esc = (v="") => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
  return [header.join(","), ...rows.map(o => header.map(h => esc(o[h] ?? "")).join(","))].join("\n");
}

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

async function pageDump(page, tag) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: `${DEBUG_DIR}/screenshot_${tag}.png`, fullPage: true }).catch(()=>{});
    const html = await page.content().catch(()=>"<no content>");
    await fs.writeFile(`${DEBUG_DIR}/page_${tag}.html`, html, "utf8").catch(()=>{});
  } catch {}
}

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
      if (low.includes("seriál")) type = "seriál";
      if (low.includes("epizoda")) type = "epizoda";
      if (low.includes("série"))  type = "série";

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

// Pomocná: zkus najít IMDb link na aktuální stránce
async function extractImdbOnPage(page) {
  try {
    // první odkaz s imdb.com/title/tt…
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

// Fallback: u epizod vezmi rodiče (o jeden segment výš)
function parentTitleUrl(csfdUrl) {
  try {
    const u = new URL(csfdUrl);
    // typické: /film/1557488-serial/1557492-epizoda/  →  /film/1557488-serial/
    const parts = u.pathname.split("/").filter(Boolean);
    // najít „/film/<id-name>/…“
    const ix = parts.findIndex(p => p === "film");
    if (ix >= 0 && parts.length > ix + 2) {
      const parent = `/${parts.slice(0, ix + 2).join("/")}/`;
      return `${u.origin}${parent}`;
    }
  } catch {}
  return "";
}

async function enrichWithImdb(context, items) {
  // fronta s omezenou souběžností
  let idx = 0;
  let done = 0;

  async function worker(workerId) {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const it = items[i];

      try {
        const page = await context.newPage();
        await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(()=>{});
        await acceptCookies(page);

        // primární pokus
        let { imdb_id, imdb_url } = await extractImdbOnPage(page);

        // fallback pro epizodu/sérii: zkus rodičovský titul
        if (!imdb_id && (it.type === "epizoda" || it.type === "série" || it.type === "seriál")) {
          const parentUrl = parentTitleUrl(it.url);
          if (parentUrl) {
            await page.goto(parentUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(()=>{});
            const res2 = await extractImdbOnPage(page);
            imdb_id = res2.imdb_id;
            imdb_url = res2.imdb_url;
          }
        }

        it.imdb_id = imdb_id || "";
        it.imdb_url = imdb_url || "";

        await page.close();
      } catch (e) {
        // neházej, jen zaznamenej prázdné
        it.imdb_id = it.imdb_id || "";
        it.imdb_url = it.imdb_url || "";
      }

      done++;
      if (done % 50 === 0) console.log(`[IMDb] processed ${done}/${items.length}`);
      await sleep(DETAIL_DELAY_MS);
    }
  }

  const workers = Array.from({ length: DETAIL_CONCURRENCY }, (_, k) => worker(k));
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

  // 1) seber položky ze všech stránky
  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = pageUrl(p);
    console.log("Page:", url);

    // jednoduchý retry
    let items = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      items = await parseListPage(page, url, `p${p}_a${attempt}`);
      if (items.length) break;
      await sleep(1200);
    }

    if (!items.length) {
      console.log("→ stránka bez položek (viz debug/), končím.");
      break;
    }

    let added = 0;
    for (const it of items) {
      const k = `${it.url}::${it.title}`;
      if (!seen.has(k)) {
        seen.add(k);
        // vyplň default IMDb sloupce
        it.imdb_id = "";
        it.imdb_url = "";
        all.push(it);
        added++;
      }
    }
    console.log(`→ přidáno: ${added}, celkem: ${all.length}`);
    if (added === 0) break;

    await sleep(DELAY_MS);
  }

  // 2) IMDb enrichment (detailové stránky)
  console.log("[IMDb] start enrichment…");
  await enrichWithImdb(context, all);
  console.log("[IMDb] done.");

  await browser.close();

  // 3) ulož CSV
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_FILE, toCsv(all), "utf8");
  console.log(`OK: ${all.length} řádků → ${OUT_FILE}`);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try { await fs.mkdir(DEBUG_DIR, { recursive: true }); } catch {}
  try { await fs.writeFile(`${DEBUG_DIR}/error.txt`, String(e.stack || e), "utf8"); } catch {}
  process.exit(1);
});