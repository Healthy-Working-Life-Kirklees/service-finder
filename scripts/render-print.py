"""Turns print/out/service-finder-directory.html into an A4 PDF with headless Chromium.

    node scripts/build-print.mjs && python3 scripts/render-print.py

Needs Playwright for Python (pip install playwright && playwright install chromium).
Reports any service page whose text still overflows after shrinking.
"""
import pathlib
import sys

from playwright.sync_api import sync_playwright

OUT = pathlib.Path(__file__).resolve().parent.parent / "print" / "out"
keys = ["directory"]

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    for k in keys:
        html = OUT / f"service-finder-{k}.html"
        page.goto(html.as_uri())
        page.wait_for_selector("html[data-fitted=yes]")
        page.evaluate("document.fonts.ready")
        over = page.eval_on_selector_all(".page[data-overflow=yes]", "els => els.map(e => e.id + ' ' + e.dataset.short)")
        small = page.eval_on_selector_all(".page.svc", "els => els.filter(e => +e.dataset.size < 100).map(e => e.id + ' ' + e.dataset.size + '%' + (e.classList.contains('compact') ? ' compact' : ''))")
        print(k, small)
        n = page.eval_on_selector_all(".page", "els => els.length")
        pdf = html.with_suffix(".pdf")
        page.pdf(path=str(pdf), prefer_css_page_size=True, print_background=True)
        print(f"design {k}: {n} pages -> {pdf.name}" + (f"  OVERFLOW: {over}" if over else ""))
    browser.close()
