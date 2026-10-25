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
  tutorialSeenStepIds: string[];
}

type UpdateState =
  | { phase: "checking" }
  | { phase: "current" }
  | { phase: "available"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "error"; message: string };

interface AppState {
  settings: Settings;
  effectiveDownloadDir: string;
  bridge: { running: boolean; port: number; error?: string };
  extensionPath: string;
  dataPath: string;
  version: string;
  launchAtLogin: boolean;
  update: UpdateState | null;
}

interface CascadeAPI {
  list(): Promise<UIDownload[]>;
  add(url: string, destinationDir?: string): Promise<UIDownload>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  erase(id: string): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  revealInFinder(id: string): Promise<void>;
  getThumbnail(id: string): Promise<string | null>;
  chooseDestinationDir(): Promise<string | null>;
  getFreeSpace(dir: string): Promise<number | null>;
  getState(): Promise<AppState>;
  updateSettings(patch: Partial<Settings>): Promise<AppState>;
  regenerateToken(): Promise<AppState>;
  setLaunchAtLogin(enabled: boolean): Promise<AppState>;
  installUpdate(): Promise<void>;
  copyText(text: string): Promise<void>;
  revealExtensionFolder(): Promise<void>;
  revealDataFolder(): Promise<void>;
  openSupportLink(): Promise<void>;
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
const freeSpaceLabel = $("freeSpaceLabel");
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
const launchAtLoginToggle = $("launchAtLoginToggle") as HTMLInputElement;

let chosenDestDir: string | null = null;

// Every icon is a <use> reference into the sprite defined once in index.html — add a symbol there
// to add an icon here, rather than inlining SVG path data at each call site.
function useIcon(id: string): string {
  return `<svg class="icon" viewBox="0 0 16 16"><use href="#icon-${id}"/></svg>`;
}

// A quick visual sort cue down a long list: what kind of thing is this, at a glance, before the name
// is even read. Falls back to a plain-file glyph for anything not recognized.
const FILE_TYPE_ICON: Record<string, string> = Object.fromEntries(
  [
    ["image", "jpg jpeg png gif webp avif heic heif bmp svg ico tiff tif jxl"],
    ["video", "mp4 mov mkv avi webm m4v wmv flv mpg mpeg ogv 3gp ts"],
    ["audio", "mp3 m4a wav flac aac ogg opus weba mid"],
    ["archive", "zip rar 7z tar gz bz2 xz zst dmg iso jar apk deb rpm"],
    ["doc", "pdf doc docx txt md rtf pages odt xls xlsx ppt pptx csv"],
  ].flatMap(([kind, exts]) => exts.split(" ").map((e) => [e, kind]))
);
function fileTypeIconId(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return "file-" + ((m && FILE_TYPE_ICON[m[1].toLowerCase()]) || "generic");
}

// A real preview of the downloaded image, used as that row's icon instead of the generic glyph.
// Rows are rebuilt from scratch on every list update, so without a cache this would re-request the
// same thumbnail over IPC on every tick; null means "already tried, nothing to show" (not yet fetched).
const thumbCache = new Map<string, string | null>();
const thumbFetching = new Set<string>();
function maybeLoadThumbnail(d: UIDownload, typeIconEl: HTMLElement): void {
  if (d.status !== "completed" || fileTypeIconId(d.destinationPath) !== "file-image") return;
  const cached = thumbCache.get(d.id);
  if (cached) {
    typeIconEl.innerHTML = `<img class="row-thumb" src="${cached}" alt="" />`;
    return;
  }
  if (thumbCache.has(d.id) /* cached as null: tried already, no thumbnail available */ || thumbFetching.has(d.id)) return;
  thumbFetching.add(d.id);
  void cascade.getThumbnail(d.id).then((url) => {
    thumbFetching.delete(d.id);
    thumbCache.set(d.id, url);
    if (!url) return;
    // The row may have been rebuilt since this request started — look it up fresh rather than
    // holding on to typeIconEl, which could by now be a detached element from a replaced row.
    const freshIcon = listEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(d.id)}"] .row-type`);
    if (freshIcon) freshIcon.innerHTML = `<img class="row-thumb" src="${url}" alt="" />`;
  });
}

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

function iconButton(iconId: string, title: string, onClick: () => void, variant?: "danger"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "btn-icon row-action" + (variant ? ` ${variant}` : "");
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.innerHTML = useIcon(iconId);
  // Row actions live inside a row that itself has no click behavior, so no stopPropagation is needed —
  // kept as separate listeners (not row-level delegation) so each button's purpose stays self-contained.
  btn.addEventListener("click", onClick);
  return btn;
}

function renderRow(d: UIDownload): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = d.id;

  const typeIcon = document.createElement("div");
  typeIcon.className = "row-type";
  typeIcon.innerHTML = useIcon(fileTypeIconId(d.destinationPath));
  maybeLoadThumbnail(d, typeIcon);

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
  // How many live connections this download is using becomes the number of visible flow channels —
  // real engine state rendered directly, not a decorative texture.
  track.style.setProperty("--channels", String(Math.min(8, Math.max(1, d.progress.connections || 1))));
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  if (d.status === "failed") fill.classList.add("danger");
  if (d.status === "completed") fill.classList.add("success");
  if (d.status === "downloading") fill.classList.add("active");
  if (d.progress.percent === null && (d.status === "downloading" || d.status === "connecting")) {
    fill.classList.add("indeterminate");
  } else {
    fill.style.width = `${d.status === "completed" ? 100 : d.progress.percent ?? 0}%`;
  }
  track.append(fill);

  const status = document.createElement("div");
  status.className = "row-status";
  const statusText = document.createElement("span");
  statusText.className = "row-status-main";
  if (d.status === "failed") statusText.classList.add("danger-text");
  if (d.status === "completed") statusText.innerHTML = useIcon("check") + "<span>Completed</span>";
  else statusText.textContent = statusLabel(d);
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
    actions.append(iconButton("pause", "Pause", () => void cascade.pause(d.id)));
  } else if (d.status === "failed") {
    actions.append(iconButton("retry", "Retry now", () => void cascade.resume(d.id)));
  } else if (d.status === "paused") {
    actions.append(iconButton("play", "Resume", () => void cascade.resume(d.id)));
  }
  // A link button was here, but what's useful on a row you're already looking at is the file
  // itself, not its URL — show it in Finder. There's something to point to in every status except
  // queued (not started) and canceled (its partial file was deleted along with the cancel).
  if (d.status !== "queued" && d.status !== "canceled") {
    actions.append(iconButton("folder", "Show in Finder", () => void cascade.revealInFinder(d.id)));
  }

  // The × (dismiss — list entry only, no file touched) only makes sense once a download is actually
  // finished: that's the one point where "keep the file but tidy the list" is something you'd
  // plausibly want. For anything not yet complete — queued, connecting, downloading, paused, failed,
  // canceled — there's no finished file worth keeping around with no list entry pointing at it, so
  // the only action offered is the trash can, which always means cascade.erase(): stop it if it's
  // still running, then delete whatever's actually on disk (partial or, for completed, the real file).
  if (d.status === "completed") {
    actions.append(iconButton("close", "Remove from list (keeps the file)", () => void cascade.dismiss(d.id)));
    actions.append(iconButton("trash", "Delete file and remove", () => void cascade.erase(d.id), "danger"));
  } else {
    const label = d.status === "downloading" || d.status === "connecting" ? "Cancel and delete partial file" : "Delete and remove";
    actions.append(iconButton("trash", label, () => void cascade.erase(d.id), "danger"));
  }

  row.append(typeIcon, main, actions);
  return row;
}

// Status and resumability are what decide a row's actual shape — which buttons show, the status
// icon vs. plain text, the fill's color class. Everything else (bytes, percent, speed, connection
// count) just ticks continuously without changing any of that. Tracking this separately from the
// full download object is what lets render() below tell "just a progress tick" from "something
// actually changed" without re-deriving it from the live DOM on every call.
const lastRowShape = new Map<string, string>();
const rowShape = (d: UIDownload): string => `${d.status}|${d.resumable}`;

// Patches an existing row's own DOM nodes in place — nothing is removed or recreated. Only called
// when rowShape() confirms the row's buttons/classes don't need to change, which is what actually
// matters here: replacing a hovered row's element out from under the cursor, even with an identical
// replacement, drops and re-applies :hover (and restarts its opacity transition) on every single
// tick, which is what used to make a row's actions flicker continuously while it downloaded.
function patchRow(row: HTMLElement, d: UIDownload): void {
  const track = row.querySelector<HTMLElement>(".progress-track")!;
  track.style.setProperty("--channels", String(Math.min(8, Math.max(1, d.progress.connections || 1))));
  const fill = row.querySelector<HTMLElement>(".progress-fill")!;
  const indeterminate = d.progress.percent === null && (d.status === "downloading" || d.status === "connecting");
  fill.classList.toggle("indeterminate", indeterminate);
  if (indeterminate) fill.style.removeProperty("width"); // in case a previous tick had set one
  else fill.style.width = `${d.status === "completed" ? 100 : d.progress.percent ?? 0}%`;

  if (d.status !== "completed") {
    row.querySelector<HTMLElement>(".row-status-main")!.textContent = statusLabel(d);
  }
  const sizeEl = row.querySelector<HTMLElement>(".row-status .mono");
  if (sizeEl && d.status !== "completed") {
    sizeEl.textContent =
      d.progress.totalBytes !== null
        ? `${formatBytes(d.progress.bytesDownloaded)} / ${formatBytes(d.progress.totalBytes)}`
        : formatBytes(d.progress.bytesDownloaded);
  }
}

// Rows are rebuilt from scratch here (simplest correct approach for genuine structural change, and
// this list is short), which would otherwise make every add/remove/reorder look like a hard cut. A
// plain FLIP pass restores continuity: measure where surviving rows were, replace the DOM, then
// animate each from its old position to its new one. New rows get a small entrance instead of
// popping in. Skipped under reduced-motion. render() below only takes this path for an actual
// structural change — see patchRow() above for the far more common "just a progress tick" case.
const seenRowIds = new Set<string>();
function render(downloads: UIDownload[]): void {
  // listEl and emptyStateEl are sibling flex:1 children of the same column — with no downloads,
  // an empty listEl still claims half the vertical space for itself and pushes the empty state off
  // center, so this has to run on every call including the fast path below, not just when rows are
  // actually rebuilt — otherwise the very first render on a fresh, empty install would return out of
  // the fast path (0 current rows, 0 incoming — technically no change) without ever setting either.
  const empty = downloads.length === 0;
  emptyStateEl.hidden = !empty;
  listEl.hidden = empty;

  const currentRows = Array.from(listEl.children) as HTMLElement[];
  const currentIds = currentRows.map((el) => el.dataset.id);
  const sameShape =
    currentIds.length === downloads.length &&
    currentIds.every((id, i) => id === downloads[i].id && lastRowShape.get(id!) === rowShape(downloads[i]));
  if (sameShape) {
    downloads.forEach((d, i) => patchRow(currentRows[i], d));
    return;
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const before = reduceMotion
    ? null
    : new Map((Array.from(listEl.children) as HTMLElement[]).map((el) => [el.dataset.id!, el.getBoundingClientRect()]));

  listEl.replaceChildren(...downloads.map(renderRow));
  lastRowShape.clear();
  for (const d of downloads) lastRowShape.set(d.id, rowShape(d));

  for (const el of Array.from(listEl.children) as HTMLElement[]) {
    const id = el.dataset.id!;
    const prevRect = before?.get(id);
    if (!reduceMotion && prevRect) {
      const newRect = el.getBoundingClientRect();
      const dy = prevRect.top - newRect.top;
      if (Math.abs(dy) > 1) {
        el.style.transition = "none";
        el.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 0.28s cubic-bezier(.2,.7,.3,1)";
          el.style.transform = "";
        });
      }
    } else if (!reduceMotion && !seenRowIds.has(id)) {
      el.classList.add("row-enter");
    }
    seenRowIds.add(id);
  }
  for (const id of Array.from(seenRowIds)) {
    if (!downloads.some((d) => d.id === id)) seenRowIds.delete(id);
  }
}

// ---- Add sheet ----
// A stale number is worse than no number — each call is tagged, and only the most recently started
// one is allowed to write the label, so a fast re-pick after a slow one can't land out of order.
let freeSpaceRequestId = 0;
function updateFreeSpaceLabel(dir: string): void {
  const requestId = ++freeSpaceRequestId;
  freeSpaceLabel.textContent = "";
  void cascade.getFreeSpace(dir).then((bytes) => {
    if (requestId !== freeSpaceRequestId) return;
    freeSpaceLabel.textContent = bytes !== null ? `${formatBytes(bytes)} free` : "";
  });
}
function openAddOverlay(): void {
  urlInput.value = "";
  addError.hidden = true;
  chosenDestDir = null;
  destInput.value = appState ? appState.effectiveDownloadDir : "";
  addOverlay.hidden = false;
  urlInput.focus();
  if (appState) updateFreeSpaceLabel(appState.effectiveDownloadDir);
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
    updateFreeSpaceLabel(dir);
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
  launchAtLoginToggle.checked = s.launchAtLogin;
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

  const banner = $("updateBanner");
  const msg = $("updateMsg");
  const installBtn = $("updateInstallBtn") as HTMLButtonElement;
  const u = s.update;
  if (!u || u.phase === "current" || u.phase === "checking") {
    banner.hidden = true;
  } else if (u.phase === "available") {
    banner.hidden = false;
    msg.textContent = u.version ? `Downloading Cascade ${u.version}…` : "Downloading update…";
    installBtn.hidden = true;
  } else if (u.phase === "ready") {
    banner.hidden = false;
    msg.textContent = u.version ? `Cascade ${u.version} is ready.` : "Update ready.";
    installBtn.hidden = false;
  } else if (u.phase === "error") {
    banner.hidden = false;
    // Transient (offline, rate-limit) — don't alarm, just quietly note it.
    msg.textContent = "Update check failed — will retry.";
    installBtn.hidden = true;
  }
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
launchAtLoginToggle.addEventListener("change", () => void cascade.setLaunchAtLogin(launchAtLoginToggle.checked).then(applyState));
connRange.addEventListener("input", () => (connLabel.textContent = connRange.value));
connRange.addEventListener("change", () => void cascade.updateSettings({ maxConnections: Number(connRange.value) }).then(applyState));
concRange.addEventListener("input", () => (concLabel.textContent = concRange.value));
concRange.addEventListener("change", () => void cascade.updateSettings({ maxConcurrent: Number(concRange.value) }).then(applyState));
bridgeToggle.addEventListener("change", () => void cascade.updateSettings({ bridgeEnabled: bridgeToggle.checked }).then(applyState));
$("copyTokenBtn").addEventListener("click", () => void cascade.copyText(tokenInput.value));
$("newTokenBtn").addEventListener("click", () => void cascade.regenerateToken().then(applyState));
$("revealDataBtn").addEventListener("click", () => void cascade.revealDataFolder());
$("revealExtBtn").addEventListener("click", () => void cascade.revealExtensionFolder());
$("supportBtn").addEventListener("click", () => void cascade.openSupportLink());
$("updateInstallBtn").addEventListener("click", () => void cascade.installUpdate());
$("replayTutorialBtn").addEventListener("click", () => {
  settingsOverlay.hidden = true;
  window.CascadeTutorial.replay((seenIds) => void cascade.updateSettings({ tutorialSeenStepIds: seenIds }).then(applyState));
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!settingsOverlay.hidden) settingsOverlay.hidden = true;
  else if (!addOverlay.hidden) closeAddOverlay();
});

cascade.onChanged(render);
cascade.onStateChanged(applyState);
void cascade.list().then(render);
void cascade.getState().then((s) => {
  applyState(s);
  // Only on this first load, not on every onStateChanged update, or finishing the tour would
  // immediately re-trigger itself the moment the completion's own updateSettings() call lands.
  window.CascadeTutorial.maybeStart(s.settings.tutorialSeenStepIds, (seenIds) => {
    const merged = Array.from(new Set([...s.settings.tutorialSeenStepIds, ...seenIds]));
    void cascade.updateSettings({ tutorialSeenStepIds: merged }).then(applyState);
  });
});
