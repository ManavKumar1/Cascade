import * as fs from "node:fs";
import * as path from "node:path";
import type { DownloadManager } from "../engine/DownloadManager";
import type { DownloadTask } from "../engine/DownloadTask";
import { mergeHeaders, sanitizeFileName } from "../engine/utils";
import type { BridgeAddRequest, BridgeAddResult } from "./bridge";

export interface AdderDeps {
  manager: DownloadManager;
  /** The remembered download folder (already resolved to something usable). */
  getDownloadDir: () => string;
  /** Used if the remembered folder is gone (e.g. an unplugged drive). */
  fallbackDir: string;
  getMaxConnections: () => number;
}

// Servers commonly block or degrade unknown clients (Node's default User-Agent gets 403 from several big sites),
// and hotlink protection wants a same-site Referer. A captured browser download brings its own real values.
const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Cascade/0.2";

function withDefaultHeaders(url: string, headers?: Record<string, string>): Record<string, string> {
  let referer: string | undefined;
  try {
    referer = new URL(url).origin + "/";
  } catch {
    /* no referer */
  }
  return mergeHeaders({ "user-agent": DEFAULT_UA, ...(referer ? { referer } : {}) }, headers);
}

export function filenameFromUrl(url: string): string {
  try {
    const base = path.basename(new URL(url).pathname);
    return decodeURIComponent(base) || "download";
  } catch {
    return "download";
  }
}

/** Returns `dir` if it exists (or can be created), else null. */
export function usableDir(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export function makeAdder(deps: AdderDeps) {
  function add(input: { url: string; fileName?: string; dir?: string; headers?: Record<string, string> }): DownloadTask {
    const dir = usableDir(input.dir ?? deps.getDownloadDir()) ?? usableDir(deps.fallbackDir) ?? deps.fallbackDir;
    const name = sanitizeFileName(input.fileName || filenameFromUrl(input.url));
    return deps.manager.add({
      url: input.url,
      destinationPath: path.join(dir, name),
      headers: withDefaultHeaders(input.url, input.headers),
      maxConnections: deps.getMaxConnections(),
      nameIsFinal: !!input.fileName, // a name from the browser is final; one guessed from the URL can be corrected by the server
    });
  }

  /** Handles a download captured by the browser extension. */
  async function capture(req: BridgeAddRequest, wait: boolean): Promise<BridgeAddResult> {
    const headers: Record<string, string> = {};
    if (req.cookies) headers["Cookie"] = req.cookies;
    if (req.referrer) headers["Referer"] = req.referrer;
    if (req.userAgent) headers["User-Agent"] = req.userAgent;
    const task = add({ url: req.url, fileName: req.fileName, headers });
    if (!wait) return { ok: true, id: task.id, fileName: path.basename(task.destinationPath) };

    // The browser is still holding its own copy of this download. Only let it go once the
    // server has actually accepted ours — otherwise a failed capture would lose the download.
    const outcome = await deps.manager.waitForOutcome(task, 6000);
    if (outcome === "failed") {
      const error = task.getError() ?? "download failed";
      await deps.manager.remove(task.id);
      return { ok: false, error };
    }
    return { ok: true, id: task.id, fileName: path.basename(task.destinationPath) };
  }

  return { add, capture };
}
