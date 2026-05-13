#!/usr/bin/env node
/**
 * Generate a placeholder icon.icns for electron-builder mac builds.
 *
 * Pure Node (zlib + Buffer), no external deps.
 * Produces a valid Apple Icon Image (.icns) with:
 *   - ic08  = 256x256 PNG
 *   - ic09  = 512x512 PNG
 * Both images are the same solid gray (#505050) with darker border,
 * matching the existing icon.ico style.
 *
 * Run: node packages/desktop-shell/scripts/gen-placeholder-icns.mjs
 * Output: packages/desktop-shell/build/icon.icns
 *
 * ICNS format reference:
 *   https://en.wikipedia.org/wiki/Apple_Icon_Image_format
 *   Magic: 'icns' (4 bytes)
 *   File length: UInt32BE (4 bytes)
 *   Repeated blocks: OSType (4 bytes) + block length UInt32BE (4 bytes) + data
 *   Block length includes the 8-byte header.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'build', 'icon.icns');

const FILL_R = 0x50, FILL_G = 0x50, FILL_B = 0x50;
const BORDER_R = 0x20, BORDER_G = 0x20, BORDER_B = 0x20;
const BORDER_PX = 10;

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

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rowBytes = 1 + size * 4;
  const row = Buffer.alloc(rowBytes);
  const raw = Buffer.alloc(size * rowBytes);
  for (let y = 0; y < size; y++) {
    row[0] = 0; // filter type None
    for (let x = 0; x < size; x++) {
      const onBorder = x < BORDER_PX || y < BORDER_PX
        || x >= size - BORDER_PX || y >= size - BORDER_PX;
      const r = onBorder ? BORDER_R : FILL_R;
      const g = onBorder ? BORDER_G : FILL_G;
      const b = onBorder ? BORDER_B : FILL_B;
      const idx = 1 + x * 4;
      row[idx] = r; row[idx + 1] = g; row[idx + 2] = b; row[idx + 3] = 0xff;
    }
    row.copy(raw, y * rowBytes);
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICNS assembly ----

function icnsBlock(osType, data) {
  // block length includes the 8-byte header (4 type + 4 length)
  const header = Buffer.alloc(8);
  Buffer.from(osType, 'ascii').copy(header, 0);
  header.writeUInt32BE(8 + data.length, 4);
  return Buffer.concat([header, data]);
}

const png256 = makePng(256);
const png512 = makePng(512);

const block256 = icnsBlock('ic08', png256); // ic08 = 256x256 PNG/JPEG2000
const block512 = icnsBlock('ic09', png512); // ic09 = 512x512 PNG/JPEG2000

const bodyLen = block256.length + block512.length;
const fileLen = 8 + bodyLen; // 4 magic + 4 file-length + blocks

const header = Buffer.alloc(8);
Buffer.from('icns', 'ascii').copy(header, 0);
header.writeUInt32BE(fileLen, 4);

const icns = Buffer.concat([header, block256, block512]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, icns);
console.log(`wrote ${OUT} — ${icns.length} bytes (256x256 + 512x512 placeholder)`);
