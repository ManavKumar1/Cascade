import * as path from "node:path";

/** Sliding-window speed estimate: reflects *current* speed, not an all-time average. */
export class SpeedSampler {
  private samples: Array<{ t: number; bytes: number }> = [];
  private readonly windowMs: number;

  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
  }

  sample(totalBytesSoFar: number, now: number = Date.now()): void {
    this.samples.push({ t: now, bytes: totalBytesSoFar });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) this.samples.shift();
  }

  speedBytesPerSec(now: number = Date.now()): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    if (now - last.t > this.windowMs) return 0;
    return Math.max(0, (last.bytes - first.bytes) / dt);
  }

  reset(): void {
    this.samples = [];
  }
}

export function etaSeconds(remainingBytes: number, speedBytesPerSec: number): number | null {
  if (speedBytesPerSec <= 0) return null;
  return remainingBytes / speedBytesPerSec;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const precision = i === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
  return `${value.toFixed(precision)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/** Splits [0, totalBytes) into `count` contiguous, roughly-equal byte ranges. */
export function planSegments(totalBytes: number, count: number): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  const base = Math.floor(totalBytes / count);
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = i === count - 1 ? totalBytes - 1 : start + base - 1;
    segments.push({ start, end });
    start = end + 1;
  }
  return segments;
}

/** Turns Node's terse "fetch failed" into something with the real cause (ENOTFOUND, ECONNREFUSED...). */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string } }).cause;
    const code = cause?.code ?? (err as NodeJS.ErrnoException).code;
    if (code && !err.message.includes(code)) return `${err.message} (${code})`;
    return err.message;
  }
  return String(err);
}

const DOUBLE_EXT = /\.tar\.(gz|bz2|xz|zst|lz|z)$/i;

/** "a.zip" -> "a (1).zip" (and "a.tar.gz" -> "a (1).tar.gz") until `isTaken` says it's free. */
export function uniquePath(p: string, isTaken: (candidate: string) => boolean): string {
  if (!isTaken(p)) return p;
  const dir = path.dirname(p);
  const base = path.basename(p);
  const m = DOUBLE_EXT.exec(base);
  const ext = m ? m[0] : path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!isTaken(candidate)) return candidate;
  }
  return p;
}

/** Makes an untrusted file name (e.g. from a browser or URL) safe to join onto a directory. */
export function sanitizeFileName(name: string, fallback = "download"): string {
  let n = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n || fallback;
}

// ---------------------------------------------------------------------------
// File naming: URL path -> Content-Disposition -> Content-Type -> magic bytes
// ---------------------------------------------------------------------------

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/pjpeg": "jpg", "image/png": "png", "image/apng": "png",
  "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/heic": "heic", "image/heif": "heif",
  "image/svg+xml": "svg", "image/bmp": "bmp", "image/x-ms-bmp": "bmp", "image/tiff": "tiff", "image/jxl": "jxl",
  "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
  "application/pdf": "pdf", "application/zip": "zip", "application/x-zip-compressed": "zip", "application/x-zip": "zip",
  "application/gzip": "gz", "application/x-gzip": "gz", "application/x-tar": "tar", "application/x-bzip2": "bz2",
  "application/x-xz": "xz", "application/zstd": "zst", "application/x-7z-compressed": "7z",
  "application/vnd.rar": "rar", "application/x-rar-compressed": "rar", "application/x-rar": "rar",
  "application/java-archive": "jar", "application/x-apple-diskimage": "dmg", "application/x-iso9660-image": "iso",
  "application/x-msdownload": "exe", "application/vnd.microsoft.portable-executable": "exe", "application/x-msi": "msi",
  "application/vnd.android.package-archive": "apk", "application/x-debian-package": "deb", "application/x-rpm": "rpm",
  "application/x-bittorrent": "torrent", "application/epub+zip": "epub", "application/wasm": "wasm",
  "application/json": "json", "application/xml": "xml", "text/xml": "xml", "text/csv": "csv", "text/plain": "txt",
  "text/html": "html", "application/xhtml+xml": "xhtml", "text/css": "css", "text/javascript": "js",
  "application/javascript": "js", "application/x-javascript": "js", "text/markdown": "md", "application/rtf": "rtf",
  "text/calendar": "ics", "text/vcard": "vcf",
  "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt", "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/x-msvideo": "avi",
  "video/mpeg": "mpg", "video/ogg": "ogv", "video/x-flv": "flv", "video/3gpp": "3gp", "video/x-ms-wmv": "wmv", "video/mp2t": "ts",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/ogg": "ogg",
  "audio/opus": "opus", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac",
  "audio/x-flac": "flac", "audio/webm": "weba", "audio/midi": "mid",
  "font/woff": "woff", "font/woff2": "woff2", "font/ttf": "ttf", "font/otf": "otf",
};

/** Pages that legitimately answer with HTML (or other content), so an .php/.asp name proves nothing. */
const DYNAMIC_EXTS = new Set(["php", "asp", "aspx", "jsp", "jspx", "cgi", "do", "action", "cfm", "pl", "shtml"]);
export const HTML_LIKE_EXTS = new Set(["html", "htm", "xhtml", ...DYNAMIC_EXTS]);

/** Extension of a file name, lowercase and without the dot. "" if none (all-digit "extensions" like v1.2 don't count). */
export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  if (!m || /^\d+$/.test(m[1])) return "";
  return m[1].toLowerCase();
}

export function extFromMime(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  return MIME_EXT[contentType.split(";")[0].trim().toLowerCase()] ?? null;
}

export function isHtmlMime(contentType: string | null | undefined): boolean {
  const m = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return m === "text/html" || m === "application/xhtml+xml";
}

function fixMojibake(s: string): string {
  // Some servers send raw UTF-8 in headers; fetch hands it to us as latin1.
  if (!/[\u0080-\u00ff]/.test(s)) return s;
  const re = Buffer.from(s, "latin1").toString("utf8");
  return re.includes("\ufffd") ? s : re;
}

/** RFC 6266 Content-Disposition: handles filename*=UTF-8''..., quoted and bare filename=, and path stripping. */
export function parseContentDisposition(header: string | null | undefined): { filename?: string; attachment: boolean } {
  if (!header) return { attachment: false };
  const attachment = /^\s*attachment\b/i.test(header);
  let filename: string | undefined;

  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star) {
    const m = /^\s*([\w-]+)'[^']*'(.*)$/.exec(star[1].trim());
    if (m) {
      const bytes = Buffer.from(m[2].replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      filename = m[1].toLowerCase() === "utf-8" ? bytes.toString("utf8") : bytes.toString("latin1");
    }
  }
  if (!filename) {
    const plain = /filename\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]+)/i.exec(header);
    if (plain) {
      filename = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, "$1") : plain[1].trim();
      filename = fixMojibake(filename);
    }
  }
  if (filename) filename = filename.split(/[\\/]/).pop();
  return { filename: filename || undefined, attachment };
}

/**
 * Picks the name a download should be saved under. A name that came from a URL path is a guess;
 * the server's Content-Disposition beats it, and the Content-Type fills in a missing/bogus extension
 * (so an image URL like ".../photo-1234?w=800" becomes photo-1234.jpg instead of an extensionless blob).
 */
export function chooseFileName(opts: {
  current: string;
  /** True when the name was chosen by the user/browser: don't let the server rename it. */
  locked: boolean;
  contentType?: string | null;
  contentDisposition?: string | null;
  finalUrl?: string;
}): string {
  let name = opts.current;
  const cd = parseContentDisposition(opts.contentDisposition);
  if (!opts.locked && cd.filename) {
    name = sanitizeFileName(cd.filename);
  } else if (!opts.locked && opts.finalUrl && !extOf(name)) {
    // The original link had no extension but the redirect target does: prefer the target's name.
    try {
      const fromFinal = decodeURIComponent(path.basename(new URL(opts.finalUrl).pathname));
      if (extOf(fromFinal)) name = sanitizeFileName(fromFinal);
    } catch {
      /* keep name */
    }
  }
  const mimeExt = extFromMime(opts.contentType);
  if (!mimeExt) return name;
  const ext = extOf(name);
  if (!ext) return `${name.replace(/\.+$/, "")}.${mimeExt}`;
  if (DYNAMIC_EXTS.has(ext) && ext !== mimeExt) return `${name.slice(0, -ext.length - 1)}.${mimeExt}`;
  return name;
}

/** Identifies common file types from their first bytes (for downloads whose name and Content-Type say nothing). */
export function sniffExtension(buf: Buffer): string | null {
  const s = (i: number, str: string) => buf.subarray(i, i + str.length).toString("latin1") === str;
  if (buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (s(0, "GIF87a") || s(0, "GIF89a")) return "gif";
  if (s(0, "RIFF") && s(8, "WEBP")) return "webp";
  if (s(0, "RIFF") && s(8, "WAVE")) return "wav";
  if (s(0, "RIFF") && s(8, "AVI ")) return "avi";
  if (s(0, "%PDF-")) return "pdf";
  if (s(0, "PK\x03\x04")) return "zip";
  if (buf[0] === 0x1f && buf[1] === 0x8b) return "gz";
  if (s(0, "7z\xbc\xaf\x27\x1c")) return "7z";
  if (s(0, "Rar!\x1a\x07")) return "rar";
  if (s(0, "BZh")) return "bz2";
  if (buf.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return "xz";
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && buf[3] === 0x2a)) return "tiff";
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return "ico";
  if (s(4, "ftyp")) {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "heic";
    if (brand === "qt  ") return "mov";
    if (brand.startsWith("M4A")) return "m4a";
    return "mp4";
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return buf.subarray(0, 64).includes("webm") ? "webm" : "mkv";
  if (s(0, "ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
  if (s(0, "OggS")) return "ogg";
  if (s(0, "fLaC")) return "flac";
  const head = buf.toString("utf8").trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}

/** Merges header maps case-insensitively (later sources win), returning lowercase keys. */
export function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) out[k.toLowerCase()] = v;
  }
  return out;
}
