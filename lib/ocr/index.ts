/**
 * Public OCR surface — `extract()` is what composer, slash command, and the
 * plugin tool all call.
 *
 * Responsibilities:
 *   1. Resolve `OcrInput.source` to a Blob + mime type (callers pass an
 *      `attachmentResolver` / `filePathResolver` when those source kinds are
 *      in play; data-url / blob sources resolve inline).
 *   2. Compute the cache key, read through the Dexie cache, short-circuit on hit.
 *   3. Pick the provider (explicit id or auto-router).
 *   4. Call `provider.extract()`, wrap timing + cost, write back to the cache.
 *
 * The function is shaped so that every external dependency (registry,
 * settings, platform detection, credentials lookup) is injectable. Test code
 * passes a small fake provider; production code passes the shared registry +
 * `keyring`-backed credentials resolver.
 */

import type { NativePlatform } from "@/lib/capacitor/_shared"
import { sha256Blob, sha256Bytes } from "./hash"
import { readCachedResult, writeCachedResult } from "./cache"
import { combinePageMarkdown, combinePageText, normalizeLanguages } from "./image-prep"
import { buildOcrDocument } from "./document"
import { maybeEscalateResult } from "./confidence"
import { OcrError } from "./errors"
import {
  type OcrCredentials,
  type OcrInput,
  type OcrProvider,
  type OcrProviderConfig,
  type OcrResult,
  type OcrSource,
  type UserOcrSettings,
} from "@/types/ocr"
import type { OcrRegistry } from "./registry"
import { pickDefaultProvider, resolveProviderById } from "./auto-router"

export interface ResolvedSource {
  blob: Blob
  mimeType: string
  /** Bytes already on hand — providers can re-use without another fetch. */
  bytes?: Uint8Array
}

export interface AttachmentResolver {
  (attachmentId: string): Promise<ResolvedSource>
}

export interface FilePathResolver {
  (path: string): Promise<ResolvedSource>
}

export interface CredentialsResolver {
  (providerId: string, keys: readonly string[]): Promise<OcrCredentials>
}

export interface ExtractDeps {
  registry: OcrRegistry
  settings: UserOcrSettings
  platform: NativePlatform
  /** Sub-OS tag for the auto-router's local preference table. */
  osTag?: "windows" | "macos" | "linux" | "ios" | "android" | "browser"
  /** Pulls credentials from the keyring (Tauri) or encrypted Dexie (web). */
  credentialsResolver: CredentialsResolver
  /** Required only when callers pass `kind: "attachment-id"` sources. */
  attachmentResolver?: AttachmentResolver
  /** Required only when callers pass `kind: "file-path"` sources. */
  filePathResolver?: FilePathResolver
  /** Hook for tests / observability — every extract result flows through here. */
  onResult?: (result: OcrResult) => void
}

async function resolveSource(
  source: OcrSource,
  deps: Pick<ExtractDeps, "attachmentResolver" | "filePathResolver">
): Promise<ResolvedSource> {
  if (source.kind === "blob") {
    return { blob: source.blob, mimeType: source.mimeType || source.blob.type }
  }
  if (source.kind === "data-url") {
    const match = /^data:([^;,]+)(?:;[^,]*)*;base64,(.+)$/.exec(source.dataUrl)
    if (!match) {
      throw new OcrError("invalid_input", "extract", "Data URL must be base64-encoded.")
    }
    const mimeType = source.mimeType || match[1]!
    const b64 = match[2]!
    const bin =
      typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary")
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return {
      blob: new Blob([bytes as BlobPart], { type: mimeType }),
      mimeType,
      bytes,
    }
  }
  if (source.kind === "file-path") {
    if (!deps.filePathResolver) {
      throw new OcrError(
        "invalid_input",
        "extract",
        "file-path source requires a filePathResolver."
      )
    }
    return deps.filePathResolver(source.path)
  }
  if (!deps.attachmentResolver) {
    throw new OcrError(
      "invalid_input",
      "extract",
      "attachment-id source requires an attachmentResolver."
    )
  }
  return deps.attachmentResolver(source.attachmentId)
}

async function computeFileSha(resolved: ResolvedSource): Promise<string> {
  if (resolved.bytes) return sha256Bytes(resolved.bytes)
  return sha256Blob(resolved.blob)
}

function pickProviderConfig(settings: UserOcrSettings, providerId: string): OcrProviderConfig {
  return settings.providerConfig[providerId] ?? {}
}

async function callProvider(
  provider: OcrProvider,
  input: OcrInput,
  deps: ExtractDeps,
  signal: AbortSignal | undefined
): Promise<OcrResult> {
  const credentials = await deps.credentialsResolver(provider.id, provider.credentialKeys)
  const start = Date.now()
  try {
    const out = await provider.extract(input, {
      credentials,
      config: pickProviderConfig(deps.settings, provider.id),
      signal,
      platform: deps.platform,
    })
    const durationMs = out.durationMs > 0 ? out.durationMs : Date.now() - start
    return rebuildResult(out, provider.id, durationMs)
  } catch (err) {
    // Duck-type as well as instanceof so cross-module require chains (rare in
    // app code, common in Jest) still preserve the original error code.
    if (
      err instanceof OcrError ||
      (err !== null &&
        typeof err === "object" &&
        (err as { name?: string }).name === "OcrError" &&
        "code" in err &&
        "providerId" in err)
    ) {
      throw err
    }
    throw new OcrError(
      "provider_failed",
      provider.id,
      err instanceof Error ? err.message : String(err),
      err
    )
  }
}

/** Re-normalize an OcrResult so we always emit consistent combined fields. */
function rebuildResult(raw: OcrResult, providerId: string, durationMs: number): OcrResult {
  const combinedMarkdown = raw.combinedMarkdown || combinePageMarkdown(raw.pages)
  const combinedText = raw.combinedText || combinePageText(raw.pages)
  // Phase 2 — synthesize the typed IR from the per-page output when a provider
  // didn't supply one. Additive: combined fields above are unchanged.
  const document = raw.document ?? buildOcrDocument(raw.pages, providerId)
  return {
    ...raw,
    providerId,
    combinedMarkdown,
    combinedText,
    durationMs,
    cached: false,
    document,
  }
}

/**
 * E2E hook: when running under `NEXT_PUBLIC_E2E=1` the renderer may publish
 * `window.__cogniaE2EOcrMock` (a function `(input) => Promise<OcrResult> |
 * OcrResult`) to short-circuit provider selection entirely. The mock's
 * return value is forwarded through the standard `onResult` callback and
 * caching path is skipped. Dead-code-eliminated in production because the
 * global is only installed by the dev-only bridge in
 * `lib/dev/expose-test-globals.tsx`.
 */
function readOcrMockHook(): ((input: OcrInput) => Promise<OcrResult> | OcrResult) | null {
  if (typeof window === "undefined") return null
  const w = window as {
    __cogniaE2EOcrMock?: (input: OcrInput) => Promise<OcrResult> | OcrResult
  }
  return typeof w.__cogniaE2EOcrMock === "function" ? w.__cogniaE2EOcrMock : null
}

/**
 * The single public entry point used by composer / slash command / plugin tool.
 * `deps` carries every dependency (registry, settings, platform, credentials)
 * so tests can stub each independently. Callers in app code construct deps
 * once via `lib/ocr/runtime.ts` (browser) or via `useOcr()` (React).
 */
export async function extract(input: OcrInput, deps: ExtractDeps): Promise<OcrResult> {
  if (input.signal?.aborted) {
    throw new OcrError("aborted", "extract", "OCR cancelled before dispatch.")
  }

  const mock = readOcrMockHook()
  if (mock) {
    const out = await mock(input)
    deps.onResult?.(out)
    return out
  }

  const resolved = await resolveSource(input.source, deps)
  const fileSha = await computeFileSha(resolved)
  const languages = normalizeLanguages(input.languages, deps.settings.defaultLanguages)

  // Provider selection.
  const provider =
    input.providerId !== undefined
      ? resolveProviderById(deps.registry, input.providerId, deps.platform)
      : await pickDefaultProvider({
          registry: deps.registry,
          settings: deps.settings,
          platform: deps.platform,
          osTag: deps.osTag,
          localPreference: deps.settings.platformOverrides,
        })

  // Cache lookup.
  const useCache = input.useCache !== false
  if (useCache) {
    const hit = await readCachedResult({ fileSha, providerId: provider.id, languages })
    if (hit) {
      deps.onResult?.(hit)
      return hit
    }
  }

  // Hand a blob-backed input down to the provider so file-path / attachment
  // sources don't have to be re-resolved.
  const providerInput: OcrInput = {
    ...input,
    languages,
    source: { kind: "blob", blob: resolved.blob, mimeType: resolved.mimeType },
  }

  const result = await callProvider(provider, providerInput, deps, input.signal)

  // Phase 2 / 2c — confidence-driven escalation. No-op unless the setting is on
  // and the result's mean confidence is below the threshold (default off).
  const finalResult = await maybeEscalateResult({
    result,
    settings: deps.settings,
    reextract: (providerId) =>
      callProvider(
        resolveProviderById(deps.registry, providerId, deps.platform),
        providerInput,
        deps,
        input.signal
      ),
  })

  if (useCache) {
    await writeCachedResult({
      fileSha,
      providerId: finalResult.providerId,
      languages,
      result: finalResult,
      bytesIn: resolved.blob.size,
    })
  }

  deps.onResult?.(finalResult)
  return finalResult
}

export { OcrError } from "./errors"
