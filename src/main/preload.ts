import { contextBridge, ipcRenderer } from "electron";
import type { AppState, Settings, UIDownload } from "../shared/types";

const api = {
  list: (): Promise<UIDownload[]> => ipcRenderer.invoke("downloads:list"),
  add: (url: string, destinationDir?: string): Promise<UIDownload> =>
    ipcRenderer.invoke("downloads:add", { url, destinationDir }),
  pause: (id: string): Promise<void> => ipcRenderer.invoke("downloads:pause", id),
  resume: (id: string): Promise<void> => ipcRenderer.invoke("downloads:resume", id),
  remove: (id: string): Promise<void> => ipcRenderer.invoke("downloads:remove", id),
  pauseAll: (): Promise<void> => ipcRenderer.invoke("downloads:pauseAll"),
  resumeAll: (): Promise<void> => ipcRenderer.invoke("downloads:resumeAll"),
  revealInFinder: (id: string): Promise<void> => ipcRenderer.invoke("downloads:revealInFinder", id),
  chooseDestinationDir: (): Promise<string | null> => ipcRenderer.invoke("downloads:chooseDestinationDir"),

  getState: (): Promise<AppState> => ipcRenderer.invoke("state:get"),
  updateSettings: (patch: Partial<Settings>): Promise<AppState> => ipcRenderer.invoke("state:update", patch),
  regenerateToken: (): Promise<AppState> => ipcRenderer.invoke("state:regenerateToken"),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write", text),
  revealExtensionFolder: (): Promise<void> => ipcRenderer.invoke("extension:reveal"),
  revealDataFolder: (): Promise<void> => ipcRenderer.invoke("app:revealData"),

  /** Subscribes to live updates; call the returned function to unsubscribe. */
  onChanged: (callback: (downloads: UIDownload[]) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, downloads: UIDownload[]) => callback(downloads);
    ipcRenderer.on("downloads:changed", handler);
    return () => ipcRenderer.off("downloads:changed", handler);
  },
  onStateChanged: (callback: (state: AppState) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.off("state:changed", handler);
  },
};

contextBridge.exposeInMainWorld("cascade", api);

export type CascadeAPI = typeof api;
