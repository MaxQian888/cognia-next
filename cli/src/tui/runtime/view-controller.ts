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
import { constants } from "node:fs"
import { homedir } from "node:os"
import { StringDecoder } from "node:string_decoder"
import { createCliTranslator, type CliLocale } from "../i18n"
import path from "node:path"

import { errorMessage, openDocument } from "./shared"
import { langFromPath } from "../markdown/highlight"
import type { DocumentFormat, TuiAction } from "../state/types"

export interface ViewDeps {
  dispatch: (action: TuiAction) => void
  /** Working directory relative paths resolve against. */
  cwd: string
  locale?: CliLocale
  /** File reader; defaults to the real filesystem. Injected in tests. */
  readFile?: (absPath: string) => Promise<string>
  /** Max bytes to render before truncating (guards the pager on huge files). */
  maxBytes?: number
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
  const lang = langFromPath(filePath)
  return { format: "text", ...(lang ? { lang } : {}) }
}

const DEFAULT_MAX_BYTES = 256 * 1024

function previewText(buffer: Buffer, maxBytes: number, locale?: CliLocale): string {
  const t = createCliTranslator(locale, "cliUiCommands")
  const truncated = buffer.length > maxBytes
  const sample = buffer.subarray(0, maxBytes)
  if (sample.includes(0)) throw new Error(t("viewBinary"))
  // write() retains an incomplete trailing UTF-8 sequence instead of emitting �.
  const decoder = new StringDecoder("utf8")
  const body = decoder.write(sample) + (truncated ? "" : decoder.end())
  return (
    body + (truncated ? `\n\n… (${t("viewTruncated", { kb: Math.round(maxBytes / 1024) })})` : "")
  )
}

/** Read at most the preview budget plus one byte to detect truncation. */
async function readPreview(file: string, maxBytes: number, locale?: CliLocale): Promise<string> {
  const handle = await nodeFs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(createCliTranslator(locale, "cliUiCommands")("viewNotFile"))
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    return previewText(buffer.subarray(0, length), maxBytes, locale)
  } finally {
    await handle.close()
  }
}

/** Read a file and open it in the document viewer. */
export async function viewFile(arg: string, deps: ViewDeps): Promise<void> {
  const t = createCliTranslator(deps.locale, "cliUiCommands")
  let target = arg.trim()
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  )
    target = target.slice(1, -1)
  if (!target) {
    deps.dispatch({ type: "NOTICE", message: t("viewUsage", { command: "/view <path>" }) })
    return
  }
  const local = target.startsWith("~/") ? path.join(homedir(), target.slice(2)) : target
  const absPath = path.resolve(deps.cwd, local)
  const maxBytes =
    Number.isSafeInteger(deps.maxBytes) && deps.maxBytes! > 0
      ? Math.min(deps.maxBytes!, DEFAULT_MAX_BYTES)
      : DEFAULT_MAX_BYTES
  try {
    const body = deps.readFile
      ? previewText(Buffer.from(await deps.readFile(absPath), "utf8"), maxBytes, deps.locale)
      : await readPreview(absPath, maxBytes, deps.locale)
    const { format, lang } = detectFormat(absPath)
    const title = path.relative(deps.cwd, absPath) || path.basename(absPath)
    openDocument(deps.dispatch, { title, body, format, ...(lang ? { lang } : {}) })
  } catch (err) {
    deps.dispatch({
      type: "NOTICE",
      message: t("viewReadFailed", { target, error: errorMessage(err) }),
    })
  }
}

/** Bounded, read-only preview for a file inside a skill's directory. */
export async function readSkillFile(
  root: string,
  file: string,
  locale?: CliLocale
): Promise<DetectedFormat & { body: string }> {
  const [realRoot, realFile] = await Promise.all([nodeFs.realpath(root), nodeFs.realpath(file)])
  const relative = path.relative(realRoot, realFile)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(createCliTranslator(locale, "cliUiCommands")("viewOutsideSkill"))
  }
  return { ...detectFormat(file), body: await readPreview(realFile, DEFAULT_MAX_BYTES, locale) }
}
