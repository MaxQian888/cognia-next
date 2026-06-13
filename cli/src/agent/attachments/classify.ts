/**
 * Classify `@<path>` attachment references by file extension so the build
 * orchestrator can route each to the right handler. The grammar mirrors the
 * image-only extractor it supersedes: an `@` token runs to the next whitespace.
 * A trailing sentence punctuation mark (`.,;:!?`) is naturally excluded because
 * the extension capture only accepts alphanumerics.
 */
import path from "node:path"

export type RefKind = "image" | "pdf" | "rich" | "text" | "unknown"

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])

/** Binary/rich docs that must go through `lib/document` text extraction. */
export const RICH_EXTS = new Set([
  ".docx",
  ".doc",
  ".docm",
  ".xlsx",
  ".xls",
  ".xlsm",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".epub",
  ".rtf",
  ".html",
  ".htm",
])

/** Plain-text & code formats read directly as UTF-8. */
export const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".mdx",
  ".json",
  ".jsonc",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".log",
  ".env",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".css",
  ".scss",
  ".less",
])

/** Any `@token` ending in a `.<alnum>` extension. */
const FILE_REF = /@([^\s]+\.[A-Za-z0-9]+)/g
const SKILL_OR_AGENT = /^(skill|agent):/

export function extractFileRefs(prompt: string): string[] {
  const refs: string[] = []
  for (const m of prompt.matchAll(FILE_REF)) {
    const p = m[1]
    if (SKILL_OR_AGENT.test(p)) continue
    refs.push(p)
  }
  return refs
}

export function classifyRef(ref: string): RefKind {
  const ext = path.extname(ref).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return "image"
  if (ext === ".pdf") return "pdf"
  if (RICH_EXTS.has(ext)) return "rich"
  if (TEXT_EXTS.has(ext)) return "text"
  return "unknown"
}
