import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite, exists } from "./fsutil";
import type { SerializedDownload } from "./types";

/** Unfinished data lives in "<name>.part" and its resume state in "<name>.part.json", right beside it. */
export const PART_SUFFIX = ".part";
export const SIDECAR_SUFFIX = ".part.json";
const SENSITIVE = new Set(["cookie", "authorization", "proxy-authorization"]);

export const partPathFor = (finalPath: string): string => finalPath + PART_SUFFIX;
export const sidecarPathFor = (finalPath: string): string => finalPath + SIDECAR_SUFFIX;

/** The sidecar sits in a user-visible folder (and may be synced): never put credentials in it. */
export function redact(state: SerializedDownload): SerializedDownload {
  if (!state.headers) return state;
  const headers = Object.fromEntries(Object.entries(state.headers).filter(([k]) => !SENSITIVE.has(k.toLowerCase())));
  return { ...state, headers: Object.keys(headers).length ? headers : undefined };
}

export async function writeSidecar(state: SerializedDownload): Promise<void> {
  await atomicWrite(sidecarPathFor(state.destinationPath), JSON.stringify(redact(state), null, 2));
}

export async function removeSidecar(finalPath: string): Promise<void> {
  await fs.rm(sidecarPathFor(finalPath), { force: true }).catch(() => {});
}

/**
 * Finds resume data next to partial files in `dir` (top level only). This is what lets a download
 * survive the app's own database being lost or corrupted, the way torrent clients rediscover
 * partial files. Sidecars whose partial data is gone are stale and get cleaned up.
 */
export async function scanForRecoverable(dir: string): Promise<SerializedDownload[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SerializedDownload[] = [];
  for (const n of names) {
    if (!n.endsWith(SIDECAR_SUFFIX)) continue;
    const sidecar = path.join(dir, n);
    try {
      const state = JSON.parse(await fs.readFile(sidecar, "utf-8")) as SerializedDownload;
      if (!state || typeof state.id !== "string" || typeof state.url !== "string" || !Array.isArray(state.segmentStates)) continue;
      state.destinationPath = path.join(dir, n.slice(0, -SIDECAR_SUFFIX.length)); // the file name is authoritative
      if (!(await exists(partPathFor(state.destinationPath)))) {
        await fs.rm(sidecar, { force: true }).catch(() => {});
        continue;
      }
      out.push(state);
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}
