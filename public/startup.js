// Keep this bootstrap compatible with older WebViews so a syntax/module failure
// in the main application produces recovery controls instead of a blank screen.
// Also paint the saved theme before CSS to avoid a dark/light flash on load.
// The theme block above must stay first: it is the parse-time theme bootstrap and
// everything below it (including the no-network fallback) runs after it, in order.
(function () {
  try {
    var p = window.localStorage.getItem('dinosour.ui.v1');
    var t = p ? JSON.parse(p).theme : null;
    if (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) t = 'light';
    document.documentElement.dataset.theme = t || 'dark';
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.content = t === 'light' ? '#ffffff' : '#0f0f0f';
  } catch (e) {}

  // No-network fallback: if the page is still not interactive ~4s after parse,
  // show a tiny local card. Uses no modules, no network and no native bridge,
  // and removes itself as soon as the main app signals readiness.
  var fallbackTimer = null, fallbackCard = null, fallbackWatch = null;
  function hideFallbackIfReady() {
    if (!window.__dinosourReady) return;
    if (fallbackWatch) { window.clearInterval(fallbackWatch); fallbackWatch = null; }
    if (fallbackTimer) { window.clearTimeout(fallbackTimer); fallbackTimer = null; }
    if (fallbackCard && fallbackCard.parentNode) fallbackCard.parentNode.removeChild(fallbackCard);
    fallbackCard = null;
  }
  function showFallback() {
    if (window.__dinosourReady || fallbackCard) return;
    if (!document.body) {
      // Parsed in <head> on very old WebViews: retry once the body exists.
      document.addEventListener('DOMContentLoaded', function once() {
        document.removeEventListener('DOMContentLoaded', once);
        showFallback();
      });
      return;
    }
    try {
      var light = document.documentElement.dataset.theme === 'light';
      var palette = light
        ? { overlay: 'rgba(255,255,255,.78)', card: '#ffffff', border: '#e0e0e0', text: '#0f0f0f', subtle: '#555555', accent: '#065fd4' }
        : { overlay: 'rgba(15,15,15,.78)', card: '#1f1f1f', border: '#333333', text: '#f1f1f1', subtle: '#aaaaaa', accent: '#3ea6ff' };
      var style = document.createElement('style');
      style.textContent = '@keyframes dinosour-startup-spin{to{transform:rotate(360deg)}}'
        + '#dinosour-startup-fallback .dinosour-arc{animation:dinosour-startup-spin 1s linear infinite}'
        + '@media (prefers-reduced-motion: reduce){#dinosour-startup-fallback .dinosour-arc{animation:none}}';
      (document.head || document.documentElement).appendChild(style);
      var overlay = document.createElement('div');
      overlay.id = 'dinosour-startup-fallback';
      overlay.setAttribute('role', 'alert');
      overlay.setAttribute('aria-label', 'Dinosour is starting');
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:' + palette.overlay + ';font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;';
      overlay.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;max-width:240px;padding:22px 28px;border-radius:12px;border:1px solid ' + palette.border + ';background:' + palette.card + ';color:' + palette.text + ';box-shadow:0 8px 32px rgba(0,0,0,.35);text-align:center">'
        + '<svg class="dinosour-arc" width="36" height="36" viewBox="0 0 36 36" role="progressbar" aria-label="Loading"><circle cx="18" cy="18" r="14" fill="none" stroke="' + palette.border + '" stroke-width="3"></circle><path d="M18 4 a14 14 0 0 1 12 7" fill="none" stroke="' + palette.accent + '" stroke-width="3" stroke-linecap="round"></path></svg>'
        + '<div style="font-size:18px;font-weight:700;line-height:1.2">Dinosour</div>'
        + '<div style="font-size:13px;color:' + palette.subtle + '">Rendering…</div>'
        + '<button type="button" style="margin-top:4px;padding:8px 22px;border:0;border-radius:999px;background:' + palette.accent + ';color:#ffffff;font-size:14px;font-weight:600;cursor:pointer">Reload</button>'
        + '</div>';
      overlay.querySelector('button').addEventListener('click', function () { window.location.reload(); });
      document.body.appendChild(overlay);
      fallbackCard = overlay;
      fallbackWatch = window.setInterval(hideFallbackIfReady, 500);
    } catch (e) {}
  }
  fallbackTimer = window.setTimeout(showFallback, 4000);

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
    // Modules are unsupported, so the main app will never ready-up: show the local fallback too.
    showFallback();
  }
})();
