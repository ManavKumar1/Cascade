// This file deliberately has no import/export statements. The renderer loads as a plain <script>
// with no module loader: even a type-only import makes tsc emit CommonJS boilerplate (a reference
// to the global `exports`) that throws immediately in this context. Keep the shapes below in sync
// by hand with src/shared/types.ts and the `api` object in src/main/preload.ts.

type DownloadStatus = "queued" | "connecting" | "downloading" | "paused" | "completed" | "failed" | "canceled";

interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number | null;
  percent: number | null;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  connections: number;
}

interface UIDownload {
  id: string;
  url: string;
  destinationPath: string;
  status: DownloadStatus;
  error: string | null;
  progress: DownloadProgress;
  resumable: boolean | null;
  retryAt: number | null;
}

type ThemeMode = "system" | "light" | "dark";
type ThemeId = "cascade" | "ocean" | "forest" | "sunset" | "rose" | "mono";

interface Settings {
  mode: ThemeMode;
  theme: ThemeId;
  downloadDir: string | null;
  maxConnections: number;
  maxConcurrent: number;
  bridgeEnabled: boolean;
  bridgePort: number;
  bridgeToken: string;
}

interface AppState {
  settings: Settings;
  effectiveDownloadDir: string;
  bridge: { running: boolean; port: number; error?: string };
  extensionPath: string;
  dataPath: string;
  version: string;
}

interface CascadeAPI {
  list(): Promise<UIDownload[]>;
  add(url: string, destinationDir?: string): Promise<UIDownload>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  revealInFinder(id: string): Promise<void>;
  chooseDestinationDir(): Promise<string | null>;
  getState(): Promise<AppState>;
  updateSettings(patch: Partial<Settings>): Promise<AppState>;
  regenerateToken(): Promise<AppState>;
  copyText(text: string): Promise<void>;
  revealExtensionFolder(): Promise<void>;
  revealDataFolder(): Promise<void>;
  onChanged(callback: (downloads: UIDownload[]) => void): () => void;
  onStateChanged(callback: (state: AppState) => void): () => void;
}

declare const cascade: CascadeAPI;

// ---- Formatting (mirrors src/engine/utils.ts; the renderer can't import it without a bundler) ----
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const precision = i === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[i]}`;
}
function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}
function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m left`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m left`;
}
function filename(p: string): string {
  return p.split("/").pop() || p;
}
function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

// ---- Theme ----
const THEMES: Array<{ id: ThemeId; name: string }> = [
  { id: "cascade", name: "Cascade" },
  { id: "ocean", name: "Ocean" },
  { id: "forest", name: "Forest" },
  { id: "sunset", name: "Sunset" },
  { id: "rose", name: "Rose" },
  { id: "mono", name: "Graphite" },
];
const html = document.documentElement;
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let appState: AppState | null = null;

function applyAppearance(s: Settings | null): void {
  const mode: ThemeMode = s ? s.mode : "system";
  html.dataset.theme = s ? s.theme : html.dataset.theme || "cascade";
  html.dataset.mode = mode === "dark" || (mode === "system" && darkQuery.matches) ? "dark" : "light";
}
// First paint: the main process passes the saved theme in the URL, so there's no flash of the default.
html.dataset.theme = new URLSearchParams(location.search).get("theme") || "cascade";
html.dataset.mode = darkQuery.matches ? "dark" : "light";
darkQuery.addEventListener("change", () => applyAppearance(appState ? appState.settings : null));

// ---- Elements ----
const listEl = $("list");
const emptyStateEl = $("emptyState");
const addOverlay = $("addOverlay");
const urlInput = $("urlInput") as HTMLInputElement;
const destInput = $("destInput") as HTMLInputElement;
const addError = $("addError");
const settingsOverlay = $("settingsOverlay");
const modeSeg = $("modeSeg");
const swatchesEl = $("themeSwatches");
const dirLabel = $("dirLabel");
const connRange = $("connRange") as HTMLInputElement;
const connLabel = $("connLabel");
const concRange = $("concRange") as HTMLInputElement;
const concLabel = $("concLabel");
const bridgeToggle = $("bridgeToggle") as HTMLInputElement;
const bridgeStatusEl = $("bridgeStatus");
const bridgeDetails = $("bridgeDetails");
const tokenInput = $("tokenInput") as HTMLInputElement;

let chosenDestDir: string | null = null;

const icons = {
  play: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M4 2.8c0-.7.8-1.1 1.4-.7l8 5.2c.5.3.5 1.1 0 1.4l-8 5.2c-.6.4-1.4 0-1.4-.7V2.8Z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1"/></svg>',
  remove: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none"><path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3l1.3 1.6h5.3A1.2 1.2 0 0 1 14 5.8v6A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8V4.2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

// ---- Download list ----
function statusLabel(d: UIDownload): string {
  switch (d.status) {
    case "queued":
      return "Queued";
    case "connecting":
      return "Connecting…";
    case "downloading": {
      const conn = d.progress.connections > 1 ? ` · ${d.progress.connections} connections` : "";
      return `${formatSpeed(d.progress.speedBytesPerSec)} · ${formatEta(d.progress.etaSeconds)}${conn}`;
    }
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return `Failed — ${d.error ?? "unknown error"}${d.retryAt ? " · retrying automatically" : ""}`;
    case "canceled":
      return "Canceled";
  }
}

function iconButton(svg: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "btn-icon";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = svg;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderRow(d: UIDownload): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  const main = document.createElement("div");
  main.className = "row-main";

  const top = document.createElement("div");
  top.className = "row-top";
  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = filename(d.destinationPath);
  const url = document.createElement("span");
  url.className = "row-url";
  url.textContent = d.url;
  top.append(name, url);

  const track = document.createElement("div");
  track.className = "progress-track";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  if (d.status === "failed") fill.classList.add("danger");
  if (d.status === "completed") fill.classList.add("success");
  if (d.progress.percent === null && (d.status === "downloading" || d.status === "connecting")) {
    fill.classList.add("indeterminate");
  } else {
    fill.style.width = `${d.status === "completed" ? 100 : d.progress.percent ?? 0}%`;
  }
  track.append(fill);

  const status = document.createElement("div");
  status.className = "row-status";
  const statusText = document.createElement("span");
  if (d.status === "failed") statusText.classList.add("danger-text");
  statusText.textContent = statusLabel(d);
  status.append(statusText);
  if (d.status === "downloading" || d.status === "paused") {
    const size = document.createElement("span");
    size.className = "mono";
    size.textContent =
      d.progress.totalBytes !== null
        ? `${formatBytes(d.progress.bytesDownloaded)} / ${formatBytes(d.progress.totalBytes)}`
        : formatBytes(d.progress.bytesDownloaded);
    status.append(size);
  } else if (d.status === "completed" && d.progress.totalBytes !== null) {
    const size = document.createElement("span");
    size.className = "mono";
    size.textContent = formatBytes(d.progress.totalBytes);
    status.append(size);
  }
  if (d.resumable === false && d.status !== "completed" && d.status !== "queued") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "Can't resume";
    tag.title = "This server doesn't allow continuing a partial download, so pausing or quitting restarts it from the beginning.";
    status.append(tag);
  }
  main.append(top, track, status);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  if (d.status === "downloading" || d.status === "connecting") {
    actions.append(iconButton(icons.pause, "Pause", () => void cascade.pause(d.id)));
  } else if (d.status === "paused" || d.status === "failed") {
    actions.append(iconButton(icons.play, "Resume", () => void cascade.resume(d.id)));
  } else if (d.status === "completed") {
    actions.append(iconButton(icons.folder, "Show in Finder", () => void cascade.revealInFinder(d.id)));
  }
  const removeBtn = iconButton(
    icons.remove,
    d.status === "completed" ? "Remove from list (keeps the file)" : "Cancel and delete partial file",
    () => void cascade.remove(d.id)
  );
  removeBtn.classList.add("danger");
  actions.append(removeBtn);

  row.append(main, actions);
  return row;
}

function render(downloads: UIDownload[]): void {
  listEl.replaceChildren(...downloads.map(renderRow));
  emptyStateEl.hidden = downloads.length > 0;
}

// ---- Add sheet ----
function openAddOverlay(): void {
  urlInput.value = "";
  addError.hidden = true;
  chosenDestDir = null;
  destInput.value = appState ? appState.effectiveDownloadDir : "";
  addOverlay.hidden = false;
  urlInput.focus();
}
function closeAddOverlay(): void {
  addOverlay.hidden = true;
}
async function confirmAdd(): Promise<void> {
  const url = urlInput.value.trim();
  const fail = (msg: string) => {
    addError.textContent = msg;
    addError.hidden = false;
  };
  if (!url) return fail("Enter a URL.");
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return fail("Only http and https links are supported.");
  } catch {
    return fail("That doesn't look like a valid URL.");
  }
  try {
    await cascade.add(url, chosenDestDir ?? undefined);
    closeAddOverlay();
  } catch (e) {
    fail(e instanceof Error ? e.message : "Couldn't add that download.");
  }
}

$("addBtn").addEventListener("click", openAddOverlay);
$("cancelAddBtn").addEventListener("click", closeAddOverlay);
$("confirmAddBtn").addEventListener("click", () => void confirmAdd());
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void confirmAdd();
});
$("chooseDestBtn").addEventListener("click", async () => {
  const dir = await cascade.chooseDestinationDir();
  if (dir) {
    chosenDestDir = dir;
    destInput.value = dir;
  }
});
addOverlay.addEventListener("click", (e) => {
  if (e.target === addOverlay) closeAddOverlay();
});
$("pauseAllBtn").addEventListener("click", () => void cascade.pauseAll());
$("resumeAllBtn").addEventListener("click", () => void cascade.resumeAll());

// ---- Settings sheet ----
THEMES.forEach((t) => {
  const b = document.createElement("button");
  b.className = "swatch";
  b.dataset.theme = t.id; // scopes this theme's CSS variables to the swatch, so it previews itself
  b.setAttribute("role", "radio");
  b.innerHTML = `<span class="dot"></span><span>${t.name}</span>`;
  b.addEventListener("click", () => void cascade.updateSettings({ theme: t.id }).then(applyState));
  swatchesEl.append(b);
});
modeSeg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
  b.addEventListener("click", () => void cascade.updateSettings({ mode: b.dataset.mode as ThemeMode }).then(applyState));
});

function renderSettings(s: AppState): void {
  const st = s.settings;
  modeSeg.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === st.mode)));
  swatchesEl.querySelectorAll<HTMLButtonElement>(".swatch").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.theme === st.theme)));
  dirLabel.textContent = s.effectiveDownloadDir;
  connRange.value = String(st.maxConnections);
  connLabel.textContent = String(st.maxConnections);
  concRange.value = String(st.maxConcurrent);
  concLabel.textContent = String(st.maxConcurrent);
  bridgeToggle.checked = st.bridgeEnabled;
  bridgeDetails.hidden = !st.bridgeEnabled;
  tokenInput.value = st.bridgeToken;
  bridgeStatusEl.className = "setting-sub " + (s.bridge.running ? "good" : s.bridge.error ? "bad" : "");
  bridgeStatusEl.textContent = s.bridge.running
    ? `Listening on 127.0.0.1:${s.bridge.port} (this computer only)`
    : s.bridge.error ?? "Off";
  $("dataPathLabel").textContent = s.dataPath;
  $("aboutLine").textContent = `Cascade ${s.version}`;
}

function applyState(s: AppState): void {
  appState = s;
  applyAppearance(s.settings);
  renderSettings(s);
}

$("settingsBtn").addEventListener("click", () => {
  settingsOverlay.hidden = false;
});
$("closeSettingsBtn").addEventListener("click", () => {
  settingsOverlay.hidden = true;
});
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});
$("changeDirBtn").addEventListener("click", async () => {
  const dir = await cascade.chooseDestinationDir();
  if (dir) applyState(await cascade.updateSettings({ downloadDir: dir }));
});
connRange.addEventListener("input", () => (connLabel.textContent = connRange.value));
connRange.addEventListener("change", () => void cascade.updateSettings({ maxConnections: Number(connRange.value) }).then(applyState));
concRange.addEventListener("input", () => (concLabel.textContent = concRange.value));
concRange.addEventListener("change", () => void cascade.updateSettings({ maxConcurrent: Number(concRange.value) }).then(applyState));
bridgeToggle.addEventListener("change", () => void cascade.updateSettings({ bridgeEnabled: bridgeToggle.checked }).then(applyState));
$("copyTokenBtn").addEventListener("click", () => void cascade.copyText(tokenInput.value));
$("newTokenBtn").addEventListener("click", () => void cascade.regenerateToken().then(applyState));
$("revealDataBtn").addEventListener("click", () => void cascade.revealDataFolder());
$("revealExtBtn").addEventListener("click", () => void cascade.revealExtensionFolder());

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!settingsOverlay.hidden) settingsOverlay.hidden = true;
  else if (!addOverlay.hidden) closeAddOverlay();
});

cascade.onChanged(render);
cascade.onStateChanged(applyState);
void cascade.list().then(render);
void cascade.getState().then(applyState);
