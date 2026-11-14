// Keep this bootstrap compatible with older WebViews so a syntax/module failure
// in the main application produces recovery controls instead of a blank screen.
(function () {
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
