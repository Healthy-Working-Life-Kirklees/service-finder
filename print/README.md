# Printed directory

An A4 print version of the Service Finder, one service per page, built from the services on the live list (`listing.decision` is `include`).

    npm run build-print                 # writes print/out/service-finder-directory.html
    python3 scripts/render-print.py     # writes print/out/service-finder-directory.pdf (needs Playwright for Python)

Or open the HTML file in Chrome or Edge and print to A4 with "Background graphics" on.

What's in it:

- A cover with contents.
- Four indexes: all services A to Z; services in Kirklees A to Z (no national services); North Kirklees by town; South Kirklees by town.
- The services in four sections, A to Z within each: All Kirklees, North Kirklees, South Kirklees, National.

Which section a service goes in (`sectionOf` in `scripts/build-print.mjs`):

- `level` is `national`: National.
- Only North Kirklees towns (Batley, Dewsbury, Mirfield, Spen Valley) in `areas`: North Kirklees.
- Only South Kirklees towns (Huddersfield, Colne Valley, Holme Valley, Kirkburton): South Kirklees.
- Anything else (towns in both halves, or Kirklees-wide with no town, including regional services): All Kirklees.

In the PDF and the HTML, every index entry links to that service's page, the contents on the cover link to each index and section, and "Service Finder" at the top of each page links back to the contents.

Long entries are shrunk to fit one page by a small script in the page. `render-print.py` lists any page that still doesn't fit.

The Service Finder's own web address and QR code are left off the cover until the site is public. Set `SHOW_SITE_LINK = true` in `scripts/build-print.mjs` to put them back; the space for them is kept.

Files: `print/styles/base.css` (page geometry; the index row heights are fixed because the script works out index page numbers from them), `print/styles/directory.css` (the look), `print/assets/hwl-logo.png` (the Healthy Working Life logo). The output in `print/out/` isn't committed.
