import type { FileHandle } from "node:fs/promises";
import { mergeHeaders } from "./utils";

const DEFAULT_WRITE_BUFFER = 1024 * 1024; // coalesce network chunks into 1 MiB disk writes
// ...but never sit on received bytes for longer than this. On a slow connection a 1 MiB buffer can take
// minutes to fill, and bytes that aren't on disk can't be counted as saved progress after a crash.
const FLUSH_INTERVAL_MS = 1000;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class RangeNotSupportedError extends Error {
  constructor() {
    super("Server did not honor the Range request (expected 206 Partial Content).");
    this.name = "RangeNotSupportedError";
  }
}

/** The file on the server is no longer the one we started downloading (If-Range validator mismatch). */
export class ResourceChangedError extends Error {
  constructor() {
    super("The file on the server changed while downloading.");
    this.name = "ResourceChangedError";
  }
}

/** A failure that retrying cannot fix (e.g. the server returned a web page instead of the file). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(status: number, retryAfterMs?: number) {
    super(`Server responded with status ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
  get retryable(): boolean {
    return RETRYABLE_STATUSES.has(this.status);
  }
}

export class FileWriteError extends Error {
  constructor(cause: unknown) {
    super(`Could not write to disk: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "FileWriteError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** True for failures worth retrying / worth shedding a connection over (network blips, 429/503...). */
export function isRetryableError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof RangeNotSupportedError || err instanceof FileWriteError) return false;
  if (err instanceof ResourceChangedError || err instanceof PermanentError) return false;
  if (err instanceof HttpStatusError) return err.retryable;
  return true;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 60000) : undefined;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The mutable slice of a segment this function reads and advances. `end` may shrink mid-flight (work stealing). */
export interface SegmentLike {
  start: number;
  end: number | null;
  received: number;
  buffered?: number;
}

export interface DownloadSegmentOptions {
  segment: SegmentLike;
  getUrl: () => string;
  getHeaders: (url: string) => Record<string, string> | undefined;
  /** Validator (strong ETag or Last-Modified) to send as If-Range, if we have one. */
  ifRange?: () => string | undefined;
  /** True when the server is known to support Range, so a 200 answer to an If-Range request means "file changed". */
  expectPartial?: boolean;
  file: FileHandle;
  signal: AbortSignal;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  writeBufferBytes?: number;
}

/**
 * Downloads `segment` into `file` at the matching offsets. Network chunks are coalesced into large
 * writes, a dropped connection resumes from the last byte written, and `segment.end` is re-read
 * continuously so another connection can take over the tail of this segment (work stealing).
 */
export async function downloadSegment(opts: DownloadSegmentOptions): Promise<void> {
  const { segment, file, signal } = opts;
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelay = opts.retryBaseDelayMs ?? 1000;
  const bufSize = opts.writeBufferBytes ?? DEFAULT_WRITE_BUFFER;
  const lengthOf = () => (segment.end === null ? Infinity : segment.end - segment.start + 1);

  let buffer: Buffer | null = null;
  let attempt = 0;

  for (;;) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (segment.end !== null && segment.start + segment.received > segment.end) return;

    const rangeStart = segment.start + segment.received;
    const requestEnd = segment.end;
    const receivedBefore = segment.received;
    buffer ??= Buffer.allocUnsafe(requestEnd === null ? bufSize : Math.max(1, Math.min(bufSize, requestEnd - rangeStart + 1)));
    const buf = buffer;
    let filled = 0;
    let bufferPos = rangeStart;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let lastFlush = Date.now();

    const flush = async (): Promise<void> => {
      if (filled === 0) return;
      const writeLen = segment.end === null ? filled : Math.max(0, Math.min(filled, segment.end - bufferPos + 1));
      if (writeLen > 0) {
        try {
          await file.write(buf, 0, writeLen, bufferPos);
        } catch (e) {
          throw new FileWriteError(e);
        }
        segment.received = Math.min(segment.received + writeLen, lengthOf());
      }
      bufferPos += filled;
      filled = 0;
      segment.buffered = 0;
      lastFlush = Date.now();
    };

    try {
      const url = opts.getUrl();
      const rangeHeader =
        requestEnd !== null ? `bytes=${rangeStart}-${requestEnd}` : rangeStart > 0 ? `bytes=${rangeStart}-` : undefined;
      const ifRange = rangeHeader ? opts.ifRange?.() : undefined;
      // Ask for the raw bytes: if a server gzips the response, fetch would transparently decode it and the
      // byte counts (and therefore the saved file) would no longer match the ranges we asked for.
      const headers = mergeHeaders(
        { "accept-encoding": "identity" },
        opts.getHeaders(url),
        rangeHeader ? { range: rangeHeader } : undefined,
        ifRange ? { "if-range": ifRange } : undefined
      );

      const response = await fetch(url, { headers, signal });

      if (response.status === 206) {
        // Guard against a server answering with a different range than we asked for.
        const m = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "");
        if (m && Number(m[1]) !== rangeStart) {
          response.body?.cancel().catch(() => {});
          throw new RangeNotSupportedError();
        }
      } else if (!(response.status === 200 && rangeStart === 0 && !(ifRange && opts.expectPartial))) {
        // (A 200 starting at byte 0 is fine: full body, which we clamp below.)
        response.body?.cancel().catch(() => {});
        if (response.status === 200 && ifRange && opts.expectPartial) throw new ResourceChangedError();
        if (response.status >= 200 && response.status < 300) throw new RangeNotSupportedError();
        throw new HttpStatusError(response.status, parseRetryAfter(response.headers.get("retry-after")));
      }
      if (!response.body) throw new Error("Response had no body");

      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        let take = value.length;
        if (segment.end !== null) {
          const remaining = segment.end - (bufferPos + filled) + 1;
          if (remaining <= 0) break; // our tail was handed to another connection
          if (take > remaining) take = remaining;
        }
        let off = 0;
        while (off < take) {
          const n = Math.min(buf.length - filled, take - off);
          buf.set(value.subarray(off, off + n), filled);
          filled += n;
          off += n;
          segment.buffered = filled;
          if (filled === buf.length) await flush();
        }
        if (segment.end !== null && bufferPos + filled > segment.end) break; // got everything we need
        if (filled > 0 && Date.now() - lastFlush >= FLUSH_INTERVAL_MS) await flush();
      }
      await flush();

      if (segment.end !== null && segment.start + segment.received <= segment.end) {
        throw new Error("Connection closed before segment finished");
      }
      return;
    } catch (err) {
      // Keep whatever valid data we already buffered, so pauses and drops lose almost nothing.
      if (!(err instanceof FileWriteError)) {
        try {
          await flush();
        } catch {
          /* a real disk problem will surface on the next attempt */
        }
      }
      if (signal.aborted || isAbortError(err)) throw err;
      if (!isRetryableError(err)) throw err;

      if (segment.received > receivedBefore) attempt = 0; // made progress: the budget refreshes
      attempt++;
      if (attempt > maxRetries) throw err instanceof Error ? err : new Error(String(err));
      const backoff = Math.min(baseDelay * 2 ** (attempt - 1), 15000) + Math.random() * 250;
      const hinted = err instanceof HttpStatusError ? err.retryAfterMs ?? 0 : 0;
      await sleep(Math.max(backoff, hinted), signal);
    } finally {
      segment.buffered = 0;
      reader?.cancel().catch(() => {});
    }
  }
}
