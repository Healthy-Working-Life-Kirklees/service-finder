// The Admin home page: sign in with the team passcode, then the list of Admin pages.
// The passcode is checked with the Worker (GET /log/check) before it is kept for this browser tab.
(() => {
  'use strict';

  const cfg = window.FINDER_CONFIG || {};
  const API = String(cfg.apiBase || '').replace(/\/$/, '');
  const AUTH = window.TEAM_AUTH;
  const $ = (s) => document.querySelector(s);

  // Where to go after signing in, if you were sent here from another Admin page. Only the Admin pages are allowed.
  const NEXT_RE = /^(help|services|log|feedback)\.html([?#][^]*)?$/;
  const next = (() => {
    const v = new URLSearchParams(location.search).get('next') || '';
    return NEXT_RE.test(v) ? v : '';
  })();

  function show() {
    const signedIn = Boolean(AUTH.pass());
    $('#gate').hidden = signedIn;
    $('#app').hidden = !signedIn;
    if (!signedIn) $('#pass').focus();
  }

  function say(msg, kind = 'err') {
    const m = $('#gate-msg');
    m.className = 'msg ' + kind;
    m.textContent = msg || '';
    m.hidden = !msg;
  }

  async function check(pass) {
    if (!API) throw Object.assign(new Error('This page has not been connected to the Worker yet.'), { status: 0 });
    let res;
    try {
      res = await fetch(API + '/log/check', { headers: { 'x-team-passcode': pass } });
    } catch {
      throw Object.assign(new Error('Could not reach the Support Finder service. Please check your connection.'), { status: 0 });
    }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw Object.assign(new Error(d.error || 'Something went wrong.'), { status: res.status });
    }
  }

  $('#signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('#pass').value.trim();
    if (!pass) return;
    say('');
    $('#unlock').disabled = true;
    try {
      await check(pass);
    } catch (err) {
      say(err.status === 404 ? 'Admin has not been switched on yet (the TEAM_PASSCODE secret is not set). Ask Phil.' : err.status === 401 ? 'That passcode is not right.' : err.message);
      return;
    } finally {
      $('#unlock').disabled = false;
    }
    AUTH.setBy($('#by').value);
    AUTH.setPass(pass);
    $('#pass').value = '';
    if (next) location.href = next;
    else show();
  });

  $('#lock').addEventListener('click', () => {
    AUTH.signOut();
    show();
  });

  $('#by').value = AUTH.by();
  if (next && !AUTH.pass()) say('Please sign in to open that page.', 'info');
  if (next && AUTH.pass()) location.replace(next);
  else show();
})();
