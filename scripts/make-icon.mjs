import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { deflateSync } from "zlib";

/**
 * Erzeugt desktop/build/icon.icns ohne externe Bildbibliotheken:
 * PNG wird direkt kodiert, die Größenvarianten macht sips, das Bündeln iconutil.
 *
 * Motiv: blaue Squircle-Fläche, Play-Dreieck (Video) über drei Untertitel-Balken.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(ROOT, "desktop", "build");
const SIZE = 1024;
const SS = 2; // 2x Supersampling für weiche Kanten

// ── Geometrie-Helfer (Abdeckung 0..1 je Subpixel) ───────────

const roundedRect = (x, y, cx, cy, w, h, r) => {
  const dx = Math.abs(x - cx) - (w / 2 - r);
  const dy = Math.abs(y - cy) - (h / 2 - r);
  if (dx <= 0 || dy <= 0) return Math.abs(x - cx) <= w / 2 && Math.abs(y - cy) <= h / 2;
  return Math.hypot(dx, dy) <= r;
};

const triangle = (x, y, ax, ay, bx, by, cx2, cy2) => {
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = sign(x, y, ax, ay, bx, by);
  const d2 = sign(x, y, bx, by, cx2, cy2);
  const d3 = sign(x, y, cx2, cy2, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};

// ── Bild rendern ────────────────────────────────────────────

const W = SIZE * SS;
const px = new Uint8Array(W * W * 4);

const TOP = [59, 130, 246];   // blue-500
const BOT = [29, 78, 216];    // blue-700

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const ux = x / SS;
    const uy = y / SS;

    // Squircle-Hintergrund
    if (!roundedRect(ux, uy, 512, 512, 832, 832, 190)) continue;

    const t = uy / SIZE;
    px[i] = Math.round(TOP[0] + (BOT[0] - TOP[0]) * t);
    px[i + 1] = Math.round(TOP[1] + (BOT[1] - TOP[1]) * t);
    px[i + 2] = Math.round(TOP[2] + (BOT[2] - TOP[2]) * t);
    px[i + 3] = 255;

    // Play-Dreieck
    const inPlay = triangle(ux, uy, 430, 285, 430, 525, 640, 405);
    // Untertitel-Balken
    const inBars =
      roundedRect(ux, uy, 512, 660, 460, 62, 31) ||
      roundedRect(ux, uy, 448, 772, 332, 62, 31);

    if (inPlay || inBars) {
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
    }
  }
}

// ── Auf Zielgröße mitteln (Anti-Aliasing) ───────────────────

const out = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  out[o++] = 0; // Filter: None
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3];
      }
    }
    const n = SS * SS;
    out[o++] = Math.round(r / n);
    out[o++] = Math.round(g / n);
    out[o++] = Math.round(b / n);
    out[o++] = Math.round(a / n);
  }
}

// ── PNG schreiben ───────────────────────────────────────────

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(out, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(BUILD_DIR, { recursive: true });
const master = join(BUILD_DIR, "icon.png");
writeFileSync(master, png);

// ── .iconset → .icns ────────────────────────────────────────

const iconset = join(BUILD_DIR, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const variants = [
  [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"],
];

for (const [size, name] of variants) {
  execFileSync("sips", ["-z", String(size), String(size), master, "--out", join(iconset, name)], {
    stdio: "ignore",
  });
}

execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(BUILD_DIR, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });

console.log(`🎨 App-Icon erzeugt: ${join(BUILD_DIR, "icon.icns")}`);
