# Paper Grabber

A Chrome extension (Manifest V3) that downloads a paper and its supplementary
material in one click, naming files `Author_Year_Title`.

## Features

- One-click download of a paper plus its supplement
- Automatic filename generation in `Author_Year_Title` format
- Works across publisher sites (Nature, Elsevier, bioRxiv, J Hepatology, and more)

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this folder

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `popup.html` / `popup.js` | Toolbar popup UI and logic |
| `content.js` | Page scraping (metadata + download links) |
| `background.js` | Download orchestration / service worker |
| `merge_watcher.py` | Helper script to merge downloaded paper + supplement |
| `test_*.html` | Saved publisher pages used for local testing |
| `test_runner.py` | Local test harness |
