# ČSFD Scraper

[![Scrape CSFD](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml/badge.svg)](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml)
[![Latest CSV](https://img.shields.io/badge/data-csfd__ratings.csv-blue)](https://raw.githubusercontent.com/ludivitto/csfd-chatgpt/main/data/csfd_ratings.csv)

This repository contains a GitHub Actions workflow that automatically scrapes all my movie and TV show ratings from [ČSFD](https://www.csfd.cz/) and saves them into a CSV file.

The scraper also enriches the dataset with **IMDb links**.

## ❓ Why
The purpose of this project is to **feed ChatGPT with my ratings** so I can simply ask questions like:

- *“Have I seen film X? How did I rate it?”*  
- *“Show me my top-rated sci-fi from the last 10 years.”*  
- *“What comedies did I give 4 stars or more?”*  

Instead of browsing ČSFD manually, I can now query my dataset directly.

## 📂 Output

- Data is stored in: `data/csfd_ratings.csv` and `data/csfd_ratings.json`
- The file contains the following columns: `title, year, type, rating, ratingDate, url, imdb_id, imdb_url, original_title`
- Test runs create timestamped files: `csfd_ratings_test_<timestamp>.csv`

## 🚀 How

### Workflow
- **GitHub Actions** runs a Playwright scraper on a schedule (every Monday at 03:00 UTC) or manually.  
- It fetches all rating pages from ČSFD, extracts the relevant fields, visits detail pages to grab IMDb IDs and original titles, and commits the results.  
- **New:** Multiple testing modes available for faster iteration and debugging.
- If something fails, debug screenshots/HTML are uploaded as workflow artifacts.

### Using the data
- Open the CSV directly via the **blue badge** above
- Import into **Google Sheets**:
```excel
=IMPORTDATA("https://raw.githubusercontent.com/<USER>/<REPO>/main/data/csfd_ratings.csv")
```
- Do not forget to have your repository setup to **Public** so Google Sheets can access the .csv
- **New:** JSON format also available at `data/csfd_ratings.json` for easier programmatic access

## 🛠️ Technical Details

- Uses **[Playwright](https://playwright.dev/)** (Chromium)
- Runs inside **GitHub Actions** (`ubuntu-latest`)
- Includes minor stealth tweaks (User-Agent, `--disable-blink-features=AutomationControlled`)
- Each scraped title is enriched with its **IMDb ID**, **IMDb URL**, and **original title** (episodes and series fall back to their parent title)
- **New features:**
  - **Caching system** - speeds up repeated runs
  - **Resume functionality** - continue from interruption
  - **Retry logic** with exponential backoff
  - **Multiple testing modes** for fast iteration
  - **Progress monitoring** with detailed logging
- If the page fails to load, debug dumps are created:
  - `debug/screenshot_*.png`
  - `debug/page_*.html`
- These files are automatically uploaded as **Artifacts** in the Actions tab

## 🧪 Testing & Development

The scraper now includes multiple testing modes for fast iteration:

### Quick Testing (5-30 seconds)
```bash
# Ultra fast test - just parsing, no details
node scrape_csfd.mjs --test --skipDetails

# Test with IMDb/original title extraction (3 items)
node scrape_csfd.mjs --maxItems 3

# Test with visible browser for debugging
node scrape_csfd.mjs --test --headful --verbose
```

### Medium Testing (2-10 minutes)
```bash
# Test first page with full details
node scrape_csfd.mjs --maxPages 1 --verbose

# Test specific number of items
node scrape_csfd.mjs --maxItems 10 --verbose

# Test with resume functionality
node scrape_csfd.mjs --maxPages 5
# ... interrupt and resume:
node scrape_csfd.mjs --resume
```

### Production Run (3+ hours)
```bash
# Full scrape with all optimizations
node scrape_csfd.mjs --verbose

# Disable cache if needed
node scrape_csfd.mjs --no-cache
```

### Available Options
- `--test` - Quick test mode (1 page, 5 items, faster delays)
- `--maxPages N` - Limit to N pages
- `--maxItems N` - Stop after N items total
- `--skipDetails` - Skip IMDb/original title enrichment
- `--headful` - Show browser (for debugging)
- `--verbose` - Detailed logging
- `--resume` - Resume from previous state
- `--no-cache` - Disable caching
- `--help` - Show help

## 📝 Setup & Notes

- Ratings are fetched page by page (with configurable delays)
- Detail pages are visited to extract IMDb IDs and original titles (with limited concurrency)
- **Cache system** stores results to speed up repeated runs
- **Resume functionality** allows continuing after interruption
- If the workflow fails due to bot protection, check the `debug` artifacts

### Local Development
```bash
npm install
npx playwright install chromium

# Quick test to verify everything works
node scrape_csfd.mjs --test --skipDetails

# Test IMDb extraction
node scrape_csfd.mjs --maxItems 5 --verbose
```

## ⚡ Performance & Reliability

- **Testing modes**: From 5 seconds to full production run
- **Caching**: Repeated runs are faster thanks to smart caching
- **Resume**: Continue from where you left off after interruption
- **Retry logic**: Handles temporary failures with exponential backoff
- **Progress monitoring**: Real-time feedback on scraping progress

## ✅ With this setup

- The green badge shows whether the workflow is passing
- The blue badge links directly to the latest CSV file with ČSFD ratings + IMDb + original titles
- **Fast testing** ensures the scraper works before committing to 3+ hour runs
- And most importantly: the dataset gives ChatGPT the knowledge of what I've seen and how I rated it
