/**
 * Read a captured chat window with a LOCAL OCR engine only (ADR-0194 §8).
 *
 * The user's OCR default may be a cloud service, which is fine for a document
 * they chose to upload and wrong for a picture of a private conversation. So
 * the provider is picked from the auto-router's ready candidates with cloud
 * fallback forced off, keeping the first `local` one (Apple Vision, PaddleOCR,
 * Tesseract). When none is ready the read fails with `no_local_ocr` rather
 * than quietly sending the frame out. The result is never cached: the OCR
 * cache is a Dexie table, and a chat screenshot's text has no business
 * persisting there.
 */

import { blocksToScreenMatches } from "@/lib/automation/ocr-click"
import type { Screenshot } from "@/lib/automation/types"
import { extract as defaultExtract, type ExtractDeps } from "@/lib/ocr"
import { listProviderCandidates } from "@/lib/ocr/auto-router"
import { buildOcrDeps } from "@/lib/ocr/deps"
import { loadUserOcrSettings } from "@/lib/ocr/user-settings"
import type { OcrInput, OcrProvider, OcrResult } from "@/types/ocr"
import type { ScreenLine } from "./bubble-grouper"

export class LocalOcrUnavailableError extends Error {
  constructor() {
    super("no local OCR engine is ready")
    this.name = "LocalOcrUnavailableError"
  }
}

export interface LocalOcrDeps {
  ocrDeps: () => Promise<ExtractDeps>
  candidates: (deps: ExtractDeps) => Promise<OcrProvider[]>
  extract: (input: OcrInput, deps: ExtractDeps) => Promise<OcrResult>
}

const defaultDeps: LocalOcrDeps = {
  ocrDeps: async () => buildOcrDeps({ settings: await loadUserOcrSettings() }),
  candidates: (deps) =>
    listProviderCandidates({
      registry: deps.registry,
      settings: { ...deps.settings, cloudFallbackEnabled: false },
      platform: deps.platform,
      osTag: deps.osTag,
      localPreference: deps.settings.platformOverrides,
      runtimeStatus: deps.runtimeStatus,
      localReadiness: deps.localReadiness,
      hasCredentials: deps.hasCredentials,
    }),
  extract: defaultExtract,
}

export interface WindowText {
  providerId: string
  lines: ScreenLine[]
}

export async function readWindowText(
  shot: Screenshot,
  signal?: AbortSignal,
  deps: LocalOcrDeps = defaultDeps
): Promise<WindowText> {
  const ocrDeps = await deps.ocrDeps()
  const local = (await deps.candidates(ocrDeps)).find((provider) => provider.category === "local")
  if (!local) throw new LocalOcrUnavailableError()
  signal?.throwIfAborted()
  const mimeType = shot.format === "jpeg" ? "image/jpeg" : "image/png"
  const result = await deps.extract(
    {
      source: { kind: "data-url", dataUrl: `data:${mimeType};base64,${shot.bytes}`, mimeType },
      providerId: local.id,
      useCache: false,
      ...(signal ? { signal } : {}),
    },
    ocrDeps
  )
  return {
    providerId: result.providerId,
    lines: blocksToScreenMatches(result, shot).map((match) => ({
      text: match.text,
      bbox: match.bbox,
    })),
  }
}
