#!/usr/bin/env node
/**
 * Generate a 256x256 placeholder icon.ico for electron-builder.
 *
 * Pure Node (zlib + Buffer), no external deps. The icon is a solid gray
 * (#505050) field with a darker border — matches the tray-icon style
 * from main.cjs. Designer can swap in a real asset later by replacing
 * build/icon.ico.
 *
 * Run: node packages/desktop-shell/scripts/gen-placeholder-icon.mjs
 * Output: packages/desktop-shell/build/icon.ico
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '..', 'build', 'icon.ico');

const SIZE = 256;
const FILL_R = 0x50, FILL_G = 0x50, FILL_B = 0x50;
const BORDER_R = 0x20, BORDER_G = 0x20, BORDER_B = 0x20;
const BORDER_PX = 8;

// ---- PNG synthesis ----

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePng() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // raw pixel data with filter byte 0 per row
  const row = Buffer.alloc(1 + SIZE * 4);
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    row[0] = 0;
    for (let x = 0; x < SIZE; x++) {
      const onBorder = x < BORDER_PX || y < BORDER_PX
        || x >= SIZE - BORDER_PX || y >= SIZE - BORDER_PX;
      const r = onBorder ? BORDER_R : FILL_R;
      const g = onBorder ? BORDER_G : FILL_G;
      const b = onBorder ? BORDER_B : FILL_B;
      const idx = 1 + x * 4;
      row[idx] = r; row[idx + 1] = g; row[idx + 2] = b; row[idx + 3] = 0xff;
    }
    row.copy(raw, y * row.length);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO wrap (1 image, PNG-embedded) ----

function wrapIco(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(1, 4);   // count: 1 image

  const entry = Buffer.alloc(16);
  entry[0] = SIZE === 256 ? 0 : SIZE;
  entry[1] = SIZE === 256 ? 0 : SIZE;
  entry[2] = 0;     // palette count
  entry[3] = 0;     // reserved
  entry.writeUInt16LE(1, 4);   // planes
  entry.writeUInt16LE(32, 6);  // bpp
  entry.writeUInt32LE(pngBuf.length, 8);   // image size
  entry.writeUInt32LE(6 + 16, 12);         // image offset

  return Buffer.concat([header, entry, pngBuf]);
}

const png = makePng();
const ico = wrapIco(png);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico);
console.log(`wrote ${out} — ${ico.length} bytes (${SIZE}x${SIZE} placeholder)`);
