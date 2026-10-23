import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DownloadTask } from "../src/engine/DownloadTask";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { TestServer, makeContent } from "./testServer";

async function tmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), "cascade-fuzz-" + randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("FUZZ: overlapping pause/resume calls (unawaited, simulating a UI race)", () => {
  it("never loses progress when resume() is fired before pause() has finished unwinding", async () => {
    const TRIALS = 30;
    let worstDrop = 0;
    let anyResetToZero = false;
    let anyFailed = 0;
    let anyCorrupt = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const content = makeContent(4 * 1024 * 1024, 100 + trial);
      const server = new TestServer({ content, chunkDelayMs: 5 }); // slow enough that pause's unwind takes real time
      await server.start();
      const dest = path.join(await tmpDir(), "race.bin");
      const task = new DownloadTask({ id: `race-${trial}`, url: server.url, destinationPath: dest, maxConnections: 16, minSizeToSegment: 32 * 1024 });

      const run = task.start();
      // let it get some real progress with many connections actively flushing
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
      const before = task.getProgress().bytesDownloaded;

      // THE RACE: fire pause, but DON'T await it before firing resume — exactly what an eager double-click
      // or an optimistic-UI re-enabled button could produce.
      const pausePromise = task.pause(); // NOT awaited — fire resume in the same tick, no gap at all
      const resumePromise = task.resume();
      await Promise.allSettled([pausePromise, resumePromise]);
      await new Promise((r) => setTimeout(r, 80));

      const after = task.getProgress().bytesDownloaded;
      if (after < before) worstDrop = Math.max(worstDrop, before - after);
      if (before > 300 * 1024 && after < 10 * 1024) anyResetToZero = true;

      // let it finish normally (whatever state it's in) and check final correctness
      try {
        await run;
      } catch { /* run() is the first start(); resume may have begun a second run */ }
      // settle: if paused, resume to completion; if mid-flight from the race, just wait
      for (let i = 0; i < 400 && !["completed", "failed", "canceled"].includes(task.getStatus()); i++) {
        if (task.getStatus() === "paused") await task.resume();
        await new Promise((r) => setTimeout(r, 15));
      }
      await server.stop();

      if (task.getStatus() === "completed") {
        const final = await fs.readFile(dest).catch(() => null);
        const correct = final && final.equals(content);
        if (!correct) { anyCorrupt++; console.log(`trial ${trial}: COMPLETED BUT CORRUPT (before=${before} after=${after})`); }
      } else {
        anyFailed++;
        console.log(`trial ${trial}: ended as ${task.getStatus()} (before=${before}, after=${after}, error=${task.getError()})`);
      }
    }
    console.log(`\n${TRIALS} trials: worst progress drop=${worstDrop}B, reset-to-zero=${anyResetToZero}, ended failed/canceled=${anyFailed}, completed-but-corrupt=${anyCorrupt}`);
    expect({ anyResetToZero, anyFailed, anyCorrupt }).toEqual({ anyResetToZero: false, anyFailed: 0, anyCorrupt: 0 });
  }, 90000);

  it("survives a rapid pause/resume/pause/resume burst (all unawaited) without corrupting the file", async () => {
    const TRIALS = 20;
    for (let trial = 0; trial < TRIALS; trial++) {
      const content = makeContent(3 * 1024 * 1024, 200 + trial);
      const server = new TestServer({ content, chunkDelayMs: 4 });
      await server.start();
      const dest = path.join(await tmpDir(), "burst.bin");
      const task = new DownloadTask({ id: `burst-${trial}`, url: server.url, destinationPath: dest, maxConnections: 12, minSizeToSegment: 32 * 1024 });

      void task.start();
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 100));
      // Fire four control calls back-to-back with no awaits between them at all.
      void task.pause();
      void task.resume();
      void task.pause();
      const lastCall = task.resume();
      await lastCall;

      for (let i = 0; i < 400 && !["completed", "failed", "canceled"].includes(task.getStatus()); i++) {
        if (task.getStatus() === "paused") await task.resume();
        await new Promise((r) => setTimeout(r, 15));
      }
      await server.stop();
      expect(task.getStatus(), `trial ${trial}: ${task.getError() ?? ""}`).toBe("completed");
      expect((await fs.readFile(dest)).equals(content), `trial ${trial}: file mismatch`).toBe(true);
    }
  }, 90000);
});
