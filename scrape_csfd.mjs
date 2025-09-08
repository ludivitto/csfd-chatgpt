// CSFD → CSV + JSON (GitHub Actions + Playwright)
// Scraper that collects ratings from CSFD, enriches with IMDb links and original titles.

import { chromium } from "playwright";
import fs from "node:fs/promises";

// Parse CLI flags - EXTENDED
const argv = process.argv.slice(2);

const maxPagesFlag = (() => {
  const idx = argv.indexOf("--maxPages");
  if (idx >= 0 && argv[idx + 1]) return Math.max(1, Number(argv[idx + 1]) || 1);
  return null;
})();

// NEW testing flags
const maxItemsFlag = (() => {
  const idx = argv.indexOf("--maxItems");
  if (idx >= 0 && argv[idx + 1]) return Math.max(1, Number(argv[idx + 1]) || 1);
  return null;
})();

const testModeFlag = argv.includes("--test");
const skipDetailsFlag = argv.includes("--skipDetails");
const headlessFlag = !argv.includes("--headful");
const verboseFlag = argv.includes("--verbose");
const resumeFlag = argv.includes("--resume");
const cacheFlag = !argv.includes("--no-cache");


/** ────────────────────────────────
 *  CONFIG - DYNAMIC BASED ON TESTS
 *  ──────────────────────────────── */
const BASE = "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/";
const MAX_PAGES = maxPagesFlag || (testModeFlag ? 1 : 2000);
const MAX_ITEMS = maxItemsFlag || (testModeFlag ? 5 : null);

// Faster settings for tests
const PAGINATION_DELAY_MS = testModeFlag ? 100 : 350;
const DETAIL_CONCURRENCY = testModeFlag ? 2 : 4;
const DETAIL_DELAY_MS = testModeFlag ? 50 : 250;
const BATCH_SIZE = testModeFlag ? 10 : 100;

const OUT_DIR = "data";
const timestamp = testModeFlag ? `_test_${Date.now()}` : "";
const OUT_CSV = `${OUT_DIR}/csfd_ratings${timestamp}.csv`;
const OUT_JSON = `${OUT_DIR}/csfd_ratings${timestamp}.json`;
const CACHE_FILE = `${OUT_DIR}/scraper_cache.json`;
const STATE_FILE = `${OUT_DIR}/scraper_state.json`;

const DEBUG_DIR = "debug";

/** ────────────────────────────────
 *  HELPERS - OPTIMIZED
 *  ──────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageUrl = (n) => (n === 1 ? BASE : `${BASE}?page=${n}`);
const abs = (u) => new URL(u, BASE).href;

// Cache management
let cache = new Map();
async function loadCache() {
  if (!cacheFlag) return;
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(data);
    cache = new Map(Object.entries(parsed));
    if (verboseFlag) console.log(`[cache] loaded ${cache.size} entries`);
  } catch {
    if (verboseFlag) console.log('[cache] no existing cache found');
  }
}

async function saveCache() {
  if (!cacheFlag) return;
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const obj = Object.fromEntries(cache);
    await fs.writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8');
    if (verboseFlag) console.log(`[cache] saved ${cache.size} entries`);
  } catch (e) {
    console.warn('[cache] failed to save:', e.message);
  }
}

// State management for resume
async function loadState() {
  if (!resumeFlag) return null;
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    console.log(`[resume] continuing from page ${state.lastPage}, ${state.items.length} items`);
    return state;
  } catch {
    console.log('[resume] no previous state found, starting fresh');
    return null;
  }
}

async function saveState(page, items) {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const state = { lastPage: page, items, timestamp: Date.now() };
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[state] failed to save:', e.message);
  }
}

// Retry with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelay = 1000, context = '') {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) {
        if (verboseFlag) console.error(`[retry] ${context} failed after ${maxRetries} attempts:`, e.message);
        throw e;
      }
      const delay = baseDelay * Math.pow(2, i);
      if (verboseFlag) console.warn(`[retry] ${context} attempt ${i + 1} failed, retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}



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

/** Cookie consent (Didomi) if present - WITH CACHE */
let cookiesAccepted = false;
async function acceptCookies(page) {
  if (cookiesAccepted) return; // cache for performance
  
  try {
    const btnSel =
      'button[id^="didomi-notice-agree-button"], #didomi-notice-agree-button';
    const iframeSel = 'iframe[src*="didomi"]';

    const btn = await page.$(btnSel);
    if (btn) {
      await btn.click({ timeout: 2000 }).catch(() => {});
      cookiesAccepted = true;
      if (verboseFlag) console.log('[cookies] accepted via direct button');
      return;
    }
    const ifr = await page.$(iframeSel);
    if (ifr) {
      const frame = await ifr.contentFrame();
      const fbtn = await frame.$(btnSel);
      if (fbtn) {
        await fbtn.click({ timeout: 2000 }).catch(() => {});
        cookiesAccepted = true;
        if (verboseFlag) console.log('[cookies] accepted via iframe');
      }
    }
  } catch (e) {
    if (verboseFlag) console.warn('[cookies] error:', e.message);
  }
}

/** Parse a single ratings page (list of titles) - OPTIMIZED */
async function parseListPage(page, url, tag) {
  return withRetry(async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await acceptCookies(page);
    
    // Wait for content with timeout
    try {
      await page.waitForSelector('#snippet--ratings table.striped tbody tr', {
        timeout: 20_000,
      });
    } catch (e) {
      if (verboseFlag) console.warn(`[parse] no content selector found on ${url}`);
      await pageDump(page, tag || "noparse");
      return [];
    }

    const items = await page.$$eval('#snippet--ratings table.striped tbody tr', (trs) => {
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
    });

    if (!items.length && verboseFlag) {
      console.warn(`[parse] no items found on ${url}`);
      await pageDump(page, tag || "noparse");
    }

    for (const it of items) it.url = abs(it.url);
    return items;
  }, 2, 1500, `parsing ${url}`);
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

    // Text fallback: lines containing "Originální název:" (original title)
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

/** Visit detail pages to enrich items with IMDb + original title - OPTIMIZED */
async function enrichWithDetails(context, items) {
  if (items.length === 0) return;
  
  let idx = 0;
  let done = 0;
  const total = items.length;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const it = items[i];

      // Check cache first
      const cacheKey = `${it.url}::details`;
      if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        it.imdb_id = cached.imdb_id || "";
        it.imdb_url = cached.imdb_url || "";
        it.original_title = cached.original_title || "";
        done++;
        if (verboseFlag && done % 10 === 0) {
          console.log(`[details] cached ${done}/${total}`);
        }
        continue;
      }

      try {
        const page = await context.newPage();

        await withRetry(async () => {
          // Go to detail + cookie + small settle time
          await page.goto(it.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
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
              await page.goto(parentUrl, {
                waitUntil: "domcontentloaded",
                timeout: 60_000,
              });
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

          // Save to cache
          cache.set(cacheKey, {
            imdb_id: it.imdb_id,
            imdb_url: it.imdb_url,
            original_title: it.original_title
          });

        }, 2, 1000, `enriching ${it.url}`);

        await page.close();
      } catch (e) {
        if (verboseFlag) console.warn(`[details] failed for ${it.url}:`, e.message);
        it.imdb_id = it.imdb_id || "";
        it.imdb_url = it.imdb_url || "";
        it.original_title = it.original_title || "";
      }

      done++;
      if (done % 25 === 0) {
        console.log(`[details] processed ${done}/${total}`);
        await saveCache(); // Periodic cache save
      }
      await sleep(DETAIL_DELAY_MS);
    }
  }

  const workers = Array.from({ length: DETAIL_CONCURRENCY }, () => worker());
  await Promise.all(workers);
  await saveCache(); // Final cache save
}

/** ────────────────────────────────
 *  MAIN - OPTIMIZED
 *  ──────────────────────────────── */
async function main() {
  // Print usage info
  if (argv.includes('--help')) {
    console.log(`
CSFD Scraper - Usage:
  node scrape_csfd.mjs [options]

Options:
  --test              Quick test mode (1 page, 5 items, faster delays)
  --maxPages N        Limit to N pages (default: 2000, test: 1)
  --maxItems N        Stop after N items total
  --skipDetails       Skip IMDb/original title enrichment
  --headful           Show browser (for debugging)
  --verbose           Detailed logging
  --resume            Resume from previous state
  --no-cache          Disable caching
  --help              Show this help

Examples:
  node scrape_csfd.mjs --test --skipDetails    # Ultra fast test (~5s)
  node scrape_csfd.mjs --maxItems 10           # Test with 10 items (~30s)
  node scrape_csfd.mjs --maxPages 5            # First 5 pages (~10min)
  node scrape_csfd.mjs --resume --verbose      # Resume previous run
`);
    return;
  }

  console.log(`[config] MAX_PAGES=${MAX_PAGES}, MAX_ITEMS=${MAX_ITEMS || 'unlimited'}, headless=${headlessFlag}`);
  if (testModeFlag) console.log('[config] TEST MODE enabled - faster delays');
  if (skipDetailsFlag) console.log('[config] skipping detail enrichment');
  
  await loadCache();
  
  const browser = await chromium.launch({
    headless: headlessFlag,
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

  // 1) Load previous state if resuming
  let all = [];
  let startPage = 1;
  const previousState = await loadState();
  if (previousState) {
    all = previousState.items;
    startPage = previousState.lastPage + 1;
    console.log(`[resume] starting from page ${startPage} with ${all.length} existing items`);
  }

  // 2) Crawl paginated rating pages
  const seen = new Set(all.map(it => `${it.url}::${it.title}`));

  for (let p = startPage; p <= MAX_PAGES; p++) {
    const url = pageUrl(p);
    console.log(`[page] ${p}/${MAX_PAGES}: ${url}`);

    let items = [];
    try {
      items = await parseListPage(page, url, `p${p}`);
    } catch (e) {
      console.error(`[page] failed to parse page ${p}:`, e.message);
      continue;
    }

    if (!items.length) {
      console.log("→ no items on page. Stopping.");
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
        
        // Check item limit
        if (MAX_ITEMS && all.length >= MAX_ITEMS) {
          console.log(`→ reached max items limit (${MAX_ITEMS}), stopping`);
          break;
        }
      }
    }
    
    console.log(`→ added: ${added}, total: ${all.length}`);
    if (added === 0 || (MAX_ITEMS && all.length >= MAX_ITEMS)) break;

    // Save state periodically
    if (p % 5 === 0) {
      await saveState(p, all);
    }

    await sleep(PAGINATION_DELAY_MS);
  }

  // 3) Enrich with IMDb and original title
  if (!skipDetailsFlag && all.length > 0) {
    console.log(`[details] enriching ${all.length} items...`);
    await enrichWithDetails(context, all);
    console.log("[details] done.");
  } else if (skipDetailsFlag) {
    console.log("[details] skipped (--skipDetails flag)");
  }

  await browser.close();

  // 4) Save CSV + JSON
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_CSV, toCsv(all), "utf8");
  await fs.writeFile(OUT_JSON, JSON.stringify(all, null, 2), "utf8");

  // 5) Clean up state file on successful completion
  if (!testModeFlag) {
    try {
      await fs.unlink(STATE_FILE);
    } catch {}
  }

  // 6) Summary
  const withImdb = all.filter((x) => x.imdb_id).length;
  const withOrig = all.filter((x) => x.original_title).length;
  console.log(`[summary] IMDb IDs: ${withImdb}/${all.length}, original titles: ${withOrig}/${all.length}`);
  console.log(`[summary] cache entries: ${cache.size}`);
  console.log(`✓ ${all.length} rows → ${OUT_CSV} & ${OUT_JSON}`);
}

main().catch(async (e) => {
  console.error("💥 FATAL:", e.message);
  if (verboseFlag) console.error(e.stack);
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    await fs.writeFile(`${DEBUG_DIR}/error.txt`, String(e.stack || e), "utf8");
  } catch {}
  process.exit(1);
});