/**
 * `/view <path>` controller — read a file from disk and open it in the scrollable
 * {@link DocumentViewer}. Markdown files render through the markdown tokenizer;
 * everything else renders as syntax-highlighted text (language inferred from the
 * extension). Also the selection target the skill bundled-file browser chains
 * into (`/skill files` → `/view <abspath>`).
 *
 * Pure + fs-injected: the read + cwd are dependencies so the path resolution and
 * format detection are unit-tested without touching the real filesystem.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import { errorMessage, openDocument } from "./shared"
import type { DocumentFormat, TuiAction } from "../state/types"

export interface ViewDeps {
  dispatch: (action: TuiAction) => void
  /** Working directory relative paths resolve against. */
  cwd: string
  /** File reader; defaults to the real filesystem. Injected in tests. */
  readFile?: (absPath: string) => Promise<string>
  /** Max bytes to render before truncating (guards the pager on huge files). */
  maxBytes?: number
}

/** Extension → highlight.js language id for the text viewer. */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  rs: "rust",
  py: "python",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  xml: "xml",
}

/** Markdown extensions render through the markdown tokenizer (not as text). */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"])

export interface DetectedFormat {
  format: DocumentFormat
  lang?: string
}

/** Decide how to render a file from its extension. */
export function detectFormat(filePath: string): DetectedFormat {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (MARKDOWN_EXTS.has(ext)) return { format: "markdown" }
  const lang = LANG_BY_EXT[ext]
  return { format: "text", ...(lang ? { lang } : {}) }
}

const DEFAULT_MAX_BYTES = 256 * 1024

/** Read a file and open it in the document viewer. */
export async function viewFile(arg: string, deps: ViewDeps): Promise<void> {
  const target = arg.trim()
  if (!target) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /view <path>" })
    return
  }
  const absPath = path.isAbsolute(target) ? target : path.resolve(deps.cwd, target)
  const read = deps.readFile ?? ((p: string) => nodeFs.readFile(p, "utf8"))
  let content: string
  try {
    content = await read(absPath)
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Cannot read ${target}: ${errorMessage(err)}` })
    return
  }

  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  let body = content
  let truncatedNote = ""
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    body = content.slice(0, maxBytes)
    truncatedNote = `\n\n… (truncated at ${Math.round(maxBytes / 1024)} KB)`
  }

  const { format, lang } = detectFormat(absPath)
  const title = path.relative(deps.cwd, absPath) || path.basename(absPath)
  openDocument(deps.dispatch, {
    title,
    body: body + truncatedNote,
    format,
    ...(lang ? { lang } : {}),
  })
}
