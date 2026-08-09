/**
 * Streaming model pull for Ollama.
 *
 * `/api/pull` answers with NDJSON — one JSON progress object per line, held
 * open for the whole download. That is the one shape `proxy_http_request`
 * cannot carry: it returns a fully-buffered `body: String`, so a caller would
 * see nothing until the download finished and then get every progress line at
 * once. This is why pull, alone among the local-provider calls, needs its own
 * Rust command instead of riding the shared proxy.
 *
 * Transport per host:
 * - Tauri  → `ollama_pull_model_stream`, which streams NDJSON server-side and
 *   emits each line as an `ollama-pull-progress` event.
 * - Browser → `fetch` + a ReadableStream reader. There is no CSP in a plain
 *   browser tab, and `pnpm dev` has none either.
 *
 * ── Cancellation is a client-side illusion, and we say so ──────────────────
 * Ollama's server CANNOT cancel a pull. Aborting the HTTP connection does not
 * stop it; the download runs to completion server-side regardless
 * (ollama#13142, still open). The only true stop is killing the process.
 * So `cancel()` here detaches the listener and stops reporting — it does not
 * stop the download. Callers must not label this "cancelled" without telling
 * the user the transfer continues in the background. A cancelled pull DOES
 * resume from where it left off on the next attempt; a dropped network
 * connection reportedly restarts from 0%.
 */

import type { OllamaPullProgress } from "@cognia/provider-types/ollama"
import { validateStaticHeaders } from "@cognia/provider-types/transport-header-policy"
import { isTauri } from "./runtime-adapters"

export interface PullOllamaModelArgs {
  baseUrl: string
  modelName: string
  apiKey?: string
  customHeaders?: Record<string, string>
  onProgress?: (progress: OllamaPullProgress) => void
  signal?: AbortSignal
}

export interface PullOllamaModelHandle {
  success: boolean
  /**
   * Detach the progress listener. Does NOT stop the server-side download —
   * see the cancellation note above.
   */
  unsubscribe: () => void
}

/** Strip a trailing slash and a trailing `/v1` so `/api/*` paths append cleanly. */
function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, "")
  if (url.endsWith("/v1")) {
    url = url.slice(0, -3)
  }
  return url
}

/**
 * Pull a model, reporting NDJSON progress as it arrives.
 *
 * Resolves once the stream ends. Progress objects are forwarded verbatim with
 * `model` stamped on, so callers can compute a percentage from
 * `completed`/`total` — and must show an indeterminate state until those
 * appear, since Ollama's early lines ("pulling manifest") carry no totals.
 */
export async function pullOllamaModelStreaming(
  args: PullOllamaModelArgs
): Promise<PullOllamaModelHandle> {
  const { baseUrl, modelName, apiKey, customHeaders, onProgress, signal } = args
  const url = normalizeBaseUrl(baseUrl)
  const violations = validateStaticHeaders(customHeaders)
  if (violations.length > 0) {
    const details = violations.map(({ name, reason }) => `${name}: ${reason}`).join(", ")
    throw new Error(`Invalid custom headers (${details})`)
  }

  if (isTauri()) {
    return pullViaTauri(url, modelName, apiKey, customHeaders, onProgress, signal)
  }
  return pullViaFetch(url, modelName, apiKey, customHeaders, onProgress, signal)
}

async function pullViaTauri(
  url: string,
  modelName: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
  onProgress?: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal
): Promise<PullOllamaModelHandle> {
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ])

  // A pull id scopes the event stream to THIS call. Without it two concurrent
  // pulls would each receive the other's progress, and the `unsubscribe` of one
  // would look like it silenced both.
  const pullId = `${modelName}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`

  let unlisten: (() => void) | undefined
  if (onProgress) {
    const un = await listen<OllamaPullProgress & { pullId?: string }>(
      "ollama-pull-progress",
      (event) => {
        if (event.payload.pullId !== pullId) return
        onProgress({ ...event.payload, model: modelName })
      }
    )
    unlisten = un
  }

  const onAbort = () => unlisten?.()
  signal?.addEventListener("abort", onAbort, { once: true })
  // `await listen(...)` above yields, so a caller that aborts immediately does
  // so BEFORE this listener exists and the event is missed entirely — leaking
  // the subscription for the life of the pull. Re-check after attaching.
  if (signal?.aborted) onAbort()

  try {
    const success = await invoke<boolean>("ollama_pull_model_stream", {
      baseUrl: url,
      modelName,
      pullId,
      apiKey: apiKey?.trim() || undefined,
      customHeaders,
    })
    return { success, unsubscribe: () => unlisten?.() }
  } catch (error) {
    unlisten?.()
    throw error
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

async function pullViaFetch(
  url: string,
  modelName: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
  onProgress?: (progress: OllamaPullProgress) => void,
  signal?: AbortSignal
): Promise<PullOllamaModelHandle> {
  const headers: Record<string, string> = {
    ...(customHeaders ?? {}),
    "Content-Type": "application/json",
  }
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  const response = await fetch(`${url}/api/pull`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: modelName, stream: true }),
    signal,
  })

  if (!response.ok) {
    throw new Error(`Failed to pull model: ${response.status}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error("No response body")
  }

  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    // The tail is almost always a partial line — hold it for the next chunk.
    buffer = lines.pop() || ""

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const progress = JSON.parse(line) as OllamaPullProgress
        progress.model = modelName
        onProgress?.(progress)
      } catch {
        // A malformed line must not abort a running download.
      }
    }
  }

  return { success: true, unsubscribe: () => {} }
}
