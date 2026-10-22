import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, clipboard, powerMonitor } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { DownloadManager } from "../engine/DownloadManager";
import { DownloadTask } from "../engine/DownloadTask";
import { SettingsStore } from "./settings";
import { BrowserBridge } from "./bridge";
import { makeAdder } from "./adder";
import { createLogger } from "./log";
import type { AppState, BridgeStatus, Settings, UIDownload } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let manager: DownloadManager;
let settingsStore: SettingsStore;
let adder: ReturnType<typeof makeAdder>;
let bridge: BrowserBridge | null = null;
let bridgeStatus: BridgeStatus = { running: false, port: 0 };
let quitting = false;
let log: (message: string) => void = () => {};

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

function currentState(): AppState {
  return {
    settings: settingsStore.get(),
    effectiveDownloadDir: effectiveDownloadDir(),
    bridge: bridgeStatus,
    extensionPath: extensionPath(),
    dataPath: app.getPath("userData"),
    version: app.getVersion(),
  };
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
  ipcMain.handle("downloads:pauseAll", () => manager.pauseAll());
  ipcMain.handle("downloads:resumeAll", () => manager.resumeAll());

  ipcMain.handle("downloads:revealInFinder", (_e, id: string) => {
    const task = manager.get(id);
    if (task) shell.showItemInFolder(task.destinationPath);
  });

  ipcMain.handle("downloads:chooseDestinationDir", async (): Promise<string | null> => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      defaultPath: effectiveDownloadDir(),
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("state:get", (): AppState => currentState());
  ipcMain.handle("state:update", (_e, patch: Partial<Settings>) => updateSettings(patch ?? {}));
  ipcMain.handle("state:regenerateToken", (): AppState => {
    settingsStore.regenerateToken();
    broadcastState();
    return currentState();
  });
  ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(String(text)));
  ipcMain.handle("app:revealData", () => shell.openPath(app.getPath("userData")));
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
