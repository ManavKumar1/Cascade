import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface BridgeAddRequest {
  url: string;
  fileName?: string;
  referrer?: string;
  userAgent?: string;
  cookies?: string;
}

export interface BridgeAddResult {
  ok: boolean;
  id?: string;
  fileName?: string;
  error?: string;
}

export interface BridgeOptions {
  port: number;
  getToken: () => string;
  /** `wait` = the browser wants to know whether the server accepted the download before it lets go of its own. */
  onAdd: (req: BridgeAddRequest, wait: boolean) => Promise<BridgeAddResult>;
  version: string;
}

const MAX_BODY_BYTES = 256 * 1024;
// Chrome extension ids are 32 chars of a-p. Only extensions may talk to us, never web pages.
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const HEADER_UNSAFE = /[\r\n\0]/;

/**
 * Loopback-only HTTP endpoint the browser extension posts captured downloads to.
 * Defenses, in order: loopback bind, Host check (DNS rebinding), Origin must be
 * absent or a browser extension (blocks web pages), and a shared secret token.
 */
export class BrowserBridge {
  private server: http.Server | null = null;
  private boundPort = 0;

  constructor(private readonly opts: BridgeOptions) {}

  get port(): number {
    return this.boundPort || this.opts.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch(() => send(res, 500, { ok: false, error: "internal error" }));
      });
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        this.boundPort = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private authorized(req: http.IncomingMessage): boolean {
    const token = this.opts.getToken();
    const given = req.headers["x-cascade-token"];
    if (!token || typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return send(res, 403, { ok: false, error: "bad host" });
    }
    const origin = req.headers.origin;
    const originOk = typeof origin === "string" && EXTENSION_ORIGIN.test(origin);
    if (origin !== undefined && !originOk) return send(res, 403, { ok: false, error: "origin not allowed" });
    const cors: Record<string, string> = originOk ? { "Access-Control-Allow-Origin": origin as string, Vary: "Origin" } : {};

    if (req.method === "OPTIONS") {
      const headers: Record<string, string> = {
        ...cors,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-cascade-token",
        "Access-Control-Max-Age": "600",
      };
      if (req.headers["access-control-request-private-network"]) headers["Access-Control-Allow-Private-Network"] = "true";
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const authorized = this.authorized(req);

    if (req.method === "GET" && pathname === "/ping") {
      return send(res, 200, { ok: true, app: "Cascade", version: this.opts.version, authorized }, cors);
    }
    if (!authorized) return send(res, 401, { ok: false, error: "invalid or missing token" }, cors);

    if (req.method === "POST" && pathname === "/add") {
      const body = await readJson(req);
      if (body === "too-large") {
        res.once("finish", () => req.destroy());
        return send(res, 413, { ok: false, error: "request too large" }, cors);
      }
      const parsed = validateAdd(body);
      if (typeof parsed === "string") return send(res, 400, { ok: false, error: parsed }, cors);
      const result = await this.opts.onAdd(parsed, (body as { wait?: unknown }).wait === true);
      return send(res, result.ok ? 200 : 422, result, cors);
    }
    send(res, 404, { ok: false, error: "not found" }, cors);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<unknown | "too-large"> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        resolve("too-large");
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function validateAdd(body: unknown): BridgeAddRequest | string {
  if (!body || typeof body !== "object") return "expected a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.url !== "string" || b.url.length > 8192) return "url is required";
  let u: URL;
  try {
    u = new URL(b.url);
  } catch {
    return "url is not valid";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "only http(s) URLs are supported";

  const optional = (key: string, max: number): string | undefined | null => {
    const v = b[key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string" || v.length > max || HEADER_UNSAFE.test(v)) return null;
    return v;
  };
  const fileName = optional("fileName", 255);
  const referrer = optional("referrer", 8192);
  const userAgent = optional("userAgent", 512);
  const cookies = optional("cookies", 128 * 1024);
  if (fileName === null || referrer === null || userAgent === null || cookies === null) return "invalid field";
  return { url: b.url, fileName, referrer, userAgent, cookies };
}
