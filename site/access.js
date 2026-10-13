// Accessibility options: text size, high contrast and read aloud.
//
// Text size and contrast are kept in the address (?size=2, ?contrast=high), like the language, not in browser
// storage, so the page still stores nothing. A link ending ?size=3&contrast=high opens the page that way.
//
// Read aloud uses the speech voices built into the person's own phone or computer (the browser's speech
// synthesis), so there is no extra service or cost. The page prefers voices that run on the device. Where a
// device has no voice at all for a language, the Listen buttons for that language are hidden.
(() => {
  'use strict';

  const t = (key, vars) => window.I18N.t(key, vars);
  const root = document.documentElement;
  const SIZES = { 1: '', 2: 'text-large', 3: 'text-larger' };

  // ---------- settings kept in the address ----------
  const params = new URLSearchParams(location.search);
  let size = SIZES[params.get('size')] !== undefined ? Number(params.get('size')) : 1;
  let contrast = params.get('contrast') === 'high';

  function saveToUrl() {
    const url = new URL(location.href);
    if (size === 1) url.searchParams.delete('size'); else url.searchParams.set('size', String(size));
    if (contrast) url.searchParams.set('contrast', 'high'); else url.searchParams.delete('contrast');
    history.replaceState(null, '', url);
  }

  function apply() {
    root.classList.remove('text-large', 'text-larger');
    if (SIZES[size]) root.classList.add(SIZES[size]);
    root.classList.toggle('high-contrast', contrast);
    for (const b of document.querySelectorAll('[data-size]')) b.setAttribute('aria-pressed', String(Number(b.dataset.size) === size));
    const c = document.getElementById('contrast-toggle');
    if (c) c.setAttribute('aria-pressed', String(contrast));
  }

  for (const b of document.querySelectorAll('[data-size]')) {
    b.addEventListener('click', () => { size = Number(b.dataset.size); apply(); saveToUrl(); });
  }
  const contrastBtn = document.getElementById('contrast-toggle');
  if (contrastBtn) contrastBtn.addEventListener('click', () => { contrast = !contrast; apply(); saveToUrl(); });
  apply();

  // ---------- read aloud ----------
  const synth = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window ? window.speechSynthesis : null;
  let voices = [];
  let playing = null; // { button, token }
  let token = 0;

  function loadVoices() {
    voices = synth ? synth.getVoices() : [];
    refreshButtons();
  }

  // Best voice for a locale such as 'en-GB': exact match first, then the same language, preferring voices that
  // run on the device over online ones.
  function pickVoice(locale) {
    const want = locale.toLowerCase().replace('_', '-');
    const lang = want.split('-')[0];
    const norm = (v) => v.lang.toLowerCase().replace('_', '-');
    const score = (v) => (norm(v) === want ? 2 : 0) + (v.localService ? 1 : 0);
    const matches = voices.filter((v) => norm(v).split('-')[0] === lang);
    matches.sort((a, b) => score(b) - score(a));
    return matches[0] || null;
  }

  function refreshButtons() {
    for (const b of document.querySelectorAll('.listen')) b.hidden = !pickVoice(b.dataset.locale);
  }

  function setLabel(button, isPlaying) {
    button.classList.toggle('playing', isPlaying);
    button.setAttribute('aria-pressed', String(isPlaying));
    button.querySelector('.listen-text').textContent = isPlaying ? t('stop') : t('listen');
  }

  function stop() {
    token++;
    if (synth) synth.cancel();
    if (playing) setLabel(playing.button, false);
    playing = null;
  }

  // Some browsers cut speech off after about 15 seconds, so long text is read a sentence or two at a time.
  function chunks(text) {
    const parts = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?۔؟\n]+[.!?۔؟]*\s*/g) || [];
    const out = [];
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 200 && cur) { out.push(cur.trim()); cur = ''; }
      cur += p;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function speak(button, getText) {
    const wasThis = playing && playing.button === button;
    stop();
    if (wasThis) return;
    const voice = pickVoice(button.dataset.locale);
    const pieces = chunks(getText());
    if (!voice || !pieces.length) return;
    const mine = ++token;
    playing = { button, token: mine };
    setLabel(button, true);
    pieces.forEach((piece, i) => {
      const u = new SpeechSynthesisUtterance(piece);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = 0.95;
      if (i === pieces.length - 1) {
        u.onend = u.onerror = () => { if (token === mine) { setLabel(button, false); playing = null; } };
      }
      synth.speak(u);
    });
  }

  // A "Listen" button. getText is called when it is pressed. locale is the language the text is in.
  function listenButton(getText, locale, label) {
    const icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn secondary small listen';
    b.dataset.locale = locale;
    b.setAttribute('aria-pressed', 'false');
    if (label) b.setAttribute('aria-label', label);
    b.innerHTML = icon; // fixed markup, no user or AI text
    const span = document.createElement('span');
    span.className = 'listen-text';
    span.textContent = t('listen');
    b.append(span);
    b.hidden = !synth || !pickVoice(locale);
    b.addEventListener('click', () => speak(b, getText));
    return b;
  }

  if (synth) {
    loadVoices();
    if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', loadVoices);
    else synth.onvoiceschanged = loadVoices;
    // Stop talking if the person leaves or reloads the page.
    window.addEventListener('pagehide', stop);
  }

  // Keep button wording in step with the language switcher.
  window.I18N.onChange(() => {
    stop();
    for (const s of document.querySelectorAll('.listen .listen-text')) s.textContent = t('listen');
  });

  window.ACCESS = { listenButton, stop, get canSpeak() { return !!synth; } };
})();
