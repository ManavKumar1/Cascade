/* Cascade Download Catcher: decision + transport logic.
 * Plain script so the service worker can importScripts() it and the Node test suite can require() it. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CascadeCore = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const DEFAULTS = { enabled: true, port: 38573, token: "", minSizeMB: 0, excludedDomains: "" };

  function parseDomains(text) {
    return String(text || "").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  function hostMatches(host, domains) {
    return domains.some((d) => host === d || host.endsWith("." + d));
  }
  function baseName(p) {
    return String(p || "").split(/[\\/]/).pop() || "";
  }

  async function loadSettings(chromeApi) {
    return Object.assign({}, DEFAULTS, await chromeApi.storage.local.get(DEFAULTS));
  }

  /** Should this Chrome download be handed to Cascade? Anything we can't safely re-fetch stays in Chrome. */
  function shouldCapture(item, settings) {
    if (!settings.enabled || !settings.token) return false;
    if (item.incognito) return false; // different cookie jar; also respects the user's privacy intent
    if (item.byExtensionId) return false;
    let u;
    try {
      u = new URL(item.url || item.finalUrl || "");
    } catch (e) {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false; // blob:, data:, file: can't be re-fetched
    const hosts = [u.hostname.toLowerCase()];
    try {
      if (item.finalUrl) hosts.push(new URL(item.finalUrl).hostname.toLowerCase());
    } catch (e) {}
    const excluded = parseDomains(settings.excludedDomains);
    if (hosts.some((h) => hostMatches(h, excluded))) return false;
    const minBytes = (Number(settings.minSizeMB) || 0) * 1024 * 1024;
    if (minBytes > 0 && item.fileSize > 0 && item.fileSize < minBytes) return false; // unknown size => capture
    return true;
  }

  async function buildPayload(chromeApi, item, suggestedName, userAgent) {
    // Re-issue the *original* request (not the redirect target) so tokens/redirects behave as they did in Chrome.
    const url = item.url || item.finalUrl;
    let cookies = "";
    try {
      const list = await chromeApi.cookies.getAll({ url });
      cookies = list.map((c) => c.name + "=" + c.value).join("; ");
    } catch (e) {}
    return {
      url,
      fileName: baseName(suggestedName || item.filename) || undefined,
      referrer: item.referrer || undefined,
      userAgent: userAgent || undefined,
      cookies: cookies || undefined,
    };
  }

  async function postToApp(fetchImpl, settings, payload, wait) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), wait ? 9000 : 4000);
    try {
      const res = await fetchImpl("http://127.0.0.1:" + settings.port + "/add", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cascade-Token": settings.token },
        body: JSON.stringify(Object.assign({}, payload, { wait })),
        signal: controller.signal,
      });
      let body = null;
      try { body = await res.json(); } catch (e) {}
      if (res.ok && body && body.ok) return { handled: true, body };
      return { handled: false, status: res.status, error: (body && body.error) || "HTTP " + res.status };
    } catch (e) {
      return { handled: false, error: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Called while Chrome is deciding a download's filename. If Cascade accepts the download
   * (it probed the server successfully), cancel Chrome's copy. If anything goes wrong,
   * return handled:false and Chrome carries on as if we weren't here.
   */
  async function handleDownload(chromeApi, fetchImpl, item, userAgent) {
    const settings = await loadSettings(chromeApi);
    if (!shouldCapture(item, settings)) return { handled: false, reason: "skipped" };
    const payload = await buildPayload(chromeApi, item, item.filename, userAgent);
    const result = await postToApp(fetchImpl, settings, payload, true);
    if (!result.handled) return { handled: false, reason: result.error, status: result.status };
    try { await chromeApi.downloads.cancel(item.id); } catch (e) {}
    try { await chromeApi.downloads.erase({ id: item.id }); } catch (e) {}
    return { handled: true };
  }

  /** Right-click "Download with Cascade" on a link. */
  async function handleLink(chromeApi, fetchImpl, info, userAgent) {
    const settings = await loadSettings(chromeApi);
    if (!settings.token) return { handled: false, reason: "no token" };
    const payload = await buildPayload(chromeApi, { url: info.linkUrl, referrer: info.pageUrl }, "", userAgent);
    return postToApp(fetchImpl, settings, payload, false);
  }

  async function ping(fetchImpl, settings) {
    try {
      const res = await fetchImpl("http://127.0.0.1:" + settings.port + "/ping", {
        headers: { "X-Cascade-Token": settings.token },
      });
      const body = await res.json();
      return { reachable: true, authorized: !!body.authorized, version: body.version };
    } catch (e) {
      return { reachable: false, authorized: false };
    }
  }

  return { DEFAULTS, parseDomains, baseName, loadSettings, shouldCapture, buildPayload, postToApp, handleDownload, handleLink, ping };
});
