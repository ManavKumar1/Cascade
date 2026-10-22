const $ = (id) => document.getElementById(id);
const FIELDS = ["token", "port", "minSizeMB", "excludedDomains"];

function read() {
  return { enabled: $("enabled").checked, token: $("token").value.trim(), port: Number($("port").value) || 38573,
           minSizeMB: Number($("minSizeMB").value) || 0, excludedDomains: $("excludedDomains").value };
}
async function load() {
  const s = await CascadeCore.loadSettings(chrome);
  $("enabled").checked = s.enabled;
  FIELDS.forEach((f) => ($(f).value = s[f]));
}
function show(text, ok) { $("status").textContent = text; $("status").className = ok ? "ok" : "bad"; }

$("save").onclick = async () => { await chrome.storage.local.set(read()); show("Saved.", true); };
$("test").onclick = async () => {
  const s = read();
  await chrome.storage.local.set(s);
  const r = await CascadeCore.ping(fetch, s);
  if (!r.reachable) show("Can't reach Cascade. Is the app running, and the port right?", false);
  else if (!r.authorized) show("Cascade is running, but the token doesn't match.", false);
  else show("Connected to Cascade " + (r.version || "") + ".", true);
};
load();
