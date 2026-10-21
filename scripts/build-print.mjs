// Builds a printable A4 directory of the live services: a cover, four indexes
// (A to Z, Kirklees, North Kirklees, South Kirklees), then one service per page in four
// sections: All Kirklees, North Kirklees, South Kirklees and National, A to Z in each.
//
//   node scripts/build-print.mjs && python3 scripts/render-print.py
//
// The output is one self-contained HTML file (fonts, logos and QR codes embedded) in
// print/out/. Open it in Chrome or Edge and print to A4 with "Background graphics" on,
// or run scripts/render-print.py to make the PDF.
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'print', 'out');
const SITE_URL = 'https://healthy-working-life-kirklees.github.io/service-finder/';
const STALE_DAYS = 135; // same as the site and mvp/help.js

const NORTH = ['Batley', 'Dewsbury', 'Mirfield', 'Spen Valley'];
const SOUTH = ['Colne Valley', 'Holme Valley', 'Huddersfield', 'Kirkburton'];

// The Service Finder isn't public yet. Set this to true to put its web address and
// QR code back on the cover (the space for them is kept).
const SHOW_SITE_LINK = false;

// ---------- data ----------
const dir = path.join(ROOT, 'data', 'services');
const services = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .filter((s) => s.listing && s.listing.decision === 'include')
  .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));

const today = new Date();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const edition = `${MONTHS[today.getMonth()]} ${today.getFullYear()}`;
const ageDays = (iso) => (today - new Date(iso + 'T00:00:00')) / 86400000;

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shortUrl = (u) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

const inNorth = (s) => s.areas.some((a) => NORTH.includes(a));
const inSouth = (s) => s.areas.some((a) => SOUTH.includes(a));
// Each service goes in one section. National services are National. Otherwise a service
// with a base or sessions only in North (or only in South) Kirklees towns goes in that
// section, and everything else (both halves, or Kirklees-wide with no town) in All Kirklees.
const SECTIONS = [
  { key: 'all', label: 'All Kirklees', title: 'All Kirklees', intro: 'Services that run across the whole of Kirklees, or in both North and South Kirklees. Includes regional services (West Yorkshire or wider) that Kirklees residents can use.' },
  { key: 'north', label: 'North Kirklees', title: 'North Kirklees', intro: 'Services with a base or sessions in Batley, Dewsbury, Mirfield or Spen Valley.' },
  { key: 'south', label: 'South Kirklees', title: 'South Kirklees', intro: 'Services with a base or sessions in Huddersfield, Colne Valley, Holme Valley or Kirkburton.' },
  { key: 'national', label: 'National', title: 'National services', intro: 'Services for the whole of the UK or England, usually by phone or online. Anyone in Kirklees can use them.' },
];
const SECTION = Object.fromEntries(SECTIONS.map((x) => [x.key, x]));
function sectionOf(s) {
  if (s.level === 'national') return SECTION.national;
  if (inNorth(s) && !inSouth(s)) return SECTION.north;
  if (inSouth(s) && !inNorth(s)) return SECTION.south;
  return SECTION.all;
}
const coverage = (s) => sectionOf(s);
const bySection = SECTIONS.map((sec) => ({ ...sec, list: services.filter((s) => sectionOf(s) === sec) }));
const ordered = bySection.flatMap((sec) => sec.list);

// ---------- index pagination ----------
// Rows have a fixed height in the CSS (6.4mm), so pages can be laid out here and the
// page numbers in the indexes are exact. A heading costs 2 rows.
const FIRST_ROWS = 31, NEXT_ROWS = 36;
function paginate(items) {
  const pages = [[]]; let used = 0; let cap = FIRST_ROWS; let group = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const cost = it.type === 'h' ? 2 : 1;
    const need = it.type === 'h' ? cost + 1 : cost; // keep a heading with its first row
    if (used + need > cap) {
      pages.push([]); used = 0; cap = NEXT_ROWS;
      if (it.type === 'r' && group) { pages.at(-1).push({ type: 'h', text: group + ' (continued)' }); used += 2; }
    }
    if (it.type === 'h') group = it.text;
    pages.at(-1).push(it); used += cost;
  }
  return pages;
}

const fullItems = services.map((s) => ({ type: 'r', s }));
const kirkleesItems = services.filter((s) => sectionOf(s) !== SECTION.national).map((s) => ({ type: 'r', s }));
function areaItems(towns) {
  const items = [];
  for (const t of towns) {
    const list = services.filter((s) => s.areas.includes(t));
    if (!list.length) continue;
    items.push({ type: 'h', text: t, count: list.length });
    for (const s of list) items.push({ type: 'r', s });
  }
  const wide = services.filter((s) => sectionOf(s) === SECTION.all && !towns.some((t) => s.areas.includes(t)));
  items.push({ type: 'h', text: 'Across all of Kirklees', count: wide.length });
  for (const s of wide) items.push({ type: 'r', s });
  return items;
}

const fullPages = paginate(fullItems);
const kirkleesPages = paginate(kirkleesItems);
const northPages = paginate(areaItems(NORTH));
const southPages = paginate(areaItems(SOUTH));

// Page plan: cover, indexes, then for each section a divider page and its services.
const fullStart = 2;
const kirkleesStart = fullStart + fullPages.length;
const northStart = kirkleesStart + kirkleesPages.length;
const southStart = northStart + northPages.length;
let next = southStart + southPages.length;
const pageOf = new Map();
for (const sec of bySection) {
  sec.divider = next++;
  for (const s of sec.list) pageOf.set(s.id, next++);
}
const totalPages = next - 1;
const nationalCount = bySection.find((x) => x.key === 'national').list.length;

// ---------- assets ----------
const b64 = (p) => fs.readFileSync(p).toString('base64');
const fontFaces = [
  ['DM Sans', 500, 'dm-sans-latin-500-normal'], ['DM Sans', 700, 'dm-sans-latin-700-normal'],
  ['Noto Sans', 400, 'noto-sans-latin-400-normal'], ['Noto Sans', 600, 'noto-sans-latin-600-normal'], ['Noto Sans', 700, 'noto-sans-latin-700-normal'],
].map(([fam, w, f]) => `@font-face{font-family:"${fam}";font-weight:${w};font-style:normal;src:url(data:font/woff2;base64,${b64(path.join(ROOT, 'site/fonts', f + '.woff2'))}) format("woff2");}`).join('\n');
const hwlLogo = `data:image/png;base64,${b64(path.join(ROOT, 'print/assets/hwl-logo.png'))}`;
const logoCache = new Map();
function orgLogo(file) {
  if (!file) return null;
  if (!logoCache.has(file)) logoCache.set(file, `data:image/webp;base64,${b64(path.join(ROOT, 'site/img/logos', file))}`);
  return logoCache.get(file);
}
const qrCache = new Map();
async function qr(url) {
  if (!qrCache.has(url)) {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#17303a', light: '#0000' } });
    qrCache.set(url, svg);
  }
  return qrCache.get(url);
}

// ---------- page parts ----------
const SELF = { yes: ['self', 'You can refer yourself'], partly: ['self', 'Self-referral with a link from a professional'], tbc: ['', 'Self-referral: to be confirmed'], no: ['', 'Needs a referral'] };

function footer(n, left) {
  return `<footer class="pfoot"><span class="pf-left">${left}</span><span class="pf-num">${n}</span></footer>`;
}
const brandFoot = `Healthy Working Life Kirklees &middot; Service Finder &middot; ${edition}`;

function indexRow(s) {
  const c = coverage(s);
  return `<li class="row"><a href="#${esc(s.id)}"><span class="nm">${s.hwlFunded ? '<span class="hwl" title="Healthy Working Life scheme">&#9679;</span>' : ''}${esc(s.name)}<span class="og"> &middot; ${esc(s.organisation)}</span></span><span class="ar ar-${c.key}">${c.label}</span><span class="dots"></span><span class="pg">${pageOf.get(s.id)}</span></a></li>`;
}
function indexPages(pages, startNo, { title, kicker, intro, cls }) {
  return pages.map((items, i) => {
    const head = i === 0
      ? `<header class="ix-head first"><p class="kicker">${kicker}</p><h1>${title}</h1><div class="ix-intro">${intro}</div></header>`
      : `<header class="ix-head"><p class="kicker">${kicker}</p><h1 class="cont">${title} <span>(continued)</span></h1></header>`;
    const body = items.map((it) => it.type === 'h'
      ? `<li class="grp"><span>${esc(it.text)}</span>${it.count != null ? `<span class="cnt">${it.count} service${it.count === 1 ? '' : 's'}</span>` : ''}</li>`
      : indexRow(it.s)).join('');
    return `<section class="page index ${cls}" id="p${startNo + i}"><div class="brandbar"><span class="hwl-logo" role="img" aria-label="Healthy Working Life"></span><a class="bb-text" href="#p1">Service Finder</a></div>${head}<ul class="ix">${body}</ul>${footer(startNo + i, brandFoot)}</section>`;
  }).join('\n');
}

function list(arr) { return arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''; }

async function servicePage(s, n) {
  const c = coverage(s);
  const logo = orgLogo(s.logo);
  const thumb = logo
    ? `<div class="thumb logo"><img src="${logo}" alt=""></div>`
    : `<div class="thumb thumb-${(s.id.length + s.name.length) % 5}"><span>${esc(s.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase())}</span></div>`;
  const self = SELF[s.selfReferral?.allowed] || null;
  const badges = [
    s.hwlFunded ? '<span class="badge hwlb">Healthy Working Life scheme</span>' : '',
    s.open ? '<span class="badge live">Open to referrals</span>' : '<span class="badge notopen">Not open yet</span>',
    self ? `<span class="badge ${self[0]}">${self[1]}</span>` : '',
    s.level === 'regional' ? '<span class="badge">Regional service</span>' : '',
    s.level === 'national' ? '<span class="badge">National service</span>' : '',
    s.age ? `<span class="badge">Age: ${esc(s.age)}</span>` : '',
  ].join('');

  const acts = (s.activities || []).map((a) => {
    const showName = a.name && a.name.trim().toLowerCase() !== s.name.trim().toLowerCase();
    return `<li>${showName ? `<strong>${esc(a.name)}.</strong> ` : ''}${esc(a.summary)}${a.duration ? ` <span class="dur">(${esc(a.duration)})</span>` : ''}</li>`;
  }).join('');

  const contact = [
    s.phone ? `<div class="ct"><dt>Phone</dt><dd>${esc(s.phone)}</dd></div>` : '',
    s.email ? `<div class="ct"><dt>Email</dt><dd>${esc(s.email)}</dd></div>` : '',
    s.webpage ? `<div class="ct"><dt>Website</dt><dd class="url">${esc(shortUrl(s.webpage))}</dd></div>` : '',
  ].join('') || '<div class="ct"><dd>No contact details yet.</dd></div>';

  const towns = s.areas.filter((a) => a !== 'Online' && a !== 'Kirklees-wide');
  const areaLine = [...towns, ...(s.areas.includes('Kirklees-wide') ? ['All of Kirklees'] : []), ...(s.areas.includes('Online') ? ['Online'] : [])].join(', ');

  const extras = [
    s.cost ? `<h3>Cost</h3><p>${esc(s.cost)}</p>` : '',
    s.languages ? `<h3>Languages and formats</h3><p>${esc(s.languages)}</p>` : '',
    s.workExperience && !/^no$|^not known$/i.test(s.workExperience) ? `<h3>Volunteering or work experience</h3><p>${esc(s.workExperience)}</p>` : '',
  ].join('');

  const qrBlock = s.webpage ? `<div class="qr">${await qr(s.webpage)}<span>Scan to open the website</span></div>` : '';
  const stale = ageDays(s.lastUpdated) > STALE_DAYS;

  return `<section class="page svc cov-${c.key}" id="${esc(s.id)}">
  <div class="tab"><span>${c.label}</span></div>
  <div class="brandbar"><span class="hwl-logo" role="img" aria-label="Healthy Working Life"></span><a class="bb-text" href="#p1">Service Finder</a><span class="bb-cov">${c.label}</span><button type="button" class="print-one" data-print-page aria-label="Print the page for ${esc(s.name)}">Print this page</button></div>
  <header class="svc-head">${thumb}<div class="ttl"><h2>${esc(s.name)}</h2><p class="org">${esc(s.organisation)}</p><div class="badges">${badges}</div></div></header>
  <div class="fit"><div class="svc-body">
    <div class="main">
      <p class="whofor">${esc(s.whoFor)}</p>
      <h3>What they offer</h3><ul class="acts">${acts}</ul>
      ${(s.eligibility || []).length ? `<h3>Who can join</h3>${list(s.eligibility)}` : ''}
      ${(s.exclusions || []).length ? `<h3>Who they can't help</h3>${list(s.exclusions)}` : ''}
      <h3>Where</h3>${list(s.locations)}${areaLine ? `<p class="areas"><span>Areas:</span> ${esc(areaLine)}</p>` : ''}
    </div>
    <aside class="side">
      <h3>Contact</h3><dl class="contact">${contact}</dl>
      <h3>How to get in</h3>${list(s.referralRoutes)}${s.selfReferral?.note ? `<p class="selfnote">${esc(s.selfReferral.note)}</p>` : ''}
      ${extras}
      ${qrBlock}
    </aside>
  </div></div>
  <div class="checked">Information last checked: ${fmtDate(s.lastUpdated)}.${stale ? ' <strong>Please check these details are still right before referring.</strong>' : ''}</div>
  ${footer(n, brandFoot)}
</section>`;
}

function dividerPage(sec) {
  const first = pageOf.get(sec.list[0].id), last = pageOf.get(sec.list.at(-1).id);
  return `<section class="page divider cov-${sec.key}" id="p${sec.divider}">
  <div class="brandbar"><span class="hwl-logo" role="img" aria-label="Healthy Working Life"></span><a class="bb-text" href="#p1">Service Finder</a></div>
  <div class="dv-main"><p class="kicker">Section ${SECTIONS.indexOf(SECTION[sec.key]) + 1} of ${SECTIONS.length}</p><h1>${sec.title}</h1>
  <p class="dv-intro">${sec.intro}</p><p class="dv-count">${sec.list.length} services, A to Z, on pages ${first} to ${last}.</p></div>
  ${footer(sec.divider, brandFoot)}
</section>`;
}

async function cover() {
  const hwlCount = services.filter((s) => s.hwlFunded).length;
  const row = (label, page) => `<li><a href="#p${page}"><span>${label}</span><span class="dots"></span><span>${page}</span></a></li>`;
  const online = SHOW_SITE_LINK
    ? `${await qr(SITE_URL)}<div><strong>The latest version is online</strong><span>${esc(shortUrl(SITE_URL))}</span></div>`
    : ''; // space kept for the web address and QR code once the site is public
  return `<section class="page cover" id="p1">
  <img class="cover-logo" src="${hwlLogo}" alt="Healthy Working Life">
  <div class="cover-main">
    <p class="kicker">Kirklees &middot; Printed directory &middot; ${edition}</p>
    <h1>Service Finder</h1>
    <p class="lede">Support for health and work in Kirklees: ${services.length} services, one per page.</p>
    <div class="contents-wrap">
    <ol class="contents"><li class="ch">Indexes</li>
      ${row('All services, A to Z', fullStart)}
      ${row('Services in Kirklees, A to Z (not national)', kirkleesStart)}
      ${row('North Kirklees, by town', northStart)}
      ${row('South Kirklees, by town', southStart)}
    </ol>
    <ol class="contents"><li class="ch">Services</li>
      ${bySection.map((sec) => row(`${sec.title} (${sec.list.length})`, sec.divider)).join('\n      ')}
    </ol>
    </div>
    <div class="howto">
      <h2>How to use this directory</h2>
      <ul>
        <li>Find a service in one of the indexes and turn to its page number.</li>
        <li><span class="hwl">&#9679;</span> marks the ${hwlCount} Healthy Working Life schemes.</li>
        <li>Each page says whether you can refer yourself, and when the details were last checked.</li>
        <li>Services change often. Before you refer someone, check the details with the service.</li>
      </ul>
    </div>
  </div>
  <div class="cover-online">${online}</div>
</section>`;
}

async function build() {
  const css = fs.readFileSync(path.join(ROOT, 'print', 'styles', 'base.css'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'print', 'styles', 'directory.css'), 'utf8');
  const parts = [await cover()];
  const tagNote = '<p class="legend"><span class="hwl">&#9679;</span> Healthy Working Life scheme</p>';
  parts.push(indexPages(fullPages, fullStart, {
    title: 'All services, A to Z', kicker: 'Index', cls: 'ix-full',
    intro: `<p>Every service in this directory. The tag after each name shows which section it's in: All Kirklees, North Kirklees, South Kirklees or National. National services are usually by phone or online, and anyone in Kirklees can use them.</p>${tagNote}`,
  }));
  parts.push(indexPages(kirkleesPages, kirkleesStart, {
    title: 'Services in Kirklees, A to Z', kicker: 'Index', cls: 'ix-kirklees',
    intro: `<p>Every service delivered in Kirklees: the All Kirklees, North Kirklees and South Kirklees sections. It leaves out the ${nationalCount} national services, which are in the full index.</p>${tagNote}`,
  }));
  parts.push(indexPages(northPages, northStart, {
    title: 'North Kirklees', kicker: 'Area index', cls: 'ix-north',
    intro: `<p>Services with a base or sessions in Batley, Dewsbury, Mirfield and Spen Valley, then services that run across all of Kirklees. A service that runs in more than one town is listed under each.</p><p>The ${nationalCount} national services, mostly by phone or online, are open to North Kirklees too. They're in the full index.</p>`,
  }));
  parts.push(indexPages(southPages, southStart, {
    title: 'South Kirklees', kicker: 'Area index', cls: 'ix-south',
    intro: `<p>Services with a base or sessions in Huddersfield, Colne Valley, Holme Valley and Kirkburton, then services that run across all of Kirklees. A service that runs in more than one town is listed under each.</p><p>The ${nationalCount} national services, mostly by phone or online, are open to South Kirklees too. They're in the full index.</p>`,
  }));
  for (const sec of bySection) {
    parts.push(dividerPage(sec));
    for (const s of sec.list) parts.push(await servicePage(s, pageOf.get(s.id)));
  }

  const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>Service Finder: printed directory</title>
<style>${fontFaces}\n.hwl-logo{background:url(${hwlLogo}) center/contain no-repeat;}\n${css}</style></head>
<body class="design-c">
${parts.join('\n')}
<script>
// Shrink the text on any service page whose content doesn't fit on one A4 page.
(function () {
  document.querySelectorAll('.page.svc .fit').forEach(function (box) {
    var size = 100;
    var tooBig = function () { return box.scrollHeight > box.clientHeight + 1; };
    while (tooBig() && size > 88) { size -= 2; box.style.fontSize = size + '%'; }
    // Long entries: tighten the spacing and widen the main column, then shrink again if needed.
    if (tooBig()) { box.closest('.page').classList.add('compact'); size = 100; box.style.fontSize = ''; }
    while (tooBig() && size > 66) { size -= 2; box.style.fontSize = size + '%'; }
    box.closest('.page').setAttribute('data-size', size);
    if (box.scrollHeight > box.clientHeight) box.closest('.page').setAttribute('data-short', Math.round((box.scrollHeight - box.clientHeight) / 3.78) + 'mm');
    if (box.scrollHeight > box.clientHeight + 1) box.closest('.page').setAttribute('data-overflow', 'yes');
  });
  document.documentElement.setAttribute('data-fitted', 'yes');

  // "Print this page" on each service: print just that page, then put the directory back.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-print-page]');
    if (!btn) return;
    var page = btn.closest('.page');
    document.body.classList.add('printing-one');
    page.classList.add('print-target');
    var done = function () {
      document.body.classList.remove('printing-one');
      page.classList.remove('print-target');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  });
})();
</script>
</body></html>`;
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'service-finder-directory.html');
  fs.writeFileSync(file, html);
  console.log(`${totalPages} pages: ${services.length} services (${bySection.map((x) => `${x.label} ${x.list.length}`).join(', ')}); indexes ${fullPages.length} + ${kirkleesPages.length} + ${northPages.length} + ${southPages.length} -> ${path.relative(ROOT, file)}`);
}

await build();
