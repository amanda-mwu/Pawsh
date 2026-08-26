import { deflateSync } from "node:zlib";

/**
 * Builders for real, decodable image files.
 *
 * These are constructed rather than checked in as binaries so that what each test hands the
 * parser is visible in source. They are genuinely complete files — a browser can decode them —
 * which matters because Pawsh refuses truncated uploads and the tests have to be able to tell
 * the difference between "header looks right" and "this is an image".
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A complete 8-bit greyscale PNG of the requested size, every pixel black. */
export function decodablePng(width = 640, height = 480): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 0;   // colour type: greyscale
  // Each scanline is a filter byte followed by one byte per pixel; zeroes throughout.
  const raw = Buffer.alloc(height * (width + 1));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/**
 * A JPEG whose frame header declares the requested size and which terminates properly.
 *
 * The entropy-coded data is not a real scan — nothing in Pawsh decodes it — but the marker
 * structure the parser walks is genuine, including the end-of-image marker it now requires.
 */
export function jpegHeader(width = 800, height = 600, { marker = 0xc0 } = {}): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const frame = [
    0xff, marker, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    ...new Array(8).fill(0)
  ];
  return Buffer.from([0xff, 0xd8, ...app0, ...frame, 0xff, 0xd9]);
}
