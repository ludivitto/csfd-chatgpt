// Inteligentní scheduler pro CSFD scraper
// Automaticky upravuje frekvenci kontrol podle aktivity

import fs from "node:fs/promises";

const config = {
  files: {
    state: "data/incremental_state.json",
    schedule: "data/schedule_config.json",
  },
  
  // Základní nastavení
  baseSchedule: {
    // Když nenajde nové položky - méně časté kontroly
    noNewItems: {
      frequency: "daily",        // Každý den
      cron: "0 2 * * *",        // 2:00 UTC
      maxPages: 3,              // Kontrola 3 stránek
    },
    
    // Když najde 1-5 nových položek - normální frekvence
    fewNewItems: {
      frequency: "daily",        // Každý den
      cron: "0 2 * * *",        // 2:00 UTC
      maxPages: 5,              // Kontrola 5 stránek
    },
    
    // Když najde 6-20 nových položek - častější kontroly
    manyNewItems: {
      frequency: "twice_daily",  // Dvakrát denně
      cron: "0 2,14 * * *",     // 2:00 a 14:00 UTC
      maxPages: 8,              // Kontrola 8 stránek
    },
    
    // Když najde 20+ nových položek - velmi časté kontroly
    lotsNewItems: {
      frequency: "every_6h",     // Každých 6 hodin
      cron: "0 2,8,14,20 * * *", // 2:00, 8:00, 14:00, 20:00 UTC
      maxPages: 10,             // Kontrola 10 stránek
    }
  },
  
  // Prahové hodnoty
  thresholds: {
    few: 5,      // 1-5 nových položek
    many: 20,    // 6-20 nových položek
    lots: 20     // 20+ nových položek
  }
};

/** ────────────────────────────────
 *  POMOCNÉ FUNKCE
 *  ──────────────────────────────── */
const log = (msg, ...args) => {
  console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
};

async function loadState() {
  try {
    const data = await fs.readFile(config.files.state, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveSchedule(scheduleConfig) {
  try {
    await fs.mkdir("data", { recursive: true });
    await fs.writeFile(config.files.schedule, JSON.stringify(scheduleConfig, null, 2), 'utf8');
    log(`Schedule uložen: ${scheduleConfig.frequency}`);
  } catch (error) {
    log(`Chyba při ukládání schedule: ${error.message}`);
  }
}

/** ────────────────────────────────
 *  HLAVNÍ LOGIKA
 *  ──────────────────────────────── */
function determineSchedule(newItemsCount) {
  if (newItemsCount === 0) {
    return {
      ...config.baseSchedule.noNewItems,
      reason: "Žádné nové položky - standardní denní kontrola"
    };
  } else if (newItemsCount <= config.thresholds.few) {
    return {
      ...config.baseSchedule.fewNewItems,
      reason: `${newItemsCount} nových položek - standardní denní kontrola`
    };
  } else if (newItemsCount <= config.thresholds.many) {
    return {
      ...config.baseSchedule.manyNewItems,
      reason: `${newItemsCount} nových položek - častější kontroly (2x denně)`
    };
  } else {
    return {
      ...config.baseSchedule.lotsNewItems,
      reason: `${newItemsCount} nových položek - velmi časté kontroly (každých 6h)`
    };
  }
}

function generateWorkflowContent(scheduleConfig) {
  return `name: Inkrementální CSFD Update

on:
  # Automaticky generovaný schedule - ${scheduleConfig.reason}
  schedule:
    - cron: "${scheduleConfig.cron}"
  
  # Manuální spuštění
  workflow_dispatch:
    inputs:
      mode:
        description: 'Režim spuštění'
        required: true
        default: 'incremental'
        type: choice
        options:
        - 'incremental'     # Rychlá kontrola nových položek
        - 'full-check'      # Kontrola více stránek
        - 'force-full'      # Vynutit plný scraper
      verbose:
        description: 'Detailní logování'
        required: false
        default: true
        type: boolean

jobs:
  incremental-update:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: |
          npm i
          npx playwright install --with-deps chromium

      - name: Run incremental scraper
        run: |
          VERBOSE_FLAG=""
          if [ "$\{\{ github.event.inputs.verbose \}\}" = "true" ]; then
            VERBOSE_FLAG="--verbose"
          fi
          
          case "$\{\{ github.event.inputs.mode || 'incremental' \}\}" in
            "incremental")
              echo "🚀 Inkrementální režim - kontrola ${scheduleConfig.maxPages} stránek"
              node incremental_scraper.mjs --maxPages ${scheduleConfig.maxPages}
              ;;
            "full-check")
              echo "🔍 Rozšířená kontrola - více stránek"
              node incremental_scraper.mjs --maxPages 15
              ;;
            "force-full")
              echo "🏭 Vynucení plného scraperu"
              node scrape_csfd.mjs --verbose
              ;;
            *)
              echo "❌ Neznámý režim"
              exit 1
              ;;
          esac

      - name: Compress data if changed
        if: success()
        run: |
          if [ -f "data/new_items.json" ] && [ -s "data/new_items.json" ]; then
            echo "🗜️ Komprimuji data..."
            node build_compress.mjs
          fi

      - name: Commit changes
        if: success()
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/ || true
          
          if ! git diff --cached --quiet; then
            NEW_ITEMS_COUNT=0
            if [ -f "data/new_items.json" ]; then
              NEW_ITEMS_COUNT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('data/new_items.json', 'utf8')).length)")
            fi
            
            if [ "$NEW_ITEMS_COUNT" -gt 0 ]; then
              git commit -m "🆕 Přidáno $NEW_ITEMS_COUNT nových položek [skip ci]"
            else
              git commit -m "🔄 Aktualizace dat [skip ci]"
            fi
            
            git push
          fi

      - name: Update schedule based on activity
        if: success()
        run: |
          echo "🔄 Aktualizuji schedule podle aktivity..."
          node smart_scheduler.mjs --update

      - name: Summary
        if: always()
        run: |
          echo "## 📊 CSFD Update - ${scheduleConfig.frequency}" >> $GITHUB_STEP_SUMMARY
          echo "- **Frekvence:** ${scheduleConfig.frequency}" >> $GITHUB_STEP_SUMMARY
          echo "- **Max stránek:** ${scheduleConfig.maxPages}" >> $GITHUB_STEP_SUMMARY
          echo "- **Důvod:** ${scheduleConfig.reason}" >> $GITHUB_STEP_SUMMARY
`;
}

async function updateSchedule() {
  log("🔄 Aktualizuji schedule podle aktivity...");
  
  const state = await loadState();
  if (!state) {
    log("❌ Žádný stav nenalezen - použitím výchozí schedule");
    const defaultSchedule = determineSchedule(0);
    await saveSchedule(defaultSchedule);
    return defaultSchedule;
  }
  
  const newItemsCount = state.newItemsFound || 0;
  const scheduleConfig = determineSchedule(newItemsCount);
  
  log(`📊 Nalezeno ${newItemsCount} nových položek`);
  log(`📅 Nový schedule: ${scheduleConfig.frequency} (${scheduleConfig.cron})`);
  log(`📄 Max stránek: ${scheduleConfig.maxPages}`);
  log(`💡 Důvod: ${scheduleConfig.reason}`);
  
  await saveSchedule(scheduleConfig);
  
  // Generování nového workflow souboru
  const workflowContent = generateWorkflowContent(scheduleConfig);
  await fs.writeFile(".github/workflows/incremental.yml", workflowContent, 'utf8');
  log("✅ Workflow soubor aktualizován");
  
  return scheduleConfig;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--update')) {
    await updateSchedule();
  } else if (args.includes('--status')) {
    const state = await loadState();
    if (state) {
      log("📊 Aktuální stav:");
      log(`- Poslední běh: ${state.lastRun}`);
      log(`- Nové položky: ${state.newItemsFound}`);
      log(`- Celkem položek: ${state.totalItems}`);
      log(`- Zkontrolované stránky: ${state.pagesChecked}`);
    } else {
      log("❌ Žádný stav nenalezen");
    }
  } else {
    log("Smart Scheduler - CSFD");
    log("Použití:");
    log("  node smart_scheduler.mjs --update   # Aktualizovat schedule");
    log("  node smart_scheduler.mjs --status   # Zobrazit stav");
  }
}

main().catch(error => {
  console.error("💥 Chyba:", error.message);
  process.exit(1);
});
