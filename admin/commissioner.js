// Across Kirklees (admin/commissioner.html): the whole live list as a timetable, map and counts by ward, for
// planning and commissioning. Reads the same data as All services (services-all.json: services, venues and the
// allowed choices) and the shared rules in ../listing-logic.js (what is open today, days and times in words).
// Nothing is sent anywhere: the filters and counts are worked out in the browser.
//
// A service is counted in a ward when one of its sessions (or the venues every project uses) is at a venue in that
// ward. Services by appointment, online, or that haven't given a venue yet have no ward: they are counted
// separately, so a "gap" is never just missing data.
(() => {
  'use strict';

  const LL = globalThis.LISTING;
  const $ = (sel) => document.querySelector(sel);
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
    return n;
  }
  const list = (v) => (Array.isArray(v) ? v : []);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  const NO_WARD = '(No venue given)';
  const KIRKLEES = [53.645, -1.78];

  let DATA = null;
  let venues = new Map();
  let map = null;
  let layer = null;

  // ---------- the rows: one per session, plus one for each project with no sessions ----------
  // { s, p, se (or null), venue (or null), ward, runs: Set }
  function rows(includeReview) {
    const today = LL.today();
    const out = [];
    for (const s of DATA.services) {
      const d = s.listing && s.listing.decision;
      if (!(d === 'include' || (includeReview && d === 'review'))) continue;
      if (!s.open && d === 'include') continue;
      const shared = list(s.venues).map((id) => venues.get(id)).filter(Boolean);
      for (const x of LL.visible(s, today)) {
        const p = x.project;
        const runs = new Set(list(p.runs));
        if (!runs.size && x.sessions.some((c) => c.session.venue || list(c.session.days).length)) runs.add('set');
        if (!runs.size) runs.add('unknown');
        if (x.sessions.length) {
          for (const c of x.sessions) {
            const v = c.session.venue ? venues.get(c.session.venue) : null;
            out.push({ s, p, se: c.session, venue: v, ward: v ? v.ward || null : null, runs, dates: c.dates });
          }
        } else if (shared.length) {
          for (const v of shared) out.push({ s, p, se: null, venue: v, ward: v.ward || null, runs, dates: x.dates });
        } else {
          out.push({ s, p, se: null, venue: null, ward: null, runs, dates: x.dates });
        }
      }
    }
    return out;
  }

  // ---------- filters ----------
  const F = {};
  function readFilters() {
    return {
      ward: $('#f-ward').value, group: $('#f-group').value, cat: $('#f-cat').value, day: $('#f-day').value, time: $('#f-time').value,
      runs: new Set([...document.querySelectorAll('input[name=runs]:checked')].map((i) => i.value)),
      hwl: $('#f-hwl').checked, review: $('#f-review').checked,
    };
  }
  const startHour = (se) => (se && /^\d\d:\d\d$/.test(se.start || '') ? Number(se.start.slice(0, 2)) : null);
  function rowMatches(r, f) {
    if (f.hwl && !r.s.hwlFunded) return false;
    if (f.group && !list(r.s.groups).includes(f.group)) return false;
    if (f.cat && !list(r.s.categories).includes(f.cat)) return false;
    if (![...r.runs].some((x) => f.runs.has(x))) return false;
    if (f.ward && (f.ward === NO_WARD ? r.ward : r.ward !== f.ward)) return false;
    if (f.day && !list(r.se && r.se.days).includes(f.day)) return false;
    if (f.time) {
      const days = list(r.se && r.se.days);
      if (f.time === 'weekend') { if (!days.some((d) => d === 'sat' || d === 'sun')) return false; }
      else {
        const h = startHour(r.se);
        if (h === null) return false;
        if (f.time === 'morning' && h >= 12) return false;
        if (f.time === 'afternoon' && (h < 12 || h >= 17)) return false;
        if (f.time === 'evening' && h < 17) return false;
      }
    }
    return true;
  }

  // ---------- views ----------
  function draw() {
    const f = readFilters();
    const all = rows(f.review);
    const hit = all.filter((r) => rowMatches(r, f));
    const services = new Map();
    for (const r of hit) services.set(r.s.id, r.s);
    const timed = hit.filter((r) => r.se && list(r.se.days).length);
    const vset = new Set(hit.filter((r) => r.venue).map((r) => r.venue.id));
    const appt = new Set(hit.filter((r) => r.runs.has('appointment')).map((r) => r.s.id));
    const online = new Set(hit.filter((r) => r.runs.has('online')).map((r) => r.s.id));
    $('#stats').replaceChildren(
      stat(services.size, 'service', 'services'),
      stat(timed.length, 'session with a day', 'sessions with a day'),
      stat(vset.size, 'venue', 'venues'),
      stat(appt.size, 'by appointment or around the person', 'by appointment or around the person'),
      stat(online.size, 'online or by phone', 'online or by phone'));
    drawMap(hit);
    drawWeek(hit);
    drawWards(hit);
    drawList(hit, services);
    drawGaps(all);
    F.last = hit;
  }
  const stat = (n, one, many) => el('div', { class: 'stat' }, el('b', { text: String(n) }), el('span', { text: n === 1 ? one : many }));
  const sessionLabel = (r) => [r.se && r.se.name, r.se && LL.timeWords(r.se), r.se && (r.se.note || r.se.when)].filter(Boolean).join(', ');
  const findLink = (s) => el('a', { href: 'services.html?q=' + encodeURIComponent(s.id), text: s.name });

  function drawMap(hit) {
    const byVenue = new Map();
    for (const r of hit) if (r.venue) byVenue.set(r.venue.id, [...(byVenue.get(r.venue.id) || []), r]);
    const placed = [...byVenue.values()].filter((rs) => typeof rs[0].venue.lat === 'number');
    const unplaced = byVenue.size - placed.length;
    $('#map-note').textContent = (unplaced ? plural(unplaced, 'venue has', 'venues have') + ' no map position yet: positions are looked up from the postcode when the team\'s changes are applied. ' : '')
      + 'Services without a venue (by appointment, online, or not given yet) are not on the map: see "By ward" and "List".';
    if (!globalThis.L || !$('#map')) return;
    if (!map) {
      map = globalThis.L.map('map', { scrollWheelZoom: false }).setView(KIRKLEES, 11);
      globalThis.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
      layer = globalThis.L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    for (const rs of placed) {
      const v = rs[0].venue;
      const n = new Set(rs.map((r) => r.s.id)).size;
      const pop = el('div', { class: 'cm-pop' },
        el('strong', { text: v.name }), el('br'), document.createTextNode(LL.venueLine(v) + (v.ward ? ' (' + v.ward + ')' : '')),
        el('ul', {}, rs.map((r) => el('li', {}, findLink(r.s), document.createTextNode(': ' + (sessionLabel(r) || r.p.name))))));
      globalThis.L.circleMarker([v.lat, v.lng], { radius: 6 + Math.min(10, n * 2), color: '#0b5c5c', weight: 2, fillColor: '#0b6b6b', fillOpacity: 0.55 })
        .bindPopup(pop).bindTooltip(v.name + ': ' + plural(n, 'service', 'services')).addTo(layer);
    }
  }

  function drawWeek(hit) {
    const box = $('#view-week');
    const cols = LL.DAYS.map((d) => {
      const rs = hit.filter((r) => r.se && list(r.se.days).includes(d)).sort((a, b) => String(a.se.start || '99').localeCompare(String(b.se.start || '99')));
      return el('div', { class: 'cm-day' }, el('h3', { text: LL.DAY_NAMES[d] + ' (' + rs.length + ')' }),
        rs.length ? rs.map((r) => el('div', { class: 'cm-sess' },
          el('strong', { text: [r.se.start && r.se.end ? LL.clock(r.se.start) + ' to ' + LL.clock(r.se.end) : r.se.start ? LL.clock(r.se.start) : 'Time not given', r.se.frequency && r.se.frequency !== 'weekly' ? LL.FREQUENCY[r.se.frequency] : ''].filter(Boolean).join(', ') }),
          el('br'), findLink(r.s), document.createTextNode((r.se.name ? ' (' + r.se.name + ')' : '') + (r.venue ? ': ' + r.venue.name + (r.ward ? ', ' + r.ward : '') : '')))) : el('p', { class: 'hint', text: 'Nothing on this day.' }));
    });
    const noDay = hit.filter((r) => !(r.se && list(r.se.days).length));
    const inWords = noDay.filter((r) => r.se && (r.se.note || r.se.when));
    box.replaceChildren(
      el('div', { class: 'cm-week' }, cols),
      el('h3', { text: 'No day given (' + noDay.length + ')' }),
      el('p', { class: 'hint', text: plural(inWords.length, 'of these has', 'of these have') + ' days and times in words, waiting for the service to turn them into sessions when it checks its listing. The rest are by appointment, online, or not given yet.' }),
      el('ul', { class: 'cm-plain' }, noDay.slice(0, 200).map((r) => el('li', {}, findLink(r.s), document.createTextNode(': ' + r.p.name + (sessionLabel(r) ? ', ' + sessionLabel(r) : '') + (r.venue ? ', ' + r.venue.name : ''))))));
  }

  function drawWards(hit) {
    const box = $('#view-wards');
    const by = new Map();
    for (const r of hit) {
      const w = r.ward || NO_WARD;
      if (!by.has(w)) by.set(w, { services: new Set(), sessions: 0, venues: new Set(), evening: 0 });
      const x = by.get(w);
      x.services.add(r.s.id);
      if (r.se && list(r.se.days).length) x.sessions += 1;
      if (r.venue) x.venues.add(r.venue.id);
      const h = startHour(r.se);
      if ((h !== null && h >= 17) || list(r.se && r.se.days).some((d) => d === 'sat' || d === 'sun')) x.evening += 1;
    }
    const wards = [...by.keys()].sort((a, b) => (a === NO_WARD) - (b === NO_WARD) || a.localeCompare(b));
    box.replaceChildren(
      el('p', { class: 'hint', text: 'Choose a ward to filter everything else by it. "' + NO_WARD + '" is services by appointment, online, or whose venue hasn\'t been given yet: their area is in their listing, in words.' }),
      el('div', { class: 'table-scroll' }, el('table', { class: 'cm-table' },
        el('thead', {}, el('tr', {}, ['Ward', 'Services', 'Sessions with a day', 'Venues', 'Evening or weekend sessions'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, wards.map((w) => {
          const x = by.get(w);
          return el('tr', {},
            el('th', { scope: 'row' }, el('button', { type: 'button', class: 'linkish', text: w, onclick: () => { $('#f-ward').value = w; draw(); } })),
            el('td', { text: String(x.services.size) }), el('td', { text: String(x.sessions) }), el('td', { text: String(x.venues.size) }), el('td', { text: String(x.evening) }));
        })))));
  }

  function drawList(hit, services) {
    const box = $('#view-list');
    const rowsBy = new Map();
    for (const r of hit) rowsBy.set(r.s.id, [...(rowsBy.get(r.s.id) || []), r]);
    const ss = [...services.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-GB'));
    box.replaceChildren(el('div', { class: 'table-scroll' }, el('table', { class: 'cm-table' },
      el('thead', {}, el('tr', {}, ['Service', 'Organisation', "Who it's for", 'Wards', 'Days'].map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, ss.map((s) => {
        const rs = rowsBy.get(s.id) || [];
        const wards = [...new Set(rs.map((r) => r.ward).filter(Boolean))];
        const days = LL.DAYS.filter((d) => rs.some((r) => list(r.se && r.se.days).includes(d))).map((d) => LL.DAY_NAMES[d].slice(0, 3));
        return el('tr', {},
          el('th', { scope: 'row' }, findLink(s), s.hwlFunded ? ' (HWL)' : ''),
          el('td', { text: s.organisation }),
          el('td', { text: list(s.groups).map((g) => LL.GROUPS[g] || g).join(', ') || 'Not ticked yet' }),
          el('td', { text: wards.join(', ') || '—' }),
          el('td', { text: days.join(', ') || '—' }));
      })))));
  }

  // How much is still to collect, across everything shown (whatever the filters), so the gaps can be read honestly.
  function drawGaps(all) {
    const box = $('#view-gaps');
    const services = [...new Map(all.map((r) => [r.s.id, r.s])).values()];
    const noGroups = services.filter((s) => !list(s.groups).length);
    const projects = [...new Map(all.map((r) => [r.s.id + '|' + r.p.id, r])).values()];
    const noTimes = projects.filter((r) => !list(r.p.sessions).some((x) => list(x.days).length) && !list(r.p.runs).some((x) => x === 'appointment' || x === 'online'));
    const inWords = all.filter((r) => r.se && !list(r.se.days).length && (r.se.note || r.se.when));
    const usedVenues = [...new Set(all.filter((r) => r.venue).map((r) => r.venue))];
    const noWard = usedVenues.filter((v) => !v.ward);
    const line = (n, total, what) => el('li', {}, el('strong', { text: n + ' of ' + total }), ' ' + what);
    box.replaceChildren(
      el('ul', { class: 'cm-plain' },
        line(noGroups.length, services.length, 'services haven\'t ticked who they\'re for yet.'),
        line(noTimes.length, projects.length, 'projects have no days or times yet (and aren\'t by appointment or online).'),
        line(inWords.length, all.length, 'sessions have their days and times in words only, to be turned into a timetable.'),
        line(noWard.length, usedVenues.length, 'venues have no ward or map position yet (looked up from the postcode when changes are applied).')),
      el('p', { class: 'hint', text: 'These fill in as Healthy Working Life partners check their listings through their review links, and as the team updates the others.' }),
      el('details', {}, el('summary', { text: 'Services with no days or times yet (' + new Set(noTimes.map((r) => r.s.id)).size + ')' }),
        el('ul', { class: 'cm-plain' }, [...new Map(noTimes.map((r) => [r.s.id, r.s])).values()].map((s) => el('li', {}, findLink(s), ', ' + s.organisation)))));
  }

  // ---------- the spreadsheet: one row per session ----------
  function download() {
    const head = ['Service', 'Organisation', 'Healthy Working Life', 'Project', 'Session', 'Days', 'Start', 'End', 'How often', 'In words', 'Venue', 'Address', 'Postcode', 'Ward', 'How it runs', "Who it's for", 'Kinds of support', 'Dates', 'Service id'];
    const cell = (v) => {
      let t = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
      return '"' + t.replace(/"/g, '""') + '"';
    };
    const lines = [head.map(cell).join(',')];
    for (const r of F.last || []) {
      const se = r.se || {};
      lines.push([r.s.name, r.s.organisation, r.s.hwlFunded ? 'Yes' : 'No', r.p.name, se.name, list(se.days).map((d) => LL.DAY_NAMES[d]).join(' '), se.start, se.end, se.frequency ? LL.FREQUENCY[se.frequency] : '',
        se.note || se.when || '', r.venue && r.venue.name, r.venue && r.venue.address, r.venue && r.venue.postcode, r.ward, [...r.runs].map((x) => LL.RUNS[x] || 'Not said').join('; '),
        list(r.s.groups).map((g) => LL.GROUPS[g] || g).join('; '), list(r.s.categories).join('; '), LL.dateWords(r.dates || {}).join('; '), r.s.id].map(cell).join(','));
    }
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'kirklees-timetable-' + LL.today() + '.csv' });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // ---------- tabs ----------
  function tabs() {
    const ts = [...document.querySelectorAll('[role=tab]')];
    const pick = (t) => {
      for (const x of ts) {
        const on = x === t;
        x.setAttribute('aria-selected', String(on));
        x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
      }
      if (t.id === 'tab-map' && map) map.invalidateSize();
    };
    for (const t of ts) {
      t.addEventListener('click', () => pick(t));
      t.addEventListener('keydown', (e) => {
        const i = ts.indexOf(t);
        const n = e.key === 'ArrowRight' ? ts[(i + 1) % ts.length] : e.key === 'ArrowLeft' ? ts[(i - 1 + ts.length) % ts.length] : null;
        if (n) { e.preventDefault(); pick(n); n.focus(); }
      });
    }
  }

  // ---------- start ----------
  fetch('services-all.json', { cache: 'no-cache' })
    .then((r) => r.json())
    .then((d) => {
      DATA = d;
      venues = new Map(list(d.venues).map((v) => [v.id, v]));
      const wards = [...new Set(list(d.venues).map((v) => v.ward).filter(Boolean))].sort();
      $('#f-ward').append(...wards.map((w) => el('option', { value: w, text: w })), el('option', { value: NO_WARD, text: NO_WARD }));
      $('#f-group').append(...Object.entries(LL.GROUPS).map(([k, v]) => el('option', { value: k, text: v })));
      $('#f-cat').append(...list(d.choices && d.choices.categories).map((c) => el('option', { value: c, text: c })));
      $('#f-day').append(...LL.DAYS.map((x) => el('option', { value: x, text: LL.DAY_NAMES[x] })));
      $('#filters').addEventListener('change', draw);
      $('#f-reset').addEventListener('click', () => { $('#filters').reset(); draw(); });
      $('#download').addEventListener('click', download);
      tabs();
      draw();
    })
    .catch(() => { $('#stats').replaceChildren(el('p', { class: 'msg err', text: "The services couldn't be loaded. Please reload the page." })); });
})();
