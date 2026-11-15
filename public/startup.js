// Keep this bootstrap compatible with older WebViews so a syntax/module failure
// in the main application produces recovery controls instead of a blank screen.
// Also paint the saved theme before CSS to avoid a dark/light flash on load.
(function () {
  try {
    var p = window.localStorage.getItem('dinosour.ui.v1');
    var t = p ? JSON.parse(p).theme : null;
    if (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) t = 'light';
    document.documentElement.dataset.theme = t || 'dark';
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.content = t === 'light' ? '#ffffff' : '#0f0f0f';
  } catch (e) {}
  var bridge = window.DinosourAndroid;
  if (!bridge || !bridge.startupFailed) return;
  function fail(message) {
    if (window.__dinosourReady) return;
    try { bridge.startupFailed(String(message || 'The app could not start.')); } catch (_) {}
  }
  window.addEventListener('error', function (event) {
    if (event.message) fail(event.message);
    else if (event.target && event.target.tagName === 'SCRIPT') fail('An application script could not load.');
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    fail(event.reason && event.reason.message || 'An application script failed.');
  });
  if (!('noModule' in document.createElement('script'))) {
    fail('This version of Android WebView is too old. Update Android System WebView or Chrome.');
  }
})();
