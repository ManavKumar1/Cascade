import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { DownloadTask } from "../src/engine/DownloadTask";
import { DownloadManager } from "../src/engine/DownloadManager";
import { uniquePath, sanitizeFileName } from "../src/engine/utils";
import { exists } from "../src/engine/fsutil";
import { TestServer, makeContent } from "./testServer";

let tmpDirs: string[] = [];
async function tmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `cascade-test-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

function waitFor(task: DownloadTask, status: string, timeoutMs = 15000): Promise<void> {
  if (task.getStatus() === status) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for status "${status}"`)), timeoutMs);
    const onStatus = (s: string) => {
      if (s === status) {
        clearTimeout(timer);
        task.events.off("status", onStatus);
        resolve();
      }
    };
    task.events.on("status", onStatus);
  });
}

async function pauseMidFlight(task: DownloadTask): Promise<Promise<void>> {
  const startPromise = task.start();
  const deadline = Date.now() + 5000;
  while (task.getProgress().bytesDownloaded === 0) {
    if (Date.now() > deadline) throw new Error("no bytes flowed before deadline");
    await new Promise((r) => setTimeout(r, 2));
  }
  await task.pause();
  return startPromise;
}

describe("multi-connection download", () => {
  it("downloads a range-supporting file byte-for-byte across parallel connections", async () => {
    const content = makeContent(2 * 1024 * 1024, 42);
    const server = new TestServer({ content });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "t1", url: server.url, destinationPath: dest, maxConnections: 4, minSizeToSegment: 256 * 1024 });
    await task.start();
    await server.stop();

    expect(task.getStatus()).toBe("completed");
    expect(task.serialize().segmentStates.length).toBeGreaterThanOrEqual(4);
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("falls back to a single stream when the server doesn't support ranges", async () => {
    const content = makeContent(512 * 1024, 7);
    const server = new TestServer({ content, supportsRanges: false });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "t2", url: server.url, destinationPath: dest, minSizeToSegment: 1024 });
    await task.start();
    await server.stop();

    expect(task.getStatus()).toBe("completed");
    expect(task.serialize().segmentStates.length).toBe(1);
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("doesn't split a file below the minimum segment size", async () => {
    const content = makeContent(10 * 1024, 3);
    const server = new TestServer({ content });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "t3", url: server.url, destinationPath: dest, maxConnections: 8, minSizeToSegment: 4 * 1024 * 1024 });
    await task.start();
    await server.stop();

    expect(task.serialize().segmentStates.length).toBe(1);
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("recovers a correct file after a simulated mid-stream connection drop", async () => {
    const content = makeContent(1024 * 1024, 99);
    const server = new TestServer({ content, failAfterBytes: 300 * 1024 });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "t4", url: server.url, destinationPath: dest, maxConnections: 3, minSizeToSegment: 64 * 1024, retryBaseDelayMs: 20 });
    await task.start();
    await server.stop();

    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("pauses mid-download and resumes to a byte-correct file", async () => {
    const content = makeContent(1.5 * 1024 * 1024, 55);
    const server = new TestServer({ content, chunkDelayMs: 4 });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "t5", url: server.url, destinationPath: dest, maxConnections: 4, minSizeToSegment: 64 * 1024 });
    await pauseMidFlight(task);
    expect(task.getStatus()).toBe("paused");
    const atPause = task.getProgress().bytesDownloaded;
    expect(atPause).toBeGreaterThan(0);
    expect(atPause).toBeLessThan(content.length);

    await task.resume();
    await server.stop();
    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("removes the partial file on cancel", async () => {
    const content = makeContent(1024 * 1024, 11);
    const server = new TestServer({ content });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "t6", url: server.url, destinationPath: dest, minSizeToSegment: 64 * 1024 });
    const startPromise = task.start();
    await new Promise((r) => setTimeout(r, 15));
    await task.cancel();
    await startPromise;
    await server.stop();

    expect(task.getStatus()).toBe("canceled");
    await expect(fs.access(dest)).rejects.toThrow();
    await expect(fs.access(dest + ".part")).rejects.toThrow();
  });

  it("reports a sensible error and 'failed' status for a 404", async () => {
    const notFound = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const url = await new Promise<string>((resolve) =>
      notFound.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(notFound.address() as { port: number }).port}/x`))
    );
    const task = new DownloadTask({ id: "t7", url, destinationPath: path.join(await tmpDir(), "out.bin") });
    await task.start();
    notFound.closeAllConnections();
    await new Promise<void>((r) => notFound.close(() => r()));

    expect(task.getStatus()).toBe("failed");
    expect(task.getError()).toContain("404");
  });
});

describe("speed: dynamic work stealing", () => {
  it("rescues a slow connection by splitting its remaining work across idle ones", async () => {
    const content = makeContent(3 * 1024 * 1024, 5);
    // Every 4th socket is ~40x slower than the rest.
    const server = new TestServer({ content, chunkDelayMs: 1, slowEveryNthSocket: 4, slowChunkDelayMs: 40 });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({
      id: "w1", url: server.url, destinationPath: dest,
      maxConnections: 4, minSizeToSegment: 256 * 1024, minStealBytes: 64 * 1024,
    });
    await task.start();
    await server.stop();

    expect(task.getStatus()).toBe("completed");
    // More segments than the 4 we started with means idle connections really did steal work.
    expect(task.serialize().segmentStates.length).toBeGreaterThan(4);
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("stays byte-correct under randomized sizes, connection counts, steal thresholds and pauses", async () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 24; i++) {
      const size = 150_000 + Math.floor(rnd() * 1_800_000);
      const content = makeContent(size, 100 + i);
      const server = new TestServer({
        content,
        chunkDelayMs: Math.floor(rnd() * 3),
        slowEveryNthSocket: rnd() < 0.5 ? 3 : undefined,
        slowChunkDelayMs: 15,
      });
      await server.start();
      const dest = path.join(await tmpDir(), "out.bin");
      const task = new DownloadTask({
        id: `r${i}`, url: server.url, destinationPath: dest,
        maxConnections: 1 + Math.floor(rnd() * 12),
        minSizeToSegment: [16, 64, 256][Math.floor(rnd() * 3)] * 1024,
        minStealBytes: [16, 64][Math.floor(rnd() * 2)] * 1024,
        retryBaseDelayMs: 10,
      });
      if (rnd() < 0.4) {
        const run = task.start();
        await new Promise((r) => setTimeout(r, Math.floor(rnd() * 30)));
        await task.pause();
        await run;
        if (task.getStatus() === "paused") await task.resume();
      } else {
        await task.start();
      }
      await server.stop();
      expect(task.getStatus(), `iteration ${i} (size ${size})`).toBe("completed");
      expect((await fs.readFile(dest)).equals(content), `iteration ${i} bytes differ`).toBe(true);
    }
  }, 60000);

  it("retries 503 'busy' responses instead of failing", async () => {
    const content = makeContent(1024 * 1024, 8);
    const server = new TestServer({ content, busyFirstRequests: 3 });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "b1", url: server.url, destinationPath: dest, maxConnections: 4, minSizeToSegment: 128 * 1024, retryBaseDelayMs: 10 });
    await task.start();
    await server.stop();

    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });
});

describe("headers and redirects", () => {
  it("uses the resolved redirect target directly and never forwards cookies cross-origin", async () => {
    const content = makeContent(1024 * 1024, 21);
    const cdn = new TestServer({ content });
    await cdn.start();
    const origin = new TestServer({ content, redirectTo: cdn.url });
    await origin.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({
      id: "h1", url: origin.url, destinationPath: dest, maxConnections: 4, minSizeToSegment: 128 * 1024,
      headers: { Cookie: "sid=secret", Referer: "http://example.test/page", "User-Agent": "TestAgent/1" },
    });
    await task.start();
    await origin.stop();
    await cdn.stop();

    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
    // Origin saw exactly one request (the probe) — every connection after that went straight to the CDN.
    expect(origin.requests.length).toBe(1);
    expect(origin.requests[0].headers.cookie).toBe("sid=secret");
    expect(cdn.requests.length).toBeGreaterThan(1);
    for (const r of cdn.requests) {
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.referer).toBe("http://example.test/page");
      expect(r.headers["user-agent"]).toBe("TestAgent/1");
    }
  });
});

describe("pause/resume edge cases", () => {
  it("restarts cleanly (instead of failing) when a non-resumable server is paused", async () => {
    const content = makeContent(600 * 1024, 31);
    const server = new TestServer({ content, supportsRanges: false, chunkDelayMs: 4 });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "n1", url: server.url, destinationPath: dest });
    await pauseMidFlight(task);
    await task.resume();
    await server.stop();

    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("starts over if the partial file was deleted while paused", async () => {
    const content = makeContent(1.2 * 1024 * 1024, 32);
    const server = new TestServer({ content, chunkDelayMs: 4 });
    await server.start();
    const dest = path.join(await tmpDir(), "out.bin");

    const task = new DownloadTask({ id: "n2", url: server.url, destinationPath: dest, maxConnections: 3, minSizeToSegment: 64 * 1024 });
    await pauseMidFlight(task);
    await fs.rm(dest + ".part");
    await task.resume();
    await server.stop();

    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });
});

describe("DownloadManager", () => {
  it("respects maxConcurrent and drains the queue", async () => {
    const content = makeContent(64 * 1024, 5);
    const server = new TestServer({ content });
    await server.start();
    const dir = await tmpDir();

    const manager = new DownloadManager({ maxConcurrent: 2 });
    const tasks = [0, 1, 2, 3, 4].map((i) => manager.add({ url: server.url, destinationPath: path.join(dir, `f${i}.bin`) }));
    const activeNow = tasks.filter((t) => ["downloading", "connecting"].includes(t.getStatus())).length;
    expect(activeNow).toBeLessThanOrEqual(2);

    await Promise.all(tasks.map((t) => waitFor(t, "completed")));
    await server.stop();
    for (const t of tasks) expect(t.getStatus()).toBe("completed");
  });

  it("resumes a download that was running at shutdown, after a restart", async () => {
    const content = makeContent(1024 * 1024, 21);
    const server = new TestServer({ content, chunkDelayMs: 8 });
    await server.start();
    const dir = await tmpDir();
    const statePath = path.join(dir, "state.json");

    const manager1 = new DownloadManager({ maxConcurrent: 1, statePath });
    const task = manager1.add({ url: server.url, destinationPath: path.join(dir, "f.bin"), maxConnections: 2, minSizeToSegment: 64 * 1024 });
    await new Promise((r) => setTimeout(r, 30));
    await manager1.shutdown();

    const manager2 = new DownloadManager({ maxConcurrent: 1, statePath });
    await manager2.loadState({ autoResume: true });
    const reloaded = manager2.get(task.id)!;
    expect(reloaded).toBeDefined();
    await waitFor(reloaded, "completed");
    await server.stop();

    expect((await fs.readFile(path.join(dir, "f.bin"))).equals(content)).toBe(true);
  });

  it("keeps a download the user paused, paused, after a restart", async () => {
    const content = makeContent(1024 * 1024, 22);
    const server = new TestServer({ content, chunkDelayMs: 8 });
    await server.start();
    const dir = await tmpDir();
    const statePath = path.join(dir, "state.json");

    const manager1 = new DownloadManager({ maxConcurrent: 1, statePath });
    const task = manager1.add({ url: server.url, destinationPath: path.join(dir, "f.bin"), maxConnections: 2, minSizeToSegment: 64 * 1024 });
    await new Promise((r) => setTimeout(r, 30));
    await manager1.pause(task.id);
    await manager1.shutdown();

    const manager2 = new DownloadManager({ maxConcurrent: 1, statePath });
    await manager2.loadState({ autoResume: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(manager2.get(task.id)!.getStatus()).toBe("paused");
    await server.stop();
  });

  it("never overwrites an existing file: picks a unique name", async () => {
    const content = makeContent(32 * 1024, 40);
    const server = new TestServer({ content });
    await server.start();
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "report.bin"), "precious");

    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "report.bin") });
    expect(path.basename(task.destinationPath)).toBe("report (1).bin");
    await waitFor(task, "completed");
    await server.stop();

    expect(await fs.readFile(path.join(dir, "report.bin"), "utf-8")).toBe("precious");
    expect((await fs.readFile(task.destinationPath)).equals(content)).toBe(true);
  });

  it("removing a COMPLETED download keeps the file on disk", async () => {
    const content = makeContent(32 * 1024, 41);
    const server = new TestServer({ content });
    await server.start();
    const dir = await tmpDir();

    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "keep.bin") });
    await waitFor(task, "completed");
    await manager.remove(task.id);
    await server.stop();

    expect(manager.list().length).toBe(0);
    expect((await fs.readFile(path.join(dir, "keep.bin"))).equals(content)).toBe(true);
  });

  it("dismissing a COMPLETED download keeps the file on disk (same as remove)", async () => {
    const content = makeContent(32 * 1024, 42);
    const server = new TestServer({ content });
    await server.start();
    const dir = await tmpDir();

    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "keep2.bin") });
    await waitFor(task, "completed");
    await manager.dismiss(task.id);
    await server.stop();

    expect(manager.list().length).toBe(0);
    expect((await fs.readFile(path.join(dir, "keep2.bin"))).equals(content)).toBe(true);
  });

  it("dismissing a PAUSED download keeps the partial file on disk", async () => {
    const server = new TestServer({ content: makeContent(4 * 1024 * 1024, 43), chunkDelayMs: 20 });
    await server.start();
    const dir = await tmpDir();

    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "partial.bin") });
    await waitFor(task, "downloading");
    await task.pause();
    const partPath = task.destinationPath + ".part";
    expect(await fs.stat(partPath).then(() => true, () => false)).toBe(true);

    await manager.dismiss(task.id);
    await server.stop();

    expect(manager.list().length).toBe(0);
    expect(await fs.stat(partPath).then(() => true, () => false)).toBe(true);
  });

  it("erasing a COMPLETED download DELETES the file — the gap remove()/dismiss() deliberately don't cover", async () => {
    const content = makeContent(32 * 1024, 44);
    const server = new TestServer({ content });
    await server.start();
    const dir = await tmpDir();

    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "erase-me.bin") });
    await waitFor(task, "completed");
    const finalPath = task.destinationPath;
    expect(await fs.stat(finalPath).then(() => true, () => false)).toBe(true);

    await manager.erase(task.id);
    await server.stop();

    expect(manager.list().length).toBe(0);
    expect(await fs.stat(finalPath).then(() => true, () => false)).toBe(false);
  });

  it("erasing a PAUSED download deletes the partial file", async () => {
    const server = new TestServer({ content: makeContent(4 * 1024 * 1024, 45), chunkDelayMs: 20 });
    await server.start();
    const dir = await tmpDir();

    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "erase-partial.bin") });
    await waitFor(task, "downloading");
    await task.pause();
    const partPath = task.destinationPath + ".part";
    expect(await fs.stat(partPath).then(() => true, () => false)).toBe(true);

    await manager.erase(task.id);
    await server.stop();

    expect(manager.list().length).toBe(0);
    expect(await fs.stat(partPath).then(() => true, () => false)).toBe(false);
  });

  it("erasing an ACTIVELY DOWNLOADING download stops it and deletes the partial file", async () => {
    const server = new TestServer({ content: makeContent(4 * 1024 * 1024, 46), chunkDelayMs: 20 });
    await server.start();
    const dir = await tmpDir();

    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "erase-active.bin") });
    await waitFor(task, "downloading");
    const partPath = task.destinationPath + ".part";

    await manager.erase(task.id);
    await server.stop();

    expect(manager.list().length).toBe(0);
    expect(await fs.stat(partPath).then(() => true, () => false)).toBe(false);
  });
});

describe("helpers", () => {
  it("uniquePath handles extensions and .tar.gz", () => {
    const taken = new Set(["/d/a.zip", "/d/a (1).zip", "/d/b.tar.gz"]);
    expect(uniquePath("/d/a.zip", (c) => taken.has(c))).toBe("/d/a (2).zip");
    expect(uniquePath("/d/b.tar.gz", (c) => taken.has(c))).toBe("/d/b (1).tar.gz");
    expect(uniquePath("/d/free.txt", (c) => taken.has(c))).toBe("/d/free.txt");
  });

  it("sanitizeFileName neutralises path tricks and junk", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFileName("a/b\\c:d*e.zip")).toBe("a_b_c_d_e.zip");
    expect(sanitizeFileName("   ")).toBe("download");
    expect(sanitizeFileName(".hidden")).toBe("hidden");
  });
});

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff, 0xe0];
function withMagic(content: Buffer, magic: number[]): Buffer {
  const b = Buffer.from(content);
  Buffer.from(magic).copy(b, 0);
  return b;
}

describe("file names and types (the 'image saved as a nameless non-image file' bug)", () => {
  it("adds the extension from Content-Type when the URL path has none", async () => {
    const content = withMagic(makeContent(300 * 1024, 61), PNG);
    const server = new TestServer({ content, contentType: "image/png" });
    await server.start();
    const dir = await tmpDir();
    const task = new DownloadTask({ id: "i1", url: server.url, destinationPath: path.join(dir, "photo-1506744038136") });
    await task.start();
    await server.stop();
    expect(task.getStatus()).toBe("completed");
    expect(path.basename(task.destinationPath)).toBe("photo-1506744038136.png");
    expect(await fs.readdir(dir)).toEqual(["photo-1506744038136.png"]);
    expect((await fs.readFile(task.destinationPath)).equals(content)).toBe(true);
  });

  it("identifies the type from the file's bytes when the server and URL say nothing", async () => {
    const content = withMagic(makeContent(200 * 1024, 62), JPG);
    const server = new TestServer({ content });
    await server.start();
    const dir = await tmpDir();
    const task = new DownloadTask({ id: "i2", url: server.url, destinationPath: path.join(dir, "IMG") });
    await task.start();
    await server.stop();
    expect(path.basename(task.destinationPath)).toBe("IMG.jpg");
    expect(await fs.readdir(dir)).toEqual(["IMG.jpg"]);
  });

  it("uses the server's Content-Disposition name for a link-derived name", async () => {
    const content = makeContent(100 * 1024, 63);
    const server = new TestServer({ content, contentDisposition: 'attachment; filename="My Report (final).pdf"' });
    await server.start();
    const dir = await tmpDir();
    const task = new DownloadTask({ id: "i3", url: server.url, destinationPath: path.join(dir, "download") });
    await task.start();
    await server.stop();
    expect(path.basename(task.destinationPath)).toBe("My Report (final).pdf");
  });

  it("does not let the server rename a name the user or browser chose", async () => {
    const content = makeContent(50 * 1024, 64);
    const server = new TestServer({ content, contentDisposition: 'attachment; filename="evil.exe"' });
    await server.start();
    const dir = await tmpDir();
    const task = new DownloadTask({ id: "i4", url: server.url, destinationPath: path.join(dir, "mine.bin"), nameIsFinal: true });
    await task.start();
    await server.stop();
    expect(path.basename(task.destinationPath)).toBe("mine.bin");
  });

  it("refuses an HTML page served in place of an image, and leaves nothing on disk", async () => {
    const server = new TestServer({ content: Buffer.alloc(1), htmlBody: "<html><body>Please sign in</body></html>" });
    await server.start();
    const dir = await tmpDir();
    const task = new DownloadTask({ id: "i5", url: server.url, destinationPath: path.join(dir, "photo.jpg") });
    await task.start();
    await server.stop();
    expect(task.getStatus()).toBe("failed");
    expect(task.getError()).toContain("web page");
    expect(task.isAutoRetryable()).toBe(false);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("still saves an HTML page when the link itself has no file-type claim", async () => {
    const server = new TestServer({ content: Buffer.alloc(1), htmlBody: "<html><body>About us</body></html>" });
    await server.start();
    const dir = await tmpDir();
    const task = new DownloadTask({ id: "i6", url: server.url, destinationPath: path.join(dir, "about") });
    await task.start();
    await server.stop();
    expect(task.getStatus()).toBe("completed");
    expect(path.basename(task.destinationPath)).toBe("about.html");
  });

  it("asks for raw bytes, so a gzip-happy server can't corrupt the saved file", async () => {
    const content = makeContent(600 * 1024, 65);
    const server = new TestServer({ content, gzipIfAccepted: true });
    await server.start();
    const dir = await tmpDir();
    const task = new DownloadTask({ id: "i7", url: server.url, destinationPath: path.join(dir, "data.bin"), maxConnections: 3, minSizeToSegment: 64 * 1024 });
    await task.start();
    await server.stop();
    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(path.join(dir, "data.bin"))).equals(content)).toBe(true);
    expect(server.requests.every((r) => !/gzip|deflate|br/i.test(String(r.headers["accept-encoding"])))).toBe(true); // never advertises compression
  });

  it("picks a unique name when the corrected name is already taken", async () => {
    const content = withMagic(makeContent(80 * 1024, 66), PNG);
    const server = new TestServer({ content, contentType: "image/png" });
    await server.start();
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, "photo.png"), "mine");
    const manager = new DownloadManager();
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "photo") });
    await waitFor(task, "completed");
    await server.stop();
    expect(path.basename(task.destinationPath)).toBe("photo (1).png");
    expect(await fs.readFile(path.join(dir, "photo.png"), "utf-8")).toBe("mine");
  });
});

describe("persistence: pause/resume that survives restarts and crashes", () => {
  it("keeps unfinished data in a .part file and only creates the real file on completion", async () => {
    const content = makeContent(1.5 * 1024 * 1024, 70);
    const server = new TestServer({ content, chunkDelayMs: 4 });
    await server.start();
    const dest = path.join(await tmpDir(), "movie.bin");
    const task = new DownloadTask({ id: "p1", url: server.url, destinationPath: dest, maxConnections: 4, minSizeToSegment: 64 * 1024 });
    await pauseMidFlight(task);
    expect(await exists(dest)).toBe(false); // a half-finished file must never look finished
    expect(await exists(dest + ".part")).toBe(true);
    await task.resume();
    await server.stop();
    expect(await exists(dest)).toBe(true);
    expect(await exists(dest + ".part")).toBe(false);
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
  });

  it("gets received bytes onto disk within about a second, even on a slow connection", async () => {
    const content = makeContent(3 * 1024 * 1024, 76);
    const server = new TestServer({ content, chunkDelayMs: 40 }); // ~400 KB/s per connection: a 1 MiB buffer would take ~2.5s
    await server.start();
    const dest = path.join(await tmpDir(), "slow.bin");
    const task = new DownloadTask({ id: "f1", url: server.url, destinationPath: dest, maxConnections: 2, minSizeToSegment: 256 * 1024 });
    const run = task.start();
    await new Promise((r) => setTimeout(r, 1700));
    const onDisk = task.serialize().segmentStates.reduce((sum, s) => sum + s.received, 0);
    const total = task.getProgress().bytesDownloaded;
    expect(total).toBeGreaterThan(300 * 1024);
    expect(onDisk).toBeGreaterThan(total * 0.4); // would be ~0 if progress only counted full 1 MiB buffers
    await task.pause();
    await run;
    await server.stop();
  });

  it("recovers a paused download from the files beside it when the queue file is lost entirely", async () => {
    const content = makeContent(1.5 * 1024 * 1024, 71);
    const server = new TestServer({ content, chunkDelayMs: 4 });
    await server.start();
    const dir = await tmpDir();

    const manager1 = new DownloadManager({ statePath: path.join(dir, "state", "queue.json") });
    const t1 = manager1.add({ url: server.url, destinationPath: path.join(dir, "movie.bin"), maxConnections: 3, minSizeToSegment: 64 * 1024 });
    while (t1.getProgress().bytesDownloaded === 0) await new Promise((r) => setTimeout(r, 5));
    await manager1.pause(t1.id);
    await manager1.saveNow();
    const progressBefore = t1.getProgress().bytesDownloaded;
    expect(await exists(path.join(dir, "movie.bin.part.json"))).toBe(true);

    // The app's own database is gone (new profile, wiped Application Support, corruption...).
    const manager2 = new DownloadManager({ statePath: path.join(dir, "other-state", "queue.json") });
    const summary = await manager2.loadState({ scanDirs: [dir] });
    expect(summary).toMatchObject({ loaded: 0, recovered: 1 });
    const t2 = manager2.list()[0];
    expect(t2.getStatus()).toBe("paused");
    expect(t2.getProgress().bytesDownloaded).toBe(progressBefore); // progress came back with it

    await manager2.resume(t2.id);
    await waitFor(t2, "completed");
    await server.stop();
    expect((await fs.readFile(path.join(dir, "movie.bin"))).equals(content)).toBe(true);
    expect(await exists(path.join(dir, "movie.bin.part.json"))).toBe(false);
  });

  it("upgrades a v0.1 download in progress: its partial data (at the final name) moves to a .part file and continues", async () => {
    const content = makeContent(600 * 1024, 77);
    const server = new TestServer({ content });
    await server.start();
    const dir = await tmpDir();
    const dest = path.join(dir, "old-download.bin");
    // What v0.1 left on disk: a pre-allocated file at the FINAL name with only the first 200 KiB filled in...
    const partial = Buffer.alloc(content.length);
    content.copy(partial, 0, 0, 200 * 1024);
    await fs.writeFile(dest, partial);
    // ...and a queue file in the old format (no resumeOnLaunch / nameLocked / etag, legacy "maxSegments").
    const statePath = path.join(dir, "queue.json");
    await fs.writeFile(statePath, JSON.stringify([{
      id: "legacy-1", url: server.url, destinationPath: dest, maxSegments: 4, status: "paused",
      totalBytes: content.length, acceptsRanges: true, createdAt: Date.now(),
      segmentStates: [{ index: 0, start: 0, end: content.length - 1, received: 200 * 1024, done: false }],
    }]));

    const manager = new DownloadManager({ statePath });
    await manager.loadState({ autoResume: true });
    const task = manager.get("legacy-1")!;
    await waitFor(task, "completed");
    await server.stop();
    expect((await fs.readFile(dest)).equals(content)).toBe(true);
    expect(await exists(dest + ".part")).toBe(false);
  });

  it("falls back to the backup copy when the queue file is corrupt", async () => {
    const content = makeContent(1024 * 1024, 72);
    const server = new TestServer({ content, chunkDelayMs: 6 });
    await server.start();
    const dir = await tmpDir();
    const statePath = path.join(dir, "queue.json");

    const manager1 = new DownloadManager({ statePath });
    const t = manager1.add({ url: server.url, destinationPath: path.join(dir, "f.bin"), maxConnections: 2, minSizeToSegment: 64 * 1024 });
    while (t.getProgress().bytesDownloaded === 0) await new Promise((r) => setTimeout(r, 5));
    await manager1.pause(t.id);
    await manager1.saveNow();
    await manager1.saveNow(); // second save leaves the first as queue.json.bak
    await fs.writeFile(statePath, "{{{ this is not json"); // e.g. a torn write after a power cut

    const manager2 = new DownloadManager({ statePath });
    const summary = await manager2.loadState();
    expect(summary.source).toBe("backup");
    expect(manager2.list().length).toBe(1);
    expect((await fs.readdir(dir)).some((n) => n.startsWith("queue.json.corrupt-"))).toBe(true); // kept for inspection
    await server.stop();
  });

  it("stops stitching old and new bytes together when the file changes on the server", async () => {
    const original = makeContent(1.2 * 1024 * 1024, 73);
    const changed = makeContent(1.2 * 1024 * 1024, 74);
    const server = new TestServer({ content: original, etag: '"v1"', chunkDelayMs: 4 });
    await server.start();
    const dest = path.join(await tmpDir(), "data.bin");
    const task = new DownloadTask({ id: "c1", url: server.url, destinationPath: dest, maxConnections: 3, minSizeToSegment: 64 * 1024 });
    await pauseMidFlight(task);
    server.setContent(changed, '"v2"');
    await task.resume();
    await server.stop();
    expect(task.getStatus()).toBe("completed");
    expect((await fs.readFile(dest)).equals(changed)).toBe(true); // all new bytes, none of the old
  });

  it("automatically retries transient failures and finishes by itself", async () => {
    const content = makeContent(200 * 1024, 75);
    const server = new TestServer({ content, busyFirstRequests: 14 }); // outlasts a task's own retries
    await server.start();
    const dir = await tmpDir();
    const manager = new DownloadManager({ autoRetryDelaysMs: [20, 20, 20, 20, 20, 20] });
    const task = manager.add({ url: server.url, destinationPath: path.join(dir, "f.bin"), maxConnections: 1, retryBaseDelayMs: 2 });
    await waitFor(task, "completed", 20000);
    await server.stop();
    expect((await fs.readFile(path.join(dir, "f.bin"))).equals(content)).toBe(true);
  });

  it("does not auto-retry a permanent failure like a 404", async () => {
    const gone = http.createServer((_q, res) => { res.writeHead(404); res.end(); });
    const url = await new Promise<string>((r) => gone.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(gone.address() as { port: number }).port}/x`)));
    const manager = new DownloadManager({ autoRetryDelaysMs: [10] });
    const task = manager.add({ url, destinationPath: path.join(await tmpDir(), "x.bin") });
    await waitFor(task, "failed");
    expect(task.isAutoRetryable()).toBe(false);
    expect(manager.getRetryAt(task.id)).toBeNull();
    gone.closeAllConnections();
    gone.close();
  });
});
