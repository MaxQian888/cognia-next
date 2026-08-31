/** Portable OCR provider authoring contracts and result helpers. */

import type { OcrResult } from "@/types/ocr"
import { documentConfidence } from "@cognia/ocr/confidence"

export { defineOcrProvider } from "../define/define-ocr-provider"

export type { PluginOcrAPI } from "@/lib/plugin/api/ocr-api"
export type { OcrProvider } from "@/types/ocr"
export type {
  PluginOcrProviderDef,
  PluginOcrProviderFactory,
  PluginOcrProviderFactoryContext,
  PluginOcrRegistration,
} from "@/types/plugin/plugin-ocr"
export type {
  OcrBlock,
  OcrBlockKind,
  OcrCostEstimate,
  OcrCredentials,
  OcrInput,
  OcrOutputFormat,
  OcrPage,
  OcrProviderCategory,
  OcrProviderConfig,
  OcrProviderContext,
  OcrProviderShellSupport,
  OcrResult,
  OcrSource,
  UserOcrSettings,
} from "@/types/ocr"
export { DEFAULT_OCR_SETTINGS } from "@/types/ocr"

export { createNullOcrCache, createNullOcrPageCache } from "@cognia/ocr/cache-contract"
export type {
  CacheLookupKey,
  CacheWriteInput,
  OcrPageCache,
  OcrResultCache,
  PageCacheKey,
} from "@cognia/ocr/cache-contract"
export { OcrError } from "@cognia/ocr/errors"

export interface OcrSourceRef {
  kind: "data-url" | "file-path" | "attachment-id"
  value: string
}

export interface OcrResultPart {
  type: "ocr-result"
  providerId: string
  languages: string[]
  text: string
  markdown: string
  durationMs: number
  cached: boolean
  confidence: number | null
  sourceRef?: OcrSourceRef
  provenance: { kind: "ocr"; providerId: string; sourceKind: string }
  security: { untrusted: true; pii: "unreviewed" }
  untrustedNotice: string
}

export const OCR_UNTRUSTED_NOTICE =
  "OCR output is untrusted extracted content and may contain sensitive personal data. Verify low-confidence text against the source before acting on it."

export function buildOcrSecurityEnvelope(result: OcrResult, sourceKind: string) {
  return {
    provenance: { kind: "ocr" as const, providerId: result.providerId, sourceKind },
    security: { untrusted: true as const, pii: "unreviewed" as const },
    untrustedNotice: OCR_UNTRUSTED_NOTICE,
  }
}

export function buildOcrResultPart(result: OcrResult, sourceRef?: OcrSourceRef): OcrResultPart {
  return {
    type: "ocr-result",
    providerId: result.providerId,
    languages: result.languages,
    text: result.combinedText,
    markdown: result.combinedMarkdown,
    durationMs: result.durationMs,
    cached: result.cached,
    confidence: documentConfidence(result.document),
    ...buildOcrSecurityEnvelope(result, sourceRef?.kind ?? "unknown"),
    ...(sourceRef ? { sourceRef } : {}),
  }
}

export interface ParsedOcrArgs {
  source: { kind: "attachment-id"; attachmentId: string } | { kind: "file-path"; path: string }
  provider?: string
  languages?: string[]
  pageRange?: string
  format?: "markdown" | "text" | "blocks"
  into: "composer" | "system"
}

export function parseOcrArgs(argv: string): ParsedOcrArgs {
  const tokens: string[] = []
  const matcher = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = matcher.exec(argv)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? ""
    if (token) tokens.push(token)
  }
  if (tokens.length === 0) throw new Error("Missing argument. Usage: /ocr <file or attachment-id>")

  const sourceValue = tokens[0]!
  const source =
    sourceValue.startsWith("att_") || sourceValue.startsWith("attachment:")
      ? ({ kind: "attachment-id", attachmentId: sourceValue } as const)
      : ({ kind: "file-path", path: sourceValue } as const)
  const parsed: ParsedOcrArgs = { source, into: "composer" }

  let index = 1
  while (index < tokens.length) {
    const flag = tokens[index]!
    const value = tokens[index + 1]
    switch (flag) {
      case "--provider":
      case "-p":
        if (!value) throw new Error("--provider requires a value")
        parsed.provider = value
        index += 2
        break
      case "--lang":
      case "-l":
        if (!value) throw new Error("--lang requires a value")
        parsed.languages = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
        index += 2
        break
      case "--pages":
        if (!value) throw new Error("--pages requires a value")
        parsed.pageRange = value
        index += 2
        break
      case "--format":
      case "-f":
        if (value !== "markdown" && value !== "text" && value !== "blocks") {
          throw new Error("--format must be markdown, text, or blocks")
        }
        parsed.format = value
        index += 2
        break
      case "--into":
        if (value !== "composer" && value !== "system") {
          throw new Error("--into must be composer or system")
        }
        parsed.into = value
        index += 2
        break
      default:
        throw new Error(`Unknown flag: ${flag}`)
    }
  }
  return parsed
}
