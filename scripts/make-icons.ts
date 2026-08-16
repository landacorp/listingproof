/**
 * Icon generator (M8).
 *
 * The extension needs PNG icons at four sizes and the toolchain has no image
 * library, so the mark is drawn analytically and encoded to PNG here with
 * node's zlib. Supersampling at 4x gives the antialiasing a rasteriser would
 * normally provide.
 *
 * The mark is a shield with a checkmark cut out of it. It has to survive being
 * 16 px wide in a browser toolbar, which rules out anything with fine detail —
 * no magnifier, no text, no thin strokes.
 *
 * Run: npx vite-node scripts/make-icons.ts
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, '../public/icon');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

/** Deep indigo: reads as "trust/verification" without being a browser-chrome blue. */
const BACKGROUND: RGB = [37, 42, 92];
const FOREGROUND: RGB = [255, 255, 255];

type RGB = [number, number, number];

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(rgba: Uint8Array, size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 are compression, filter and interlace methods — all 0.

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let i = 0; i < size * 4; i++) raw[rowStart + 1 + i] = rgba[y * size * 4 + i];
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the mark, in normalised 0..1 coordinates -------------------------------

/** Rounded-square app tile, so the icon reads as a solid shape at 16 px. */
function inTile(x: number, y: number): boolean {
  const r = 0.22;
  const dx = Math.max(r - x, 0, x - (1 - r));
  const dy = Math.max(r - y, 0, y - (1 - r));
  return dx * dx + dy * dy <= r * r;
}

/**
 * Shield: straight shoulders down to 55% height, then tapering to a point.
 * The exponent controls how full the taper looks — below ~1.4 it reads as a
 * triangle, above ~2 as a bullet.
 */
function inShield(x: number, y: number): boolean {
  const top = 0.14;
  const bottom = 0.88;
  if (y < top || y > bottom) return false;

  const t = (y - top) / (bottom - top);
  const shoulder = 0.30;
  const halfWidth = t <= 0.5 ? shoulder : shoulder * (1 - Math.pow((t - 0.5) / 0.5, 1.7));
  const dx = Math.abs(x - 0.5);

  // Round the two top corners so the shoulders do not look sheared.
  if (t < 0.12) {
    const r = 0.12;
    const cornerY = top + r * (bottom - top);
    const cornerX = 0.5 + shoulder - r;
    if (dx > cornerX) {
      const ddx = dx - cornerX;
      const ddy = Math.max(cornerY - y, 0);
      return ddx * ddx + ddy * ddy <= r * r;
    }
  }
  return dx <= halfWidth;
}

/** Checkmark stroke, cut out of the shield. */
function inCheck(x: number, y: number): boolean {
  const width = 0.075;
  const segments: Array<[number, number, number, number]> = [
    [0.36, 0.50, 0.46, 0.61],
    [0.46, 0.61, 0.65, 0.39],
  ];
  for (const [x1, y1, x2, y2] of segments) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / (vx * vx + vy * vy)));
    const px = x - (x1 + t * vx);
    const py = y - (y1 + t * vy);
    if (px * px + py * py <= (width / 2) * (width / 2)) return true;
  }
  return false;
}

function renderIcon(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!inTile(x, y)) continue;

          // The checkmark punches back to the tile colour, so the mark stays
          // legible whether the icon sits on a light or a dark toolbar.
          const colour: RGB =
            inShield(x, y) && !inCheck(x, y) ? FOREGROUND : BACKGROUND;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }

      const i = (py * size + px) * 4;
      if (a === 0) continue;
      // Un-premultiply: colour is averaged over covered samples only, alpha
      // over all of them, otherwise edges darken toward black.
      const covered = a / 255;
      out[i] = Math.round(r / covered);
      out[i + 1] = Math.round(g / covered);
      out[i + 2] = Math.round(b / covered);
      out[i + 3] = Math.round(a / samples);
    }
  }
  return out;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const png = encodePng(renderIcon(size), size);
    writeFileSync(join(OUT_DIR, `${size}.png`), png);
    console.log(`icon/${size}.png ${png.length} bytes`);
  }
}

main();
