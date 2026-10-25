#!/usr/bin/env node
// Run with: npm run sync:maintainer
//
// maintainer.config.json is the one file you actually edit. This script copies those values into
// the two places that can't read it themselves: README.md and .github/FUNDING.yml are both static
// text GitHub renders directly — there's no server, no templating, nothing fetches at view-time.
// The marker comments below (MAINTAINER:...) bound exactly what this script is allowed to touch in
// README.md; everything outside them is yours, hand-written, and this script never rewrites it.
// Safe to re-run any time after editing the config — it's idempotent.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const configPath = path.join(ROOT, "maintainer.config.json");
const fundingPath = path.join(ROOT, ".github", "FUNDING.yml");
const readmePath = path.join(ROOT, "README.md");
const qrPath = path.join(ROOT, "assets", "upi-qr.png");
const qrPlaceholderPath = path.join(ROOT, "assets", "upi-qr-placeholder.png");

function fail(msg) {
  console.error(`sync-maintainer-info: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(configPath)) fail(`maintainer.config.json not found at ${configPath}`);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const username = (config.githubUsername || "").trim();
const upiId = (config.upiId || "").trim();
const payeeName = (config.upiPayeeName || "Cascade").trim();

if (!username) {
  console.warn("No githubUsername set in maintainer.config.json — leaving the placeholder in place.");
}

// ---- .github/FUNDING.yml ----
if (username) {
  let funding = fs.readFileSync(fundingPath, "utf8");
  funding = funding.replace(/^github:\s*\[.*\]\s*$/m, `github: [${username}]`);
  fs.writeFileSync(fundingPath, funding);
  console.log(`Updated .github/FUNDING.yml -> github: [${username}]`);
}

// ---- README.md ----
let readme = fs.readFileSync(readmePath, "utf8");

function replaceBetween(text, marker, newInner) {
  const re = new RegExp(`(<!-- MAINTAINER:${marker}_START -->)([\\s\\S]*?)(<!-- MAINTAINER:${marker}_END -->)`);
  if (!re.test(text)) {
    console.warn(`Marker MAINTAINER:${marker} not found in README.md — skipping that block.`);
    return text;
  }
  return text.replace(re, `$1\n${newInner}\n$3`);
}

if (username) {
  readme = replaceBetween(
    readme,
    "SPONSORS_LINK",
    `[GitHub Sponsors](https://github.com/sponsors/${username})`
  );
}

if (upiId) {
  // Keep the QR encoding the real ID in sync with the ID text, so they can never drift apart.
  let qrNote = "Scan to pay. Generated automatically from the UPI ID in `maintainer.config.json`.";
  try {
    const QRCode = require("qrcode");
    const upiUri = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&cu=INR`;
    fs.mkdirSync(path.dirname(qrPath), { recursive: true });
    QRCode.toFile(qrPath, upiUri, { errorCorrectionLevel: "M", width: 320, margin: 2 }, (err) => {
      if (err) console.warn("Could not regenerate the UPI QR image:", err.message);
      else console.log(`Regenerated assets/upi-qr.png for ${upiId}`);
    });
  } catch {
    qrNote = "Install the `qrcode` package (`npm i -D qrcode`) to auto-generate the QR, or drop your own PNG at `assets/upi-qr.png`.";
    console.warn("`qrcode` package not installed — UPI ID text updated, but the QR image was not regenerated.");
  }
  readme = replaceBetween(
    readme,
    "UPI",
    `  <p align="center"><img src="assets/upi-qr.png" width="220" alt="UPI QR code"></p>\n\n  \`\`\`\n  UPI ID: ${upiId}\n  \`\`\`\n\n  ${qrNote}`
  );
} else {
  readme = replaceBetween(
    readme,
    "UPI",
    `  Not set up yet. \`upiId\` is empty in \`maintainer.config.json\` — add it there and re-run \`npm run sync:maintainer\` to show a real UPI ID and QR here instead of this line.`
  );
}

fs.writeFileSync(readmePath, readme);
console.log("Updated README.md");

// Clean up the old placeholder image once a real one exists, so nothing stale ships by accident.
if (upiId && fs.existsSync(qrPlaceholderPath)) {
  fs.unlinkSync(qrPlaceholderPath);
  console.log("Removed assets/upi-qr-placeholder.png (replaced by the real QR).");
}
