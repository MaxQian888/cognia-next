// Deterministic ZIP writer for the VSIX package.
//
// `build.mjs` used to shell out to the system `zip`, which is not present on
// every platform the release matrix builds on (GitHub's windows-latest image
// ships 7-Zip, not `zip`) — tolerable while the .vsix was committed, fatal once
// the build has to regenerate it. It also stamped each entry with the current
// mtime, so every rebuild produced a byte-different archive of the same size.
//
// This writes the archive directly: no external binary, and a fixed DOS
// timestamp so the same inputs always yield the same bytes. Files only — no
// directory entries. VSIX readers resolve parts through the central directory,
// and `vsce`'s own packer (yazl) omits them too.

import { crc32, deflateRawSync } from "node:zlib"

/** 1980-01-01 00:00:00, the earliest instant the DOS field can encode. */
const DOS_DATE = 0x0021
const DOS_TIME = 0x0000

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** 2.0 — the version that introduced deflate, which is all this uses. */
const VERSION = 20

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/**
 * Pack `entries` into a ZIP archive.
 *
 * Entry order is preserved rather than sorted: the OPC layout a .vsix follows
 * wants `[Content_Types].xml` written first, and the caller's list is static,
 * so preserving it is both correct and deterministic.
 *
 * @param {ReadonlyArray<{ name: string, data: Buffer }>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  /** @type {Buffer[]} */
  const body = []
  /** @type {Buffer[]} */
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const deflated = deflateRawSync(raw, { level: 9 })
    // Deflate can grow an already-dense or very small part; storing it then
    // costs nothing and keeps the archive honest about its own sizes.
    const compressed = deflated.length < raw.length
    const payload = compressed ? deflated : raw
    const method = compressed ? METHOD_DEFLATE : METHOD_STORE
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(VERSION, 4)
    // Flags stay 0 — in particular never bit 3, because both sizes are known
    // before the entry is written and no data descriptor follows it.
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    body.push(local, name, payload)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(CENTRAL_SIG, 0)
    // "Version made by" claims MS-DOS rather than Unix, so the external
    // attributes carry no permission bits that could vary between machines.
    record.writeUInt16LE(VERSION, 4)
    record.writeUInt16LE(VERSION, 6)
    record.writeUInt16LE(0, 8)
    record.writeUInt16LE(method, 10)
    record.writeUInt16LE(DOS_TIME, 12)
    record.writeUInt16LE(DOS_DATE, 14)
    record.writeUInt32LE(checksum, 16)
    record.writeUInt32LE(payload.length, 20)
    record.writeUInt32LE(raw.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30)
    record.writeUInt16LE(0, 32)
    record.writeUInt16LE(0, 34)
    record.writeUInt16LE(0, 36)
    record.writeUInt32LE(0, 38)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += local.length + name.length + payload.length
  }

  const directory = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...body, directory, eocd])
}
