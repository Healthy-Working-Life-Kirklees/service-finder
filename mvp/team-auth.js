// One sign-in for all the MVP team pages (All services, Issues and actions log, Feedback and usage).
//
// There is one team passcode (the Worker secret TEAM_PASSCODE). Whichever page you sign in on, the passcode is
// kept for this browser tab only (sessionStorage), so moving between the MVP pages in the same tab keeps you
// signed in, and closing the tab signs you out. Your name or initials are kept the same way and saved with what
// you do. Signing out on any page signs you out of all of them.
//
// This file is loaded before each page's own script. It also shows "Signed in as ..." and "Sign out" in the
// "MVP team only" bar on every MVP page.
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

  let box = null;

  function refresh() {
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
    note: 'One passcode for all the MVP team pages: All services, the issues log, and feedback and usage. You stay signed in on these pages until you close this browser tab. Don’t have it? Ask Phil.',
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
