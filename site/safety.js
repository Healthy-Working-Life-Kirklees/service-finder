// Help with abuse and safety (safety.html).
//
// The text and the language switcher come from i18n.js; text size and contrast from access.js.
// This file only keeps the settings on the links back to the main page, and runs the quick exit.
// Nothing is counted or stored on this page.
(() => {
  'use strict';

  // Back to the main page, keeping the language, text size and contrast in the address.
  for (const id of ['home-link', 'back-link']) {
    const a = document.getElementById(id);
    if (a) a.addEventListener('click', () => { a.href = './' + location.search; });
  }

  // Quick exit: replace this page in the browser's history, so pressing Back doesn't bring it up again.
  // Without JavaScript the link still opens the same site.
  const exit = document.getElementById('quick-exit');
  if (exit) {
    exit.addEventListener('click', (e) => {
      e.preventDefault();
      location.replace(exit.href);
    });
  }
})();
