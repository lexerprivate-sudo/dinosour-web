// On Android the installed app supplies networking and extraction. Ordinary
// desktop browsers continue using the Node server unchanged.
(() => {
  const bridge = window.DinosourAndroid;
  if (!bridge?.nativeRequest) return;
  window.__dinosourStandalone = true;
  const originalFetch = window.fetch.bind(window);
  const pending = new Map();
  const session = String(Date.now());
  let sequence = 0;

  window.__dinosourNativeResult = (id, payload) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); request.cleanup();
    if (payload.ok) request.resolve(payload.result);
    else request.reject(new Error(payload.error || 'Could not connect. Please retry.'));
  };
  window.__dinosourNativeCall = (kind, payload, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const id = `${session}-${++sequence}`;
    const abort = () => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id); request.cleanup();
      bridge.cancelRequest(id);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id); signal?.removeEventListener('abort', abort);
      bridge.cancelRequest(id);
      reject(new Error('The connection took too long. Please retry.'));
    }, kind === 'extract' ? 110000 : 25000);
    pending.set(id, {
      resolve, reject,
      cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
    });
    signal?.addEventListener('abort', abort, { once: true });
    try { bridge.nativeRequest(id, kind, JSON.stringify(payload)); }
    catch (error) { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); }
  });

  // Copy previous WebView-origin storage into the stable bundled origin once.
  // Native backup also preserves it if WebView storage is evicted.
  const keys = ['dinosour.library.v1', 'dinosour.ui.v1'];
  try {
    const saved = JSON.parse(bridge.readStorage() || '{}');
    for (const key of keys) if (localStorage.getItem(key) === null && typeof saved[key] === 'string') localStorage.setItem(key, saved[key]);
  } catch {}
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    setItem.call(this, key, value);
    if (this === localStorage && keys.includes(key)) bridge.saveStorage(key, String(value));
  };
  const removeItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function(key) {
    removeItem.call(this, key);
    if (this === localStorage && keys.includes(key)) bridge.saveStorage(key, '');
  };

  let apiModule;
  window.fetch = async (input, init = {}) => {
    const request = new Request(new URL(typeof input === 'string' ? input : input.url || input, location.href), input instanceof Request ? input : undefined);
    const url = new URL(request.url);
    const signal = init.signal || request.signal;
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
      apiModule ||= import('/native-api.js');
      return (await apiModule).handleRequest(url, signal);
    }
    if (url.origin === location.origin || !['http:', 'https:'].includes(url.protocol)) return originalFetch(input, init);
    const result = await window.__dinosourNativeCall('http', {
      url: url.href, method: init.method || request.method,
      headers: Object.fromEntries(new Headers(init.headers || request.headers)),
      body: init.body ?? (request.method !== 'GET' && request.method !== 'HEAD' ? await request.text() : null),
    }, signal);
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
})();
