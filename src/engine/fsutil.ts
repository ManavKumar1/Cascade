import * as fs from "node:fs/promises";
import * as path from "node:path";

let counter = 0;

/**
 * Durable atomic write. The data is fsync'd before the rename and the directory entry after it, so a
 * power cut or forced shutdown leaves either the complete old file or the complete new one — never a
 * truncated one (which is what a plain write+rename can leave behind).
 */
export async function atomicWrite(file: string, data: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++counter}.tmp`;
  const fh = await fs.open(tmp, "w", mode);
  try {
    await fh.writeFile(data, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  try {
    const dh = await fs.open(path.dirname(file), "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* some filesystems refuse fsync on directories; the file itself is already durable */
  }
}

export async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  );
}

export async function readHead(file: string, bytes: number): Promise<Buffer | null> {
  try {
    const fh = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await fh.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
