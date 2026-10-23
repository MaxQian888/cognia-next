/**
 * UTF-8 / UTF-16 coordinate helpers. JS strings are indexed in UTF-16 code
 * units; patch edits and protected-change ranges live in UTF-8 byte space.
 * Only the `TextEncoder` global is used (no node:buffer).
 */
import type { ByteRange } from "./types.ts";

const encoder = new TextEncoder();

/** UTF-8 encoding of `text`. */
export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Length of `text` in UTF-8 bytes. */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * UTF-16 code-unit index → UTF-8 byte offset prefix map. map[i] is the byte
 * offset of code unit i; map[text.length] is the total byte length. The low
 * surrogate of a pair maps to the same offset as its high surrogate.
 */
export function charToByteMap(text: string): Uint32Array {
  const map = new Uint32Array(text.length + 1);
  let byte = 0;
  let i = 0;
  while (i < text.length) {
    map[i] = byte;
    const cp = text.codePointAt(i) as number;
    const u16 = cp > 0xffff ? 2 : 1;
    if (u16 === 2) map[i + 1] = byte;
    byte += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    i += u16;
  }
  map[text.length] = byte;
  return map;
}

/**
 * Convert a UTF-16 [start, end) range of `text` into UTF-8 byte offsets:
 * startByte is the byte length of `text.slice(0, start)`, endByte that of
 * `text.slice(0, end)`.
 */
export function utf16RangeToUtf8(text: string, start: number, end: number): ByteRange {
  const startByte = utf8Bytes(text.slice(0, start)).length;
  return { startByte, endByte: startByte + utf8Bytes(text.slice(start, end)).length };
}
