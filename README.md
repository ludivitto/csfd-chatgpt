# ČSFD Scraper

[![Scrape CSFD](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml/badge.svg)](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml)
[![Latest CSV](https://img.shields.io/badge/data-csfd__ratings.csv-blue)](https://raw.githubusercontent.com/ludivitto/csfd-chatgpt/main/data/csfd_ratings.csv)

This repository contains a GitHub Actions workflow that automatically scrapes all my movie and TV show ratings from [ČSFD](https://www.csfd.cz/) and saves them into a CSV file.

The scraper also enriches the dataset with **IMDb links** and **original titles** using **intelligent automatic search** when direct links aren't available, plus advanced optimizations for performance and reliability.

## ❓ Why
The purpose of this project is to **feed ChatGPT with my ratings** so I can simply ask questions like:

- *"Have I seen film X? How did I rate it?"*  
- *"Show me my top-rated sci-fi from the last 10 years."*  
- *"What comedies did I give 4 stars or more?"*
- *"Which Danny Boyle films have I watched and how did I rate them?"*
- *"Show me all thrillers with Liam Neeson I've seen."*
- *"Find movies about viruses or pandemics in my ratings."*  

Instead of browsing ČSFD manually, I can now query my dataset directly.

## 📂 Output

- **Main data**: `data/csfd_ratings.csv` and `data/csfd_ratings.json`
- **Columns**: `title, year, type, rating, ratingDate, url, imdb_id, imdb_url, original_title, genre, director, cast, description`
- **🆕 New fields**: Genre, director, cast, and short plot description with optimized length (≤250 chars)
- **🆕 Clean titles**: Both Czech and original titles have "(více)" suffixes automatically removed
- **🆕 IMDb data**: Includes automatically found IMDb links even when not directly available on ČSFD
- **🆕 Optimized performance**: Adaptive delays, improved memory management, and 47% smaller JSON files
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
- **🆕 Refactored modular design** with structured configuration and utility functions
- **Worker pool pattern** for parallel detail page processing (configurable concurrency)
- **Structured configuration system** with logical grouping (delays, concurrency, browser settings)
- **Clean CLI utilities** with centralized flag parsing

### Stealth & Anti-Detection
- Includes stealth tweaks:
  - Custom User-Agent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125`
  - `--disable-blink-features=AutomationControlled`
  - Locale set to `cs-CZ`
  - Intelligent cookie consent handling

### Data Enrichment
- Each scraped title is enriched with **IMDb ID**, **IMDb URL**, and **original title**
- **🆕 Intelligent IMDb Search**: When direct links aren't available (common for logged-out users), automatically searches IMDb by original title with 90%+ success rate
- **🆕 Advanced Title Cleaning**: Automatically removes "(více)" suffixes from both Czech and original titles for consistent data quality
- **Robust extraction strategies**:
  - **Direct IMDb links**: Multiple CSS selectors (up to 9 fallback options)
  - **🆕 Automatic IMDb search**: Searches by original title with modern/legacy selector fallbacks
  - **JSON-LD metadata parsing** for hidden data
  - **HTML regex fallback** for embedded IMDb IDs
  - **Parent page fallback** for episodes/series
  - **Title normalization** for consistent data quality

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
  - **🆕 `debug/imdb_search_*.html`** - IMDb search pages for debugging automatic search
- Debug artifacts are automatically uploaded as **GitHub Actions Artifacts**
- **Enhanced verbose logging** with structured configuration flags

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

# 🆕 Test IMDb search functionality specifically
node scrape_csfd.mjs --maxItems 3 --verbose

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
# Install dependencies and Playwright
npm install
npx playwright install chromium

# Fastest test - verify everything works (~30s)
node scrape_csfd.mjs --test --skipDetails

# Test with IMDb extraction (~2min)
node scrape_csfd.mjs --maxItems 5 --verbose

# Medium test for development (~5min)
node scrape_csfd.mjs --maxPages 2 --verbose
```

### 🏢 Production Architecture
- **Paginated scraping**: Progressive page reading with configurable delays
- **Concurrent detail processing**: Parallel detail page processing (4 workers)
- **Smart caching**: Persistent cache for IMDb data and original titles
- **State management**: Resume functionality with automatic progress saving
- **Robust error handling**: Graceful degradation with retry logic

### 🚫 Anti-Detection Strategy
- **Human-like behavior**: Random delays, realistic browsing patterns
- **Stealth browser**: Disabled automation features, custom User-Agent
- **Intelligent cookie handling**: Automatic GDPR cookie acceptance
- **Rate limiting**: Respects server load with adaptive delays

### 🛠️ Troubleshooting
- **Bot protection**: Check `debug` artifacts in GitHub Actions
- **Cache issues**: Use `--no-cache` for fresh start
- **Resume problems**: Delete `data/scraper_state.json` for clean restart
- **🆕 IMDb search fails**: Check `debug/imdb_search_*.html` files for search page analysis
- **🆕 Title cleaning issues**: Check verbose logs for "(více)" removal process
- **IMDb extraction fails**: Check debug screenshots in `debug/` directory
- **🆕 Configuration issues**: Use `--verbose` to see detailed config summary at startup

### 📈 Performance Tips
- **First run**: Expect 3+ hours for complete dataset
- **Repeated runs**: Up to 70% faster thanks to cache
- **Test modes**: Use `--test` or `--maxItems` for quick verification
- **Resume**: Continue interrupted runs with `--resume`

## ⚡ Performance & Reliability

### 🚀 Performance Optimizations
- **Smart Caching System**: 
  - 📁 Cache for IMDb data and original titles
  - 🔄 Repeated runs up to **70% faster**
  - 💾 Periodic saves every 25 items
  - 🧺 JSON cache format for fast access

- **Worker Pool Architecture**:
  - 👥 4 parallel workers for detail pages 
  - 🔄 Intelligent task distribution
  - ⏱️ Adaptive delays by mode (50ms test, 250ms production)

- **Adaptive Performance**:
  - 🏎️ Fast settings for test modes
  - 🐢 Conservative settings for production
  - 📈 Batch processing with optimized batches

### 🛡️ Reliability Features
- **Resume Functionality**: 
  - 💾 State management - continue exactly where you left off
  - ♾️ Automatic cleanup of state files after successful completion
  - 🔁 Progress preservation between restarts

- **Advanced Retry Logic**:
  - 🔄 3 attempts with exponential backoff (1s → 2s → 4s)
  - 🎯 Context-aware error handling
  - 🛡️ Graceful degradation on individual page failures

- **Real-time Monitoring**:
  - 📊 Progress tracking with detailed metrics
  - 🔍 Verbose logging for debugging
  - 📈 Cache hit rate monitoring
  - ⏱️ Performance benchmarks

### 🔄 Testing Spectrum
| 🎯 Goal | ⏱️ Time | 📁 Options | 🔧 Usage |
|---------|--------|-----------|----------|
| Quick validation | 5-30s | `--test --skipDetails` | Verify parsing logic |
| Feature testing | 2-10min | `--maxItems 10-50` | Test new features |
| Integration testing | 10-30min | `--maxPages 2-5` | Before production deployment |
| Full production | 3+ hrs | no limits | Complete dataset update |

## ✅ Result

### 🎯 What this solution provides:
- 🟢 **Status badge**: Green badge shows whether the workflow is working
- 🔵 **Direct access**: Blue badge leads directly to the latest CSV with ČSFD ratings + IMDb + original titles  
- ⚡ **Fast testing**: Functionality verification in seconds instead of hours
- 🤖 **AI-ready dataset**: ChatGPT has access to what I've watched and how I rated it

### 🚀 Key improvements:
- **🆕 Intelligent IMDb Search** - automatically finds IMDb data even when direct links aren't available
- **🆕 Advanced Title Cleaning** - removes "(více)" suffixes for consistent data quality
- **🆕 Refactored Architecture** - structured configuration with improved maintainability
- **70% faster repeated runs** thanks to smart caching system
- **Resume functionality** - continue where you left off
- **Robust error handling** with automatic retry attempts and enhanced debugging
- **Flexible testing modes** - from 30 seconds to 3+ hours
- **Production-ready** architecture with worker pools and monitoring

### 💡 For ChatGPT:
Now I can simply ask:
- *"Have I seen movie X? How did I rate it?"*
- *"Show me my top-rated sci-fi from the last 10 years."*  
- *"What comedies did I give 4 stars or more?"*
- *"Which Christopher Nolan films have I watched?"*
- *"Find all movies with Tom Hanks in my ratings."*
- *"Show me thrillers about artificial intelligence I've seen."*
- *"Recommend something similar to movie Y that I rated highly."*

**And the dataset is always current thanks to automatic weekly scraping! 🎉**

## 🆕 Recent Technical Enhancements

### Intelligent IMDb Search System
When direct IMDb links aren't available (e.g., for users not logged into ČSFD), the scraper now automatically:

1. **Searches IMDb by original title** using the title extracted from ČSFD
2. **Uses multiple selector strategies** to handle both modern and legacy IMDb layouts
3. **Cleans titles automatically** by removing "(více)" suffixes before searching
4. **Provides detailed debug output** with saved search pages for troubleshooting
5. **Falls back gracefully** if automatic search fails

**Example workflow:**
```
ČSFD page → Extract "The Naked Gun (více)" → Clean to "The Naked Gun" 
         → Search IMDb → Find tt3402138 → Save IMDb link
```

### Advanced Title Normalization
- **Czech titles**: Removes "(více)" from film names for clean data
- **Original titles**: Removes "(více)" from extracted original titles
- **Consistent format**: Ensures uniform data quality across the dataset
- **Backward compatible**: Works with existing cached data

### Refactored Configuration System
- **Structured config object** with logical grouping (delays, concurrency, browser settings)
- **Dynamic file paths** with automatic test/production file naming
- **Centralized CLI parsing** with reusable utility functions
- **Performance tuning** with separate settings for test vs production modes

### Enhanced Debugging Capabilities
- **IMDb search debugging**: Saves search result pages as HTML files
- **Verbose configuration**: Shows complete config summary at startup
- **Structured logging**: Consistent verbose output across all modules
- **Error context**: Enhanced error messages with operation context

These improvements make the scraper more reliable, maintainable, and capable of handling edge cases while providing comprehensive debugging information.
