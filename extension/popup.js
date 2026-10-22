(async () => {
  const s = await CascadeCore.loadSettings(chrome);
  const en = document.getElementById("enabled");
  en.checked = s.enabled;
  en.onchange = () => chrome.storage.local.set({ enabled: en.checked });
  document.getElementById("opts").onclick = () => chrome.runtime.openOptionsPage();
  const st = document.getElementById("st");
  const r = await CascadeCore.ping(fetch, s);
  if (!r.reachable) { st.textContent = "App not running"; st.className = "st bad"; }
  else if (!r.authorized) { st.textContent = "Token needed — open Settings"; st.className = "st bad"; }
  else { st.textContent = "Connected"; st.className = "st ok"; }
})();
