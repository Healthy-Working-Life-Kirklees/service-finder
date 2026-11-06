// Admin test mode. An Admin opens the finder from the Admin home page with "Open the finder in test mode", which
// marks this browser tab (sessionStorage, the same place the Admin sign-in is kept). In test mode the page sends
// the team passcode with each search, usage event and piece of feedback, and the Worker keeps them apart from
// real use (worker/src/feedback.js isTeamTest). Closing the tab or pressing "Stop test mode" ends it.
// Nothing about the person or what they type is stored by this. Admin-only, so English only.
(() => {
  'use strict';
  const get = (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } };
  const pass = get('hwlTeamTest') === '1' ? get('hwlTeamPass') : '';
  window.HWL_TEAM_TEST = pass; // read by app.js, usage.js and feedback.js
  if (!pass) return;

  function banner() {
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'team-test-stop';
    stop.textContent = 'Stop test mode';
    stop.addEventListener('click', () => {
      try { sessionStorage.removeItem('hwlTeamTest'); } catch { /* ignore */ }
      location.reload();
    });
    const text = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = 'Test mode. ';
    text.append(strong, 'Searches, button presses and feedback here are kept apart from real use and shown under "Admin team testing" on the Feedback and usage page. Searches still use AI credit.');
    const bar = document.createElement('div');
    bar.className = 'team-test-bar';
    bar.setAttribute('role', 'note');
    bar.append(text, stop);
    document.body.prepend(bar);
    document.documentElement.classList.add('team-test');
  }
  if (document.body) banner();
  else document.addEventListener('DOMContentLoaded', banner);
})();
