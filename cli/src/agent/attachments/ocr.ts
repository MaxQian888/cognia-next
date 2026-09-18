/**
 * Node-safe OCR runner for the CLI. Reuses `@cognia/ocr`'s `extract` with a
 * hand-built `ExtractDeps` (fresh registry holding only `anthropic-vision`,
 * injected credentials from the CLI's Anthropic key, cache disabled) so it
 * pulls in NO Dexie/Tauri/keyring code. Used as the PDF fallback when the
 * active model cannot accept a native PDF block.
 *
 * Import discipline: ONLY `@cognia/ocr` subpaths — the pure, zero-`@/` core.
 * Never `lib/ocr`'s index (its `extract` wrapper meters through
 * `@/lib/db/session-usage` → Dexie), `runtime.ts` / `deps.ts` /
 * `credentials.ts` / `cache.ts` / `lib/keyring` / `lib/db/*` (Tauri/Dexie at
 * module top level).
 */
import { createNullOcrCache, createNullOcrPageCache } from "@cognia/ocr/cache-contract"
import { extract as realExtract, type ExtractDeps } from "@cognia/ocr"
import { createOcrRegistry } from "@cognia/ocr/registry"
import { anthropicVisionProvider } from "@cognia/ocr/providers/anthropic-vision"
import { DEFAULT_OCR_SETTINGS, type OcrInput, type OcrResult } from "@cognia/ocr/types"

export interface OcrRunDeps {
  /** Resolves the Anthropic API key (from CLI config / env). */
  anthropicKey: () => string | null
  /** Injectable for tests; defaults to the real `lib/ocr` extract. */
  extract?: (input: OcrInput, deps: ExtractDeps) => Promise<OcrResult>
}

export type OcrRunResult = { ok: true; text: string } | { ok: false; reason?: string }

function bytesToBase64(data: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(data)).toString("base64")
}

export async function ocrExtractText(
  data: ArrayBuffer,
  mimeType: string,
  deps: OcrRunDeps
): Promise<OcrRunResult> {
  const key = deps.anthropicKey()
  if (!key) return { ok: false, reason: "no-anthropic-key" }
  const extract = deps.extract ?? realExtract

  const registry = createOcrRegistry()
  registry.register(anthropicVisionProvider)

  const extractDeps: ExtractDeps = {
    registry,
    settings: { ...DEFAULT_OCR_SETTINGS, defaultProviderId: "anthropic-vision" },
    platform: "web",
    osTag: "browser",
    credentialsResolver: async () => ({
      secrets: {},
      getMainProviderKey: async (id) => (id === "anthropic" ? key : null),
    }),
    // The CLI runs in Node (no IndexedDB) and dispatches with `useCache: false`,
    // so persistence is explicitly opted out rather than silently unavailable.
    cache: createNullOcrCache(),
    pageCache: createNullOcrPageCache(),
  }

  const input: OcrInput = {
    source: {
      kind: "data-url",
      dataUrl: `data:${mimeType};base64,${bytesToBase64(data)}`,
      mimeType,
    },
    providerId: "anthropic-vision",
    useCache: false,
  }

  try {
    const result = await extract(input, extractDeps)
    const text = (result.combinedMarkdown || result.combinedText || "").trim()
    if (!text) return { ok: false, reason: "empty" }
    return { ok: true, text }
  } catch {
    return { ok: false, reason: "extract-failed" }
  }
}
