// One sign-in for the whole Admin section (Help, All services, Issues and actions log, Feedback and usage).
//
// There is one team passcode (the Worker secret TEAM_PASSCODE). You sign in on the Admin home page
// (admin/index.html), which checks the passcode with the Worker. The passcode is then kept for this browser tab
// only (sessionStorage), so moving between the Admin pages in the same tab keeps you signed in, and closing the
// tab signs you out. Your name or initials are kept the same way and saved with what you do. Signing out on any
// page signs you out of all of them.
//
// This file is loaded in the <head> of every Admin page, before anything is drawn. On every page except the
// Admin home, if nobody is signed in in this tab, it sends you to the Admin home to sign in, and brings you back
// afterwards. It also shows "Signed in as ..." and "Sign out" in the Admin bar on every Admin page.
//
// The pages are plain files on GitHub Pages, so this is a front door, not a lock: the team's data (the log,
// decisions, edits, feedback and usage) is only ever sent by the Worker to someone with the right passcode.
(() => {
  'use strict';

  const PASS_KEY = 'hwlTeamPass';
  const BY_KEY = 'hwlLogBy';
  const OLD_KEYS = ['hwlLogPass', 'hwlFeedbackPass']; // from when there were two passcodes

  const ss = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
  };
  for (const k of OLD_KEYS) ss.del(k);

  // The Admin home page marks itself with <html data-admin="home">. Every other Admin page needs a sign-in.
  const isHome = document.documentElement.getAttribute('data-admin') === 'home';

  function toHome() {
    const page = location.pathname.split('/').pop() || '';
    const next = page + location.search + location.hash;
    document.documentElement.style.visibility = 'hidden';
    location.replace('./' + (page ? '?next=' + encodeURIComponent(next) : ''));
  }

  if (!isHome && !ss.get(PASS_KEY)) {
    toHome();
    return;
  }

  let box = null;

  function refresh() {
    // Signed out (here or on another page in this tab): back to the Admin home to sign in again.
    if (!isHome && !ss.get(PASS_KEY)) return toHome();
    const bar = document.querySelector('.teambar .wrap');
    if (!bar) return;
    if (!box) {
      box = document.createElement('span');
      box.className = 'team-auth';
      bar.append(box);
    }
    const pass = ss.get(PASS_KEY);
    const by = ss.get(BY_KEY);
    box.replaceChildren();
    if (pass) {
      box.append('Signed in' + (by ? ' as ' + by : ''));
      const out = document.createElement('button');
      out.type = 'button';
      out.className = 'linklike';
      out.textContent = 'Sign out';
      out.addEventListener('click', () => {
        ss.del(PASS_KEY);
        location.reload();
      });
      box.append(' ', out);
    } else {
      box.append('Not signed in');
    }
  }

  window.TEAM_AUTH = {
    PASS_KEY,
    BY_KEY,
    pass: () => ss.get(PASS_KEY),
    by: () => ss.get(BY_KEY),
    setPass: (v) => { ss.set(PASS_KEY, v); refresh(); },
    setBy: (v) => { ss.set(BY_KEY, String(v || '').trim()); refresh(); },
    signOut: () => { ss.del(PASS_KEY); refresh(); },
    refresh,
    // Shown under every sign-in box, so it's clear it is the same passcode everywhere.
    note: 'One passcode for all the Admin pages: Help, All services, the issues log, and feedback and usage. You stay signed in on these pages until you close this browser tab. Don’t have it? Ask Phil.',
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
