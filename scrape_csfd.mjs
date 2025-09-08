// CSFD → CSV + JSON (GitHub Actions + Playwright)
// Scraper that collects ratings from CSFD, enriches with IMDb links and original titles.

import { chromium } from "playwright";
import fs from "node:fs/promises";

/** ────────────────────────────────
 *  CLI UTILITIES
 *  ──────────────────────────────── */
function parseCliFlag(name, defaultValue = null) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1]) {
    const value = Number(argv[idx + 1]);
    return isNaN(value) ? defaultValue : Math.max(1, value);
  }
  return defaultValue;
}

function hasCliFlag(name) {
  return process.argv.includes(`--${name}`);
}

// Parse CLI flags - CLEAN
const maxPagesFlag = parseCliFlag('maxPages');
const maxItemsFlag = parseCliFlag('maxItems');
const testModeFlag = hasCliFlag('test');
const skipDetailsFlag = hasCliFlag('skipDetails');
const headlessFlag = !hasCliFlag('headful');
const verboseFlag = hasCliFlag('verbose');
const resumeFlag = hasCliFlag('resume');
const cacheFlag = !hasCliFlag('no-cache');


/** ────────────────────────────────
 *  CONFIG - STRUCTURED
 *  ──────────────────────────────── */
const config = {
  // Core settings
  BASE_URL: "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/",
  MAX_PAGES: maxPagesFlag || (testModeFlag ? 1 : 2000),
  MAX_ITEMS: maxItemsFlag || (testModeFlag ? 5 : null),
  
  // Performance settings
  delays: {
    pagination: testModeFlag ? 100 : 350,
    detail: testModeFlag ? 50 : 250,
    pageSettle: testModeFlag ? 400 : 2000,
    retry: testModeFlag ? 800 : 1500,
  },
  
  concurrency: {
    details: testModeFlag ? 2 : 4,
    batchSize: testModeFlag ? 10 : 100,
  },
  
  // File paths
  directories: {
    output: "data",
    debug: "debug",
  },
  
  get files() {
    const timestamp = testModeFlag ? `_test_${Date.now()}` : "";
    const dir = this.directories.output;
    return {
      csv: `${dir}/csfd_ratings${timestamp}.csv`,
      json: `${dir}/csfd_ratings${timestamp}.json`,
      cache: `${dir}/scraper_cache.json`,
      state: `${dir}/scraper_state.json`,
    };
  },
  
  // Browser settings
  browser: {
    headless: headlessFlag,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox", 
      "--disable-blink-features=AutomationControlled",
    ],
  },
  
  // Flags
  flags: {
    test: testModeFlag,
    skipDetails: skipDetailsFlag,
    verbose: verboseFlag,
    resume: resumeFlag,
    cache: cacheFlag,
  }
};

/** ────────────────────────────────
 *  HELPERS - OPTIMIZED
 *  ──────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageUrl = (n) => (n === 1 ? config.BASE_URL : `${config.BASE_URL}?page=${n}`);
const abs = (u) => new URL(u, config.BASE_URL).href;

/** ────────────────────────────────
 *  TITLE UTILITIES
 *  ──────────────────────────────── */
function cleanTitle(title) {
  if (!title || typeof title !== 'string') return '';
  return title
    .trim()
    .replace(/\s+/g, ' ')                    // Normalize whitespace
    .replace(/\s*\(více\)\s*$/i, '')         // Remove "(více)"
    .trim();
}

function normalizeFilmType(infoText) {
  if (!infoText) return 'film';
  const low = infoText.toLowerCase();
  if (low.includes('seriál')) return 'series';
  if (low.includes('epizoda')) return 'episode';
  if (low.includes('série')) return 'season';
  return 'film';
}

function extractYear(infoText) {
  if (!infoText) return '';
  const match = infoText.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : '';
}

function extractRating(element) {
  if (!element) return '';
  const className = element.className || '';
  const match = className.match(/stars-(\d)/);
  return match ? match[1] : '';
}

/** ────────────────────────────────
 *  CACHE & STATE MANAGEMENT
 *  ──────────────────────────────── */
let cache = new Map();

async function loadCache() {
  if (!config.flags.cache) return;
  try {
    const data = await fs.readFile(config.files.cache, 'utf8');
    const parsed = JSON.parse(data);
    cache = new Map(Object.entries(parsed));
    if (config.flags.verbose) console.log(`[cache] loaded ${cache.size} entries`);
  } catch {
    if (config.flags.verbose) console.log('[cache] no existing cache found');
  }
}

async function saveCache() {
  if (!config.flags.cache) return;
  try {
    await fs.mkdir(config.directories.output, { recursive: true });
    const obj = Object.fromEntries(cache);
    await fs.writeFile(config.files.cache, JSON.stringify(obj, null, 2), 'utf8');
    if (config.flags.verbose) console.log(`[cache] saved ${cache.size} entries`);
  } catch (e) {
    console.warn('[cache] failed to save:', e.message);
  }
}

async function loadState() {
  if (!config.flags.resume) return null;
  try {
    const data = await fs.readFile(config.files.state, 'utf8');
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
    await fs.mkdir(config.directories.output, { recursive: true });
    const state = { lastPage: page, items, timestamp: Date.now() };
    await fs.writeFile(config.files.state, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[state] failed to save:', e.message);
  }
}

/** ────────────────────────────────
 *  ERROR HANDLING & RETRY
 *  ──────────────────────────────── */
async function withRetry(fn, maxRetries = 3, baseDelay = 1000, context = '') {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) {
        if (config.flags.verbose) console.error(`[retry] ${context} failed after ${maxRetries} attempts:`, e.message);
        throw e;
      }
      const delay = baseDelay * Math.pow(2, i);
      if (config.flags.verbose) console.warn(`[retry] ${context} attempt ${i + 1} failed, retrying in ${delay}ms`);
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
      if (config.flags.verbose) console.log('[cookies] accepted via direct button');
      return;
    }
    const ifr = await page.$(iframeSel);
    if (ifr) {
      const frame = await ifr.contentFrame();
      const fbtn = await frame.$(btnSel);
      if (fbtn) {
        await fbtn.click({ timeout: 2000 }).catch(() => {});
        cookiesAccepted = true;
        if (config.flags.verbose) console.log('[cookies] accepted via iframe');
      }
    }
  } catch (e) {
    if (config.flags.verbose) console.warn('[cookies] error:', e.message);
  }
}

/** ────────────────────────────────
 *  CSFD PAGE PARSING
 *  ──────────────────────────────── */
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
      if (config.flags.verbose) console.warn(`[parse] no content selector found on ${url}`);
      await pageDump(page, tag || "noparse");
      return [];
    }

    const items = await page.$$eval('#snippet--ratings table.striped tbody tr', (trs) => {
      // Helper functions - must be inline in page context
      const cleanTitleInline = (title) => {
        if (!title) return '';
        return title.trim().replace(/\s+/g, ' ').replace(/\s*\(více\)\s*$/i, '').trim();
      };
      
      const out = [];
      for (const tr of trs) {
        const link = tr.querySelector(".name .film-title-name");
        if (!link) continue;

        const url = link.getAttribute("href") || "";
        const title = cleanTitleInline(link.textContent || "");
        
        const infoParts = Array.from(tr.querySelectorAll(".film-title-info .info"))
          .map((s) => (s.textContent || "").trim());
        const infoText = infoParts.join(" ");

        // Year
        const yearMatch = infoText.match(/\b(19\d{2}|20\d{2})\b/);
        const year = yearMatch ? yearMatch[1] : "";

        // Type 
        const low = infoText.toLowerCase();
        let type = "film";
        if (low.includes("seriál")) type = "series";
        if (low.includes("epizoda")) type = "episode";
        if (low.includes("série")) type = "season";

        // Rating
        const starsEl = tr.querySelector(".star-rating .stars");
        const className = starsEl?.className || "";
        const ratingMatch = className.match(/stars-(\d)/);
        const rating = ratingMatch ? ratingMatch[1] : "";

        // Date
        const ratingDate = (tr.querySelector(".date-only")?.textContent || "").trim();

        out.push({ title, year, type, rating, ratingDate, url });
      }
      return out;
    });

    if (!items.length && config.flags.verbose) {
      console.warn(`[parse] no items found on ${url}`);
      await pageDump(page, tag || "noparse");
    }

    // Convert relative URLs to absolute
    for (const item of items) {
      item.url = abs(item.url);
    }
    
    return items;
  }, 2, config.delays.retry, `parsing ${url}`);
}


/** ────────────────────────────────
 *  IMDB SEARCH & EXTRACTION
 *  ──────────────────────────────── */

/** IMDb search selectors - structured for easy maintenance */
const imdbSelectors = {
  // Modern IMDb layout
  modern: {
    container: '.ipc-metadata-list-summary-item',
    link: 'a[href*="/title/tt"]',
    title: '.ipc-metadata-list-summary-item__t, .titleNameText, h3',
    year: '.ipc-metadata-list-summary-item__li, .secondaryText'
  },
  
  // Legacy IMDb layout
  legacy: {
    container: '.findSection .findResult, .findList .findResult',
    link: 'a[href*="/title/tt"]',
    title: '.primaryText, .result_text a',
    year: '.yearText, .text-muted'
  }
};

async function searchImdbByTitle(originalTitle, year, context) {
  if (!originalTitle || originalTitle.length < 2) return { imdb_id: "", imdb_url: "" };
  
  const cleanedTitle = cleanTitle(originalTitle);
  if (!cleanedTitle) return { imdb_id: "", imdb_url: "" };
  
  try {
    if (config.flags.verbose) console.log(`[imdb-search] Searching for: "${cleanedTitle}" (${year})`);
    
    const page = await context.newPage();
    const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(cleanedTitle)}&ref_=nv_sr_sm`;
    
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(config.delays.pageSettle);
    
    // Debug: Save search page
    if (config.flags.verbose) {
      await saveImdbSearchDebug(page);
    }
    
    // Try modern selector first, then fallback to legacy
    let result = await tryImdbSelector(page, imdbSelectors.modern) || 
                 await tryImdbSelector(page, imdbSelectors.legacy);
    
    await page.close();
    
    if (result) {
      if (config.flags.verbose) {
        console.log(`[imdb-search] Found: ${result.title} (${result.year}) - ${result.imdb_id}`);
      }
      return { imdb_id: result.imdb_id, imdb_url: result.imdb_url };
    }
    
    if (config.flags.verbose) console.log(`[imdb-search] No results found for "${cleanedTitle}"`);
    
  } catch (e) {
    if (config.flags.verbose) console.warn(`[imdb-search] Failed to search: ${e.message}`);
  }
  
  return { imdb_id: "", imdb_url: "" };
}

/** Try a specific IMDb selector strategy */
async function tryImdbSelector(page, selector) {
  try {
    return await page.$$eval(selector.container, (results, sel) => {
      for (const result of results.slice(0, 3)) {
        const link = result.querySelector(sel.link);
        const titleEl = result.querySelector(sel.title);
        const yearEl = result.querySelector(sel.year);
        
        if (link) {
          const href = link.href;
          const title = titleEl?.textContent?.trim() || '';
          const yearText = yearEl?.textContent || '';
          const yearMatch = yearText.match(/\b(19\d{2}|20\d{2})\b/);
          const foundYear = yearMatch ? yearMatch[1] : '';
          
          const ttMatch = href.match(/(tt\d+)/);
          if (ttMatch) {
            return {
              imdb_id: ttMatch[1],
              imdb_url: `https://www.imdb.com/title/${ttMatch[1]}/`,
              title,
              year: foundYear
            };
          }
        }
      }
      return null;
    }, selector);
  } catch (e) {
    if (config.flags.verbose) console.log(`[imdb-search] Selector failed: ${e.message}`);
    return null;
  }
}

/** Save IMDb search page for debugging */
async function saveImdbSearchDebug(page) {
  try {
    await fs.mkdir(config.directories.debug, { recursive: true });
    const html = await page.content();
    const filename = `imdb_search_${Date.now()}.html`;
    await fs.writeFile(`${config.directories.debug}/${filename}`, html, 'utf8');
    if (config.flags.verbose) console.log(`[imdb-search] Search page saved to debug/`);
  } catch (e) {
    // Silent fail for debug saves
  }
}

/** Extract IMDb (robust: several selectors + HTML regex fallback) */
async function extractImdbOnPage(page) {
  try {
    // 🔍 DEBUG: Najdi všechny odkazy a tlačítka
    if (config.flags.verbose) {
      const allImdbLinks = await page.$$eval('a[href*="imdb"]', (links) => {
        return links.map(link => ({
          href: link.href,
          text: link.textContent?.trim(),
          className: link.className,
          innerHTML: link.innerHTML
        }));
      });
      console.log(`[debug] Found ${allImdbLinks.length} IMDb links:`, allImdbLinks);

      // Debug všechna tlačítka a externí odkazy
      const allButtons = await page.$$eval('a, button', (elements) => {
        return elements
          .filter(el => {
            const text = el.textContent?.toLowerCase() || '';
            const classes = el.className || '';
            const href = el.href || '';
            return text.includes('imdb') || classes.includes('imdb') || href.includes('imdb') || classes.includes('external');
          })
          .map(el => ({
            tag: el.tagName,
            href: el.href,
            text: el.textContent?.trim(),
            className: el.className,
            id: el.id,
            innerHTML: el.innerHTML
          }));
      });
      console.log(`[debug] Found ${allButtons.length} external/IMDb buttons:`, allButtons);
    }

    // 🔍 Hledej IMDb ID v skrytých datech (JSON, data atributy, JS vars) - VŽDY
    const hiddenImdb = await page.evaluate(() => {
      const results = [];
      
      // 1) Hledej v celém HTML textu
      const htmlText = document.documentElement.outerHTML;
      const ttMatches = htmlText.match(/\b(tt\d{6,})\b/gi) || [];
      if (ttMatches.length) results.push({type: 'html_text', data: ttMatches});
      
      // 2) Hledej v data atributech
      const dataElements = document.querySelectorAll('[data-imdb], [data-imdb-id], [data-tt]');
      if (dataElements.length) {
        results.push({type: 'data_attrs', data: Array.from(dataElements).map(el => ({
          tag: el.tagName, 
          attrs: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value]))
        }))});
      }
      
      // 3) Hledej v window objektu
      if (window.filmData || window.imdbId || window.movieData) {
        results.push({type: 'window_vars', data: {
          filmData: window.filmData,
          imdbId: window.imdbId, 
          movieData: window.movieData
        }});
      }
      
      // 4) Hledej v JSON script tags
      const scripts = document.querySelectorAll('script[type="application/ld+json"], script[type="text/json"]');
      Array.from(scripts).forEach((script, i) => {
        try {
          const json = JSON.parse(script.textContent);
          const jsonStr = JSON.stringify(json);
          const jsonTtMatches = jsonStr.match(/\b(tt\d{6,})\b/gi) || [];
          if (jsonTtMatches.length) {
            results.push({type: `json_script_${i}`, data: {matches: jsonTtMatches, json}});
          }
        } catch {}
      });
      
      return results;
    });
    
    if (verboseFlag && hiddenImdb.length) {
      console.log(`[debug] Found hidden IMDb data:`, hiddenImdb);
    }

    const selectors = [
      'a.button-imdb',                     // 🆕 HLAVNÍ - přesně to co vidíš
      '.button-imdb',                      // 🆕 BACKUP
      'a.button.button-imdb',              // 🆕 ÚPLNÝ selektor
      'a[href*="imdb.com/title/tt"]',      // ✅ FUNGUJE
      'a[href*="imdb.com/title/"]',        // ✅ FUNGUJE  
      'a[href*="://www.imdb.com/title/"]', // ✅ FUNGUJE
      'a.imdb',                            // 🗑️ STARÝ
      '.imdb a',                           // 🗑️ STARÝ
      'a[href*="imdb"]',                   // ✅ OBECNÝ
    ];
    for (const sel of selectors) {
      const a = await page.$(sel);
      if (a) {
        const href = await a.getAttribute("href");
        if (config.flags.verbose) console.log(`[debug] Found selector "${sel}" with href: ${href}`);
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

    // 2) Use hidden IMDb data if found
    if (typeof hiddenImdb !== 'undefined' && hiddenImdb.length) {
      for (const hidden of hiddenImdb) {
        if (hidden.type === 'html_text' && hidden.data.length) {
          const ttId = hidden.data[0]; // Použij první nalezené
          if (config.flags.verbose) console.log(`[debug] Using hidden IMDb from HTML: ${ttId}`);
          return {
            imdb_id: ttId,
            imdb_url: `https://www.imdb.com/title/${ttId}/`,
          };
        }
        if (hidden.type.startsWith('json_script') && hidden.data.matches.length) {
          const ttId = hidden.data.matches[0];
          if (config.flags.verbose) console.log(`[debug] Using hidden IMDb from JSON: ${ttId}`);
          return {
            imdb_id: ttId,
            imdb_url: `https://www.imdb.com/title/${ttId}/`,
          };
        }
      }
    }

    // 3) Search whole HTML for imdb link  
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

    // 4) Last resort: find ttXXXXXX and construct URL
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
      ".film-names li:first-child",           // 🆕 NOVÝ layout ČSFD
      ".film-header-name .film-names li",     // 🆕 Specifičtější selektor
      ".film-names li",                       // 🆕 Obecnější
      ".film-header-name .original",          // Existující
      ".film-header-name .original-name",     // Existující  
      ".names .original",                     // Existující
      "span.original, span.original-name",    // Existující
      "h1 small",                             // Existující
      '[data-testid="original-title"]',       // Existující
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
          await page.waitForTimeout(2000); // Delší čekání na JavaScript

          // Zkus najít sekci s externými odkazy
          try {
            await page.waitForSelector('.external-links, .film-links, .film-header-links', { timeout: 3000 });
            if (config.flags.verbose) console.log('[debug] External links section found');
          } catch (e) {
            if (config.flags.verbose) console.log('[debug] No external links section found');
          }

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

          // 🆕 FALLBACK: Hledej IMDb přes originální název
          if (!imdb_id && original_title) {
            if (config.flags.verbose) console.log(`[fallback] Searching IMDb by title: "${original_title}"`);
            const searchResult = await searchImdbByTitle(original_title, it.year, context);
            if (searchResult.imdb_id) {
              imdb_id = searchResult.imdb_id;
              imdb_url = searchResult.imdb_url;
              if (config.flags.verbose) console.log(`[fallback] Found IMDb via search: ${imdb_id}`);
            }
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

          // 🆕 FALLBACK pro epizody: Hledej IMDb přes originální název i zde
          if (!imdb_id && original_title && (it.type === "episode" || it.type === "season" || it.type === "series")) {
            if (config.flags.verbose) console.log(`[fallback-episode] Searching IMDb by title: "${original_title}"`);
            const searchResult = await searchImdbByTitle(original_title, it.year, context);
            if (searchResult.imdb_id) {
              imdb_id = searchResult.imdb_id;
              imdb_url = searchResult.imdb_url;
              if (config.flags.verbose) console.log(`[fallback-episode] Found IMDb via search: ${imdb_id}`);
            }
          }

          it.imdb_id = imdb_id || "";
          it.imdb_url = imdb_url || "";
          // Vyčisti "(více)" z originálního názvu
          it.original_title = (original_title || "").replace(/\s*\(více\)\s*$/i, '').trim();

          // Save to cache
          cache.set(cacheKey, {
            imdb_id: it.imdb_id,
            imdb_url: it.imdb_url,
            original_title: it.original_title
          });

        }, 2, 1000, `enriching ${it.url}`);

        await page.close();
      } catch (e) {
        if (config.flags.verbose) console.warn(`[details] failed for ${it.url}:`, e.message);
        it.imdb_id = it.imdb_id || "";
        it.imdb_url = it.imdb_url || "";
        it.original_title = it.original_title || "";
      }

      done++;
      if (done % 25 === 0) {
        console.log(`[details] processed ${done}/${total}`);
        await saveCache(); // Periodic cache save
      }
      await sleep(config.delays.detail);
    }
  }

  const workers = Array.from({ length: config.concurrency.details }, () => worker());
  await Promise.all(workers);
  await saveCache(); // Final cache save
}

/** ────────────────────────────────
 *  MAIN - OPTIMIZED
 *  ──────────────────────────────── */
/** ────────────────────────────────
 *  MAIN FUNCTION - REFACTORED
 *  ──────────────────────────────── */
async function main() {
  // Print usage info
  if (hasCliFlag('help')) {
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

  // Configuration summary
  console.log(`[config] MAX_PAGES=${config.MAX_PAGES}, MAX_ITEMS=${config.MAX_ITEMS || 'unlimited'}, headless=${config.browser.headless}`);
  if (config.flags.test) console.log('[config] TEST MODE enabled - faster delays');
  if (config.flags.skipDetails) console.log('[config] skipping detail enrichment');
  
  await loadCache();
  
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: config.browser.args,
  });

  const context = await browser.newContext({
    userAgent: config.browser.userAgent,
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

  for (let p = startPage; p <= config.MAX_PAGES; p++) {
    const url = pageUrl(p);
    console.log(`[page] ${p}/${config.MAX_PAGES}: ${url}`);

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
        if (config.MAX_ITEMS && all.length >= config.MAX_ITEMS) {
          console.log(`→ reached max items limit (${config.MAX_ITEMS}), stopping`);
          break;
        }
      }
    }
    
    console.log(`→ added: ${added}, total: ${all.length}`);
    if (added === 0 || (config.MAX_ITEMS && all.length >= config.MAX_ITEMS)) break;

    // Save state periodically
    if (p % 5 === 0) {
      await saveState(p, all);
    }

    await sleep(config.delays.pagination);
  }

  // 3) Enrich with IMDb and original title
  if (!config.flags.skipDetails && all.length > 0) {
    console.log(`[details] enriching ${all.length} items...`);
    await enrichWithDetails(context, all);
    console.log("[details] done.");
  } else if (config.flags.skipDetails) {
    console.log("[details] skipped (--skipDetails flag)");
  }

  await browser.close();

  // 4) Save CSV + JSON
  const files = config.files;
  await fs.mkdir(config.directories.output, { recursive: true });
  await fs.writeFile(files.csv, toCsv(all), "utf8");
  await fs.writeFile(files.json, JSON.stringify(all, null, 2), "utf8");

  // 5) Clean up state file on successful completion
  if (!config.flags.test) {
    try {
      await fs.unlink(files.state);
    } catch {}
  }

  // 6) Summary
  const withImdb = all.filter((x) => x.imdb_id).length;
  const withOrig = all.filter((x) => x.original_title).length;
  console.log(`[summary] IMDb IDs: ${withImdb}/${all.length}, original titles: ${withOrig}/${all.length}`);
  console.log(`[summary] cache entries: ${cache.size}`);
  console.log(`✓ ${all.length} rows → ${files.csv} & ${files.json}`);
}

main().catch(async (e) => {
  console.error("💥 FATAL:", e.message);
  if (config.flags.verbose) console.error(e.stack);
  try {
    await fs.mkdir(config.directories.debug, { recursive: true });
    await fs.writeFile(`${config.directories.debug}/error.txt`, String(e.stack || e), "utf8");
  } catch {}
  process.exit(1);
});