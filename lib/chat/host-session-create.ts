/**
 * Create a conversation on the paired Host before this client activates it.
 *
 * A paired client's new chat used to exist only in its own database. The
 * Host's `sessions` table never heard of it, so every later write that needs
 * the row — a HostState `message.enqueue`, a direct turn's durable admission,
 * the Host's transcript persister — answered `session_not_found`, and the
 * conversation's replies were never kept where the turn ran.
 *
 * The client mints the id and names its choices (workspace, agent, model,
 * provider) as a closed, id-only seed on `session.create`; the Host checks it
 * owns the workspace and agent, then writes its row. Credentials are not part
 * of the seed: each turn carries them on its own direct Agent RPC options.
 *
 * Outcomes, from the caller's side:
 * - `host` — the Host created (or already had) the row.
 * - `local` — no paired Host negotiated HostState, or the Host predates the
 *   intent. The conversation is local-only, exactly as before.
 * - `pending` — the action is durably queued but the Host did not answer in
 *   time (offline, slow link). It is delivered in order once reachable.
 * - a thrown {@link HostSessionRefusedError} — the Host refused; the caller
 *   must not activate a conversation the Host will not run.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { HostStateSessionSeed } from "@cognia/agent-config-types/host-state"

import { HOST_STATE_UNSUPPORTED_SUBMIT_CODE } from "@/lib/sync/host-state-intent-settlement"

/** Long enough for an online Host's round trip, short enough not to stall "new chat". */
export const HOST_SESSION_CREATE_WAIT_MS = 5_000

/**
 * Refusals that mean the Host already has this conversation. Only a redelivery
 * of our own create can produce one, so it is the success it looks like.
 */
const ALREADY_ON_HOST = new Set(["host_state_session_exists"])

export class HostSessionRefusedError extends Error {
  readonly code: string
  constructor(code: string) {
    super(`The paired host refused to create this conversation (${code})`)
    this.name = "HostSessionRefusedError"
    this.code = code
  }
}

export type HostSessionCreateResult = "host" | "local" | "pending"

export interface HostSessionCreateDeps {
  enqueue?: typeof import("@/lib/db/mobile-outbound-queue").enqueueHostStateIntentIfAvailable
  awaitSettlement?: typeof import("@/lib/db/mobile-outbound-queue").awaitHostStateIntentSettlement
  timeoutMs?: number
}

/** The session's own choices, as the closed wire seed. Empty when there are none. */
export function hostSessionSeed(session: ChatSession): HostStateSessionSeed | undefined {
  const seed: HostStateSessionSeed = {
    ...(session.projectId ? { projectId: session.projectId } : {}),
    ...(session.characterId ? { characterId: session.characterId } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.providerOverride ? { provider: session.providerOverride } : {}),
  }
  return Object.keys(seed).length > 0 ? seed : undefined
}

export async function createSessionOnPairedHost(
  session: ChatSession,
  options: { title?: string } = {},
  deps: HostSessionCreateDeps = {}
): Promise<HostSessionCreateResult> {
  const queue =
    deps.enqueue && deps.awaitSettlement
      ? undefined
      : await import("@/lib/db/mobile-outbound-queue")
  const enqueue = deps.enqueue ?? queue!.enqueueHostStateIntentIfAvailable
  const awaitSettlement = deps.awaitSettlement ?? queue!.awaitHostStateIntentSettlement
  const title = options.title?.trim()
  const seed = hostSessionSeed(session)
  const row = await enqueue({
    sessionId: session.id,
    action: {
      kind: "session.create",
      ...(title ? { title } : {}),
      ...(seed ? { seed } : {}),
    },
  })
  if (!row) return "local"
  const settlement = await awaitSettlement(row.id, {
    timeoutMs: deps.timeoutMs ?? HOST_SESSION_CREATE_WAIT_MS,
  })
  switch (settlement.outcome) {
    case "applied":
      return "host"
    case "pending":
      return "pending"
    case "rejected":
      if (settlement.code === HOST_STATE_UNSUPPORTED_SUBMIT_CODE) return "local"
      if (ALREADY_ON_HOST.has(settlement.code)) return "host"
      throw new HostSessionRefusedError(settlement.code)
  }
}
