importScripts("core.js");

let badgeTimer = null;
function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}

function reportResult(result) {
  if (result.handled) flashBadge("\u2713", "#2fb350");
  else if (result.status === 401) flashBadge("!", "#e0483e"); // token mismatch: tell the user
}

// Fires while Chrome picks a filename for a new download. We must call suggest() exactly once.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    try {
      reportResult(await CascadeCore.handleDownload(chrome, fetch, item, navigator.userAgent));
    } catch (e) {
      console.warn("Cascade: capture failed, leaving the download to Chrome", e);
    } finally {
      suggest(); // no override: Chrome proceeds (or has already had its download cancelled)
    }
  })();
  return true; // async suggest()
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "cascade-link", title: "Download with Cascade", contexts: ["link"] });
  });
  const s = await CascadeCore.loadSettings(chrome);
  if (!s.token) chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "cascade-link" || !info.linkUrl) return;
  reportResult(await CascadeCore.handleLink(chrome, fetch, info, navigator.userAgent));
});
