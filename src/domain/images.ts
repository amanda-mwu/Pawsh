/**
 * Structural validation for uploaded photographs.
 *
 * Pawsh has no malware scanner wired up, so nothing here should be read as one. What this does
 * is refuse to accept bytes whose declared type is not what they actually are: the browser's
 * multipart `mimetype` is client-supplied and worth nothing, and these bytes are later served
 * back to a browser inline so an `<img>` can show them.
 *
 * Reading the dimensions out of the header is the check, not a bonus. Anything that survives it
 * has a real, parseable image header of the type it claims — a stronger statement than matching
 * four magic bytes and hoping.
 */

export const supportedPhotoContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoContentType = typeof supportedPhotoContentTypes[number];

export interface PhotoShape {
  contentType: PhotoContentType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.byteLength < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + length));
}

function readPng(bytes: Uint8Array): PhotoShape | null {
  // The IHDR chunk is mandatory and must come first, so its position is fixed.
  if (!matches(bytes, 0, PNG_SIGNATURE)) return null;
  if (bytes.byteLength < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { contentType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpeg(bytes: Uint8Array): PhotoShape | null {
  if (!matches(bytes, 0, [0xff, 0xd8])) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Walk the marker segments to the frame header. Dimensions live in SOFn, and which SOFn it is
  // depends on the encoding, so the scan looks for the family rather than one marker.
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Padding and standalone markers carry no length field.
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 > bytes.byteLength) return null;
      return {
        contentType: "image/jpeg",
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7)
      };
    }
    // Start of scan: the entropy-coded data follows and there is no frame header after it.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

function readWebp(bytes: Uint8Array): PhotoShape | null {
  if (bytes.byteLength < 30) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (chunk === "VP8 ") {
    // Lossy: a 3-byte start code follows the frame tag, then 14-bit dimensions.
    if (!matches(bytes, 23, [0x9d, 0x01, 0x2a])) return null;
    return {
      contentType: "image/webp",
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff
    };
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const packed = view.getUint32(21, true);
    return {
      contentType: "image/webp",
      width: (packed & 0x3fff) + 1,
      height: ((packed >> 14) & 0x3fff) + 1
    };
  }
  if (chunk === "VP8X") {
    // Extended: canvas size is stored minus one, little-endian, across three bytes each.
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { contentType: "image/webp", width, height };
  }
  return null;
}

export const maxPhotoBytes = 8 * 1024 * 1024;
// Well above any camera output that matters and far below anything that would make a decoder
// allocate absurdly. A 30000×30000 "image" is a decompression bomb, not a photo of a dog.
export const maxPhotoDimension = 12_000;

/**
 * Whether the file ends the way its format says it must.
 *
 * A readable header is not the same as a complete file, and the realistic failure is a phone
 * losing its connection mid-upload. Storing the truncated result would put a permanently broken
 * thumbnail in the appointment, so the terminator is checked the same way PDF uploads check for
 * `%%EOF`. WebP is exempt: RIFF carries its payload length up front, which `readWebp` has
 * already had to agree with.
 */
function complete(bytes: Uint8Array, shape: PhotoShape): boolean {
  if (shape.contentType === "image/png") {
    // IEND is the final chunk and its content is empty, so the last eight bytes are fixed.
    return matches(bytes, bytes.byteLength - 8, [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44])
      || matches(bytes, bytes.byteLength - 12, [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44]);
  }
  if (shape.contentType === "image/jpeg") {
    // Some encoders pad after the end-of-image marker, so it is looked for near the tail rather
    // than required to be the final two bytes exactly.
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - 64));
    for (let index = 0; index + 1 < tail.byteLength; index += 1) {
      if (tail[index] === 0xff && tail[index + 1] === 0xd9) return true;
    }
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // RIFF size counts everything after the first eight bytes.
  return view.getUint32(4, true) + 8 <= bytes.byteLength;
}

/**
 * Identify an uploaded photograph, or return null if the bytes are not a supported image.
 *
 * Callers must use the returned `contentType` rather than the one the client sent.
 */
export function readPhotoShape(bytes: Uint8Array): PhotoShape | null {
  if (bytes.byteLength === 0 || bytes.byteLength > maxPhotoBytes) return null;
  const shape = readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
  if (!shape) return null;
  if (shape.width <= 0 || shape.height <= 0) return null;
  if (shape.width > maxPhotoDimension || shape.height > maxPhotoDimension) return null;
  if (!complete(bytes, shape)) return null;
  return shape;
}

const PHOTO_EXTENSIONS: Record<PhotoContentType, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};

/**
 * A display-safe filename for a photograph.
 *
 * The extension comes from the sniffed type, never from what was uploaded: a file named
 * `cute.png` whose bytes are a JPEG should not keep advertising itself as a PNG.
 */
export function safePhotoFilename(value: string, contentType: PhotoContentType): string {
  const normalized = [...String(value).normalize("NFC")]
    .map((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      || character === "\\" || character === "/" ? " " : character)
    .join("").trim();
  const withoutExtension = normalized.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  // Separators became spaces above, so `../../etc/passwd` arrives as `.. .. etc passwd`. The
  // leading run is stripped rather than kept: it is meaningless as a label and reads as an
  // attempted path to anyone who sees it in the interface.
  const collapsed = withoutExtension.replace(/\s+/g, " ").replace(/^[. ]+/, "");
  const bounded = collapsed.slice(0, 120).trim().replace(/[. ]+$/g, "");
  const base = bounded || "photo";
  return `${base}${PHOTO_EXTENSIONS[contentType]}`;
}
