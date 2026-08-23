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
