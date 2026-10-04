/**
 * Deterministic ZIP writer/reader for release packaging (M4).
 *
 * Writer: STORED (no compression) entries, sorted by name, fixed DOS epoch
 * timestamp (1980-01-01), no extra fields, no comments, UTF-8 flag set.
 * Identical input → byte-identical archive, which is what makes the staged
 * source-zip sha256 meaningful as a release artifact.
 *
 * Reader: parses the central directory (EOCD scan), supports method 0
 * (stored) and 8 (deflate). Entry names are validated against archive-slip
 * at read time — the reader is used on whitelisted archives we produced, but
 * it still refuses absolute/parent-escaping names rather than trusting.
 */
import { inflateRawSync } from "node:zlib";
import { ERROR_CODES, WorkbenchError } from "@latexwb/contracts";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fixed DOS timestamp: 1980-01-01 00:00:00 (the zeroed ZIP epoch). */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // year=1980, month=1, day=1

export interface ZipEntryInput {
  /** Archive-relative POSIX path; validated against slip/escapes. */
  name: string;
  data: Buffer;
}

function validateEntryName(name: string): void {
  if (
    name.length === 0 ||
    name.length > 1024 ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.includes("\\") ||
    name.split("/").some((seg) => seg === ".." || seg === "" || seg === ".") ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(name)
  ) {
    throw new WorkbenchError(
      ERROR_CODES.INVALID_REQUEST,
      `zip entry name is not a safe relative POSIX path: ${JSON.stringify(name)}`,
    );
  }
}

/** Write a deterministic STORED zip. Entry order is normalized by name. */
export function writeDeterministicZip(entries: ZipEntryInput[]): Buffer {
  const normalized = [...entries]
    .map((e) => {
      validateEntryName(e.name);
      return e;
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of normalized) {
    if (seen.has(entry.name)) {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_REQUEST,
        `duplicate zip entry ${entry.name}`,
      );
    }
    seen.add(entry.name);
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORED
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra
    localParts.push(local, nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); // STORED
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += 30 + nameBytes.length + entry.data.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(normalized.length, 8);
  eocd.writeUInt16LE(normalized.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, eocd]);
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Read a zip (STORED or DEFLATE entries) via the central directory. */
export function readZip(archive: Buffer): ZipEntry[] {
  // Locate EOCD: scan backwards for the signature (comment length varies).
  let eocd = -1;
  for (let i = archive.length - 22; i >= 0 && i >= archive.length - 22 - 0xffff; i -= 1) {
    if (archive.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new WorkbenchError(ERROR_CODES.INVALID_ARTIFACT, "not a zip archive (no EOCD)");
  }
  const count = archive.readUInt16LE(eocd + 10);
  const cdSize = archive.readUInt32LE(eocd + 12);
  const cdOffset = archive.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > archive.length) {
    throw new WorkbenchError(ERROR_CODES.INVALID_ARTIFACT, "zip central directory out of bounds");
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > archive.length || archive.readUInt32LE(p) !== 0x02014b50) {
      throw new WorkbenchError(ERROR_CODES.INVALID_ARTIFACT, "zip central directory truncated");
    }
    const method = archive.readUInt16LE(p + 10);
    const compSize = archive.readUInt32LE(p + 20);
    const nameLen = archive.readUInt16LE(p + 28);
    const extraLen = archive.readUInt16LE(p + 30);
    const commentLen = archive.readUInt16LE(p + 32);
    const localOffset = archive.readUInt32LE(p + 42);
    const name = archive.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    validateEntryName(name);

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new WorkbenchError(ERROR_CODES.INVALID_ARTIFACT, `zip local header missing for ${name}`);
    }
    const lNameLen = archive.readUInt16LE(localOffset + 26);
    const lExtraLen = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = archive.subarray(dataStart, dataStart + compSize);
    if (raw.length !== compSize) {
      throw new WorkbenchError(ERROR_CODES.INVALID_ARTIFACT, `zip data truncated for ${name}`);
    }
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new WorkbenchError(
        ERROR_CODES.INVALID_ARTIFACT,
        `zip entry ${name} uses unsupported compression method ${method}`,
      );
    }
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
