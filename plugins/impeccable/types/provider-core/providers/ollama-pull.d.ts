import { OllamaPullProgress } from "@cognia/provider-types/ollama"

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

interface PullOllamaModelArgs {
  baseUrl: string
  modelName: string
  onProgress?: (progress: OllamaPullProgress) => void
  signal?: AbortSignal
}
interface PullOllamaModelHandle {
  success: boolean
  /**
   * Detach the progress listener. Does NOT stop the server-side download —
   * see the cancellation note above.
   */
  unsubscribe: () => void
}
/**
 * Pull a model, reporting NDJSON progress as it arrives.
 *
 * Resolves once the stream ends. Progress objects are forwarded verbatim with
 * `model` stamped on, so callers can compute a percentage from
 * `completed`/`total` — and must show an indeterminate state until those
 * appear, since Ollama's early lines ("pulling manifest") carry no totals.
 */
declare function pullOllamaModelStreaming(args: PullOllamaModelArgs): Promise<PullOllamaModelHandle>

export { type PullOllamaModelArgs, type PullOllamaModelHandle, pullOllamaModelStreaming }
