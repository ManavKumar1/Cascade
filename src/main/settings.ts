import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { THEME_IDS, type Settings, type ThemeId, type ThemeMode } from "../shared/types";

export const DEFAULT_BRIDGE_PORT = 38573;

export function defaultSettings(): Settings {
  return {
    mode: "system",
    theme: "cascade",
    downloadDir: null,
    maxConnections: 16,
    maxConcurrent: 3,
    bridgeEnabled: true,
    bridgePort: DEFAULT_BRIDGE_PORT,
    bridgeToken: "",
    tutorialSeenStepIds: [],
  };
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** Applies a (possibly untrusted / partial) patch on top of `base`, clamping and validating every field. */
export function sanitizeSettings(input: Partial<Settings>, base: Settings): Settings {
  const out: Settings = { ...base };
  if (input.mode === "system" || input.mode === "light" || input.mode === "dark") out.mode = input.mode as ThemeMode;
  if (THEME_IDS.includes(input.theme as ThemeId)) out.theme = input.theme as ThemeId;
  if (input.downloadDir === null) out.downloadDir = null;
  else if (typeof input.downloadDir === "string" && path.isAbsolute(input.downloadDir)) out.downloadDir = input.downloadDir;
  out.maxConnections = clampInt(input.maxConnections, 1, 32, base.maxConnections);
  out.maxConcurrent = clampInt(input.maxConcurrent, 1, 10, base.maxConcurrent);
  if (typeof input.bridgeEnabled === "boolean") out.bridgeEnabled = input.bridgeEnabled;
  out.bridgePort = clampInt(input.bridgePort, 1024, 65535, base.bridgePort);
  if (typeof input.bridgeToken === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(input.bridgeToken)) out.bridgeToken = input.bridgeToken;
  if (Array.isArray(input.tutorialSeenStepIds) && input.tutorialSeenStepIds.every((id) => typeof id === "string")) {
    // De-duplicated and capped — this only ever grows by one small id at a time from the app itself,
    // so a large or malformed list here is a sign of something else writing to settings.json.
    out.tutorialSeenStepIds = Array.from(new Set(input.tutorialSeenStepIds)).slice(0, 200);
  }
  return out;
}

const newToken = () => randomBytes(24).toString("hex");

/** Small synchronous JSON settings store. Pure Node (no Electron), so it's unit-testable. */
export class SettingsStore {
  private current: Settings = defaultSettings();

  constructor(private readonly filePath: string) {}

  load(): Settings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<Settings>;
      this.current = sanitizeSettings(parsed, defaultSettings());
    } catch {
      this.current = defaultSettings(); // missing or corrupt file: fall back to defaults
    }
    if (!this.current.bridgeToken) {
      this.current.bridgeToken = newToken();
      this.save();
    }
    return this.get();
  }

  get(): Settings {
    return { ...this.current };
  }

  update(patch: Partial<Settings>): Settings {
    this.current = sanitizeSettings(patch, this.current);
    this.save();
    return this.get();
  }

  regenerateToken(): Settings {
    this.current = { ...this.current, bridgeToken: newToken() };
    this.save();
    return this.get();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.current, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }
}
