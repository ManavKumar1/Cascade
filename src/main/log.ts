import * as fs from "node:fs";
import * as path from "node:path";

/** Tiny append-only diagnostics log (rotated at 512 KB) so "where did my download go?" can be answered. */
export function createLogger(file: string): (message: string) => void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + ".old");
  } catch {
    /* logging must never break the app */
  }
  return (message) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* ignore */
    }
  };
}
