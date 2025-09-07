// CSFD → CSV (GitHub Actions + Playwright)
import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/";
const MAX_PAGES = 2000;
const DELAY_MS = 350;
const OUT_DIR = "data";
const OUT_FILE = `${OUT_DIR}/csfd_ratings.csv`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pageUrl = (n) => (n === 1 ? BASE : `${BASE}?page=${n}`);
const abs = (u) => new URL(u, BASE).href;

function toCsv(rows) {
  const header = ["title","year","type","rating","ratingDate","url"];
  const esc = (v="") => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v);
  return [header.join(","), ...rows.map(o => header.map(h => esc(o[h])).join(","))].join("\n");
}

async function parsePage(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForSelector('#snippet--ratings table.striped tbody tr', { timeout: 20000 });

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
  });

  for (const it of items) it.url = abs(it.url);
  return items;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125 Safari/537.36",
    locale: "cs-CZ",
  });

  const all = [];
  const seen = new Set();

  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = pageUrl(p);
    console.log("Page:", url);

    const items = await parsePage(page, url);
    if (!items.length) {
      console.log("→ prázdná stránka, končím.");
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

main().catch(e => { console.error(e); process.exit(1); });