/**
 * CLI-side client for the desktop twin-context bridge route
 * (`POST /api/v1/dev/twin/context`).
 *
 * The CLI process has no access to the GUI's Dexie tables or the vector
 * store, so twin retrieval runs on the desktop (renderer) and only the
 * REDACTED prompt segments come back. Degrades to `null` on ANY failure —
 * desktop not running, endpoint stale, HTTP error, malformed body — so
 * callers can skip twin injection without branching on error kinds.
 *
 * The 10 s abort keeps every CLI turn responsive and always resolves
 * before the Rust bridge's own 30 s renderer timeout.
 */

import { detectDesktop, DEV_TOKEN_HEADER, type HandoffClientDeps } from "../handoff/client"
import type { BridgeEndpoint } from "../handoff/endpoint"

export const TWIN_CONTEXT_PATH = "/api/v1/dev/twin/context"
const REQUEST_TIMEOUT_MS = 10_000

export interface TwinContextRequest {
  characterId: string
  message: string
  sessionId?: string
}

/** Mirror of the renderer handler's projection (lib/cli-bridge/handlers/twin-context.ts). */
export interface TwinContextResult {
  ok: boolean
  applied?: { systemPrompt: string; stable?: string; dynamic?: string }
  degraded: boolean
  degradedReason?: string
  sources: Array<{ title?: string; score: number }>
  styleSampleCount: number
  error?: string
}

export interface TwinContextClientDeps extends HandoffClientDeps {
  /** Pre-resolved endpoint (skips detectDesktop). */
  endpoint?: BridgeEndpoint | null
  timeoutMs?: number
}

/**
 * Fetch the twin context for a message. Returns `null` when the desktop is
 * unreachable or anything about the round-trip failed — the CLI then sends
 * the turn without twin context (honest degraded mode).
 */
export async function fetchTwinContext(
  request: TwinContextRequest,
  deps: TwinContextClientDeps = {}
): Promise<TwinContextResult | null> {
  const endpoint = deps.endpoint !== undefined ? deps.endpoint : await detectDesktop(deps)
  if (!endpoint) return null
  const doFetch = deps.fetch ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const res = await doFetch(`${endpoint.baseUrl}${TWIN_CONTEXT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [DEV_TOKEN_HEADER]: endpoint.devToken,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean; result?: TwinContextResult }
    if (!body?.ok || !body.result || body.result.ok !== true) return null
    return body.result
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
