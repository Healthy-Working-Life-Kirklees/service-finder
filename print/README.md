# Printed directory

An A4 print version of the Service Finder, one service per page, built from the services on the live list (`listing.decision` is `include`).

    npm run build-print                 # writes print/out/service-finder-directory.html
    python3 scripts/render-print.py     # writes print/out/service-finder-directory.pdf (needs Playwright for Python)

Or open the HTML file in Chrome or Edge and print to A4 with "Background graphics" on.

## On the website

The site has its own copy at `directory.html`, linked from the "Printable directory" button in the main page's top bar, before the language selector (on a phone, a printer icon at the end of the logo row). The Pages workflow builds it on every deploy with

    node scripts/build-print.mjs --site _site

so it always matches the live list. The website version uses the site's fonts and logos (`site/fonts/`, `site/img/logos/`) and keeps its script and styles in `directory.js` and `directory.css`, because the site's security policy blocks inline ones. It has a bar at the top with a link back to the finder, a search box and a "Print the whole directory" button; the bar doesn't print. The search looks through each service's name, organisation, page text, categories and areas (words match from their start, every word has to match, name matches come first), and choosing a result jumps to its page. It's in the standalone HTML file too. On a phone the A4 pages are scaled down to fit the screen.

To try it locally: `mkdir -p _site && cp -r site/. _site/ && node scripts/build-print.mjs --site _site`, then serve `_site/` (for example `npx serve _site`). `_site/` is git-ignored.

The page is in English only, like the scheme details. The link text on the main page is translated; the Polish and Urdu wording is a first draft for the translator to check.

What's in it:

- A cover with contents.
- Four indexes: all services A to Z; services in Kirklees A to Z (no national services); North Kirklees by town; South Kirklees by town.
- The services in four sections, A to Z within each: All Kirklees, North Kirklees, South Kirklees, National.

Which section a service goes in (`sectionOf` in `scripts/build-print.mjs`):

- `level` is `national`: National.
- Only North Kirklees towns (Batley, Dewsbury, Mirfield, Spen Valley) in `areas`: North Kirklees.
- Only South Kirklees towns (Huddersfield, Colne Valley, Holme Valley, Kirkburton): South Kirklees.
- Anything else (towns in both halves, or Kirklees-wide with no town, including regional services): All Kirklees.

In the PDF and the HTML, every index entry links to that service's page, the contents on the cover link to each index and section, and the logo and "Service Finder" at the top of each page link back to the contents. In the HTML (not the PDF), each service page also has a "Print this page" button that prints just that service; it doesn't show on paper.

Long entries are shrunk to fit one page by a small script in the page. `render-print.py` lists any page that still doesn't fit.

The Service Finder's own web address and QR code are left off the cover until the site is public. Set `SHOW_SITE_LINK = true` in `scripts/build-print.mjs` to put them back; the space for them is kept.

Files: `print/styles/base.css` (page geometry; the index row heights are fixed because the script works out index page numbers from them), `print/styles/directory.css` (the look), `print/assets/hwl-logo.png` (the Healthy Working Life logo). The output in `print/out/` isn't committed.
