# ČSFD Scraper

[![Scrape CSFD](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml/badge.svg)](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml)
[![Latest CSV](https://img.shields.io/badge/data-csfd__ratings.csv-blue)](https://raw.githubusercontent.com/ludivitto/csfd-chatgpt/main/data/csfd_ratings.csv)

This repository contains a GitHub Actions workflow that automatically scrapes all my movie and TV show ratings from [ČSFD](https://www.csfd.cz/) and saves them into a CSV file.

The scraper also enriches the dataset with **IMDb links** and **original titles** with advanced optimizations for performance and reliability.

## ❓ Why
The purpose of this project is to **feed ChatGPT with my ratings** so I can simply ask questions like:

- *“Have I seen film X? How did I rate it?”*  
- *“Show me my top-rated sci-fi from the last 10 years.”*  
- *“What comedies did I give 4 stars or more?”*  

Instead of browsing ČSFD manually, I can now query my dataset directly.

## 📂 Output

- **Main data**: `data/csfd_ratings.csv` and `data/csfd_ratings.json`
- **Columns**: `title, year, type, rating, ratingDate, url, imdb_id, imdb_url, original_title`
- **Test files**: `csfd_ratings_test_<timestamp>.csv/json` for safe testing
- **Cache & State**: `scraper_cache.json` and `scraper_state.json` for optimizations

## 🚀 How

### 🤖 GitHub Actions Workflow
- **Automatic run**: Every Monday at 03:00 UTC (`cron: "0 3 * * 1"`)
- **Manual trigger**: Via GitHub Actions tab with mode selection:
  - 🚀 **ultra-fast** (~30s) - parsing only, no enrichment
  - 🧪 **test-small** (~2min) - 10 items with full details
  - 📄 **test-medium** (~5min) - 2 pages
  - 📋 **test-large** (~15min) - 5 pages
  - 🏭 **production** (3+ hrs) - complete dataset
- **Smart commit**: Only commits when data actually changes
- **Verbose logging**: Optional detailed logging
- **Debug artifacts**: Auto-uploads screenshots and HTML for analysis on errors
- **Robust**: Continues even with individual page failures

### Using the data
- Open the CSV directly via the **blue badge** above
- Import into **Google Sheets**:
```excel
=IMPORTDATA("https://raw.githubusercontent.com/<USER>/<REPO>/main/data/csfd_ratings.csv")
```
- Do not forget to have your repository setup to **Public** so Google Sheets can access the .csv
- **New:** JSON format also available at `data/csfd_ratings.json` for easier programmatic access

## 🛠️ Technical Details

### Core Architecture
- Uses **[Playwright](https://playwright.dev/)** (Chromium) for web scraping
- Runs inside **GitHub Actions** (`ubuntu-latest`) with automatic scheduled execution
- **Modular design** with clearly separated functions for parsing, enrichment and storage
- **Worker pool pattern** for parallel detail page processing (4 workers)

### Stealth & Anti-Detection
- Includes stealth tweaks:
  - Custom User-Agent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125`
  - `--disable-blink-features=AutomationControlled`
  - Locale set to `cs-CZ`
  - Intelligent cookie consent handling

### Data Enrichment
- Each scraped title is enriched with **IMDb ID**, **IMDb URL**, and **original title**
- **Robust extraction strategies**:
  - Multiple CSS selectors (up to 9 fallback options for IMDb)
  - JSON-LD metadata parsing
  - HTML regex fallback
  - Parent page fallback for episodes/series

### Performance Optimizations
- **Smart caching system** - speeds up repeated runs by up to 70%
- **Resume functionality** - continue from interruption using state management
- **Retry logic** with exponential backoff (3 attempts, 1s→2s→4s delay)
- **Batch processing** with periodic cache saves (every 25 items)
- **Adaptive delays** - faster for test modes, slower for production

### Error Handling & Debugging
- **Graceful degradation** - continues even with individual page errors
- Automatic debug dumps on errors:
  - `debug/screenshot_*.png` - screenshot of problematic page
  - `debug/page_*.html` - HTML content for analysis
  - `debug/error.txt` - detailed error log
- Debug artifacts are automatically uploaded as **GitHub Actions Artifacts**

### Memory & Resource Efficiency
- **Streaming approach** - processes data progressively instead of loading everything into memory
- **Connection pooling** - efficient browser context management
- **Cleanup automation** - automatic closing of pages and browser instances

## 🧪 Testing & Development

The scraper includes a multi-level testing system for fast iteration and development:

### 🚀 Ultra Fast Testing (5-30 seconds)
```bash
# Fastest test - parsing only, no enrichment
node scrape_csfd.mjs --test --skipDetails

# Test with IMDb/original title extraction (3 items)
node scrape_csfd.mjs --maxItems 3

# Test with visible browser for debugging
node scrape_csfd.mjs --test --headful --verbose

# Test resume functionality
node scrape_csfd.mjs --maxItems 5
# ... interrupt with Ctrl+C and resume:
node scrape_csfd.mjs --resume
```

### 🧪 Medium Testing (2-10 minutes)
```bash
# Test first page with full details
node scrape_csfd.mjs --maxPages 1 --verbose

# Test specific number of items
node scrape_csfd.mjs --maxItems 10 --verbose

# Test multiple pages with resume
node scrape_csfd.mjs --maxPages 5
# ... interrupt and resume:
node scrape_csfd.mjs --resume --verbose

# Test without cache (for debugging cache issues)
node scrape_csfd.mjs --maxItems 10 --no-cache
```

### 🏭 Production Run (3+ hours)
```bash
# Full scrape with all optimizations
node scrape_csfd.mjs --verbose

# Resume interrupted production run
node scrape_csfd.mjs --resume --verbose

# Disable cache (fresh start)
node scrape_csfd.mjs --no-cache --verbose
```

### 🤖 GitHub Actions Modes
The following modes are available in the GitHub Actions workflow:

- **ultra-fast** (~30s): `--test --skipDetails` - basic parsing only
- **test-small** (~2min): `--maxItems 10` - small test with enrichment  
- **test-medium** (~5min): `--maxPages 2` - medium test
- **test-large** (~15min): `--maxPages 5` - larger test
- **production** (3+ hrs): Full run with all data

The workflow can be triggered manually in the GitHub Actions tab with mode selection.

### ⚙️ Available CLI Options
| Option | Description | Default |
|--------|-------------|----------|
| `--test` | Quick test mode (1 page, 5 items, faster delays) | false |
| `--maxPages N` | Limit to N pages | 2000 |
| `--maxItems N` | Stop after N items total | unlimited |
| `--skipDetails` | Skip IMDb/original title enrichment | false |
| `--headful` | Show browser (for debugging) | false |
| `--verbose` | Detailed logging and progress | false |
| `--resume` | Resume from previous state | false |
| `--no-cache` | Disable caching system | false |
| `--help` | Show help and exit | - |

### 🔍 Performance Benchmarks
| Mode | Time | Items | Usage |
|------|------|-------|-------|
| `--test --skipDetails` | ~30s | 5 | Quick parsing logic validation |
| `--maxItems 10` | ~2min | 10 | Test enrichment + IMDb extraction |
| `--maxPages 2` | ~5min | ~200 | Medium test with representative sample |
| `--maxPages 5` | ~15min | ~500 | Larger test before production |
| Full run | 3+ hrs | 8000+ | Complete dataset |

**Cache performance**: Repeated runs are up to **70% faster** thanks to smart caching system.

## 📝 Setup & Development

### 🚀 Quick Start
```bash
# Instalační dependencí a Playwright
npm install
npx playwright install chromium

# Nejrychle jší test - ověření že vše funguje (~30s)
node scrape_csfd.mjs --test --skipDetails

# Test s IMDb extraction (~2min)
node scrape_csfd.mjs --maxItems 5 --verbose

# Střední test pro vývoj (~5min)
node scrape_csfd.mjs --maxPages 2 --verbose
```

### 🏢 Production Architecture
- **Paginated scraping**: Postupné čtení stránek s konfiguratelnými delays
- **Concurrent detail processing**: Paralelní zpracování detail stránek (4 workers)
- **Smart caching**: Persistent cache pro IMDb data a original titles
- **State management**: Resume functionality s automatickým ukládáním progress
- **Robust error handling**: Graceful degradation s retry logikou

### 🚫 Anti-Detection Strategy
- **Human-like behavior**: Random delays, realistic browsing patterns
- **Stealth browser**: Disabled automation features, custom User-Agent
- **Intelligent cookie handling**: Automatické přijetí GDPR cookies
- **Rate limiting**: Respektuje server load s adaptive delays

### 🛠️ Troubleshooting
- **Bot protection**: Zkontrolujte `debug` artifacts v GitHub Actions
- **Cache issues**: Použijte `--no-cache` pro fresh start
- **Resume problems**: Smažte `data/scraper_state.json` pro clean restart
- **IMDb extraction fails**: Zkontrolujte debug screenshots v `debug/` adresáři

### 📈 Performance Tips
- **První běh**: Počítejte s 3+ hodinami pro kompletní dataset
- **Opakované běhy**: Díky cache až 70% rychlejší
- **Test režimy**: Použijte `--test` nebo `--maxItems` pro rychlé ověření
- **Resume**: Přerušené běhy pokračujte s `--resume`

## ⚡ Performance & Reliability

### 🚀 Performance Optimizations
- **Smart Caching System**: 
  - 📁 Cache pro IMDb data a original titles
  - 🔄 Opakované běhy až **70% rychlejší**
  - 💾 Periodické ukládání každých 25 položek
  - 🧺 JSON cache formát pro rychlý přístup

- **Worker Pool Architecture**:
  - 👥 4 paralelní workers pro detail stránky 
  - 🔄 Intelligent task distribution
  - ⏱️ Adaptive delays podle režimu (50ms test, 250ms produkce)

- **Adaptive Performance**:
  - 🏎️ Rychlé nastavení pro test režimy
  - 🐢 Konzervativní nastavení pro produkci
  - 📈 Batch processing s optimalizovanými dávkami

### 🛡️ Reliability Features
- **Resume Functionality**: 
  - 💾 State management - pokračování přesně tam, kde jste skončili
  - ♾️ Automatické čištění state souborů po úspěšném dokončení
  - 🔁 Zachování progress mezi restartováními

- **Advanced Retry Logic**:
  - 🔄 3 pokusy s exponential backoff (1s → 2s → 4s)
  - 🎯 Context-aware error handling
  - 🛡️ Graceful degradation při selhání jednotlivých stránek

- **Real-time Monitoring**:
  - 📊 Progress tracking s detailními metrikami
  - 🔍 Verbose logging pro debugging
  - 📈 Cache hit rate monitoring
  - ⏱️ Performance benchmarks

### 🔄 Testing Spectrum
| 🎯 Cíl | ⏱️ Čas | 📁 Možnosti | 🔧 Použití |
|---------|--------|-----------|----------|
| Quick validation | 5-30s | `--test --skipDetails` | Ověření parsing logiky |
| Feature testing | 2-10min | `--maxItems 10-50` | Test nových features |
| Integration testing | 10-30min | `--maxPages 2-5` | Před produkčním nasazením |
| Full production | 3+ hod | bez omezení | Kompletní dataset update |

## ✅ Výsledek

### 🎯 Co tohle řešení poskytuje:
- 🟢 **Status badge**: Zelený badge ukazuje, zda workflow funguje
- 🔵 **Direct access**: Modrý badge vede přímo k nejnovějšímu CSV s ČSFD hodnoceními + IMDb + originální názvy  
- ⚡ **Rychlé testování**: Ověření funkčnosti během sekund místo hodin
- 🤖 **AI-ready dataset**: ChatGPT má přístup k tomu, co jsem viděl a jak jsem to hodnotil

### 🚀 Klíčové vylepšení:
- **70% rychlejší opakované běhy** díky smart caching systému
- **Resume functionality** - pokračování tam, kde jste skončili
- **Robustní error handling** s automatickými retry pokusy  
- **Flexible testing modes** - od 30 sekund po 3+ hodin
- **Production-ready** architektura s worker pools a monitoring

### 💡 Pro ChatGPT:
Teď můžu jednoduše ptát:
- *"Viděl jsem film X? Jak jsem ho hodnotil?"*
- *"Ukaž mi nejlépe hodnocené sci-fi z posledních 10 let."*  
- *"Jaké komedie jsem dal 4 hvězdičky nebo více?"*
- *"Doporuč mi něco podobného filmu Y, který jsem hodnotil vysoko."*

**A dataset je vždy aktuální díky automatickému weekly scrapingu! 🎉**
