// Makes the PDF of the printable directory for the website, so people can download it instead of printing.
//
//   node scripts/render-print-pdf.mjs _site
//
// Run after `node scripts/build-print.mjs --site _site` (the Pages workflow does both on every deploy). It serves the
// assembled site folder on a local port, opens directory.html in Chrome, waits for the page to fit long services onto
// one page and for the fonts, and saves A4 pages to <folder>/support-finder-directory.pdf. Then it shows the
// "Download PDF" link on directory.html (it's hidden until a PDF exists), with the file size.
//
// It uses the Google Chrome already installed on GitHub's runners (playwright-core, no browser download). Elsewhere, set
// CHROME_PATH to a Chrome or Chromium executable. If anything fails it exits with an error and leaves the link hidden;
// the workflow carries on, so a PDF problem never stops the site deploying.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

export const PDF_NAME = 'support-finder-directory.pdf';

const dir = path.resolve(process.argv[2] || '_site');
const page = path.join(dir, 'directory.html');
if (!fs.existsSync(page)) throw new Error(`No directory.html in ${dir}. Run node scripts/build-print.mjs --site ${process.argv[2] || '_site'} first.`);

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
try {
  const tab = await browser.newPage();
  const problems = [];
  tab.on('pageerror', (e) => problems.push(e.message));
  tab.on('requestfailed', (r) => problems.push('could not load ' + r.url()));
  tab.on('response', (r) => { if (r.status() >= 400) problems.push(r.status() + ' ' + r.url()); });
  await tab.goto(base + 'directory.html', { waitUntil: 'networkidle' });
  await tab.waitForSelector('html[data-fitted=yes]', { timeout: 60000 });
  await tab.evaluate(() => document.fonts.ready);
  if (problems.length) throw new Error('The directory page had problems:\n  ' + problems.join('\n  '));

  const pages = await tab.$$eval('.page', (els) => els.length);
  const over = await tab.$$eval('.page[data-overflow=yes]', (els) => els.map((e) => e.id));
  const out = path.join(dir, PDF_NAME);
  await tab.pdf({ path: out, preferCSSPageSize: true, printBackground: true });

  // Show the download link now there's a PDF to download.
  const mb = (fs.statSync(out).size / 1048576).toFixed(1);
  const html = fs.readFileSync(page, 'utf8');
  const shown = html.replace(/<a class="sb-pdf"([^>]*) hidden data-pdf-link>Download PDF<\/a>/, `<a class="sb-pdf"$1 data-pdf-link>Download PDF (${mb} MB)</a>`);
  if (shown === html) throw new Error('Made the PDF but could not find the hidden Download PDF link in directory.html.');
  fs.writeFileSync(page, shown);

  console.log(`${PDF_NAME}: ${pages} A4 pages, ${mb} MB.` + (over.length ? ` These services still run over a page: ${over.join(', ')}` : ''));
} finally {
  await browser.close();
  server.close();
}
