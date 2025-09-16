// Správce CSFD scraperu - testování a správa
// Umožňuje snadné testování a správu různých režimů

import fs from "node:fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const config = {
  files: {
    mainJson: "data/csfd_ratings.json",
    newItems: "data/new_items.json",
    state: "data/incremental_state.json",
    schedule: "data/schedule_config.json",
  }
};

/** ────────────────────────────────
 *  POMOCNÉ FUNKCE
 *  ──────────────────────────────── */
const log = (msg, ...args) => {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
};

async function loadJsonFile(filename) {
  try {
    const data = await fs.readFile(filename, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function getFileStats(filename) {
  try {
    const stats = await fs.stat(filename);
    return {
      exists: true,
      size: stats.size,
      modified: stats.mtime,
      sizeFormatted: formatBytes(stats.size)
    };
  } catch {
    return { exists: false };
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** ────────────────────────────────
 *  PŘÍKAZY
 *  ──────────────────────────────── */
async function showStatus() {
  log("📊 Stav CSFD scraperu");
  log("=" .repeat(50));
  
  // Hlavní dataset
  const mainStats = await getFileStats(config.files.mainJson);
  if (mainStats.exists) {
    const mainData = await loadJsonFile(config.files.mainJson);
    log(`📁 Hlavní dataset: ${mainStats.sizeFormatted} (${mainData?.length || 0} položek)`);
    log(`   Poslední změna: ${mainStats.modified.toLocaleString('cs-CZ')}`);
  } else {
    log("❌ Hlavní dataset nenalezen");
  }
  
  // Nové položky
  const newStats = await getFileStats(config.files.newItems);
  if (newStats.exists) {
    const newData = await loadJsonFile(config.files.newItems);
    log(`🆕 Nové položky: ${newStats.sizeFormatted} (${newData?.length || 0} položek)`);
    log(`   Poslední změna: ${newStats.modified.toLocaleString('cs-CZ')}`);
  } else {
    log("ℹ️ Žádné nové položky");
  }
  
  // Stav
  const state = await loadJsonFile(config.files.state);
  if (state) {
    log(`🔄 Poslední běh: ${new Date(state.lastRun).toLocaleString('cs-CZ')}`);
    log(`   Nalezeno nových: ${state.newItemsFound}`);
    log(`   Celkem položek: ${state.totalItems}`);
    log(`   Zkontrolované stránky: ${state.pagesChecked}`);
  } else {
    log("ℹ️ Žádný stav nenalezen");
  }
  
  // Schedule
  const schedule = await loadJsonFile(config.files.schedule);
  if (schedule) {
    log(`📅 Schedule: ${schedule.frequency}`);
    log(`   Cron: ${schedule.cron}`);
    log(`   Max stránek: ${schedule.maxPages}`);
  } else {
    log("ℹ️ Žádný schedule nenalezen");
  }
}

async function testIncremental() {
  log("🧪 Testování inkrementálního scraperu...");
  
  try {
    const { stdout, stderr } = await execAsync("node incremental_scraper.mjs");
    log("✅ Inkrementální scraper dokončen");
    if (stdout) log("Output:", stdout);
    if (stderr) log("Errors:", stderr);
  } catch (error) {
    log("❌ Chyba při testování:", error.message);
  }
}

async function testFullScraper() {
  log("🏭 Testování plného scraperu (malý test)...");
  
  try {
    const { stdout, stderr } = await execAsync("node scrape_csfd.mjs --maxItems 5 --verbose");
    log("✅ Plný scraper dokončen");
    if (stdout) log("Output:", stdout);
    if (stderr) log("Errors:", stderr);
  } catch (error) {
    log("❌ Chyba při testování:", error.message);
  }
}

async function updateSchedule() {
  log("🔄 Aktualizuji schedule...");
  
  try {
    const { stdout, stderr } = await execAsync("node smart_scheduler.mjs --update");
    log("✅ Schedule aktualizován");
    if (stdout) log("Output:", stdout);
    if (stderr) log("Errors:", stderr);
  } catch (error) {
    log("❌ Chyba při aktualizaci schedule:", error.message);
  }
}

async function showRecentItems() {
  log("🆕 Posledních 10 nových položek:");
  
  const newData = await loadJsonFile(config.files.newItems);
  if (!newData || newData.length === 0) {
    log("ℹ️ Žádné nové položky");
    return;
  }
  
  const recent = newData.slice(-10);
  recent.forEach((item, i) => {
    log(`${i + 1}. ${item.title} (${item.year}) - ${item.type} - ⭐${item.rating}`);
    if (item.imdb_id) log(`   IMDb: ${item.imdb_id}`);
    if (item.genre) log(`   Žánr: ${item.genre}`);
  });
}

async function showStats() {
  log("📈 Statistiky datasetu:");
  
  const mainData = await loadJsonFile(config.files.mainJson);
  if (!mainData) {
    log("❌ Hlavní dataset nenalezen");
    return;
  }
  
  const stats = {
    total: mainData.length,
    withImdb: mainData.filter(item => item.imdb_id).length,
    withGenre: mainData.filter(item => item.genre).length,
    withDirector: mainData.filter(item => item.director).length,
    withDescription: mainData.filter(item => item.description).length,
    films: mainData.filter(item => item.type === 'film').length,
    series: mainData.filter(item => item.type === 'series').length,
    episodes: mainData.filter(item => item.type === 'episode').length,
    seasons: mainData.filter(item => item.type === 'season').length,
  };
  
  log(`📊 Celkem položek: ${stats.total}`);
  log(`🎬 Filmy: ${stats.films}`);
  log(`📺 Seriály: ${stats.series}`);
  log(`📝 Epizody: ${stats.episodes}`);
  log(`📚 Sezóny: ${stats.seasons}`);
  log(`🔗 S IMDb ID: ${stats.withImdb} (${((stats.withImdb/stats.total)*100).toFixed(1)}%)`);
  log(`🎭 S žánrem: ${stats.withGenre} (${((stats.withGenre/stats.total)*100).toFixed(1)}%)`);
  log(`🎬 S režisérem: ${stats.withDirector} (${((stats.withDirector/stats.total)*100).toFixed(1)}%)`);
  log(`📖 S popisem: ${stats.withDescription} (${((stats.withDescription/stats.total)*100).toFixed(1)}%)`);
  
  // Rating distribuce
  const ratings = {};
  mainData.forEach(item => {
    const rating = item.rating || '0';
    ratings[rating] = (ratings[rating] || 0) + 1;
  });
  
  log("\n⭐ Distribuce hodnocení:");
  Object.entries(ratings)
    .sort(([a], [b]) => b - a)
    .forEach(([rating, count]) => {
      const percentage = ((count / stats.total) * 100).toFixed(1);
      const bar = '█'.repeat(Math.round(percentage / 2));
      log(`  ${rating}⭐: ${count.toString().padStart(4)} (${percentage.padStart(5)}%) ${bar}`);
    });
}

async function cleanup() {
  log("🧹 Čištění dočasných souborů...");
  
  const filesToClean = [
    "data/new_items.json",
    "data/incremental_state.json",
    "data/scraper_cache.json",
    "data/scraper_state.json"
  ];
  
  for (const file of filesToClean) {
    try {
      await fs.unlink(file);
      log(`✅ Smazáno: ${file}`);
    } catch {
      log(`ℹ️ Soubor neexistuje: ${file}`);
    }
  }
  
  // Smazání debug složky
  try {
    await fs.rm("debug", { recursive: true, force: true });
    log("✅ Smazána debug složka");
  } catch {
    log("ℹ️ Debug složka neexistuje");
  }
}

async function showHelp() {
  log("🛠️ CSFD Scraper Manager");
  log("=" .repeat(50));
  log("Použití: node manage_scraper.mjs [příkaz]");
  log("");
  log("Příkazy:");
  log("  status          - Zobrazit stav scraperu");
  log("  stats           - Zobrazit statistiky datasetu");
  log("  test-inc        - Testovat inkrementální scraper");
  log("  test-full       - Testovat plný scraper (malý test)");
  log("  update-schedule - Aktualizovat schedule");
  log("  recent          - Zobrazit poslední nové položky");
  log("  cleanup         - Vyčistit dočasné soubory");
  log("  help            - Zobrazit tuto nápovědu");
  log("");
  log("Příklady:");
  log("  node manage_scraper.mjs status");
  log("  node manage_scraper.mjs test-inc");
  log("  node manage_scraper.mjs stats");
}

/** ────────────────────────────────
 *  HLAVNÍ FUNKCE
 *  ──────────────────────────────── */
async function main() {
  const command = process.argv[2];
  
  switch (command) {
    case 'status':
      await showStatus();
      break;
    case 'stats':
      await showStats();
      break;
    case 'test-inc':
      await testIncremental();
      break;
    case 'test-full':
      await testFullScraper();
      break;
    case 'update-schedule':
      await updateSchedule();
      break;
    case 'recent':
      await showRecentItems();
      break;
    case 'cleanup':
      await cleanup();
      break;
    case 'help':
    case '--help':
    case '-h':
      await showHelp();
      break;
    default:
      if (command) {
        log(`❌ Neznámý příkaz: ${command}`);
      }
      await showHelp();
      break;
  }
}

main().catch(error => {
  console.error("💥 Chyba:", error.message);
  process.exit(1);
});
