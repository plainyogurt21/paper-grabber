#!/usr/bin/env python3
"""
test_runner.py — headless browser test for Paper Grabber scraper logic.

Usage:
  python3 test_runner.py                    # runs against local test_page.html
  python3 test_runner.py <url> [<url>...]   # also test real journal URLs
"""

import sys
import json
import pathlib
from playwright.sync_api import sync_playwright

# ── Load the scraper JS (strips the chrome.runtime listener at the bottom) ──
SCRAPER_JS_PATH = pathlib.Path(__file__).parent / "content.js"
raw_js = SCRAPER_JS_PATH.read_text()
# Remove the chrome.runtime.onMessage block — won't exist in plain browser context
scraper_js = raw_js.split("chrome.runtime.onMessage")[0].strip()

# JS that calls the scraper and returns results as JSON
INVOKE_JS = scraper_js + """
(function() {
  const metadata = extractMetadata();
  const pdfLinks = findPDFLinks();
  return JSON.stringify({ metadata, pdfLinks });
})();
"""

TYPE_COLOR = {
    "main":       "\033[92m",   # green
    "supplement": "\033[94m",   # blue
    "pdf":        "\033[95m",   # purple
}
RESET = "\033[0m"
BOLD  = "\033[1m"
DIM   = "\033[2m"
RED   = "\033[91m"
YELLOW = "\033[93m"


def run_scraper(page, url_or_path: str) -> dict:
    if url_or_path.startswith("http"):
        page.goto(url_or_path, wait_until="domcontentloaded", timeout=20_000)
    else:
        page.goto(f"file://{url_or_path}", wait_until="domcontentloaded")
    return json.loads(page.evaluate(INVOKE_JS))


def print_report(label: str, result: dict):
    meta = result["metadata"]
    links = result["pdfLinks"]

    print(f"\n{'='*60}")
    print(f"{BOLD}{label}{RESET}")
    print(f"{'='*60}")
    print(f"  {BOLD}baseName :{RESET} {meta['baseName']}")
    print(f"  {BOLD}author   :{RESET} {meta['firstAuthor']}")
    print(f"  {BOLD}year     :{RESET} {meta['year']}")
    print(f"  {BOLD}title    :{RESET} {meta['title'][:70]}")
    print(f"\n  {BOLD}Links found: {len(links)}{RESET}")

    if not links:
        print(f"  {RED}⚠  No links scored ≥ 20. Check scraper keywords.{RESET}")
        return

    for i, lnk in enumerate(links):
        color = TYPE_COLOR.get(lnk["type"], "")
        score = lnk["score"]
        score_str = f"{YELLOW}score={score}{RESET}" if score < 50 else f"score={score}"
        short_url = lnk["url"].split("//")[-1][:65]
        label_str = lnk.get("label", "")[:50]
        print(f"\n  [{i+1}] {color}[{lnk['type']}]{RESET}  {score_str}")
        print(f"       url   : {DIM}{short_url}{RESET}")
        if label_str:
            print(f"       label : {label_str}")

    # Quick sanity checks
    types = [l["type"] for l in links]
    if "main" not in types:
        print(f"\n  {YELLOW}⚠  No 'main' PDF detected — may need meta tag or keyword tweak.{RESET}")
    if "supplement" not in types:
        print(f"  {YELLOW}⚠  No supplement links detected.{RESET}")
    else:
        n_supp = types.count("supplement")
        print(f"\n  {BOLD}✓{RESET}  {n_supp} supplement(s) found")

    # Flag suspiciously low-score items
    borderline = [l for l in links if l["score"] < 40]
    if borderline:
        print(f"  {YELLOW}⚠  {len(borderline)} borderline link(s) with score < 40 — review manually{RESET}")


def main():
    here = pathlib.Path(__file__).parent
    default_pages = [
        here / "test_page.html",      # JCO-style, full meta tags
        here / "test_nature.html",    # Nature, no citation_pdf_url
        here / "test_elsevier.html",  # ScienceDirect, supplements in sidebar
        here / "test_biorxiv.html",   # bioRxiv, supplements at bottom
        here / "test_jhepat.html",    # J Hepatol, real reference + footer HTML
    ]
    extra_urls = [a for a in sys.argv[1:] if a.startswith("http")]
    targets = [str(p) for p in default_pages] + extra_urls

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        )
        page = context.new_page()

        for target in targets:
            label = pathlib.Path(target).name if not target.startswith("http") else target
            try:
                result = run_scraper(page, target)
                print_report(label, result)
            except Exception as e:
                print(f"\n{RED}ERROR on {label}: {e}{RESET}")

        browser.close()

    print(f"\n{'='*60}\nDone.\n")


if __name__ == "__main__":
    main()
