import { Gunzip } from "fflate"
import { getFilenameExtension } from "@cognia/document/support-matrix"

export type UploadContentInspectionCode = "malicious_content" | "unsafe_archive" | "type_mismatch"

export class UploadContentInspectionError extends Error {
  constructor(readonly code: UploadContentInspectionCode) {
    super(code)
    this.name = "UploadContentInspectionError"
  }
}

export interface UploadContentInspectionResult {
  mediaType: string
  archive: boolean
}

const MAX_ARCHIVE_ENTRIES = 1_000
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const MAX_ARCHIVE_ENTRY_BYTES = 50 * 1024 * 1024
const MAX_ARCHIVE_COMPRESSION_RATIO = 200
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"

const OOXML_MEDIA_TYPES: Record<string, { directory: string; mediaType: string }> = {
  docx: {
    directory: "word/",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  docm: {
    directory: "word/",
    mediaType: "application/vnd.ms-word.document.macroenabled.12",
  },
  xlsx: {
    directory: "xl/",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  xlsm: {
    directory: "xl/",
    mediaType: "application/vnd.ms-excel.sheet.macroenabled.12",
  },
  pptx: {
    directory: "ppt/",
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  pptm: {
    directory: "ppt/",
    mediaType: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  },
}

const ODF_MEDIA_TYPES: Record<string, string> = {
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
}

const OLE_MEDIA_TYPES: Record<string, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.byteLength && prefix.every((byte, index) => bytes[index] === byte)
}

function containsAscii(bytes: Uint8Array, needle: string): boolean {
  if (needle.length === 0 || bytes.byteLength < needle.length) return false
  const target = new TextEncoder().encode(needle)
  outer: for (let offset = 0; offset <= bytes.byteLength - target.byteLength; offset++) {
    for (let index = 0; index < target.byteLength; index++) {
      if (bytes[offset + index] !== target[index]) continue outer
    }
    return true
  }
  return false
}

function assertNotExecutable(bytes: Uint8Array): void {
  const executable =
    startsWith(bytes, [0x4d, 0x5a]) ||
    startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])
  if (executable || containsAscii(bytes, EICAR)) {
    throw new UploadContentInspectionError("malicious_content")
  }
}

function assertSafeSvg(bytes: Uint8Array): void {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).toLowerCase()
  if (
    /<\s*script\b/.test(text) ||
    /\son[a-z]+\s*=/.test(text) ||
    /(?:href|src)\s*=\s*["']\s*(?:javascript:|data:text\/html)/.test(text) ||
    /<\s*(?:foreignobject|iframe|object|embed)\b/.test(text)
  ) {
    throw new UploadContentInspectionError("malicious_content")
  }
}

interface ZipIndex {
  names: string[]
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557)
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset
    }
  }
  throw new UploadContentInspectionError("unsafe_archive")
}

function inspectZip(bytes: Uint8Array): ZipIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = findEndOfCentralDirectory(bytes)
  const entries = view.getUint16(eocd + 10, true)
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (
    entries === 0xffff ||
    entries > MAX_ARCHIVE_ENTRIES ||
    centralOffset + centralSize > eocd ||
    centralOffset + centralSize > bytes.byteLength
  ) {
    throw new UploadContentInspectionError("unsafe_archive")
  }

  const names: string[] = []
  let totalCompressed = 0
  let totalUncompressed = 0
  let offset = centralOffset
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new UploadContentInspectionError("unsafe_archive")
    }
    const flags = view.getUint16(offset + 8, true)
    const compressed = view.getUint32(offset + 20, true)
    const uncompressed = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if ((flags & 1) !== 0 || next > bytes.byteLength || uncompressed > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new UploadContentInspectionError("unsafe_archive")
    }
    const name = new TextDecoder((flags & 0x800) !== 0 ? "utf-8" : "latin1")
      .decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
      .replaceAll("\\", "/")
    const segments = name.split("/")
    if (name.startsWith("/") || /^[a-z]:\//i.test(name) || segments.includes("..")) {
      throw new UploadContentInspectionError("unsafe_archive")
    }
    names.push(name.toLowerCase())
    totalCompressed += compressed
    totalUncompressed += uncompressed
    if (
      totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES ||
      totalUncompressed / Math.max(1, totalCompressed) > MAX_ARCHIVE_COMPRESSION_RATIO
    ) {
      throw new UploadContentInspectionError("unsafe_archive")
    }
    offset = next
  }
  if (offset !== centralOffset + centralSize) {
    throw new UploadContentInspectionError("unsafe_archive")
  }
  return { names }
}

const TAR_BLOCK = 512

function tarText(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length)
  const end = field.indexOf(0)
  return new TextDecoder("utf-8").decode(end === -1 ? field : field.subarray(0, end))
}

function tarOctal(bytes: Uint8Array, start: number, length: number): number {
  // A leading 0x80 is GNU's base-256 form, only needed past 8 GiB: no entry
  // this inspector accepts is that large.
  if ((bytes[start] ?? 0) & 0x80) throw new UploadContentInspectionError("unsafe_archive")
  const text = tarText(bytes, start, length).trim()
  if (text === "") return 0
  if (!/^[0-7]+$/.test(text)) throw new UploadContentInspectionError("unsafe_archive")
  return Number.parseInt(text, 8)
}

function tarHeaderChecksumOk(header: Uint8Array): boolean {
  let sum = 0
  for (let index = 0; index < TAR_BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0)
  }
  return sum === tarOctal(header, 148, 8)
}

/** `path` and `linkpath` from a pax extended header. */
function paxRecords(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {}
  const text = new TextDecoder("utf-8").decode(data)
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(" ", offset)
    if (space === -1) break
    const length = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) {
      throw new UploadContentInspectionError("unsafe_archive")
    }
    const record = text.slice(space + 1, offset + length - 1)
    const equals = record.indexOf("=")
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return records
}

/** Relative, without `..`, and (for a link target) not leading out of the archive. */
function assertTarPathInside(path: string, linkTarget?: string): void {
  const normalized = path.replaceAll("\\", "/")
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".")
  if (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    segments.includes("..") ||
    segments.length === 0
  ) {
    throw new UploadContentInspectionError("unsafe_archive")
  }
  if (linkTarget === undefined) return
  const target = linkTarget.replaceAll("\\", "/")
  if (target.startsWith("/") || /^[a-z]:\//i.test(target)) {
    throw new UploadContentInspectionError("unsafe_archive")
  }
  let depth = segments.length - 1
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue
    depth += segment === ".." ? -1 : 1
    if (depth < 0) throw new UploadContentInspectionError("unsafe_archive")
  }
}

/**
 * Walk a tar archive's headers: regular files, folders and symlinks that stay
 * inside it only, within the same entry, size and per-entry caps as a zip.
 * Pax and GNU long-name records are read for the names they carry.
 */
export function inspectTar(bytes: Uint8Array): { names: string[] } {
  const names: string[] = []
  let total = 0
  let offset = 0
  let pending: { path?: string; linkpath?: string } = {}
  while (offset + TAR_BLOCK <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK)
    if (header.every((byte) => byte === 0)) return { names }
    if (!tarHeaderChecksumOk(header)) throw new UploadContentInspectionError("unsafe_archive")
    const size = tarOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + TAR_BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > bytes.byteLength) throw new UploadContentInspectionError("unsafe_archive")
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK

    if (type === "x" || type === "L" || type === "K") {
      if (size > 1024 * 1024) throw new UploadContentInspectionError("unsafe_archive")
      const data = bytes.subarray(dataStart, dataEnd)
      if (type === "x") {
        const records = paxRecords(data)
        pending = {
          ...pending,
          ...(records.path !== undefined ? { path: records.path } : {}),
          ...(records.linkpath !== undefined ? { linkpath: records.linkpath } : {}),
        }
      } else {
        const text = tarText(data, 0, data.byteLength)
        pending = type === "L" ? { ...pending, path: text } : { ...pending, linkpath: text }
      }
      continue
    }
    // A global pax header changes defaults, never a name.
    if (type === "g") continue

    const prefix = tarText(header, 345, 155)
    const headerName = tarText(header, 0, 100)
    const name = pending.path ?? (prefix ? `${prefix}/${headerName}` : headerName)
    const linkName = pending.linkpath ?? tarText(header, 157, 100)
    pending = {}
    if (type === "0" || type === "\0" || type === "7") {
      assertTarPathInside(name)
      if (size > MAX_ARCHIVE_ENTRY_BYTES) throw new UploadContentInspectionError("unsafe_archive")
      total += size
    } else if (type === "5") {
      assertTarPathInside(name)
    } else if (type === "2") {
      assertTarPathInside(name, linkName)
    } else {
      // Hard links, devices and FIFOs: nothing an upload needs, and each can
      // turn an unpack into a write somewhere else.
      throw new UploadContentInspectionError("unsafe_archive")
    }
    names.push(name.toLowerCase())
    if (names.length > MAX_ARCHIVE_ENTRIES || total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new UploadContentInspectionError("unsafe_archive")
    }
  }
  // Ran out of bytes without the two zero blocks that end an archive.
  if (offset !== bytes.byteLength || names.length === 0) {
    throw new UploadContentInspectionError("unsafe_archive")
  }
  return { names }
}

/** Inflate a gzip stream, refusing past the archive cap as it goes. */
function gunzipCapped(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const gunzip = new Gunzip((chunk) => {
    total += chunk.byteLength
    if (total > MAX_ARCHIVE_UNCOMPRESSED_BYTES + 1024 * 1024) {
      throw new UploadContentInspectionError("unsafe_archive")
    }
    chunks.push(chunk)
  })
  try {
    const step = 64 * 1024
    for (let start = 0; start < bytes.byteLength; start += step) {
      const end = Math.min(bytes.byteLength, start + step)
      gunzip.push(bytes.subarray(start, end), end === bytes.byteLength)
    }
  } catch (error) {
    if (error instanceof UploadContentInspectionError) throw error
    throw new UploadContentInspectionError("unsafe_archive")
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

function isTarName(name: string): boolean {
  return /\.tar$/i.test(name)
}

function isGzippedTarName(name: string): boolean {
  return /\.(tgz|tar\.gz)$/i.test(name)
}

function hasUstarMagic(bytes: Uint8Array): boolean {
  return tarText(bytes, 257, 5) === "ustar"
}

function mediaTypeForZip(name: string, names: readonly string[]): string {
  if (names.some((entry) => entry.endsWith("vbaproject.bin"))) {
    throw new UploadContentInspectionError("malicious_content")
  }
  const extension = getFilenameExtension(name)
  const ooxml = OOXML_MEDIA_TYPES[extension]
  if (ooxml) {
    if (
      !names.includes("[content_types].xml") ||
      !names.some((entry) => entry.startsWith(ooxml.directory))
    ) {
      throw new UploadContentInspectionError("type_mismatch")
    }
    return ooxml.mediaType
  }
  const odf = ODF_MEDIA_TYPES[extension]
  if (odf) {
    const required = extension === "epub" ? "meta-inf/container.xml" : "meta-inf/manifest.xml"
    if (!names.includes("mimetype") || !names.includes(required)) {
      throw new UploadContentInspectionError("type_mismatch")
    }
    return odf
  }
  throw new UploadContentInspectionError("type_mismatch")
}

export function inspectUploadContent(input: {
  name: string
  declaredMediaType: string
  bytes: Uint8Array
}): UploadContentInspectionResult {
  assertNotExecutable(input.bytes)
  const extension = getFilenameExtension(input.name)

  if (input.declaredMediaType === "image/svg+xml" || extension === "svg") {
    assertSafeSvg(input.bytes)
    return { mediaType: "image/svg+xml", archive: false }
  }
  if (startsWith(input.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    if (extension !== "pdf") throw new UploadContentInspectionError("type_mismatch")
    return { mediaType: "application/pdf", archive: false }
  }
  if (extension === "pdf") throw new UploadContentInspectionError("type_mismatch")

  if (startsWith(input.bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const index = inspectZip(input.bytes)
    return { mediaType: mediaTypeForZip(input.name, index.names), archive: true }
  }
  if (OOXML_MEDIA_TYPES[extension] || ODF_MEDIA_TYPES[extension]) {
    throw new UploadContentInspectionError("type_mismatch")
  }

  // Tar, plain or gzipped (ADR-0224 A11b): checked like a zip, entry by entry.
  if (isGzippedTarName(input.name)) {
    if (!startsWith(input.bytes, [0x1f, 0x8b])) {
      throw new UploadContentInspectionError("type_mismatch")
    }
    inspectTar(gunzipCapped(input.bytes))
    return { mediaType: "application/gzip", archive: true }
  }
  if (isTarName(input.name) || hasUstarMagic(input.bytes)) {
    if (!isTarName(input.name) || !hasUstarMagic(input.bytes)) {
      throw new UploadContentInspectionError("type_mismatch")
    }
    inspectTar(input.bytes)
    return { mediaType: "application/x-tar", archive: true }
  }

  const oleType = OLE_MEDIA_TYPES[extension]
  if (oleType) {
    if (!startsWith(input.bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      throw new UploadContentInspectionError("type_mismatch")
    }
    return { mediaType: oleType, archive: false }
  }
  if (extension === "rtf") {
    if (!startsWith(input.bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) {
      throw new UploadContentInspectionError("type_mismatch")
    }
    return { mediaType: "application/rtf", archive: false }
  }

  return { mediaType: input.declaredMediaType || "application/octet-stream", archive: false }
}
