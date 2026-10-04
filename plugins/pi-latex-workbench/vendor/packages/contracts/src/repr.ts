/**
 * Unified representation helpers (API_CONTRACT §6):
 * - byte offsets are 0-based on UTF-8 bytes
 * - text lines and physical pages are 1-based
 * - timestamps are UTC RFC3339
 * - sha256 is lowercase hex
 * - canonical JSON is the only serialization fed to digest/treeHash
 */
import { createHash } from "node:crypto";
import { WorkbenchError, ERROR_CODES } from "./errors.ts";

const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * True when `offset` is a valid 0-based byte offset that lands on a UTF-8
 * character boundary (start of buffer, end of buffer, or a non-continuation
 * byte). Patch edits require both startByte and endByte to satisfy this.
 */
export function isUtf8Boundary(bytes: Uint8Array, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) {
    return false;
  }
  if (offset === 0 || offset === bytes.length) {
    return true;
  }
  const b = bytes[offset];
  return b !== undefined && (b & 0xc0) !== 0x80;
}

/** UTC RFC3339 timestamp, e.g. 2026-09-21T10:00:00.000Z. */
export function formatUtcRfc3339(date: Date): string {
  return date.toISOString();
}

export function utcNowIso(): string {
  return new Date().toISOString();
}

/**
 * Add seconds to an RFC3339 timestamp, keeping millisecond precision so the
 * result stays lexicographically comparable with utcNowIso() output.
 */
export function addSecondsIso(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export function sha256Hex(data: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof data === "string" ? utf8Bytes(data) : data);
  return hash.digest("hex");
}

export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX_PATTERN.test(value);
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new WorkbenchError(
          ERROR_CODES.INVALID_REQUEST,
          `canonicalJson: non-finite number at ${path}`,
        );
      }
      return;
    case "object": {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          assertJsonValue(value[i], `${path}[${i}]`);
        }
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === undefined) {
          throw new WorkbenchError(
            ERROR_CODES.INVALID_REQUEST,
            `canonicalJson: undefined value at ${path}.${key}`,
          );
        }
        assertJsonValue(child, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `canonicalJson: unsupported ${typeof value} at ${path}`,
      );
  }
}

function canonicalize(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key] as JsonValue);
  }
  return out;
}

/**
 * Deterministic JSON serialization: object keys sorted at every depth,
 * array order preserved, no whitespace. This — and only this — feeds
 * digest/treeHash computation so hashes are stable across producers.
 */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value, "$");
  return JSON.stringify(canonicalize(value));
}

export function digestJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
