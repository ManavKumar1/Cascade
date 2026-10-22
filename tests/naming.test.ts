import { describe, it, expect } from "vitest";
import { parseContentDisposition, chooseFileName, sniffExtension, extOf, extFromMime } from "../src/engine/utils";

describe("parseContentDisposition", () => {
  it("handles quoted, bare, escaped and attachment/inline", () => {
    expect(parseContentDisposition('attachment; filename="report.pdf"')).toEqual({ filename: "report.pdf", attachment: true });
    expect(parseContentDisposition("inline; filename=photo.jpg")).toEqual({ filename: "photo.jpg", attachment: false });
    expect(parseContentDisposition('attachment; filename="a \\"b\\".txt"').filename).toBe('a "b".txt');
    expect(parseContentDisposition("attachment").filename).toBeUndefined();
    expect(parseContentDisposition(null)).toEqual({ attachment: false });
  });
  it("prefers RFC 5987 filename* and decodes UTF-8", () => {
    expect(parseContentDisposition("attachment; filename*=UTF-8''caf%C3%A9%20menu.pdf").filename).toBe("café menu.pdf");
    expect(parseContentDisposition('attachment; filename="fallback.txt"; filename*=UTF-8\'\'real%20name.txt').filename).toBe("real name.txt");
  });
  it("repairs UTF-8 that arrived as latin1, and strips path components", () => {
    expect(parseContentDisposition('attachment; filename="cafÃ©.pdf"').filename).toBe("café.pdf");
    expect(parseContentDisposition('attachment; filename="..\\\\..\\\\evil.exe"').filename).toBe("evil.exe");
  });
});

describe("chooseFileName", () => {
  const pick = (o: Partial<Parameters<typeof chooseFileName>[0]> & { current: string }) => chooseFileName({ locked: false, ...o });
  it("gives extensionless image URLs the right extension", () => {
    expect(pick({ current: "photo-1506744038136", contentType: "image/jpeg" })).toBe("photo-1506744038136.jpg");
    expect(pick({ current: "images", contentType: "image/jpeg; charset=binary" })).toBe("images.jpg");
    expect(pick({ current: "Abc123", contentType: "image/webp" })).toBe("Abc123.webp");
  });
  it("fixes dynamic-page extensions, treats version numbers as part of the name", () => {
    expect(pick({ current: "download.php", contentType: "application/zip" })).toBe("download.zip");
    expect(pick({ current: "index.php", contentType: "text/html" })).toBe("index.html");
    expect(pick({ current: "app-1.2.3", contentType: "application/zip" })).toBe("app-1.2.3.zip");
  });
  it("leaves a plausible extension and unknown types alone", () => {
    expect(pick({ current: "photo.jpg", contentType: "image/png" })).toBe("photo.jpg");
    expect(pick({ current: "blob", contentType: "application/octet-stream" })).toBe("blob");
    expect(pick({ current: "blob" })).toBe("blob");
  });
  it("lets Content-Disposition and the redirect target beat a guessed name, unless the name is locked", () => {
    expect(pick({ current: "get", contentDisposition: 'attachment; filename="setup.dmg"' })).toBe("setup.dmg");
    expect(pick({ current: "get", finalUrl: "https://cdn.example/files/setup%20v2.dmg?sig=1" })).toBe("setup v2.dmg");
    expect(chooseFileName({ current: "mine", locked: true, contentDisposition: 'attachment; filename="x.exe"', contentType: "application/zip" })).toBe("mine.zip");
  });
});

describe("sniffExtension / extOf / extFromMime", () => {
  const b = (...bytes: number[]) => Buffer.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  it("recognises common formats from magic bytes", () => {
    expect(sniffExtension(b(0xff, 0xd8, 0xff))).toBe("jpg");
    expect(sniffExtension(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
    expect(sniffExtension(Buffer.from("GIF89a....."))).toBe("gif");
    expect(sniffExtension(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffExtension(Buffer.from("%PDF-1.7\n"))).toBe("pdf");
    expect(sniffExtension(Buffer.from("PK\x03\x04rest"))).toBe("zip");
    expect(sniffExtension(Buffer.from("\0\0\0\x18ftypavif\0\0\0\0"))).toBe("avif");
    expect(sniffExtension(Buffer.from("\0\0\0\x18ftypisom\0\0\0\0"))).toBe("mp4");
    expect(sniffExtension(Buffer.from("  <!DOCTYPE html><html>"))).toBe("html");
    expect(sniffExtension(Buffer.from('<?xml version="1.0"?><svg xmlns='))).toBe("svg");
    expect(sniffExtension(Buffer.from("just some random text bytes"))).toBeNull();
  });
  it("extOf and extFromMime", () => {
    expect(extOf("a.tar.gz")).toBe("gz");
    expect(extOf("IMG.JPG")).toBe("jpg");
    expect(extOf("v1.2")).toBe("");
    expect(extOf("noext")).toBe("");
    expect(extFromMime("IMAGE/PNG; q=1")).toBe("png");
    expect(extFromMime("application/octet-stream")).toBeNull();
  });
});
