import type { DownloadProgress, DownloadStatus } from "../engine/types";

export interface UIDownload {
  id: string;
  url: string;
  destinationPath: string;
  status: DownloadStatus;
  error: string | null;
  progress: DownloadProgress;
  /** null = not known yet; false = the server can't continue a partial download. */
  resumable: boolean | null;
  /** Epoch ms of the next automatic retry, if one is scheduled. */
  retryAt: number | null;
}

export const THEME_IDS = ["cascade", "ocean", "forest", "sunset", "rose", "mono"] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export type ThemeMode = "system" | "light" | "dark";

export interface Settings {
  mode: ThemeMode;
  theme: ThemeId;
  /** null = the system Downloads folder. Updated whenever you pick a folder, so it's remembered. */
  downloadDir: string | null;
  maxConnections: number;
  maxConcurrent: number;
  bridgeEnabled: boolean;
  bridgePort: number;
  bridgeToken: string;
}

export interface BridgeStatus {
  running: boolean;
  port: number;
  error?: string;
}

export interface AppState {
  settings: Settings;
  /** The folder new downloads will actually go to (settings.downloadDir, or the fallback). */
  effectiveDownloadDir: string;
  bridge: BridgeStatus;
  extensionPath: string;
  /** Where the queue, settings and log live. */
  dataPath: string;
  version: string;
}
