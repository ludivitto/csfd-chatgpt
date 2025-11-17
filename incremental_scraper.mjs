// Inkrementální CSFD Scraper - detekuje a přidává pouze nové filmy/seriály
// Optimalizovaný pro rychlé noční kontroly s minimálním zatížením

import { chromium } from "playwright";
import fs from "node:fs/promises";

/** ────────────────────────────────
 *  KONFIGURACE
 *  ──────────────────────────────── */
const config = {
  // CSFD URL
  BASE_URL: "https://www.csfd.cz/uzivatel/2544-ludivitto/hodnoceni/",
  
  // Soubory
  files: {
    mainJson: "data/csfd_ratings.json",
    backupJson: "data/csfd_ratings_backup.json",
    newItemsJson: "data/new_items.json",
    stateJson: "data/incremental_state.json",
  },
  
  // Nastavení
  settings: {
    maxPagesToCheck: 5,        // Kolik stránek zkontrolovat (obvykle stačí 1-2)
    maxNewItems: 50,           // Max nových položek na jeden běh
    enableEnrichment: true,    // Zda enrichovat nové položky
    createBackup: true,        // Vytvořit zálohu před změnami
    verbose: true,             // Detailní logování
  },
  
  // Performance
  delays: {
    pageLoad: 2000,
    pagination: 1000,
    detail: 500,
  },
  
  // Browser
  browser: {
    headless: true,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  }
};

/** ────────────────────────────────
 *  POMOCNÉ FUNKCE
 *  ──────────────────────────────── */
const log = (msg, ...args) => {
  if (config.settings.verbose) {
    console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
  }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Načtení existujících dat
async function loadExistingData() {
  try {
    const data = await fs.readFile(config.files.mainJson, 'utf8');
    const items = JSON.parse(data);
    log(`Načteno ${items.length} existujících položek`);
    return items;
  } catch (error) {
    log(`Chyba při načítání existujících dat: ${error.message}`);
    return [];
  }
}

// Uložení dat
async function saveData(items, filename) {
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(filename, JSON.stringify(items, null, 2), 'utf8');
    log(`Data uložena do ${filename} (${items.length} položek)`);
  } catch (error) {
    log(`Chyba při ukládání do ${filename}: ${error.message}`);
  }
}

// Vytvoření zálohy
async function createBackup(items) {
  if (config.settings.createBackup) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = `data/csfd_ratings_backup_${timestamp}.json`;
    await saveData(items, backupFile);
    log(`Záloha vytvořena: ${backupFile}`);
  }
}

// Vytvoření unikátního klíče pro položku
function createItemKey(item) {
  return `${item.url}::${item.title}::${item.year}`;
}

// Porovnání položek - najde nové
function findNewItems(existingItems, newItems) {
  const existingKeys = new Set(existingItems.map(createItemKey));
  const newItemsFiltered = newItems.filter(item => {
    const key = createItemKey(item);
    return !existingKeys.has(key);
  });
  
  log(`Nalezeno ${newItemsFiltered.length} nových položek z ${newItems.length} zkontrolovaných`);
  return newItemsFiltered;
}

/** ────────────────────────────────
 *  CSFD PARSING (zjednodušené z hlavního scraperu)
 *  ──────────────────────────────── */
async function parseListPage(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(config.delays.pageLoad);
    
    // Cookie consent
    try {
      const cookieBtn = await page.$('button[id^="didomi-notice-agree-button"], #didomi-notice-agree-button');
      if (cookieBtn) {
        await cookieBtn.click({ timeout: 2000 }).catch(() => {});
        log("Cookies přijaty");
      }
    } catch {}

    // Čekání na obsah
    await page.waitForSelector('#snippet--ratings table.striped tbody tr', { timeout: 10000 });

    const items = await page.$$eval('#snippet--ratings table.striped tbody tr', (trs) => {
      const out = [];
      for (const tr of trs) {
        const link = tr.querySelector(".name .film-title-name");
        if (!link) continue;

        const url = link.getAttribute("href") || "";
        const title = (link.textContent || "").trim().replace(/\s*\(více\)\s*$/i, '');
        
        const infoParts = Array.from(tr.querySelectorAll(".film-title-info .info"))
          .map(s => (s.textContent || "").trim());
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

        out.push({ 
          title, year, type, rating, ratingDate, url,
          // Inicializace pro enrichment
          imdb_id: "",
          imdb_url: "",
          original_title: "",
          genre: "",
          director: "",
          cast: "",
          description: "",
        });
      }
      return out;
    });

    // Konverze relativních URL na absolutní
    for (const item of items) {
      if (item.url && !item.url.startsWith('http')) {
        item.url = new URL(item.url, config.BASE_URL).href;
      }
    }
    
    log(`Načteno ${items.length} položek ze stránky`);
    return items;
  } catch (error) {
    log(`Chyba při parsování stránky ${url}: ${error.message}`);
    return [];
  }
}

/** ────────────────────────────────
 *  IMDB EXTRACTION (z hlavního scraperu)
 *  ──────────────────────────────── */

/** Extract IMDb (robust: several selectors + HTML regex fallback) */
async function extractImdbOnPage(page) {
  try {
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

    // Search whole HTML for imdb link  
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

    // Last resort: find ttXXXXXX and construct URL
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

/** ────────────────────────────────
 *  ENRICHMENT (zjednodušené z hlavního scraperu)
 *  ──────────────────────────────── */
async function enrichNewItems(context, items) {
  if (!config.settings.enableEnrichment || items.length === 0) {
    log("Enrichment přeskočen");
    return items;
  }

  log(`Enrichment ${items.length} nových položek...`);
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    log(`Enrichment ${i + 1}/${items.length}: ${item.title}`);
    
    try {
      const page = await context.newPage();
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(config.delays.detail);
      
      // Cookie consent
      try {
        const cookieBtn = await page.$('button[id^="didomi-notice-agree-button"]');
        if (cookieBtn) await cookieBtn.click({ timeout: 2000 }).catch(() => {});
      } catch {}

      // Extrakce dat (zjednodušené verze z hlavního scraperu)
      await extractBasicDetails(page, item, context);
      
      await page.close();
      await sleep(config.delays.detail);
      
    } catch (error) {
      log(`Chyba při enrichment ${item.title}: ${error.message}`);
    }
  }
  
  log("Enrichment dokončen");
  return items;
}

/** 🆕 IMDB VYHLEDÁVÁNÍ (zjednodušené z hlavního scraperu) */
async function searchImdbByTitle(originalTitle, year, context) {
  if (!originalTitle || originalTitle.length < 2) return { imdb_id: "", imdb_url: "" };
  
  const cleanedTitle = cleanTitle(originalTitle);
  if (!cleanedTitle) return { imdb_id: "", imdb_url: "" };
  
  try {
    log(`[imdb-search] Searching for: "${cleanedTitle}" (${year})`);
    
    const result = await performImdbSearch(cleanedTitle, year, context);
    
    if (result) {
      log(`[imdb-search] Found: ${result.title} (${result.year}) - ${result.imdb_id}`);
      return { imdb_id: result.imdb_id, imdb_url: result.imdb_url };
    }
    
    log(`[imdb-search] No results found for "${cleanedTitle}"`);
    
  } catch (e) {
    log(`[imdb-search] Failed to search: ${e.message}`);
  }
  
  return { imdb_id: "", imdb_url: "" };
}

/** 🆕 NOVÁ FUNKCE: Provede skutečné IMDB vyhledávání */
async function performImdbSearch(searchTitle, year, context) {
  const page = await context.newPage();
  
  try {
    const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(searchTitle)}&ref_=nv_sr_sm`;
    
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);
    
    // 🆕 NOVÝ PŘÍSTUP: Čti data z __NEXT_DATA__ JSON
    let result = await tryImdbJsonData(page, searchTitle, year);
    
    return result;
  } finally {
    await page.close();
  }
}

/** 🆕 NOVÁ FUNKCE: Čti IMDb data z __NEXT_DATA__ JSON */
async function tryImdbJsonData(page, searchTitle, targetYear) {
  try {
    const result = await page.evaluate(({ title, year }) => {
      // Najdi __NEXT_DATA__ script tag
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return null;
      
      try {
        const data = JSON.parse(script.textContent);
        
        // Projdi titleResults v JSON data
        const titleResults = data?.props?.pageProps?.titleResults?.results || [];
        
        // 🆕 VYLEPŠENÁ LOGIKA: Seřaď výsledky podle relevance
        const scoredResults = [];
        
        for (const item of titleResults.slice(0, 10)) { // Zkontroluj prvních 10 výsledků
          // 🆕 NOVÁ STRUKTURA IMDB (listopad 2025)
          const itemTitle = item.listItem?.originalTitleText || item.titleNameText || item.titleText?.text || item.titleText || '';
          const itemYear = item.listItem?.releaseYear || item.titleReleaseText || item.releaseYear?.year || item.releaseYear || '';
          const imdbId = item.index || item.id || '';
          
          if (!imdbId || !imdbId.startsWith('tt')) continue;
          
          let score = 0;
          
          // Kontrola roku (pokud je specifikován)
          const yearMatch = !year || !itemYear || itemYear.toString() === year.toString();
          if (yearMatch) score += 100; // Vysoká priorita pro shodu roku
          
          // Kontrola shody názvu (case insensitive, partial match)
          const titleLower = title.toLowerCase();
          const itemTitleLower = itemTitle.toLowerCase();
          
          if (titleLower === itemTitleLower) {
            score += 200; // Perfektní shoda
          } else if (itemTitleLower.includes(titleLower)) {
            score += 150; // Název obsahuje hledaný text
          } else if (titleLower.includes(itemTitleLower)) {
            score += 100; // Hledaný text obsahuje název
          } else {
            // Částečná shoda slov
            const titleWords = titleLower.split(/\s+/);
            const itemWords = itemTitleLower.split(/\s+/);
            const matchingWords = titleWords.filter(word => 
              itemWords.some(itemWord => itemWord.includes(word) || word.includes(itemWord))
            );
            score += matchingWords.length * 20;
          }
          
          if (score > 0) {
            scoredResults.push({
              imdb_id: imdbId,
              imdb_url: `https://www.imdb.com/title/${imdbId}/`,
              title: itemTitle,
              year: itemYear.toString(),
              score: score
            });
          }
        }
        
        // Seřaď podle skóre (nejvyšší první) a vrať nejlepší výsledek
        if (scoredResults.length > 0) {
          scoredResults.sort((a, b) => b.score - a.score);
          return scoredResults[0];
        }
        
        // Pokud nenajde přesný match, zkus první výsledek s podobným názvem
        for (const item of titleResults.slice(0, 3)) {
          // 🆕 NOVÁ STRUKTURA IMDB (listopad 2025)
          const itemTitle = item.listItem?.originalTitleText || item.titleNameText || item.titleText?.text || item.titleText || '';
          const imdbId = item.index || item.id || '';
          
          if (imdbId && imdbId.startsWith('tt') && 
              (itemTitle.toLowerCase().includes(title.toLowerCase()) || 
               title.toLowerCase().includes(itemTitle.toLowerCase()))) {
            return {
              imdb_id: imdbId,
              imdb_url: `https://www.imdb.com/title/${imdbId}/`,
              title: itemTitle,
              year: (item.listItem?.releaseYear || item.titleReleaseText || item.releaseYear?.year || '').toString()
            };
          }
        }
        
      } catch (e) {
        console.warn('Failed to parse __NEXT_DATA__ JSON:', e);
      }
      
      return null;
    }, { title: searchTitle, year: targetYear });
    
    if (result) {
      log(`[imdb-json] Found via JSON: ${result.title} (${result.year}) - ${result.imdb_id}`);
    }
    
    return result;
  } catch (e) {
    log(`[imdb-json] JSON parsing failed: ${e.message}`);
    return null;
  }
}

/** 🆕 NOVÁ FUNKCE: Vyčistí název pro vyhledávání */
function cleanTitle(title) {
  if (!title) return "";
  
  return title
    .trim()
    .replace(/\s*\(více\)\s*$/i, '')  // Odstraň "(více)" na konci
    .replace(/\s+/g, ' ')             // Normalizuj mezery
    .trim();
}

// Zjednodušená extrakce základních detailů
async function extractBasicDetails(page, item, context) {
  try {
    // IMDb - rozšířená extrakce
    const imdbData = await extractImdbOnPage(page);
    if (imdbData.imdb_id) {
      item.imdb_id = imdbData.imdb_id;
      item.imdb_url = imdbData.imdb_url;
    }
    
    // Originální název
    const originalEl = await page.$('.film-names li:first-child, .film-header-name .original');
    if (originalEl) {
      const text = await originalEl.textContent();
      if (text) {
        item.original_title = text.trim().replace(/\s*\(více\)\s*$/i, '');
      }
    }

    // 🆕 FALLBACK: Hledej IMDb přes český název (priorita)
    if (!item.imdb_id && item.title) {
      log(`[fallback] Searching IMDb by Czech title: "${item.title}"`);
      const searchResult = await searchImdbByTitle(item.title, item.year, context);
      if (searchResult.imdb_id) {
        item.imdb_id = searchResult.imdb_id;
        item.imdb_url = searchResult.imdb_url;
        log(`[fallback] Found IMDb via Czech title search: ${item.imdb_id}`);
      }
    }

    // 🆕 FALLBACK: Hledej IMDb přes originální název (pokud český název neuspěl)
    if (!item.imdb_id && item.original_title) {
      log(`[fallback] Searching IMDb by original title: "${item.original_title}"`);
      const searchResult = await searchImdbByTitle(item.original_title, item.year, context);
      if (searchResult.imdb_id) {
        item.imdb_id = searchResult.imdb_id;
        item.imdb_url = searchResult.imdb_url;
        log(`[fallback] Found IMDb via original title search: ${item.imdb_id}`);
      }
    }
    
    // Žánr
    const genreEl = await page.$('.genres');
    if (genreEl) {
      const text = await genreEl.textContent();
      if (text) {
        item.genre = text.trim().split(/[,\n]/).slice(0, 3).join(", ");
      }
    }
    
    // Režisér - s fallback
    const directorSelectors = [
      '.creators .director a',
      '.film-creator .director a',
      '.film-header .director a',
      '.film-info .director',
      '[data-type="director"] a',
    ];
    
    let director = "";
    for (const sel of directorSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        if (text && text.trim()) {
          director = text.trim();
          break;
        }
      }
    }
    
    // Fallback pro režiséra
    if (!director) {
      const text = await page.$eval('body', el => el.textContent);
      const match = text.match(/[Rr]ežie:\s*([^,\n]+)/);
      if (match) director = match[1].trim();
    }
    
    if (director) item.director = director;
    
    // Cast - zjednodušená verze
    try {
      const actors = await page.evaluate(() => {
        const creators = document.querySelector('#creators');
        if (!creators) return [];
        
        const otherProfessions = creators.querySelector('div.other-professions');
        if (!otherProfessions) return [];
        
        // Najít poslední div bez třídy před div.other-professions
        let castDiv = null;
        let previousEl = otherProfessions.previousElementSibling;
        while (previousEl) {
          if (previousEl.tagName === 'DIV' && !previousEl.className) {
            castDiv = previousEl;
            break;
          }
          previousEl = previousEl.previousElementSibling;
        }
        
        if (!castDiv) return [];
        
        // Extrahovat všechny odkazy z cast div
        const links = castDiv.querySelectorAll('a');
        return Array.from(links).map(link => link.textContent?.trim()).filter(Boolean);
      });
      
      if (actors.length > 0) {
        item.cast = actors.slice(0, 8).join(", ");
      }
    } catch {}
    
    // Popis (s čištěním distributor informací)
    const plotEl = await page.$('.plot-preview, .plot-full');
    if (plotEl) {
      const text = await plotEl.textContent();
      if (text && text.length > 10) {
        // Vyčisti distributor informace a omezeň délku
        let cleaned = text.replace(/\s+/g, ' ')
                         .replace(/[""]/g, '"')
                         .replace(/\s*\([^)]*Netflix[^)]*\)\s*/g, '') // Odstraň (Netflix)
                         .replace(/\s*\([^)]*HBO[^)]*\)\s*/g, '') // Odstraň (HBO)
                         .replace(/\s*\([^)]*Disney[^)]*\)\s*/g, '') // Odstraň (Disney)
                         .replace(/\s*\([^)]*Amazon[^)]*\)\s*/g, '') // Odstraň (Amazon)
                         .replace(/\s*\([^)]*Apple[^)]*\)\s*/g, '') // Odstraň (Apple)
                         .replace(/\s*\([^)]+\)\s*\(více\)\s*$/, '') // Odstraň "(distributor) (více)"
                         .replace(/\s*\(více\)\s*$/, '') // Odstraň "(více)" 
                         .trim();
        
        // Omezeň na 200 znaků
        if (cleaned.length > 200) {
          const truncated = cleaned.substring(0, 200);
          const lastDot = truncated.lastIndexOf('.');
          if (lastDot > 100) {
            cleaned = truncated.substring(0, lastDot + 1);
          } else {
            cleaned = truncated + '...';
          }
        }
        
        item.description = cleaned;
      }
    }
    
  } catch (error) {
    log(`Chyba při extrakci detailů: ${error.message}`);
  }
}

/** ────────────────────────────────
 *  HLAVNÍ FUNKCE
 *  ──────────────────────────────── */
async function main() {
  log("🚀 Spouštím inkrementální scraper...");
  
  // 1. Načtení existujících dat
  const existingItems = await loadExistingData();
  if (existingItems.length === 0) {
    log("❌ Žádná existující data nenalezena. Spusť nejdřív hlavní scraper.");
    return;
  }
  
  // 2. Spuštění browseru
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  
  const context = await browser.newContext({
    userAgent: config.browser.userAgent,
    locale: "cs-CZ"
  });
  
  const page = await context.newPage();
  
  // 3. Kontrola prvních stránek pro nové položky
  let allNewItems = [];
  const maxPages = Math.min(config.settings.maxPagesToCheck, 10);
  
  for (let p = 1; p <= maxPages; p++) {
    const url = p === 1 ? config.BASE_URL : `${config.BASE_URL}?page=${p}`;
    log(`📄 Kontroluji stránku ${p}: ${url}`);
    
    const pageItems = await parseListPage(page, url);
    if (pageItems.length === 0) {
      log("Žádné položky na stránce, končím");
      break;
    }
    
    const newItems = findNewItems(existingItems, pageItems);
    allNewItems.push(...newItems);
    
    log(`Stránka ${p}: ${newItems.length} nových z ${pageItems.length} celkem`);
    
    // Pokud nenajdeme nové položky na první stránce, pravděpodobně není co přidat
    if (p === 1 && newItems.length === 0) {
      log("✅ Žádné nové položky na první stránce - vše je aktuální");
      break;
    }
    
    // Omezení počtu nových položek
    if (allNewItems.length >= config.settings.maxNewItems) {
      log(`Dosažen limit ${config.settings.maxNewItems} nových položek`);
      break;
    }
    
    await sleep(config.delays.pagination);
  }
  
  // 4. Enrichment nových položek
  if (allNewItems.length > 0) {
    log(`🎯 Nalezeno ${allNewItems.length} nových položek - začínám enrichment`);
    await enrichNewItems(context, allNewItems);
    
    // 5. Uložení nových položek
    await saveData(allNewItems, config.files.newItemsJson);
    
    // 6. Přidání do hlavního souboru - nové položky na začátek (nejnovější)
    const updatedItems = [...allNewItems, ...existingItems];
    await createBackup(existingItems);
    await saveData(updatedItems, config.files.mainJson);
    
    // 7. Uložení stavu
    const state = {
      lastRun: new Date().toISOString(),
      newItemsFound: allNewItems.length,
      totalItems: updatedItems.length,
      pagesChecked: maxPages
    };
    await saveData(state, config.files.stateJson);
    
    log(`✅ Úspěšně přidáno ${allNewItems.length} nových položek`);
    log(`📊 Celkem položek: ${updatedItems.length}`);
    
  } else {
    log("✅ Žádné nové položky nenalezeny - vše je aktuální");
    
    // Uložení stavu i při žádných nových položkách
    const state = {
      lastRun: new Date().toISOString(),
      newItemsFound: 0,
      totalItems: existingItems.length,
      pagesChecked: maxPages
    };
    await saveData(state, config.files.stateJson);
  }
  
  await browser.close();
  log("🏁 Inkrementální scraper dokončen");
}

// Spuštění
main().catch(error => {
  console.error("💥 FATAL ERROR:", error.message);
  if (config.settings.verbose) console.error(error.stack);
  process.exit(1);
});
