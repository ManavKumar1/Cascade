import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { SettingsStore, defaultSettings, sanitizeSettings } from "../src/main/settings";
import { BrowserBridge } from "../src/main/bridge";
import { makeAdder } from "../src/main/adder";
import { DownloadManager } from "../src/engine/DownloadManager";
import { TestServer, makeContent } from "./testServer";

const require = createRequire(import.meta.url);
const core = require("../extension/core.js");

const TOKEN = "test-token-0123456789abcdef";
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
async function tmpDir(): Promise<string> {
  const d = path.join(os.tmpdir(), `cascade-app-${randomUUID()}`);
  await fsp.mkdir(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  await Promise.all(dirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

describe("SettingsStore", () => {
  it("creates defaults plus a persistent random token on first run", async () => {
    const file = path.join(await tmpDir(), "settings.json");
    const a = new SettingsStore(file).load();
    expect(a.mode).toBe("system");
    expect(a.maxConnections).toBe(16);
    expect(a.bridgeToken).toMatch(/^[0-9a-f]{48}$/);
    expect(new SettingsStore(file).load().bridgeToken).toBe(a.bridgeToken);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("persists changes, including the remembered download folder", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "settings.json");
    const s = new SettingsStore(file);
    s.load();
    s.update({ theme: "ocean", mode: "dark", downloadDir: path.join(dir, "Movies") });
    const again = new SettingsStore(file).load();
    expect([again.theme, again.mode, again.downloadDir]).toEqual(["ocean", "dark", path.join(dir, "Movies")]);
  });

  it("clamps and rejects invalid values instead of trusting them", () => {
    const base = defaultSettings();
    expect(sanitizeSettings({ maxConnections: 999 }, base).maxConnections).toBe(32);
    expect(sanitizeSettings({ maxConnections: 0 }, base).maxConnections).toBe(1);
    expect(sanitizeSettings({ maxConcurrent: 50 }, base).maxConcurrent).toBe(10);
    expect(sanitizeSettings({ theme: "nope" as never }, base).theme).toBe("cascade");
    expect(sanitizeSettings({ mode: "purple" as never }, base).mode).toBe("system");
    expect(sanitizeSettings({ downloadDir: "relative/path" }, base).downloadDir).toBeNull();
    expect(sanitizeSettings({ bridgeToken: "short" }, base).bridgeToken).toBe("");
    expect(sanitizeSettings({ bridgePort: 80 }, base).bridgePort).toBe(1024);
  });

  it("recovers from a corrupt file and can rotate the token", async () => {
    const file = path.join(await tmpDir(), "settings.json");
    fs.writeFileSync(file, "{not json");
    const s = new SettingsStore(file);
    const loaded = s.load();
    expect(loaded.theme).toBe("cascade");
    expect(s.regenerateToken().bridgeToken).not.toBe(loaded.bridgeToken);
  });
});

async function makeApp(opts: { token?: string } = {}) {
  const dir = await tmpDir();
  const manager = new DownloadManager({ maxConcurrent: 3 });
  const adder = makeAdder({ manager, getDownloadDir: () => dir, fallbackDir: dir, getMaxConnections: () => 4 });
  const bridge = new BrowserBridge({ port: 0, getToken: () => opts.token ?? TOKEN, onAdd: adder.capture, version: "9.9.9" });
  await bridge.start();
  cleanups.push(() => bridge.stop());
  return { dir, manager, bridge, port: bridge.port };
}

function raw(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string; host?: string }) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path, headers: { ...(o.host ? { Host: o.host } : {}), ...o.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json: any = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      }
    );
    req.on("error", reject);
    req.end(o.body);
  });
}
const post = (port: number, body: unknown, headers: Record<string, string> = {}) =>
  raw(port, { method: "POST", path: "/add", headers: { "Content-Type": "application/json", "X-Cascade-Token": TOKEN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("BrowserBridge security", () => {
  it("ping reports authorization state; /add requires the token", async () => {
    const { port } = await makeApp();
    expect((await raw(port, { path: "/ping" })).json).toMatchObject({ ok: true, app: "Cascade", authorized: false, version: "9.9.9" });
    expect((await raw(port, { path: "/ping", headers: { "X-Cascade-Token": TOKEN } })).json.authorized).toBe(true);
    expect((await raw(port, { method: "POST", path: "/add", body: "{}" })).status).toBe(401);
    expect((await post(port, { url: "http://x.test/a" }, { "X-Cascade-Token": "wrong-token-0123456789abcdef" })).status).toBe(401);
  });

  it("rejects web-page origins and DNS-rebinding hosts", async () => {
    const { port } = await makeApp();
    expect((await raw(port, { path: "/ping", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await raw(port, { path: "/ping", host: "evil.example" })).status).toBe(403);
    const ext = "chrome-extension://" + "a".repeat(32);
    const ok = await raw(port, { path: "/ping", headers: { Origin: ext } });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(ext);
  });

  it("answers CORS preflight only for extension origins", async () => {
    const { port } = await makeApp();
    const ext = "chrome-extension://" + "b".repeat(32);
    const r = await raw(port, { method: "OPTIONS", path: "/add", headers: { Origin: ext, "Access-Control-Request-Method": "POST" } });
    expect(r.status).toBe(204);
    expect(String(r.headers["access-control-allow-headers"])).toContain("x-cascade-token");
    expect((await raw(port, { method: "OPTIONS", path: "/add", headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });

  it("validates input: bad URL, non-http scheme, header injection, oversize body", async () => {
    const { port, manager } = await makeApp();
    expect((await post(port, { url: "not a url" })).status).toBe(400);
    expect((await post(port, { url: "file:///etc/passwd" })).status).toBe(400);
    expect((await post(port, { url: "http://x.test/a", cookies: "a=b\r\nX-Evil: 1" })).status).toBe(400);
    expect((await post(port, "garbage")).status).toBe(400);
    expect((await post(port, { url: "http://x.test/" + "a".repeat(300_000) })).status).toBe(413);
    expect(manager.list().length).toBe(0);
  });
});

describe("Chrome extension core → bridge → engine (chrome API mocked)", () => {
  function fakeChrome(settings: Record<string, unknown>) {
    const calls = { cancel: [] as number[], erase: [] as number[] };
    return {
      calls,
      api: {
        storage: { local: { get: async (d: object) => ({ ...d, ...settings }) } },
        cookies: { getAll: async () => [{ name: "sid", value: "abc" }, { name: "theme", value: "dark" }] },
        downloads: {
          cancel: async (id: number) => void calls.cancel.push(id),
          erase: async (q: { id: number }) => void calls.erase.push(q.id),
        },
      },
    };
  }
  const waitDone = async (m: DownloadManager) => {
    for (let i = 0; i < 300; i++) {
      const t = m.list()[0];
      if (t && t.getStatus() === "completed") return t;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("download never completed");
  };

  it("captures a download: forwards cookies/referrer/UA, keeps Chrome's filename, cancels Chrome's copy", async () => {
    const content = makeContent(400 * 1024, 77);
    const server = new TestServer({ content });
    await server.start();
    cleanups.push(() => server.stop());
    const { dir, manager, port } = await makeApp();
    const { api, calls } = fakeChrome({ token: TOKEN, port });

    const item = { id: 7, url: server.url, finalUrl: server.url, filename: "/Users/me/Downloads/report final.bin", referrer: "http://site.test/page", fileSize: content.length };
    const result = await core.handleDownload(api, fetch, item, "TestUA/1");

    expect(result.handled).toBe(true);
    expect(calls.cancel).toEqual([7]);
    expect(calls.erase).toEqual([7]);
    const task = await waitDone(manager);
    expect(path.basename(task.destinationPath)).toBe("report final.bin");
    expect(path.dirname(task.destinationPath)).toBe(dir);
    expect((await fsp.readFile(task.destinationPath)).equals(content)).toBe(true);
    const headers = server.requests[0].headers;
    expect(headers.cookie).toBe("sid=abc; theme=dark");
    expect(headers.referer).toBe("http://site.test/page");
    expect(headers["user-agent"]).toBe("TestUA/1");
  });

  it("leaves the download to Chrome when the app isn't running", async () => {
    const dead = new BrowserBridge({ port: 0, getToken: () => TOKEN, onAdd: async () => ({ ok: true }), version: "x" });
    await dead.start();
    const closedPort = dead.port;
    await dead.stop();
    const { api, calls } = fakeChrome({ token: TOKEN, port: closedPort });
    const r = await core.handleDownload(api, fetch, { id: 1, url: "http://site.test/a.zip", filename: "a.zip" }, "UA");
    expect(r.handled).toBe(false);
    expect(calls.cancel).toEqual([]);
  });

  it("leaves the download to Chrome when the token is wrong", async () => {
    const { port, manager } = await makeApp();
    const { api, calls } = fakeChrome({ token: "wrong-token-0123456789abcdef", port });
    const r = await core.handleDownload(api, fetch, { id: 2, url: "http://site.test/a.zip", filename: "a.zip" }, "UA");
    expect(r).toMatchObject({ handled: false, status: 401 });
    expect(calls.cancel).toEqual([]);
    expect(manager.list().length).toBe(0);
  });

  it("does NOT cancel Chrome's download when the server rejects our re-fetch (e.g. a POST-only link)", async () => {
    const gone = http.createServer((_q, res) => { res.writeHead(404); res.end(); });
    const url = await new Promise<string>((r) => gone.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(gone.address() as { port: number }).port}/x`)));
    cleanups.push(async () => { gone.closeAllConnections(); gone.close(); });
    const { port, manager } = await makeApp();
    const { api, calls } = fakeChrome({ token: TOKEN, port });

    const r = await core.handleDownload(api, fetch, { id: 3, url, filename: "x.bin" }, "UA");
    expect(r.handled).toBe(false);
    expect(calls.cancel).toEqual([]);
    expect(manager.list().length).toBe(0); // the failed attempt is cleaned out of the app's list
  });

  it("shouldCapture only takes downloads it can safely re-fetch", () => {
    const s = { enabled: true, token: TOKEN, minSizeMB: 5, excludedDomains: "bank.com, intranet.local" };
    const base = { url: "https://cdn.site.test/a.zip", fileSize: 50 * 1024 * 1024 };
    expect(core.shouldCapture(base, s)).toBe(true);
    expect(core.shouldCapture({ ...base, url: "blob:https://site.test/abc" }, s)).toBe(false);
    expect(core.shouldCapture({ ...base, url: "data:text/plain,hi" }, s)).toBe(false);
    expect(core.shouldCapture({ ...base, incognito: true }, s)).toBe(false);
    expect(core.shouldCapture({ ...base, fileSize: 1024 }, s)).toBe(false);
    expect(core.shouldCapture({ ...base, fileSize: -1 }, s)).toBe(true); // unknown size: capture
    expect(core.shouldCapture({ ...base, url: "https://www.bank.com/statement.pdf" }, s)).toBe(false);
    expect(core.shouldCapture(base, { ...s, enabled: false })).toBe(false);
    expect(core.shouldCapture(base, { ...s, token: "" })).toBe(false);
  });
});
