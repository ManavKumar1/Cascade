import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DownloadTask } from "./DownloadTask";
import { TypedEmitter } from "./TypedEmitter";
import { atomicWrite } from "./fsutil";
import { PART_SUFFIX, scanForRecoverable, writeSidecar } from "./sidecar";
import { uniquePath } from "./utils";
import type { DownloadInit, DownloadStatus, SerializedDownload } from "./types";

export interface DownloadManagerOptions {
  /** Max downloads actively transferring at once. Default 3. */
  maxConcurrent?: number;
  /** Where to persist the queue as JSON, so it survives an app restart. */
  statePath?: string;
  /** Delays between automatic retries of a download that failed for a transient reason. */
  autoRetryDelaysMs?: number[];
  log?: (message: string) => void;
}

export interface DownloadManagerEvents {
  /** Fired whenever the list, or any task's status/progress, changes. */
  changed: () => void;
}

export interface LoadSummary {
  loaded: number;
  /** Downloads rediscovered from resume data next to their partial files (the queue file didn't know them). */
  recovered: number;
  source: "queue" | "backup" | "none";
}

export type Outcome = "started" | "queued" | "failed" | "timeout";

const PROGRESS_SAVE_INTERVAL_MS = 5000;
const DEFAULT_RETRY_DELAYS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000, 600_000];

export class DownloadManager {
  readonly events = new TypedEmitter<DownloadManagerEvents>();

  private tasks = new Map<string, DownloadTask>();
  private order: string[] = [];
  private pendingResume = new Set<string>();
  private retryCounts = new Map<string, number>();
  private retryBytes = new Map<string, number>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private retryAt = new Map<string, number>();
  private maxConcurrent: number;
  private statePath?: string;
  private retryDelays: number[];
  private log: (message: string) => void;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaveAt = 0;
  private closed = false;

  constructor(opts: DownloadManagerOptions = {}) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
    this.statePath = opts.statePath;
    this.retryDelays = opts.autoRetryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    this.log = opts.log ?? (() => {});
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    this.scheduleNext();
  }

  /**
   * Restores the queue. Order of trust: the queue file, then its backup, then resume data found next to
   * partial files in `scanDirs` (so a lost or corrupt queue file never loses a download). Downloads that
   * were running (not user-paused) when the app closed resume automatically; paused ones stay paused.
   */
  async loadState(opts: { autoResume?: boolean; scanDirs?: string[] } = {}): Promise<LoadSummary> {
    const summary: LoadSummary = { loaded: 0, recovered: 0, source: "none" };

    if (this.statePath) {
      for (const d of await this.readQueue(summary)) {
        const task = DownloadTask.fromSerialized(d, this.reserve);
        this.attach(task);
        summary.loaded++;
        if (opts.autoResume !== false && d.status === "paused" && d.resumeOnLaunch !== false) this.pendingResume.add(task.id);
      }
    }

    const dirs = new Set<string>([...this.list().map((t) => path.dirname(t.destinationPath)), ...(opts.scanDirs ?? [])]);
    const knownIds = new Set(this.list().map((t) => t.id));
    const knownPaths = new Set(this.list().map((t) => t.destinationPath));
    for (const dir of dirs) {
      for (const s of await scanForRecoverable(dir)) {
        if (knownIds.has(s.id) || knownPaths.has(s.destinationPath)) continue;
        s.status = "paused"; // the user decides whether to continue a download we only just rediscovered
        s.resumeOnLaunch = false;
        this.attach(DownloadTask.fromSerialized(s, this.reserve));
        knownIds.add(s.id);
        summary.recovered++;
      }
    }

    this.log(`state loaded: ${summary.loaded} from ${summary.source}, ${summary.recovered} recovered from partial files`);
    this.scheduleNext();
    if (summary.recovered > 0 || summary.source === "backup") this.scheduleSave();
    return summary;
  }

  add(init: Omit<DownloadInit, "id" | "reservePath"> & { id?: string }): DownloadTask {
    // Never write into a file that already exists (or that another download is using).
    const destinationPath = this.reserve(init.destinationPath, null);
    const task = new DownloadTask({ ...init, destinationPath, id: init.id ?? randomUUID(), reservePath: this.reserve });
    this.attach(task);
    this.scheduleNext();
    return task;
  }

  get(id: string): DownloadTask | undefined {
    return this.tasks.get(id);
  }

  list(): DownloadTask[] {
    return this.order.map((id) => this.tasks.get(id)).filter((t): t is DownloadTask => !!t);
  }

  /** When an automatic retry of this download is scheduled (epoch ms), if any. */
  getRetryAt(id: string): number | null {
    return this.retryAt.get(id) ?? null;
  }

  /** Removes a download from the list. Unfinished downloads are cancelled and their partial data deleted;
   *  a completed download's file is always kept. */
  async remove(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    this.clearRetry(id);
    await task.cancel();
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.pendingResume.delete(id);
    this.scheduleSave();
    this.emitChanged();
  }

  async pause(id: string): Promise<void> {
    this.pendingResume.delete(id);
    this.clearRetry(id);
    await this.tasks.get(id)?.pause();
  }

  async resume(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) return;
    const status = task.getStatus();
    if (status !== "paused" && status !== "failed") return;
    this.clearRetry(id);
    if (this.activeCount() < this.maxConcurrent) {
      await task.resume();
    } else {
      this.pendingResume.add(id);
    }
  }

  async pauseAll(): Promise<void> {
    this.pendingResume.clear();
    for (const id of [...this.retryTimers.keys()]) this.clearRetry(id);
    await Promise.all(this.list().map((t) => t.pause()));
  }

  resumeAll(): void {
    for (const t of this.list()) {
      const s = t.getStatus();
      if (s === "paused" || s === "failed") {
        this.retryCounts.delete(t.id);
        this.clearRetry(t.id);
        this.pendingResume.add(t.id);
      }
    }
    this.scheduleNext();
  }

  /** After a sleep/wake or network change: retry transient failures now instead of waiting out their timers. */
  retryNow(): void {
    for (const t of this.list()) {
      if (t.isAutoRetryable()) {
        this.clearRetry(t.id);
        this.pendingResume.add(t.id);
      }
    }
    this.scheduleNext();
  }

  /** After a sleep/wake the old TCP connections are dead: restart active downloads from their saved progress. */
  async reconnectAll(): Promise<void> {
    const active = this.list().filter((t) => ["downloading", "connecting"].includes(t.getStatus()));
    await Promise.all(active.map((t) => t.pause()));
    for (const t of active) this.pendingResume.add(t.id);
    this.scheduleNext();
  }

  /** Resolves once a just-added download has either started transferring (so the server accepted it),
   *  failed, or the timeout passes. Queued downloads resolve immediately. */
  waitForOutcome(task: DownloadTask, timeoutMs: number): Promise<Outcome> {
    const decide = (s: DownloadStatus): Outcome | null =>
      s === "downloading" || s === "completed" ? "started" : s === "failed" || s === "canceled" ? "failed" : null;
    const now = decide(task.getStatus());
    if (now) return Promise.resolve(now);
    if (task.getStatus() === "queued") return Promise.resolve("queued");
    return new Promise((resolve) => {
      const onStatus = (s: DownloadStatus) => {
        const r = decide(s);
        if (r) {
          clearTimeout(timer);
          task.events.off("status", onStatus);
          resolve(r);
        }
      };
      const timer = setTimeout(() => {
        task.events.off("status", onStatus);
        resolve("timeout");
      }, timeoutMs);
      task.events.on("status", onStatus);
    });
  }

  /** Graceful shutdown: remembers what was running, pauses everything (flushing buffered bytes), saves. */
  async shutdown(): Promise<void> {
    // Stop any debounced save from firing later and overwriting the "was running" flags we write below.
    this.closed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    for (const id of [...this.retryTimers.keys()]) this.clearRetry(id);
    const wasRunning = new Set(
      this.list()
        .filter((t) => ["downloading", "connecting", "queued"].includes(t.getStatus()) || this.pendingResume.has(t.id))
        .map((t) => t.id)
    );
    await this.pauseAll();
    await this.saveNow(wasRunning);
    this.log(`shutdown saved ${this.list().length} downloads (${wasRunning.size} will resume on launch)`);
  }

  async saveNow(resumeIds?: Set<string>): Promise<void> {
    if (!this.statePath) return;
    this.lastSaveAt = Date.now();
    // Order matters: snapshot progress, THEN force the data it describes onto the disk, THEN record it.
    const states = this.list().map((t) => {
      const s = t.serialize();
      if (resumeIds) s.resumeOnLaunch = resumeIds.has(t.id);
      return s;
    });
    await Promise.all(this.list().map((t) => t.flushToDisk()));
    await fs.copyFile(this.statePath, this.statePath + ".bak").catch(() => {});
    await atomicWrite(this.statePath, JSON.stringify(states, null, 2));
    // Resume data beside each partial file, so a lost/corrupt queue file can never lose a download.
    await Promise.all(
      states
        .filter((s) => s.status !== "completed" && s.status !== "canceled" && s.segmentStates.length > 0)
        .map((s) => writeSidecar(s).catch(() => {}))
    );
  }

  // ---- internals -----------------------------------------------------

  /** A path no other download and no existing file (or partial file) is using. */
  private reserve = (desired: string, self: DownloadTask | null): string =>
    uniquePath(desired, (c) => {
      for (const t of this.tasks.values()) if (t !== self && t.destinationPath === c) return true;
      if (fsSync.existsSync(c)) return true;
      return c !== self?.destinationPath && fsSync.existsSync(c + PART_SUFFIX);
    });

  private async readQueue(summary: LoadSummary): Promise<SerializedDownload[]> {
    const tryRead = async (p: string): Promise<SerializedDownload[]> => {
      const data = JSON.parse(await fs.readFile(p, "utf-8"));
      if (!Array.isArray(data)) throw new Error("not a list");
      return data as SerializedDownload[];
    };
    try {
      const data = await tryRead(this.statePath!);
      summary.source = "queue";
      return data;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`queue file unreadable (${(err as Error).message}); keeping a copy and trying the backup`);
        await fs.rename(this.statePath!, `${this.statePath}.corrupt-${Date.now()}`).catch(() => {});
      }
      try {
        const data = await tryRead(this.statePath + ".bak");
        summary.source = "backup";
        return data;
      } catch {
        return [];
      }
    }
  }

  private attach(task: DownloadTask): void {
    this.tasks.set(task.id, task);
    this.order.push(task.id);
    task.events.on("status", (s) => {
      if (s === "completed") this.clearRetry(task.id, true);
      if (s === "failed") this.maybeScheduleRetry(task);
      this.scheduleSave();
      this.scheduleNext();
      this.emitChanged();
    });
    task.events.on("progress", () => {
      this.emitChanged();
      // Persist progress periodically so a crash or forced shutdown loses seconds, not hours.
      if (Date.now() - this.lastSaveAt >= PROGRESS_SAVE_INTERVAL_MS) this.scheduleSave();
    });
    this.emitChanged();
  }

  /** Transient failures (network drop, sleep/wake, 5xx) are retried automatically with backoff. */
  private maybeScheduleRetry(task: DownloadTask): void {
    if (this.closed || !task.isAutoRetryable()) return;
    const bytes = task.getProgress().bytesDownloaded;
    // Retries are only "used up" while no progress is being made, so a long download on flaky Wi-Fi isn't abandoned.
    if (bytes > (this.retryBytes.get(task.id) ?? -1)) this.retryCounts.delete(task.id);
    this.retryBytes.set(task.id, bytes);
    const n = this.retryCounts.get(task.id) ?? 0;
    if (n >= this.retryDelays.length) return; // give up; the user can still press Resume
    this.retryCounts.set(task.id, n + 1);
    const delay = this.retryDelays[n];
    this.clearRetry(task.id);
    this.retryAt.set(task.id, Date.now() + delay);
    const timer = setTimeout(() => {
      this.retryTimers.delete(task.id);
      this.retryAt.delete(task.id);
      if (task.getStatus() === "failed") void this.resume(task.id);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(task.id, timer);
    this.log(`auto-retry #${n + 1} for ${path.basename(task.destinationPath)} in ${Math.round(delay / 1000)}s`);
  }

  private clearRetry(id: string, resetCount = false): void {
    const t = this.retryTimers.get(id);
    if (t) clearTimeout(t);
    this.retryTimers.delete(id);
    this.retryAt.delete(id);
    if (resetCount) {
      this.retryCounts.delete(id);
      this.retryBytes.delete(id);
    }
  }

  private activeCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      const s = t.getStatus();
      if (s === "downloading" || s === "connecting") n++;
    }
    return n;
  }

  private scheduleNext(): void {
    let slots = this.maxConcurrent - this.activeCount();
    if (slots <= 0) return;
    for (const task of this.list()) {
      if (slots <= 0) break;
      const status = task.getStatus();
      if (status === "queued") {
        slots--;
        task.start().catch(() => {});
      } else if (status === "paused" && this.pendingResume.has(task.id)) {
        slots--;
        this.pendingResume.delete(task.id);
        task.resume().catch(() => {});
      }
    }
  }

  private scheduleSave(): void {
    if (!this.statePath || this.closed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow().catch((e) => this.log(`save failed: ${(e as Error).message}`));
    }, 300);
  }

  private emitChanged(): void {
    this.events.emit("changed");
  }
}
