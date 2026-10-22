import * as http from "node:http";
import * as zlib from "node:zlib";
import type * as net from "node:net";
import type { AddressInfo } from "node:net";

export interface TestServerOptions {
  content: Buffer;
  /** Default true. */
  supportsRanges?: boolean;
  /** Once cumulative bytes served crosses this, the current response is destroyed — once. */
  failAfterBytes?: number;
  /** Artificial delay between 16 KiB chunks. */
  chunkDelayMs?: number;
  /** Every Nth *socket* is slow (uses slowChunkDelayMs) — models one bad CDN path. */
  slowEveryNthSocket?: number;
  slowChunkDelayMs?: number;
  /** Answer this many non-probe requests with 503 first. */
  busyFirstRequests?: number;
  /** If set, every request is answered with a 302 to this URL. */
  redirectTo?: string;
  contentType?: string;
  contentDisposition?: string;
  /** Sent as ETag on every response; honored via If-Range. */
  etag?: string;
  /** If set, every request is answered with this HTML page (200), like a hotlink-protection/login wall. */
  htmlBody?: string;
  /** If the client advertises gzip, answer 200 with a gzip-encoded body (ignoring Range), like many real servers. */
  gzipIfAccepted?: boolean;
}

export interface RecordedRequest {
  range?: string;
  headers: http.IncomingHttpHeaders;
}

export class TestServer {
  url = "";
  requests: RecordedRequest[] = [];

  private server: http.Server;
  private content: Buffer;
  private opts: TestServerOptions;
  private bytesServedSoFar = 0;
  private hasFailedOnce = false;
  private busyLeft: number;
  private socketIds = new WeakMap<net.Socket, number>();
  private nextSocketId = 0;

  constructor(opts: TestServerOptions) {
    this.opts = opts;
    this.content = opts.content;
    this.busyLeft = opts.busyFirstRequests ?? 0;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  /** Swap the served file (simulates the file changing on the server). */
  setContent(content: Buffer, etag?: string): void {
    this.content = content;
    this.opts = { ...this.opts, etag };
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/file.bin`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }

  private chunkDelayFor(req: http.IncomingMessage): number {
    let id = this.socketIds.get(req.socket);
    if (id === undefined) {
      id = ++this.nextSocketId;
      this.socketIds.set(req.socket, id);
    }
    const n = this.opts.slowEveryNthSocket;
    if (n && id % n === 0) return this.opts.slowChunkDelayMs ?? 40;
    return this.opts.chunkDelayMs ?? 0;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const total = this.content.length;
    const rangeHeader = req.headers.range;
    this.requests.push({ range: rangeHeader, headers: req.headers });

    if (this.opts.redirectTo) {
      res.writeHead(302, { Location: this.opts.redirectTo });
      res.end();
      return;
    }

    if (this.opts.htmlBody !== undefined) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(this.opts.htmlBody);
      return;
    }

    const accept = String(req.headers["accept-encoding"] ?? "");
    if (this.opts.gzipIfAccepted && /gzip/i.test(accept)) {
      const body = zlib.gzipSync(this.content);
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": body.length, "Content-Type": this.opts.contentType ?? "application/octet-stream" });
      res.end(body);
      return;
    }

    const base: Record<string, string | number> = {};
    if (this.opts.contentType) base["Content-Type"] = this.opts.contentType;
    if (this.opts.contentDisposition) base["Content-Disposition"] = this.opts.contentDisposition;
    if (this.opts.etag) base["ETag"] = this.opts.etag;
    // If-Range: a validator that doesn't match means "send the whole (new) file instead of a range".
    const ifRange = req.headers["if-range"];
    const ignoreRange = typeof ifRange === "string" && ifRange !== this.opts.etag;

    const isProbe = rangeHeader === "bytes=0-0";
    if (!isProbe && this.busyLeft > 0) {
      this.busyLeft--;
      res.writeHead(503, { "Retry-After": "0" });
      res.end();
      return;
    }

    const supportsRanges = this.opts.supportsRanges ?? true;
    if (!supportsRanges || !rangeHeader || ignoreRange) {
      res.writeHead(200, { ...base, "Content-Length": total, "Accept-Ranges": supportsRanges ? "bytes" : "none" });
      this.streamChunks(req, res, this.content);
      return;
    }

    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : total - 1;
    if (start >= total || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    const clampedEnd = Math.min(end, total - 1);
    res.writeHead(206, {
      ...base,
      "Content-Range": `bytes ${start}-${clampedEnd}/${total}`,
      "Content-Length": clampedEnd - start + 1,
      "Accept-Ranges": "bytes",
    });
    this.streamChunks(req, res, this.content.subarray(start, clampedEnd + 1));
  }

  private streamChunks(req: http.IncomingMessage, res: http.ServerResponse, data: Buffer): void {
    const chunkSize = 16 * 1024;
    const delay = this.chunkDelayFor(req);
    let offset = 0;
    let clientGone = false;
    res.on("close", () => {
      clientGone = true;
    });

    const writeNext = () => {
      if (clientGone || res.destroyed) return;
      if (offset >= data.length) {
        res.end();
        return;
      }
      if (this.opts.failAfterBytes !== undefined && !this.hasFailedOnce && this.bytesServedSoFar >= this.opts.failAfterBytes) {
        this.hasFailedOnce = true;
        res.destroy();
        return;
      }
      const end = Math.min(offset + chunkSize, data.length);
      const chunk = data.subarray(offset, end);
      this.bytesServedSoFar += chunk.length;
      offset = end;
      res.write(chunk, () => {
        if (clientGone || res.destroyed) return;
        if (delay > 0) setTimeout(writeNext, delay);
        else setImmediate(writeNext);
      });
    };
    writeNext();
  }
}

/** Deterministic pseudo-random content so corruption/reordering is detectable byte-for-byte. */
export function makeContent(size: number, seed = 1): Buffer {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}
