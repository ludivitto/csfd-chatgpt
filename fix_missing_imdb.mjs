// Script pro doplnění chybějících IMDB údajů
// Použije hlavní scraper pro re-enrichment položek bez IMDB

import { chromium } from "playwright";
import fs from "node:fs/promises";

const config = {
  files: {
    mainJson: "data/csfd_ratings.json",
    backupJson: `data/csfd_ratings_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  },
  browser: {
    headless: false, // Pro debugging
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  },
  delays: {
    pageLoad: 2000,
    detail: 1000,
  },
  // Kolik položek opravit najednou
  maxItems: 200,
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// === IMDB SEARCH FUNCTIONS ===

async function searchImdbByTitle(searchTitle, year, context) {
  if (!searchTitle || searchTitle.length < 2) return { imdb_id: "", imdb_url: "" };
  
  const page = await context.newPage();
  
  try {
    const searchUrl = `https://www.imdb.com/find/?q=${encodeURIComponent(searchTitle)}&ref_=nv_sr_sm`;
    console.log(`  🔍 Searching IMDB: "${searchTitle}" (${year})`);
    
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);
    
    // Čti data z __NEXT_DATA__ JSON
    const result = await page.evaluate(({ title, year }) => {
      const script = document.querySelector('script#__NEXT_DATA__');
      if (!script) return null;
      
      try {
        const data = JSON.parse(script.textContent);
        const titleResults = data?.props?.pageProps?.titleResults?.results || [];
        
        // Seřaď výsledky podle relevance
        const scoredResults = [];
        
        for (const item of titleResults.slice(0, 10)) {
          // 🆕 NOVÁ STRUKTURA IMDB (listopad 2025)
          const itemTitle = item.listItem?.originalTitleText || item.titleNameText || item.titleText?.text || item.titleText || '';
          const itemYear = item.listItem?.releaseYear || item.titleReleaseText || item.releaseYear?.year || item.releaseYear || '';
          const imdbId = item.index || item.id || '';
          
          if (!imdbId || !imdbId.startsWith('tt')) continue;
          
          let score = 0;
          
          // Kontrola roku
          const yearMatch = !year || !itemYear || itemYear.toString() === year.toString();
          if (yearMatch) score += 100;
          
          // Kontrola shody názvu
          const titleLower = title.toLowerCase();
          const itemTitleLower = itemTitle.toLowerCase();
          
          if (titleLower === itemTitleLower) {
            score += 200; // Perfektní shoda
          } else if (itemTitleLower.includes(titleLower)) {
            score += 150;
          } else if (titleLower.includes(itemTitleLower)) {
            score += 100;
          } else {
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
        
        if (scoredResults.length > 0) {
          scoredResults.sort((a, b) => b.score - a.score);
          return scoredResults[0];
        }
        
      } catch (e) {
        console.warn('Failed to parse __NEXT_DATA__ JSON:', e);
      }
      
      return null;
    }, { title: searchTitle, year: year });
    
    if (result) {
      console.log(`  ✅ Found: ${result.title} (${result.year}) - ${result.imdb_id}`);
      return { imdb_id: result.imdb_id, imdb_url: result.imdb_url };
    } else {
      console.log(`  ❌ Not found on IMDB`);
      return { imdb_id: "", imdb_url: "" };
    }
    
  } catch (e) {
    console.warn(`  ⚠️  Search failed: ${e.message}`);
    return { imdb_id: "", imdb_url: "" };
  } finally {
    await page.close();
  }
}

async function extractImdbOnPage(page) {
  try {
    const selectors = [
      'a.button-imdb',
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
          const full = href.startsWith("http") ? href : new URL(href, page.url()).href;
          const m = full.match(/(tt\d+)/i);
          if (m) {
            return {
              imdb_id: m[1],
              imdb_url: `https://www.imdb.com/title/${m[1]}/`,
            };
          }
        }
      }
    }

    // Search whole HTML
    const html = await page.content();
    const m = html.match(/https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)/i);
    if (m) {
      return {
        imdb_id: m[1],
        imdb_url: `https://www.imdb.com/title/${m[1]}/`,
      };
    }

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

async function extractOriginalTitle(page) {
  try {
    const selectors = [
      ".film-names li:first-child",
      ".film-header-name .film-names li",
      ".film-names li",
      ".film-header-name .original",
      ".film-header-name .original-name",
    ];
    
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        const t = await el.textContent();
        if (t) return t.trim().replace(/\s*\(více\)\s*$/i, '').replace(/\s+/g, " ");
      }
    }
  } catch {}
  return "";
}

// === MAIN SCRIPT ===

async function main() {
  console.log("🔧 Fix Missing IMDB - Doplnění chybějících IMDB údajů\n");
  
  // 1. Načtení dat
  const data = JSON.parse(await fs.readFile(config.files.mainJson, 'utf8'));
  console.log(`📊 Celkem položek: ${data.length}`);
  
  // 2. Nalezení položek bez IMDB
  const itemsWithoutImdb = data.filter(item => !item.imdb_id && item.year >= 2024);
  console.log(`🔍 Položek bez IMDB (2024+): ${itemsWithoutImdb.length}`);
  
  if (itemsWithoutImdb.length === 0) {
    console.log("✅ Všechny položky mají IMDB údaje!");
    return;
  }
  
  // 3. Omezení na maxItems
  const itemsToFix = itemsWithoutImdb.slice(0, config.maxItems);
  console.log(`🎯 Opravuji ${itemsToFix.length} položek...\n`);
  
  // 4. Vytvoření zálohy
  await fs.writeFile(config.files.backupJson, JSON.stringify(data, null, 2), 'utf8');
  console.log(`💾 Záloha vytvořena: ${config.files.backupJson}\n`);
  
  // 5. Spuštění browseru
  const browser = await chromium.launch({
    headless: config.browser.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  
  const context = await browser.newContext({
    userAgent: config.browser.userAgent,
    locale: "cs-CZ"
  });
  
  // 6. Oprava položek
  let fixed = 0;
  let failed = 0;
  
  for (let i = 0; i < itemsToFix.length; i++) {
    const item = itemsToFix[i];
    console.log(`\n[${i+1}/${itemsToFix.length}] ${item.title} (${item.year})`);
    console.log(`  URL: ${item.url}`);
    
    try {
      const page = await context.newPage();
      
      // Načtení stránky
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(config.delays.pageLoad);
      
      // Cookie consent
      try {
        const cookieBtn = await page.$('button[id^="didomi-notice-agree-button"]');
        if (cookieBtn) await cookieBtn.click({ timeout: 2000 }).catch(() => {});
      } catch {}
      
      // Extrakce IMDB z CSFD
      let imdbData = await extractImdbOnPage(page);
      
      // Extrakce originálního názvu
      const originalTitle = await extractOriginalTitle(page);
      if (originalTitle && !item.original_title) {
        item.original_title = originalTitle;
        console.log(`  📝 Original title: ${originalTitle}`);
      }
      
      // Fallback 1: Hledej přes český název
      if (!imdbData.imdb_id && item.title) {
        imdbData = await searchImdbByTitle(item.title, item.year, context);
      }
      
      // Fallback 2: Hledej přes originální název
      if (!imdbData.imdb_id && (originalTitle || item.original_title)) {
        const titleToSearch = originalTitle || item.original_title;
        imdbData = await searchImdbByTitle(titleToSearch, item.year, context);
      }
      
      // Uložení výsledku
      if (imdbData.imdb_id) {
        item.imdb_id = imdbData.imdb_id;
        item.imdb_url = imdbData.imdb_url;
        fixed++;
        console.log(`  ✅ FIXED: ${imdbData.imdb_id}`);
      } else {
        failed++;
        console.log(`  ❌ Failed to find IMDB`);
      }
      
      await page.close();
      await sleep(config.delays.detail);
      
    } catch (error) {
      failed++;
      console.log(`  ⚠️  Error: ${error.message}`);
    }
  }
  
  await browser.close();
  
  // 7. Uložení opravených dat
  await fs.writeFile(config.files.mainJson, JSON.stringify(data, null, 2), 'utf8');
  console.log(`\n💾 Data uložena do ${config.files.mainJson}`);
  
  // 8. Souhrn
  console.log(`\n📊 Souhrn:`);
  console.log(`  ✅ Opraveno: ${fixed}`);
  console.log(`  ❌ Selhalo: ${failed}`);
  console.log(`  📝 Celkem: ${itemsToFix.length}`);
  console.log(`\n✅ Hotovo!`);
}

main().catch(error => {
  console.error("💥 FATAL ERROR:", error.message);
  console.error(error.stack);
  process.exit(1);
});

