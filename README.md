# ČSFD Scraper

[![Scrape CSFD](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml/badge.svg)](https://github.com/ludivitto/csfd-chatgpt/actions/workflows/scrape.yml)
[![Latest CSV](https://img.shields.io/badge/data-csfd__ratings.csv-blue)](https://raw.githubusercontent.com/ludivitto/csfd-chatgpt/main/data/csfd_ratings.csv)

This repository contains a GitHub Actions workflow that automatically scrapes all my movie and TV show ratings from [ČSFD](https://www.csfd.cz/) and saves them into a CSV file.

The scraper also enriches the dataset with **IMDb links**.

## 📂 Output

- Data is stored in: `data/csfd_ratings.csv`
- The file contains the following columns: `title, year, type, rating, ratingDate, url, imdb_id, imdb_url`

## 🚀 How to Run

### Manually
1. Go to the **Actions** tab in GitHub
2. Select the **Scrape CSFD** workflow
3. Click **Run workflow**
4. After it finishes, the updated `csfd_ratings.csv` will be committed to the repo

### Automatically
- The workflow is scheduled to run every Monday at **03:00 UTC**
- You can adjust the interval in `.github/workflows/scrape.yml` under the `schedule` section

## 🛠️ Technical Details

- Uses **[Playwright](https://playwright.dev/)** (Chromium)
- Runs inside **GitHub Actions** (`ubuntu-latest`)
- Includes minor stealth tweaks (User-Agent, `--disable-blink-features=AutomationControlled`)
- Each scraped title is enriched with its **IMDb ID** and **IMDb URL** (episodes and series fall back to their parent title)
- If the page fails to load, debug dumps are created:
  - `debug/screenshot_*.png`
  - `debug/page_*.html`
- These files are automatically uploaded as **Artifacts** in the Actions tab

## 📝 Notes

- Ratings are fetched page by page (with a short delay between requests)
- Detail pages are visited to extract IMDb IDs (with limited concurrency to avoid bans)
- If the workflow fails due to bot protection, check the `debug` artifacts to see what the page looked like
- You can also run the scraper locally:

```bash
npm install
npx playwright install chromium
node scrape_csfd.mjs
```

## ✅ With this setup

- The green badge shows whether the workflow is passing
- The blue badge links directly to the latest CSV file with ČSFD ratings + IMDb enrichment
