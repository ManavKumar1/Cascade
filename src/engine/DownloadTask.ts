import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
  downloadSegment,
  HttpStatusError,
  isRetryableError,
  parseRetryAfter,
  PermanentError,
  ResourceChangedError,
  sleep,
} from "./SegmentDownloader";
import { TypedEmitter } from "./TypedEmitter";
import { exists, readHead } from "./fsutil";
import { PART_SUFFIX, removeSidecar } from "./sidecar";
import {
  SpeedSampler,
  HTML_LIKE_EXTS,
  chooseFileName,
  describeError,
  etaSeconds,
  extOf,
  isHtmlMime,
  mergeHeaders,
  parseContentDisposition,
  planSegments,
  sniffExtension,
} from "./utils";
import type {
  DownloadEvents,
  DownloadInit,
  DownloadProgress,
  DownloadStatus,
  SegmentState,
  SerializedDownload,
} from "./types";

const DEFAULT_MAX_CONNECTIONS = 16;
const DEFAULT_MIN_SEGMENT = 1024 * 1024;
const DEFAULT_MIN_STEAL = 128 * 1024;
const PROGRESS_INTERVAL_MS = 500;
const SENSITIVE_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

interface Probed {
  totalBytes: number | null;
  acceptsRanges: boolean;
  finalUrl: string;
  contentType: string | null;
  contentDisposition: string | null;
  etag?: string;
  lastModified?: string;
}

export class DownloadTask {
  readonly id: string;
  readonly url: string;
  /** The final file name. May change once, right after the first response, when the server tells us the real name/type. */
  destinationPath: string;
  readonly events = new TypedEmitter<DownloadEvents>();

  private headers?: Record<string, string>;
  private maxConnections: number;
  private minSizeToSegment: number;
  private minStealBytes: number;
  private retryBaseDelayMs?: number;
  private createdAt: number;
  private nameLocked: boolean;
  private reserve?: (desired: string, self: DownloadTask) => string;

  private status: DownloadStatus = "queued";
  private totalBytes: number | null = null;
  private acceptsRanges = false;
  private segmentStates: SegmentState[] = [];
  private errorMessage?: string;
  private retryable = false;
  private etag?: string;
  private lastModified?: string;
  /** Only resume requests carry If-Range; fresh multi-connection starts don't (some CDNs have per-node ETags). */
  private useIfRange = false;

  /** Final URL after redirects, learned from the probe; saves every connection a redirect round trip. */
  private resolvedUrl?: string;
  private inFlight = new Set<SegmentState>();
  private activeConnections = 0;

  private controller: AbortController | null = null;
  private fileHandle: FileHandle | null = null;
  private speedSampler = new SpeedSampler();
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  /** The in-flight start() run. pause()/cancel() wait for it to fully unwind before touching the file. */
  private activeRun: Promise<void> | null = null;

  constructor(init: DownloadInit) {
    this.id = init.id;
    this.url = init.url;
    this.destinationPath = init.destinationPath;
    this.headers = init.headers;
    this.maxConnections = Math.max(1, init.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    this.minSizeToSegment = Math.max(1, init.minSizeToSegment ?? DEFAULT_MIN_SEGMENT);
    this.minStealBytes = Math.max(1, init.minStealBytes ?? DEFAULT_MIN_STEAL);
    this.retryBaseDelayMs = init.retryBaseDelayMs;
    this.nameLocked = init.nameIsFinal ?? false;
    this.reserve = init.reservePath;
    this.createdAt = Date.now();
  }

  /** Where unfinished data is written. It only becomes `destinationPath` when the download completes. */
  get partPath(): string {
    return this.destinationPath + PART_SUFFIX;
  }

  getStatus(): DownloadStatus {
    return this.status;
  }

  getError(): string | undefined {
    return this.errorMessage;
  }

  /** null until we know; false if the server can't continue a partial download (pausing restarts it). */
  getResumable(): boolean | null {
    return this.totalBytes === null && this.segmentStates.length === 0 ? null : this.acceptsRanges;
  }

  /** True if the last failure looks transient (network drop, 5xx), so retrying later is likely to work. */
  isAutoRetryable(): boolean {
    return this.status === "failed" && this.retryable;
  }

  getProgress(): DownloadProgress {
    const downloaded = this.countBytes();
    const total = this.totalBytes;
    const speed = this.speedSampler.speedBytesPerSec();
    const remaining = total !== null ? Math.max(0, total - downloaded) : null;
    return {
      bytesDownloaded: downloaded,
      totalBytes: total,
      percent: total !== null && total > 0 ? Math.min(100, (downloaded / total) * 100) : null,
      speedBytesPerSec: speed,
      etaSeconds: remaining !== null ? etaSeconds(remaining, speed) : null,
      connections: this.status === "downloading" ? this.activeConnections : 0,
    };
  }

  /** Begins (or continues, if resumable state exists) the download. */
  async start(): Promise<void> {
    if (this.status === "downloading" || this.status === "connecting") return;
    const run = this.runStart();
    this.activeRun = run;
    run.finally(() => {
      if (this.activeRun === run) this.activeRun = null;
    });
    return run;
  }

  async pause(): Promise<void> {
    if (this.status !== "downloading" && this.status !== "connecting") return;
    this.setStatus("paused");
    this.controller?.abort();
    // Wait for the run to unwind (buffers flushed, file synced and closed) so an immediate resume() can't overlap.
    await this.activeRun?.catch(() => {});
  }

  /** Resumes from saved segment state; also usable to retry a failed download. */
  async resume(): Promise<void> {
    if (this.status !== "paused" && this.status !== "failed") return;
    return this.start();
  }

  /** Cancels an unfinished download and deletes its partial data. A completed download's file is never touched. */
  async cancel(): Promise<void> {
    if (this.status === "completed") return;
    const wasActive = this.status === "downloading" || this.status === "connecting";
    this.setStatus("canceled");
    if (wasActive) this.controller?.abort();
    await this.activeRun?.catch(() => {});
    await this.fileHandle?.close().catch(() => {});
    this.fileHandle = null;
    await fs.rm(this.partPath, { force: true }).catch(() => {});
    await removeSidecar(this.destinationPath);
  }

  /** Forces everything written so far onto the disk. The manager calls this *before* saving progress,
   *  so saved progress never claims bytes that a power cut could still lose. */
  async flushToDisk(): Promise<void> {
    await this.fileHandle?.sync().catch(() => {});
  }

  serialize(): SerializedDownload {
    const active = this.status === "downloading" || this.status === "connecting";
    return {
      id: this.id,
      url: this.url,
      destinationPath: this.destinationPath,
      // Don't keep session cookies on disk once they're no longer needed.
      headers: this.status === "completed" ? undefined : this.headers,
      maxConnections: this.maxConnections,
      status: active ? "paused" : this.status,
      resumeOnLaunch: active || this.status === "queued",
      totalBytes: this.totalBytes,
      acceptsRanges: this.acceptsRanges,
      nameLocked: this.nameLocked,
      etag: this.etag,
      lastModified: this.lastModified,
      retryable: this.retryable,
      segmentStates: this.segmentStates.map(({ index, start, end, received, done }) => ({ index, start, end, received, done })),
      error: this.errorMessage,
      createdAt: this.createdAt,
    };
  }

  static fromSerialized(data: SerializedDownload, reserve?: (desired: string, self: DownloadTask) => string): DownloadTask {
    const task = new DownloadTask({
      id: data.id,
      url: data.url,
      destinationPath: data.destinationPath,
      headers: data.headers,
      maxConnections: data.maxConnections ?? data.maxSegments,
      nameIsFinal: data.nameLocked,
      reservePath: reserve,
    });
    task.totalBytes = data.totalBytes;
    task.acceptsRanges = data.acceptsRanges;
    task.segmentStates = data.segmentStates.map((s) => ({ ...s }));
    task.errorMessage = data.error;
    task.retryable = data.retryable ?? false;
    task.etag = data.etag;
    task.lastModified = data.lastModified;
    task.status = data.status;
    task.createdAt = data.createdAt;
    return task;
  }

  // ---- internals -----------------------------------------------------

  private setStatus(status: DownloadStatus): void {
    this.status = status;
    this.events.emit("status", status);
  }

  private async runStart(): Promise<void> {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.errorMessage = undefined;
    this.retryable = false;
    this.setStatus("connecting");

    try {
      for (let pass = 0; ; pass++) {
        try {
          await this.runOnce(signal);
          break;
        } catch (err) {
          // The file changed on the server since we started: stitching old and new bytes would corrupt it,
          // so throw the partial data away and start over (once).
          if (err instanceof ResourceChangedError && pass === 0 && !signal.aborted) {
            await this.discardPartial();
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      if (signal.aborted) return;
      this.errorMessage = describeError(err);
      this.retryable = isRetryableError(err);
      this.setStatus("failed");
      this.events.emit("failed", this.errorMessage);
    } finally {
      this.stopProgressTimer();
      await this.fileHandle?.sync().catch(() => {});
      await this.fileHandle?.close().catch(() => {});
      this.fileHandle = null;
    }
  }

  private async runOnce(signal: AbortSignal): Promise<void> {
    this.useIfRange = this.segmentStates.some((s) => s.received > 0);

    if (this.totalBytes === null && this.segmentStates.length === 0) {
      const probed = await probe(this.url, this.headers, signal, this.retryBaseDelayMs ?? 500);
      this.totalBytes = probed.totalBytes;
      this.acceptsRanges = probed.acceptsRanges;
      this.etag = probed.etag;
      this.lastModified = probed.lastModified;
      this.resolvedUrl = probed.finalUrl !== this.url ? probed.finalUrl : undefined;
      this.rejectWebPage(probed);
      this.applyResolvedName(probed);
    }
    if (signal.aborted) return;

    // Without Range support there is nothing to resume from: start over.
    if (!this.acceptsRanges && this.segmentStates.some((s) => s.received > 0)) this.segmentStates = [];

    await this.openFile();
    this.planSegmentsIfNeeded();
    if (signal.aborted) return;

    this.setStatus("downloading");
    await this.runSegments(signal);

    if (!signal.aborted) await this.finalize();
  }

  /** A "photo.jpg" link that answers with an HTML page is a login wall / hotlink block / error page, not the file. */
  private rejectWebPage(p: Probed): void {
    if (!isHtmlMime(p.contentType)) return;
    if (parseContentDisposition(p.contentDisposition).attachment) return;
    const ext = extOf(path.basename(this.destinationPath));
    if (ext && !HTML_LIKE_EXTS.has(ext)) {
      throw new PermanentError(
        "The server sent a web page instead of the file. The link may need you to be signed in, or the site blocks direct downloads. Try it from your browser with the Cascade extension installed."
      );
    }
  }

  private applyResolvedName(p: Probed): void {
    const dir = path.dirname(this.destinationPath);
    const current = path.basename(this.destinationPath);
    const chosen = chooseFileName({
      current,
      locked: this.nameLocked,
      contentType: p.contentType,
      contentDisposition: p.contentDisposition,
      // Only a real redirect can teach us a better name than the one we were given.
      finalUrl: p.finalUrl !== this.url ? p.finalUrl : undefined,
    });
    if (chosen !== current) {
      const desired = path.join(dir, chosen);
      this.destinationPath = this.reserve ? this.reserve(desired, this) : desired;
    }
  }

  private async openFile(): Promise<void> {
    await fs.mkdir(path.dirname(this.destinationPath), { recursive: true });
    if (this.segmentStates.length > 0) {
      // Older versions wrote partial data straight to the final name: migrate it.
      if (!(await exists(this.partPath)) && (await exists(this.destinationPath))) {
        await fs.rename(this.destinationPath, this.partPath);
      }
      try {
        this.fileHandle = await fs.open(this.partPath, "r+");
        if (this.totalBytes !== null) {
          const st = await this.fileHandle.stat();
          if (st.size < this.totalBytes) await this.fileHandle.truncate(this.totalBytes); // re-extend a shortened part file
        }
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        this.segmentStates = []; // the partial data was deleted: start over
      }
    }
    this.fileHandle = await fs.open(this.partPath, "w");
    if (this.totalBytes !== null) await this.fileHandle.truncate(this.totalBytes);
  }

  private async discardPartial(): Promise<void> {
    await this.fileHandle?.close().catch(() => {});
    this.fileHandle = null;
    await fs.rm(this.partPath, { force: true }).catch(() => {});
    await removeSidecar(this.destinationPath);
    this.segmentStates = [];
    this.totalBytes = null;
    this.acceptsRanges = false;
    this.etag = undefined;
    this.lastModified = undefined;
    this.resolvedUrl = undefined;
    this.inFlight.clear();
  }

  private planSegmentsIfNeeded(): void {
    if (this.segmentStates.length > 0) return;
    const mk = (index: number, start: number, end: number | null): SegmentState => ({ index, start, end, received: 0, done: false });
    if (this.totalBytes !== null && this.acceptsRanges) {
      const count = Math.max(1, Math.min(this.maxConnections, Math.floor(this.totalBytes / this.minSizeToSegment)));
      this.segmentStates = planSegments(this.totalBytes, count).map((r, i) => mk(i, r.start, r.end));
    } else if (this.totalBytes !== null) {
      this.segmentStates = [mk(0, 0, this.totalBytes - 1)];
    } else {
      this.segmentStates = [mk(0, 0, null)];
    }
  }

  private remainingBytes(): number {
    let sum = 0;
    for (const s of this.segmentStates) {
      if (!s.done && s.end !== null) sum += Math.max(0, s.end - s.start + 1 - s.received);
    }
    return sum;
  }

  private countBytes(): number {
    let sum = 0;
    for (const s of this.segmentStates) {
      const have = s.received + (s.buffered ?? 0);
      sum += s.end === null ? have : Math.min(have, s.end - s.start + 1);
    }
    return sum;
  }

  /** Next unit of work for an idle connection: an unclaimed segment, else the back half of the busiest one. */
  private claimSegment(canSteal: boolean): SegmentState | null {
    const free = this.segmentStates.find((s) => !s.done && !this.inFlight.has(s));
    if (free) return free;
    if (!canSteal) return null;

    let victim: SegmentState | null = null;
    let victimRemaining = 0;
    for (const s of this.inFlight) {
      if (s.end === null) continue;
      const remaining = s.end - s.start + 1 - s.received - (s.buffered ?? 0);
      if (remaining > victimRemaining) {
        victim = s;
        victimRemaining = remaining;
      }
    }
    if (!victim || victim.end === null || victimRemaining < this.minStealBytes * 2) return null;

    const splitAt = victim.start + victim.received + (victim.buffered ?? 0) + Math.floor(victimRemaining / 2);
    const nextIndex = this.segmentStates.reduce((m, s) => Math.max(m, s.index), -1) + 1;
    const stolen: SegmentState = { index: nextIndex, start: splitAt, end: victim.end, received: 0, done: false };
    victim.end = splitAt - 1; // the victim notices on its next read and stops there
    this.segmentStates.push(stolen);
    return stolen;
  }

  private headersFor(url: string): Record<string, string> | undefined {
    if (!this.headers) return undefined;
    let sameOrigin = true;
    try {
      sameOrigin = new URL(url).origin === new URL(this.url).origin;
    } catch {
      /* keep sameOrigin = true */
    }
    if (sameOrigin) return this.headers;
    // Never forward cookies/credentials to a different origin (e.g. a CDN we were redirected to).
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.headers)) {
      if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
    }
    return out;
  }

  private ifRangeValue(): string | undefined {
    if (!this.useIfRange || !this.acceptsRanges) return undefined;
    if (this.etag && !this.etag.startsWith("W/")) return this.etag; // weak validators aren't allowed in If-Range
    return this.lastModified;
  }

  private async runSegments(signal: AbortSignal): Promise<void> {
    const inner = new AbortController();
    const onOuterAbort = () => inner.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });

    this.inFlight.clear();
    this.activeConnections = 0;
    this.speedSampler.reset();
    this.startProgressTimer();

    const canParallel = this.acceptsRanges && this.totalBytes !== null;
    let liveWorkers = canParallel
      ? Math.max(1, Math.min(this.maxConnections, Math.floor(this.remainingBytes() / this.minSizeToSegment)))
      : 1;
    let fatal: Error | null = null;

    const worker = async (): Promise<void> => {
      while (!inner.signal.aborted) {
        const seg = this.claimSegment(canParallel);
        if (!seg) return;
        this.inFlight.add(seg);
        this.activeConnections++;
        try {
          await downloadSegment({
            segment: seg,
            getUrl: () => this.resolvedUrl ?? this.url,
            getHeaders: (u) => this.headersFor(u),
            ifRange: () => this.ifRangeValue(),
            expectPartial: this.acceptsRanges,
            file: this.fileHandle!,
            signal: inner.signal,
            retryBaseDelayMs: this.retryBaseDelayMs,
          });
          seg.done = true;
        } catch (err) {
          if (inner.signal.aborted) return;
          if (err instanceof HttpStatusError && [403, 404, 410].includes(err.status) && this.resolvedUrl) {
            // The cached redirect target may have expired; go back through the original URL.
            this.resolvedUrl = undefined;
            continue;
          }
          if (isRetryableError(err) && liveWorkers > 1) {
            // The server is refusing/dropping some of our connections: shed this one.
            // Its segment returns to the pool and the remaining connections absorb it.
            liveWorkers--;
            return;
          }
          fatal ??= err instanceof Error ? err : new Error(String(err));
          inner.abort();
          return;
        } finally {
          this.inFlight.delete(seg);
          this.activeConnections--;
        }
      }
    };

    try {
      for (;;) {
        await Promise.all(Array.from({ length: liveWorkers }, worker));
        if (inner.signal.aborted || fatal || this.segmentStates.every((s) => s.done)) break;
      }
    } finally {
      signal.removeEventListener("abort", onOuterAbort);
    }

    if (signal.aborted) return;
    if (fatal) throw fatal;
  }

  private async finalize(): Promise<void> {
    if (this.totalBytes === null) this.totalBytes = this.countBytes();
    await this.fileHandle?.sync().catch(() => {});
    await this.fileHandle?.close().catch(() => {});
    this.fileHandle = null;

    const oldPath = this.destinationPath;
    let finalPath = oldPath;
    const base = path.basename(finalPath);
    if (!extOf(base)) {
      // Neither the URL nor the server's headers said what this is: look at the bytes.
      const head = await readHead(this.partPath, 64);
      const ext = head ? sniffExtension(head) : null;
      if (ext) finalPath = path.join(path.dirname(finalPath), `${base.replace(/\.+$/, "")}.${ext}`);
    }
    if (this.reserve) finalPath = this.reserve(finalPath, this); // something may have taken the name meanwhile
    await fs.rename(this.partPath, finalPath);
    this.destinationPath = finalPath;
    await removeSidecar(oldPath);

    this.setStatus("completed");
    this.events.emit("progress", this.getProgress());
    this.events.emit("completed");
  }

  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => {
      this.speedSampler.sample(this.countBytes());
      this.events.emit("progress", this.getProgress());
    }, PROGRESS_INTERVAL_MS);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }
}

async function probe(
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  baseDelayMs: number
): Promise<Probed> {
  // A ranged GET for the first byte answers "does Range work?" and "how big is it?" in one round trip,
  // and works on servers that reject HEAD. (identity: we want raw bytes, not a transparently-gunzipped stream.)
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        headers: mergeHeaders({ "accept-encoding": "identity" }, headers, { range: "bytes=0-0" }),
        signal,
      });
      response.body?.cancel().catch(() => {});
      const finalUrl = response.url || url;
      const meta = {
        finalUrl,
        contentType: response.headers.get("content-type"),
        contentDisposition: response.headers.get("content-disposition"),
        etag: response.headers.get("etag") ?? undefined,
        lastModified: response.headers.get("last-modified") ?? undefined,
      };

      if (response.status === 206) {
        const total = Number((response.headers.get("content-range") ?? "").split("/")[1]);
        return { ...meta, totalBytes: Number.isFinite(total) ? total : null, acceptsRanges: true };
      }
      if (response.status === 200) {
        const len = response.headers.get("content-length");
        const total = len ? Number(len) : NaN;
        return { ...meta, totalBytes: Number.isFinite(total) ? total : null, acceptsRanges: false };
      }
      throw new HttpStatusError(response.status, parseRetryAfter(response.headers.get("retry-after")));
    } catch (err) {
      if (signal.aborted || !isRetryableError(err) || ++attempt > 2) throw err;
      await sleep(baseDelayMs * 2 ** (attempt - 1), signal);
    }
  }
}
