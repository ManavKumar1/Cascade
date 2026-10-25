import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard, powerMonitor, Menu, nativeImage, autoUpdater } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { DownloadManager } from "../engine/DownloadManager";
import { DownloadTask } from "../engine/DownloadTask";
import { SettingsStore } from "./settings";
import { BrowserBridge } from "./bridge";
import { makeAdder } from "./adder";
import { createLogger } from "./log";
import type { AppState, BridgeStatus, Settings, UIDownload, UpdateState } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let manager: DownloadManager;
let settingsStore: SettingsStore;
let adder: ReturnType<typeof makeAdder>;
let bridge: BrowserBridge | null = null;
let bridgeStatus: BridgeStatus = { running: false, port: 0 };
let quitting = false;
let log: (message: string) => void = () => {};

function buildMenu(): void {
  // Deliberately no "View" menu — that's where Electron's defaults put Reload, Force Reload,
  // and Toggle Developer Tools. Leaving it off removes all three, menu-wise; devTools:false on
  // the window is what actually blocks the shortcut too. Edit/Window roles are kept so
  // Cmd+C/V/X/A/Z keep working in the token and URL fields.
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" as const },
            { type: "separator" as const },
            { role: "services" as const },
            { type: "separator" as const },
            { role: "hide" as const },
            { role: "hideOthers" as const },
            { role: "unhide" as const },
            { type: "separator" as const },
            { role: "quit" as const },
          ],
        }]
      : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ role: "front" as const }] : [{ role: "close" as const }])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (isMac) {
    app.setAboutPanelOptions({ applicationName: "Cascade", applicationVersion: app.getVersion(), credits: "Made with ❤️ in India" });
  }
}

function createWindow(): void {
  const s = settingsStore.get();
  mainWindow = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 600,
    minHeight: 420,
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e20" : "#f5f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Off in the packaged app so there's no menu item, no Cmd+Opt+I, no window to open —
      // this is what actually blocks it, not just hiding the menu entry. Still on for `npm run dev`.
      devTools: !app.isPackaged,
    },
  });
  // The theme goes in the URL so the first paint already has the right colors (no flash of the default theme).
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { theme: s.theme } });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function serializeForUI(task: DownloadTask): UIDownload {
  return {
    id: task.id,
    url: task.url,
    destinationPath: task.destinationPath,
    status: task.getStatus(),
    error: task.getError() ?? null,
    progress: task.getProgress(),
    resumable: task.getResumable(),
    retryAt: manager.getRetryAt(task.id),
  };
}

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function effectiveDownloadDir(): string {
  const dir = settingsStore.get().downloadDir;
  return dir && fs.existsSync(dir) ? dir : app.getPath("downloads");
}

function extensionPath(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "extension") : path.join(app.getAppPath(), "extension");
}

// Single source of truth for maintainer-specific info (see maintainer.config.json at the repo root).
// Read live, not cached, so editing the file takes effect on the next click without a rebuild.
function getSupportUrl(): string {
  const configPath = app.isPackaged
    ? path.join(process.resourcesPath, "maintainer.config.json")
    : path.join(app.getAppPath(), "maintainer.config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { githubUsername?: string };
    if (config.githubUsername) return `https://github.com/sponsors/${config.githubUsername}`;
  } catch {
    // Fall through to the generic page below — still a working link, just not pre-filled to a profile.
  }
  return "https://github.com/sponsors";
}

// Tracked separately from the rest of AppState so autoUpdater events (which fire outside of any
// IPC handler) can update it and broadcast without rebuilding everything else unnecessarily.
let updateState: UpdateState | null = null;

function currentState(): AppState {
  return {
    settings: settingsStore.get(),
    effectiveDownloadDir: effectiveDownloadDir(),
    bridge: bridgeStatus,
    extensionPath: extensionPath(),
    dataPath: app.getPath("userData"),
    version: app.getVersion(),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    update: updateState,
  };
}

function setUpdateState(s: UpdateState): void {
  updateState = s;
  broadcastState();
}

// The update feed URL is built from the GitHub Releases API convention that electron-builder targets
// when you set publish.provider = "github". Each release's update metadata file (latest-mac.yml) is
// at: https://github.com/{owner}/{repo}/releases/latest/download/latest-mac.yml
// The owner/repo is read from maintainer.config.json at runtime so you only have to edit one place.
// Feed URL format: https://update.electronjs.org/{owner}/{repo}/{platform}/{version}
// (This is the public Electron update service — no server to run, reads directly from GitHub Releases.)
function setupUpdater(): void {
  if (!app.isPackaged) {
    log("updater: skipping (not a packaged build)");
    return;
  }

  const configPath = path.join(app.getAppPath(), "maintainer.config.json");
  let repoOwner = "";
  let repoName = "cascade";
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { githubUsername?: string; repoName?: string };
    repoOwner = (config.githubUsername ?? "").trim();
    if (config.repoName) repoName = config.repoName.trim();
  } catch {
    log("updater: could not read maintainer.config.json — skipping update check");
    return;
  }
  if (!repoOwner) {
    log("updater: githubUsername not set in maintainer.config.json — skipping update check");
    return;
  }

  const feedUrl = `https://update.electronjs.org/${repoOwner}/${repoName}/${process.platform}-${process.arch}/${app.getVersion()}`;
  log(`updater: feed URL ${feedUrl}`);

  try {
    autoUpdater.setFeedURL({ url: feedUrl });
  } catch (err) {
    log(`updater: could not set feed URL — ${(err as Error).message}`);
    return;
  }

  autoUpdater.on("checking-for-update", () => { log("updater: checking"); setUpdateState({ phase: "checking" }); });
  autoUpdater.on("update-not-available", () => { log("updater: current"); setUpdateState({ phase: "current" }); });
  autoUpdater.on("update-available", () => { log("updater: update available — downloading"); setUpdateState({ phase: "available", version: "" }); });
  autoUpdater.on("update-downloaded", (_e, _notes, releaseName) => {
    log(`updater: ready to install ${releaseName}`);
    setUpdateState({ phase: "ready", version: releaseName ?? "" });
  });
  autoUpdater.on("error", (err) => {
    log(`updater: error — ${err.message}`);
    // Don't surface a permanent error state for transient things (offline, rate limit). The
    // next scheduled check will clear it.
    setUpdateState({ phase: "error", message: err.message });
  });

  // Check on launch (delayed so the main window is visible before anything else happens), then
  // once every 4 hours for a long-running session.
  setTimeout(() => { try { autoUpdater.checkForUpdates(); } catch { /* already logged above */ } }, 10_000);
  setInterval(() => { try { autoUpdater.checkForUpdates(); } catch { /* already logged above */ } }, 4 * 60 * 60 * 1000);
}

function broadcastState(): void {
  send("state:changed", currentState());
}

async function restartBridge(): Promise<void> {
  await bridge?.stop();
  bridge = null;
  const s = settingsStore.get();
  if (!s.bridgeEnabled) {
    bridgeStatus = { running: false, port: s.bridgePort };
    return;
  }
  const b = new BrowserBridge({
    port: s.bridgePort,
    getToken: () => settingsStore.get().bridgeToken, // read live so rotating the token takes effect immediately
    onAdd: adder.capture,
    version: app.getVersion(),
  });
  try {
    await b.start();
    bridge = b;
    bridgeStatus = { running: true, port: b.port };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    bridgeStatus = {
      running: false,
      port: s.bridgePort,
      error: code === "EADDRINUSE" ? `Port ${s.bridgePort} is already in use.` : String((err as Error).message),
    };
  }
}

async function applySettings(prev: Settings, next: Settings): Promise<void> {
  nativeTheme.themeSource = next.mode;
  manager.setMaxConcurrent(next.maxConcurrent);
  if (prev.bridgeEnabled !== next.bridgeEnabled || prev.bridgePort !== next.bridgePort) await restartBridge();
  broadcastState();
}

async function updateSettings(patch: Partial<Settings>): Promise<AppState> {
  const prev = settingsStore.get();
  const next = settingsStore.update(patch);
  await applySettings(prev, next);
  return currentState();
}

function isHttpUrl(url: unknown): url is string {
  try {
    const u = new URL(String(url));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function registerIpc(): void {
  ipcMain.handle("downloads:list", (): UIDownload[] => manager.list().map(serializeForUI));

  ipcMain.handle("downloads:add", async (_e, input: { url: string; destinationDir?: string }): Promise<UIDownload> => {
    if (!isHttpUrl(input?.url)) throw new Error("Only http(s) URLs are supported.");
    // Remember the folder the user picked, so next time they don't have to choose it again.
    if (input.destinationDir && input.destinationDir !== settingsStore.get().downloadDir) {
      await updateSettings({ downloadDir: input.destinationDir });
    }
    return serializeForUI(adder.add({ url: input.url, dir: input.destinationDir || undefined }));
  });

  ipcMain.handle("downloads:pause", (_e, id: string) => manager.pause(id));
  ipcMain.handle("downloads:resume", (_e, id: string) => manager.resume(id));
  ipcMain.handle("downloads:remove", (_e, id: string) => manager.remove(id));
  ipcMain.handle("downloads:dismiss", (_e, id: string) => manager.dismiss(id));
  ipcMain.handle("downloads:erase", (_e, id: string) => manager.erase(id));
  ipcMain.handle("downloads:pauseAll", () => manager.pauseAll());
  ipcMain.handle("downloads:resumeAll", () => manager.resumeAll());

  ipcMain.handle("downloads:revealInFinder", (_e, id: string) => {
    const task = manager.get(id);
    if (!task) return;
    // destinationPath only exists on disk once the download has actually completed — before that,
    // the real file sitting there is partPath (the .part file). Pointing showItemInFolder at a path
    // that doesn't exist yet is why this silently did nothing for anything still in progress or paused.
    shell.showItemInFolder(task.getStatus() === "completed" ? task.destinationPath : task.partPath);
  });

  // A thumbnail of the actual downloaded image, used as that row's icon instead of the generic
  // file-type glyph. Only for completed, recognizably-image files — nativeImage decodes locally
  // (no network, no extra dependency) and resize() keeps what crosses into the renderer small.
  const THUMBNAIL_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico"]);
  ipcMain.handle("downloads:getThumbnail", (_e, id: string): string | null => {
    const task = manager.get(id);
    if (!task || task.getStatus() !== "completed") return null;
    const ext = path.extname(task.destinationPath).slice(1).toLowerCase();
    if (!THUMBNAIL_EXTENSIONS.has(ext)) return null;
    try {
      const image = nativeImage.createFromPath(task.destinationPath);
      if (image.isEmpty()) return null;
      return image.resize({ width: 64, height: 64, quality: "good" }).toDataURL();
    } catch {
      return null; // unreadable, corrupt, or a format nativeImage can't decode — fall back to the glyph
    }
  });

  ipcMain.handle("downloads:chooseDestinationDir", async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: effectiveDownloadDir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Free space on the volume a destination folder lives on, for the Add Download dialog. Walks up
  // to an existing ancestor first since the chosen folder may not exist yet (createDirectory lets
  // you pick a not-yet-created one) and statfs needs a real path.
  ipcMain.handle("downloads:getFreeSpace", async (_e, dir: string): Promise<number | null> => {
    let target = dir;
    while (!fs.existsSync(target)) {
      const parent = path.dirname(target);
      if (parent === target) return null; // reached the root without finding anything that exists
      target = parent;
    }
    try {
      const stats = await fs.promises.statfs(target);
      return stats.bavail * stats.bsize;
    } catch {
      return null; // not all filesystems report this (e.g. some network mounts) — hide the label rather than guess
    }
  });

  ipcMain.handle("state:get", (): AppState => currentState());
  ipcMain.handle("state:update", (_e, patch: Partial<Settings>) => updateSettings(patch ?? {}));
  ipcMain.handle("state:regenerateToken", (): AppState => {
    settingsStore.regenerateToken();
    broadcastState();
    return currentState();
  });
  ipcMain.handle("app:setLaunchAtLogin", (_e, enabled: boolean): AppState => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return currentState();
  });
  ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(String(text)));
  ipcMain.handle("app:revealData", () => shell.openPath(app.getPath("userData")));
  // The destination always comes from maintainer.config.json on disk, never from the renderer —
  // nothing here for a compromised page to redirect elsewhere.
  ipcMain.handle("app:openSupportLink", () => shell.openExternal(getSupportUrl()));
  ipcMain.handle("app:installUpdate", () => {
    // Only callable from the renderer; actually installs and restarts the app. The renderer shows
    // the prompt — we never restart without the user explicitly clicking the button.
    log("updater: user requested restart to install update");
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle("extension:reveal", () => {
    shell.showItemInFolder(path.join(extensionPath(), "manifest.json"));
  });
}

if (!app.requestSingleInstanceLock()) {
  // Another Cascade is already running (and owns the browser-bridge port).
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const userDataDir = app.getPath("userData");
    log = createLogger(path.join(userDataDir, "cascade.log"));
    log(`--- Cascade ${app.getVersion()} starting (data: ${userDataDir}) ---`);
    settingsStore = new SettingsStore(path.join(userDataDir, "settings.json"));
    const settings = settingsStore.load();
    nativeTheme.themeSource = settings.mode;

    manager = new DownloadManager({ maxConcurrent: settings.maxConcurrent, statePath: path.join(userDataDir, "queue.json"), log });
    adder = makeAdder({
      manager,
      getDownloadDir: effectiveDownloadDir,
      fallbackDir: app.getPath("downloads"),
      getMaxConnections: () => settingsStore.get().maxConnections,
    });
    manager.events.on("changed", () => send("downloads:changed", manager.list().map(serializeForUI)));

    registerIpc();
    try {
      // Also look beside partial files in the download folders, so a lost queue file can't lose a download.
      await manager.loadState({ autoResume: true, scanDirs: [effectiveDownloadDir(), app.getPath("downloads")] });
    } catch (err) {
      log(`could not restore downloads: ${(err as Error).message}`); // never let this stop the app from opening
    }
    await restartBridge();
    log(`bridge: ${bridgeStatus.running ? "listening on " + bridgeStatus.port : bridgeStatus.error ?? "off"}`);

    // macOS/Linux tell us before a shutdown or restart: quit gracefully so progress is saved, not lost.
    // (Not in Electron's TypeScript typings for every platform, hence the cast; the event exists on macOS and Linux.)
    (powerMonitor as unknown as NodeJS.EventEmitter).on("shutdown", (e: { preventDefault: () => void }) => {
      log("system shutdown/restart requested");
      e.preventDefault(); // ask the OS to wait for us, then quit gracefully so progress is saved
      app.quit();
    });
    powerMonitor.on("suspend", () => log("system going to sleep"));
    powerMonitor.on("resume", () => {
      log("system woke up; reconnecting downloads");
      // Old connections are dead after sleep, and Wi-Fi takes a moment to return.
      setTimeout(() => {
        void manager.reconnectAll();
        manager.retryNow();
      }, 4000);
    });
    process.on("SIGTERM", () => app.quit());
    process.on("SIGINT", () => app.quit());
    buildMenu();
    setupUpdater();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", (e) => {
    if (quitting || !manager) return;
    quitting = true;
    e.preventDefault();
    // Pause everything first so buffered bytes are flushed to disk, then remember what was running.
    const hardStop = new Promise<void>((r) => setTimeout(r, 5000));
    log("quitting: saving downloads");
    Promise.race([manager.shutdown(), hardStop])
      .catch(() => {})
      .finally(async () => {
        await bridge?.stop().catch(() => {});
        app.exit(0);
      });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
