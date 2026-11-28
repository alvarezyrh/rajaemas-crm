// Loaded synchronously in <head> (not a module) so the theme is set before the
// first paint — no flash. White is the main theme; dark mode is an explicit
// choice that is remembered in localStorage.
(function () {
  var KEY = 'rei.crm.theme.v2';
  var theme = 'light';
  try {
    if (localStorage.getItem(KEY) === 'dark') theme = 'dark';
  } catch (e) {
    /* storage blocked: keep the default */
  }
  document.documentElement.setAttribute('data-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#281744');
})();
