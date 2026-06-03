/**
 * `/ocr` slash command handler.
 *
 * Surface:
 *   /ocr <file path or attachment id>
 *     [--provider auto|<provider-id>] [--lang en,zh] [--pages 1-3]
 *     [--format markdown|text|blocks]
 *
 * Returns a system Markdown blob containing the extracted text — the slash
 * dispatcher pushes this into the chat as a system message. When the user
 * passes `--into composer` (default), the dispatcher also writes the result
 * back into the composer textarea via `dispatchPrompt`.
 */

import { extract, type ExtractDeps } from "@/lib/ocr/index"
import { OcrError } from "@/lib/ocr/errors"
import { type OcrInput, type OcrOutputFormat, type OcrResult } from "@/types/ocr"

export interface SlashOcrInput {
  /** Raw argv after the `/ocr ` prefix. */
  argv: string
  /** Resolved at the call site — composer, registry, settings, platform. */
  deps: ExtractDeps
  /** Attachment-id resolver — required when callers pass an `att_*` arg. */
  attachmentResolver?: ExtractDeps["attachmentResolver"]
  /** File-path resolver — required when callers pass a `/path/to/file` arg. */
  filePathResolver?: ExtractDeps["filePathResolver"]
  /**
   * Override the `extract` entry point. Tests inject a stub here so they
   * don't have to wire up an entire registry.
   */
  extractImpl?: typeof extract
}

export interface SlashOcrResult {
  /** Markdown to push into the chat as a system message. */
  system: string
  /** When set, the composer prepends this text to its textarea. */
  composerText?: string
  /** Raw result — useful for plugin authors. */
  result?: OcrResult
  /** Error code when the command failed. */
  errorCode?: OcrError["code"]
}

interface ParsedArgs {
  source: { kind: "attachment-id"; attachmentId: string } | { kind: "file-path"; path: string }
  provider?: string
  languages?: string[]
  pageRange?: string
  format?: OcrOutputFormat
  into: "composer" | "system"
}

export function parseOcrArgs(argv: string): ParsedArgs {
  const tokens = tokenize(argv)
  if (tokens.length === 0) {
    throw new Error("Missing argument. Usage: /ocr <file or attachment-id>")
  }
  const sourceArg = tokens[0]!
  const source = isAttachmentId(sourceArg)
    ? ({ kind: "attachment-id", attachmentId: sourceArg } as const)
    : ({ kind: "file-path", path: sourceArg } as const)

  const out: ParsedArgs = { source, into: "composer" }
  let i = 1
  while (i < tokens.length) {
    const flag = tokens[i]!
    const value = tokens[i + 1]
    switch (flag) {
      case "--provider":
      case "-p":
        if (!value) throw new Error("--provider requires a value")
        out.provider = value
        i += 2
        break
      case "--lang":
      case "-l":
        if (!value) throw new Error("--lang requires a value")
        out.languages = value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
        i += 2
        break
      case "--pages":
        if (!value) throw new Error("--pages requires a value")
        out.pageRange = value
        i += 2
        break
      case "--format":
      case "-f":
        if (value !== "markdown" && value !== "text" && value !== "blocks") {
          throw new Error("--format must be markdown, text, or blocks")
        }
        out.format = value
        i += 2
        break
      case "--into":
        if (value !== "composer" && value !== "system") {
          throw new Error("--into must be composer or system")
        }
        out.into = value
        i += 2
        break
      default:
        throw new Error(`Unknown flag: ${flag}`)
    }
  }
  return out
}

export async function handleOcrSlashCommand(input: SlashOcrInput): Promise<SlashOcrResult> {
  let parsed: ParsedArgs
  try {
    parsed = parseOcrArgs(input.argv)
  } catch (err) {
    return {
      system: err instanceof Error ? err.message : String(err),
      errorCode: "invalid_input",
    }
  }
  const extractFn = input.extractImpl ?? extract
  const deps: ExtractDeps = {
    ...input.deps,
    attachmentResolver: input.attachmentResolver ?? input.deps.attachmentResolver,
    filePathResolver: input.filePathResolver ?? input.deps.filePathResolver,
  }
  const ocrInput: OcrInput = {
    source: parsed.source,
    providerId: parsed.provider,
    languages: parsed.languages,
    pageRange: parsed.pageRange,
    format: parsed.format,
  }
  try {
    const result = await extractFn(ocrInput, deps)
    const body = renderResultMarkdown(result)
    return {
      system: body,
      composerText: parsed.into === "composer" ? result.combinedMarkdown : undefined,
      result,
    }
  } catch (err) {
    if (err instanceof OcrError) {
      return { system: `OCR failed (${err.code}): ${err.message}`, errorCode: err.code }
    }
    return {
      system: `OCR failed: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "provider_failed",
    }
  }
}

function renderResultMarkdown(result: OcrResult): string {
  const header = `**OCR via ${result.providerId}** (${result.languages.join(", ") || "auto"}, ${result.durationMs}ms${
    result.cached ? ", cached" : ""
  })`
  return `${header}\n\n${result.combinedMarkdown}`
}

function tokenize(argv: string): string[] {
  // Honour quoted strings so file paths with spaces survive.
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(argv)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "")
  }
  return out.filter((s) => s.length > 0)
}

function isAttachmentId(arg: string): boolean {
  return arg.startsWith("att_") || arg.startsWith("attachment:")
}
