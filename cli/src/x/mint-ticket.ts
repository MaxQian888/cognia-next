/**
 * Route-ticket minting for `cognia-agent x` (ADR-0163 Phase 4).
 *
 * A gateway route ticket is the credential an external agent presents to the
 * cognia gateway listener. It is minted by the desktop, not derived from an
 * upstream provider key: the listener only ever matches its own key store and
 * its ticket registry, so handing it an Anthropic or OpenAI key can only 401.
 *
 * Two legs, same request shape and result shape:
 *   - bridge: the desktop's loopback CLI bridge (`X-Cognia-Dev-Token`),
 *   - rpc:    a running `cognia-server` (`/internal/_rpc`, service token).
 * `mintRouteTicket` tries the bridge first, then the rpc.
 */

import { DEV_TOKEN_HEADER, detectDesktop } from "../handoff/client"

export const BRIDGE_ROUTE_TICKET_PATH = "/api/dev/gateway/route-ticket"
export const RPC_ROUTE_TICKET_COMMAND = "gateway_mint_route_ticket"
export const SERVER_URL_ENV = "COGNIA_SERVER_URL"
export const SERVICE_TOKEN_ENV = "COGNIA_SERVICE_TOKEN"

export interface TicketMintRequest {
  model: string
  sessionId: string
  parentSessionId?: string
  executionFingerprint: string
  routePolicy: string
  ttlMs?: number
  /** Omit for the deny-safe default scope (chat, count-tokens, models). */
  operations?: Array<"chat" | "count-tokens" | "models" | "embeddings" | "responses">
  budget?: { maxTokens?: number; maxRequests?: number; maxRequestsPerMin?: number }
}

export interface MintedRouteTicket {
  /** OpenAI-compatible base URL of the gateway listener, ending in /v1. */
  endpoint: string
  ticketId: string
  /** Shown once. Stamp into the agent's environment and drop. */
  secret: string
  /** Frozen selector → concrete model map the gateway will honour. */
  modelBindings: Record<string, string>
  expiresAtMs: number
}

export type MintTicketFailureReason =
  /** No desktop bridge endpoint, or its health check failed. */
  | "no-desktop"
  /** No `COGNIA_SERVER_URL` / `COGNIA_SERVICE_TOKEN` to reach a server with. */
  | "no-server"
  /** The leg exists but the command is not on this host's dispatch table. */
  | "unavailable"
  /** The host refused (no snapshot, unknown model, widened re-mint, …). */
  | "rejected"
  /** Transport failure. */
  | "network"

export type MintTicketOutcome =
  | { ok: true; via: "bridge" | "rpc"; ticket: MintedRouteTicket }
  | { ok: false; via: "bridge" | "rpc"; reason: MintTicketFailureReason; message: string }

export interface MintTicketDeps {
  fetch?: typeof fetch
  detect?: typeof detectDesktop
  env?: Record<string, string | undefined>
}

function toTicket(
  payload: Record<string, unknown>,
  fallbackEndpoint?: string
): MintedRouteTicket | null {
  const ticket = payload.ticket as Record<string, unknown> | undefined
  const secret = payload.secret
  if (!ticket || typeof secret !== "string") return null
  const endpoint = typeof payload.endpoint === "string" ? payload.endpoint : fallbackEndpoint
  if (!endpoint) return null
  return {
    endpoint,
    ticketId: String(ticket.ticketId ?? ""),
    secret,
    modelBindings: (ticket.modelBindings as Record<string, string> | undefined) ?? {},
    expiresAtMs: Number(ticket.expiresAtMs ?? 0),
  }
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await res.json()) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Desktop leg. */
export async function mintRouteTicketViaBridge(
  request: TicketMintRequest,
  deps: MintTicketDeps = {}
): Promise<MintTicketOutcome> {
  const detect = deps.detect ?? detectDesktop
  const endpoint = await detect(deps.fetch ? { fetch: deps.fetch } : {})
  if (!endpoint) {
    return {
      ok: false,
      via: "bridge",
      reason: "no-desktop",
      message: "the Cognia desktop app is not running (no live CLI bridge endpoint)",
    }
  }
  const doFetch = deps.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${endpoint.baseUrl}${BRIDGE_ROUTE_TICKET_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [DEV_TOKEN_HEADER]: endpoint.devToken },
      body: JSON.stringify(request),
    })
  } catch (error) {
    return { ok: false, via: "bridge", reason: "network", message: (error as Error).message }
  }
  const body = await readBody(res)
  if (!res.ok) {
    const message =
      typeof body.error === "string" ? body.error : `bridge answered HTTP ${res.status}`
    const reason: MintTicketFailureReason = res.status === 404 ? "unavailable" : "rejected"
    return { ok: false, via: "bridge", reason, message }
  }
  const ticket = toTicket(body)
  if (!ticket) {
    return { ok: false, via: "bridge", reason: "rejected", message: "bridge returned no ticket" }
  }
  return { ok: true, via: "bridge", ticket }
}

/**
 * Headless leg: `POST {COGNIA_SERVER_URL}/internal/_rpc/gateway_mint_route_ticket`
 * with the service token. The dispatch arm for that command is registered by
 * the headless RPC batch. A server without it answers `unknown_command`,
 * which this reports as `unavailable` so the caller's hint can say so.
 */
export async function mintRouteTicketViaRpc(
  request: TicketMintRequest,
  deps: MintTicketDeps = {}
): Promise<MintTicketOutcome> {
  const env = deps.env ?? process.env
  const serverUrl = env[SERVER_URL_ENV]
  const serviceToken = env[SERVICE_TOKEN_ENV]
  if (!serverUrl || !serviceToken) {
    return {
      ok: false,
      via: "rpc",
      reason: "no-server",
      message: `no headless server configured (${SERVER_URL_ENV} and ${SERVICE_TOKEN_ENV})`,
    }
  }
  const doFetch = deps.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(
      `${serverUrl.replace(/\/$/, "")}/internal/_rpc/${RPC_ROUTE_TICKET_COMMAND}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify({ request }),
      }
    )
  } catch (error) {
    return { ok: false, via: "rpc", reason: "network", message: (error as Error).message }
  }
  const body = await readBody(res)
  if (!res.ok) {
    const code = typeof body.code === "string" ? body.code : undefined
    const message =
      typeof body.message === "string" ? body.message : `server answered HTTP ${res.status}`
    const reason: MintTicketFailureReason =
      res.status === 404 || code === "unknown_command" ? "unavailable" : "rejected"
    return { ok: false, via: "rpc", reason, message }
  }
  const gatewayPort = body.gatewayPort
  const ticket = toTicket(
    body,
    typeof gatewayPort === "number" ? `http://127.0.0.1:${gatewayPort}/v1` : undefined
  )
  if (!ticket) {
    return { ok: false, via: "rpc", reason: "rejected", message: "server returned no ticket" }
  }
  return { ok: true, via: "rpc", ticket }
}

export interface MintRouteTicketResult {
  outcome: MintTicketOutcome
  /** Every leg's answer, for the actionable hint on failure. */
  attempts: MintTicketOutcome[]
}

/** Bridge first, then rpc. The first success wins. */
export async function mintRouteTicket(
  request: TicketMintRequest,
  deps: MintTicketDeps = {}
): Promise<MintRouteTicketResult> {
  const attempts: MintTicketOutcome[] = []
  for (const leg of [mintRouteTicketViaBridge, mintRouteTicketViaRpc]) {
    const outcome = await leg(request, deps)
    attempts.push(outcome)
    if (outcome.ok) return { outcome, attempts }
  }
  return { outcome: attempts[attempts.length - 1]!, attempts }
}

/** One line per failed leg, for the "here is how to fix it" message. */
export function describeMintFailure(attempts: MintTicketOutcome[]): string {
  return attempts
    .filter((attempt): attempt is Extract<MintTicketOutcome, { ok: false }> => !attempt.ok)
    .map((attempt) => `${attempt.via}: ${attempt.message}`)
    .join("\n  ")
}
