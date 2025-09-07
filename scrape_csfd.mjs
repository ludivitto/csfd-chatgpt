// CSFD → CSV (GitHub Actions + Playwright, robustní verze)
import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/";
const MAX_PAGES = 2000;
const DELAY_MS = 350;
const OUT_DIR = "data";
const OUT_FILE = `${OUT_DIR}/csfd_ratings.csv`;
const DEBUG_DIR = "debug";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageUrl = (n) => (n === 1 ? BASE : `${BASE}?page=${n}`);
const abs = (u) => new URL(u, BASE).href;

function toCsv(rows) {
  const header = ["title","year","type","rating","ratingDate","url"];
  const esc = (v="") => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
  return [header.join(","), ...rows.map(o => header.map(h => esc(o[h])).join(","))].join("\n");
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

async function parsePage(page, url, tag) {
  // méně přísné čekání: DOMContentLoaded (ne networkidle)
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(()=>{});
  await acceptCookies(page);

  // explicitně počkej na tabulku, ale neshazuj běh kvůli timeoutu
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

  if (!items.length) {
    // udělej dump, ať víme, co se načetlo (pomůže při anti-botu)
    await pageDump(page, tag || "noparse");
  }

  for (const it of items) it.url = abs(it.url);
  return items;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    // drobné „stealth-ish“ flagy a sandbox fix pro GHA
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

    // jednoduchý retry (2x) – občas síť/blokace
    let items = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      items = await parsePage(page, url, `p${p}_a${attempt}`);
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
        all.push(it);
        added++;
      }
    }
    console.log(`→ přidáno: ${added}, celkem: ${all.length}`);
    if (added === 0) break;

    await sleep(DELAY_MS);
  }

  await browser.close();

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