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

/**
 * Two accepted reference forms:
 *
 *   - `@path/to/file.png` — the bare form. Requires a `.<alnum>` extension,
 *     because without one every `@mention` in ordinary prose would be read as a
 *     file. Cannot express a path containing a space.
 *   - `@"path/to/file"` — the quoted form. Delimited, so it needs no extension
 *     heuristic and accepts spaces. This is what the SDK emits for structured
 *     attachments, where the path is data rather than something a human typed.
 *
 * The bare form is listed first and matched first, so existing prompts are
 * unaffected. "Screen Shot 2026-01-01 at 10.14.32.png" and extension-less files
 * like `Makefile` are reachable only through the quoted form.
 */
const FILE_REF = /@"([^"\n]+)"|@([^\s"]+\.[A-Za-z0-9]+)/g
const SKILL_OR_AGENT = /^(skill|agent):/

export function extractFileRefs(prompt: string): string[] {
  const refs: string[] = []
  for (const m of prompt.matchAll(FILE_REF)) {
    // Exactly one alternative matched, so exactly one group is filled: the
    // quoted form fills group 1, the bare form group 2.
    const p = (m[1] ?? m[2] ?? "").trim()
    // Reachable via `@"   "` — quoted whitespace is a ref to nothing.
    if (!p || SKILL_OR_AGENT.test(p)) continue
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
