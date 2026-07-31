// Shared extension → MIME mapping for built-in tools.
//
// Extracted from file-extras.mjs (used by file_info). Broad map covering text,
// code, image, and archive types; unknown extensions fall back to
// application/octet-stream. Distinct from core/read-media.mjs's IMAGE_MIME,
// which is an intentional vision-support whitelist (a different concern).

import path from "node:path"

export const MIME_BY_EXT = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".json", "application/json"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".ts", "text/typescript"],
  [".tsx", "text/typescript"],
  [".jsx", "text/javascript"],
  [".html", "text/html"],
  [".css", "text/css"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".pdf", "application/pdf"],
  [".zip", "application/zip"],
  [".tar", "application/x-tar"],
  [".gz", "application/gzip"],
  [".wasm", "application/wasm"],
  [".rs", "text/rust"],
  [".go", "text/x-go"],
  [".py", "text/x-python"],
  [".rb", "text/x-ruby"],
  [".java", "text/x-java"],
  [".c", "text/x-c"],
  [".h", "text/x-c"],
  [".cpp", "text/x-c++"],
  [".hpp", "text/x-c++"],
  [".sh", "application/x-sh"],
  [".toml", "application/toml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
])

/**
 * Best-effort MIME type for a path by extension.
 *
 * @param {string} p
 * @returns {string} The mapped MIME, or `application/octet-stream`.
 */
export function mimeForPath(p) {
  const ext = path.extname(p).toLowerCase()
  return MIME_BY_EXT.get(ext) ?? "application/octet-stream"
}
