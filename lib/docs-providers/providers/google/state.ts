/** Atomic credential transitions executed by the selected host, shared by WebViews. */
import { transport } from "@/lib/tauri/transport-instance"
import { DocsProviderError } from "@/lib/docs-providers/types"
import type { GoogleOAuthTokens } from "./config"
import type { GoogleOAuthPending } from "./oauth-pending"

export interface GoogleConnectionState {
  version: 1
  connection: string
  authorization: string
  tokens: GoogleOAuthTokens | null
  pending: GoogleOAuthPending | null
  claimed: boolean
  accountEmail: string | null
  legacyMetadata: boolean
}
export type GoogleStateInput =
  | { action: "snapshot" | "begin" | "disconnect" }
  | { action: "setPending"; authorization: string; pending: GoogleOAuthPending }
  | { action: "claim"; state: string; now: number }
  | { action: "commit"; authorization: string; tokens: GoogleOAuthTokens; accountEmail?: string }
  | { action: "refresh"; connection: string; tokens: GoogleOAuthTokens }
  | { action: "invalidate"; connection: string }
export type GoogleDisconnectOutcome = { revoked: true } | { revoked: false; reason: string }
export interface GoogleStateReply {
  state: GoogleConnectionState
  pending: GoogleOAuthPending | null
  outcome: GoogleDisconnectOutcome | null
}
export type GoogleStatePort = (input: GoogleStateInput) => Promise<GoogleStateReply>
let override: GoogleStatePort | null = null
export function __setGoogleStatePortForTests(port: GoogleStatePort | null): void {
  override = port
}
const observers = new Set<() => void>()
let stopSubscription: (() => void) | undefined
function notify() {
  for (const observer of observers) {
    try {
      observer()
    } catch {
      /* Observers cannot undo a host commit. */
    }
  }
}

export async function googleState(input: GoogleStateInput): Promise<GoogleStateReply> {
  try {
    return await (override
      ? override(input)
      : transport.call<GoogleStateReply>("connectors_google_docs_auth", { input }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("google_docs_state_stale"))
      throw new DocsProviderError("notAuthorized", { reason: "connection changed" })
    if (message.includes("google_docs_state_mismatch"))
      throw new DocsProviderError("notAuthorized", { reason: "oauth state mismatch" })
    throw err
  } finally {
    if (input.action !== "snapshot") notify()
  }
}

/** Events contain only a reload signal, never account data, tokens or PKCE. */
export function subscribeGoogleStateChanged(observer: () => void): () => void {
  observers.add(observer)
  if (!stopSubscription)
    stopSubscription = transport.subscribe("google-docs-connection-changed", notify)
  return () => {
    observers.delete(observer)
    if (!observers.size) {
      stopSubscription?.()
      stopSubscription = undefined
    }
  }
}
