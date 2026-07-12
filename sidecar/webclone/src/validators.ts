import { extname } from "node:path"
import { type Asset, type SnapshotOptions } from "./types.js"

const MAGIC_BYTES: Record<string, number[]> = {
  ".png": [0x89, 0x50, 0x4e, 0x47],
  ".jpg": [0xff, 0xd8, 0xff],
  ".jpeg": [0xff, 0xd8, 0xff],
  ".gif": [0x47, 0x49, 0x46],
  ".webp": [0x52, 0x49, 0x46, 0x46],
  ".wasm": [0x00, 0x61, 0x73, 0x6d],
  ".woff": [0x77, 0x4f, 0x46, 0x46],
  ".woff2": [0x77, 0x4f, 0x46, 0x32],
  ".ktx": [0xab, 0x4b, 0x54, 0x58],
  ".ktx2": [0xab, 0x4b, 0x54, 0x58],
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"])

const TEXT_EXTS = new Set([".html", ".js", ".mjs", ".css", ".svg", ".txt"])

export function isHtmlLike(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 256).toString("utf8").trimStart().toLowerCase()
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<title>")
}

export function hasExpectedMagic(filePath: string, buffer: Buffer): boolean {
  const ext = extname(filePath).toLowerCase()
  const magic = MAGIC_BYTES[ext]
  if (!magic) return true
  if (buffer.length < magic.length) return false
  return magic.every((byte, index) => buffer[index] === byte)
}

export function isValidCachedResponse(
  filePath: string,
  contentType: string,
  buffer: Buffer
): boolean {
  const ext = extname(filePath).toLowerCase()
  const ct = contentType.toLowerCase()

  if (isHtmlLike(buffer) && ext !== ".html" && ext !== "") {
    return false
  }

  if (ext === ".json") {
    try {
      JSON.parse(buffer.toString("utf8"))
      return true
    } catch {
      return false
    }
  }

  if (ext === ".js" || ext === ".mjs") {
    return !ct.includes("text/html")
  }

  if (IMAGE_EXTS.has(ext) && ct.startsWith("image/")) {
    return true
  }

  if (TEXT_EXTS.has(ext)) {
    return true
  }

  return hasExpectedMagic(filePath, buffer)
}

export function mimeFromExt(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".wasm": "application/wasm",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".otf": "font/opentype",
    ".ttf": "font/ttf",
    ".bin": "application/octet-stream",
    ".zip": "application/zip",
  }
  return map[ext] || "application/octet-stream"
}

const DEFAULT_SKIP_EXTENSIONS: string[] = [
  ".zip",
  ".rar",
  ".7z",
  ".tar",
  ".gz",
  ".bz2",
  ".exe",
  ".msi",
  ".dmg",
  ".apk",
  ".deb",
  ".rpm",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".ts",
  ".m3u8",
  ".m4v",
  ".mkv",
  ".avi",
  ".mov",
  ".flv",
  ".mp3",
  ".aac",
  ".flac",
  ".ogg",
  ".wma",
  ".wav",
  ".mp4",
  ".webm",
  ".iso",
  ".torrent",
  ".wasm",
  ".bin",
]

function normalizeExt(ext: string): string {
  const e = ext.startsWith(".") ? ext : "." + ext
  return e.toLowerCase()
}

export function getSkipExtensions(custom?: string[]): string[] {
  if (custom && custom.length > 0) {
    return custom.map(normalizeExt)
  }
  return DEFAULT_SKIP_EXTENSIONS
}

export function shouldSkipByExtension(url: string, skipExts: string[]): boolean {
  if (!skipExts || skipExts.length === 0) return false
  try {
    const pathname = new URL(url).pathname
    const ext = extname(pathname).toLowerCase()
    return ext.length > 0 && skipExts.includes(ext)
  } catch {
    return false
  }
}

export interface SkipResult {
  skip: boolean
  reason?: string
}

export function checkResourceFilter(refUrl: string, options: SnapshotOptions): SkipResult {
  const skipExts = getSkipExtensions(options.skipExtensions)
  if (shouldSkipByExtension(refUrl, skipExts)) {
    const ext = extname(new URL(refUrl).pathname).toLowerCase()
    return { skip: true, reason: `Skipped by extension: ${ext}` }
  }

  // Note: maxFileSize is checked during download (fetchWithTimeout) via Content-Length and stream size validation
  // This pre-filter cannot reliably check size without making a HEAD request, so we keep it in the fetch layer.
  // However, we explicitly document this behavior for clarity.
  if (options.maxFileSize === 0) {
    // Explicit: no size limit
    return { skip: false }
  }

  return { skip: false }
}

export const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB

export function isOverMaxFileSize(size: number, options: SnapshotOptions): boolean {
  const limit = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  return limit > 0 && size > limit
}

export function postDownloadValidation(assets: Asset[]): Array<{ url: string; error: string }> {
  const failures: Array<{ url: string; error: string }> = []

  for (const a of assets) {
    if (a.status !== "fetched") continue

    // Check for zero-length or generic binary responses
    if (a.size === 0 && a.mime === "application/octet-stream") {
      failures.push({ url: a.originUrl, error: "Zero-length or generic octet-stream response" })
    }
  }

  return failures
}
