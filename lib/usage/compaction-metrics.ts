/**
 * Compaction phase + effectiveness metrics, derived purely from the in-memory
 * message log — no Dexie schema, no persistence.
 *
 * The sidecar emits a `compact_boundary` system event which the adapter
 * (`lib/claude/adapter.ts:appendCompactBoundary`) projects into a `system`-role
 * `UIMessage` carrying a single `compact-boundary` part
 * ({@link CompactBoundaryPartData}). That part already carries `preTokens` /
 * `postTokens`, so the token delta is on the wire; when a path omits them we
 * fall back to the surrounding assistant turns' window occupancy.
 *
 * Two consumers:
 *  • the boundary marker UI shows "context reset · phase N · reclaimed X%";
 *  • the send hooks read {@link deriveContextPhases} to inject a one-shot
 *    post-compaction recovery preamble on the first turn of a new phase.
 *
 * Everything here is deterministic and clock-free.
 */

import type { UIMessage } from "ai"

import {
  type CompactBoundaryPartData,
  isCompactBoundaryMessage,
} from "@/components/chat/message-parts/compact-boundary-part"
import { tokensInWindow } from "@/lib/claude/usage"
import type { UsageInfo } from "@/lib/claude/adapter"

/**
 * One contiguous stretch of conversation between compaction boundaries.
 * `phaseNumber` is 0 before the first boundary and increments by one per
 * boundary. `turnLabel` is the assistant-turn index at which the reset
 * happened (for the "context reset at turn N" label).
 */
export interface ContextPhase {
  phaseNumber: number
  /** Id of the first message that belongs to this phase. */
  startMessageId?: string
  /** Id of the compact-boundary marker that opened this phase (phase > 0). */
  boundaryId?: string
  /** Assistant-turn index where the reset occurred (phase > 0). */
  turnLabel: number
}

/** Pre/post window occupancy around one compaction boundary. */
export interface CompactionTokenDelta {
  boundaryId: string
  phaseNumber: number
  /** Window tokens just before the boundary. */
  preCompactionTokens: number
  /** Window tokens just after the boundary. */
  postCompactionTokens: number
  /** Tokens reclaimed (`pre - post`); never negative. */
  delta: number
  /** `delta / pre`, clamped to [0, 1]; 0 when `pre` is unknown. */
  effectiveness: number
  trigger?: string
  strategy?: string
}

/** Read the boundary part off a marker message. */
function boundaryPart(message: UIMessage): CompactBoundaryPartData | null {
  if (!isCompactBoundaryMessage(message)) return null
  return message.parts[0] as unknown as CompactBoundaryPartData
}

/** Pull the `UsageInfo` off one assistant message, if present. */
function assistantUsage(message: UIMessage): UsageInfo | null {
  if (message.role !== "assistant") return null
  const meta = (message as { metadata?: Record<string, unknown> }).metadata
  const usage = meta?.usage as UsageInfo | undefined
  return usage ?? null
}

/** Window tokens of the nearest assistant turn before `index` (exclusive). */
function tokensBefore(messages: UIMessage[], index: number): number | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const usage = assistantUsage(messages[i])
    if (usage) return tokensInWindow(usage)
  }
  return undefined
}

/** Window tokens of the nearest assistant turn after `index` (exclusive). */
function tokensAfter(messages: UIMessage[], index: number): number | undefined {
  for (let i = index + 1; i < messages.length; i++) {
    const usage = assistantUsage(messages[i])
    if (usage) return tokensInWindow(usage)
  }
  return undefined
}

/**
 * Split the message log into context phases. A session with no boundaries
 * returns a single phase 0. Each boundary opens a new phase whose
 * `startMessageId` is the first message after the marker.
 */
export function deriveContextPhases(messages: UIMessage[]): ContextPhase[] {
  const phases: ContextPhase[] = []
  let phaseNumber = 0
  let assistantTurns = 0
  let pendingStart: string | undefined = messages[0]?.id
  let currentBoundaryId: string | undefined

  // Seed phase 0.
  phases.push({ phaseNumber: 0, startMessageId: pendingStart, turnLabel: 0 })

  for (const message of messages) {
    const part = boundaryPart(message)
    if (part) {
      phaseNumber += 1
      currentBoundaryId = message.id
      pendingStart = undefined
      phases.push({
        phaseNumber,
        boundaryId: currentBoundaryId,
        startMessageId: undefined,
        turnLabel: assistantTurns,
      })
      continue
    }
    // First non-boundary message after a boundary opens the new phase.
    if (pendingStart === undefined && phases.length > 0) {
      const last = phases[phases.length - 1]
      if (last.startMessageId === undefined) last.startMessageId = message.id
      pendingStart = message.id
    }
    if (message.role === "assistant") assistantTurns += 1
  }

  return phases
}

/**
 * The phase number a given message id falls in. Returns 0 when the id is
 * unknown or before any boundary.
 */
export function phaseOfMessage(messages: UIMessage[], id: string): number {
  let phaseNumber = 0
  for (const message of messages) {
    if (message.id === id) return phaseNumber
    if (boundaryPart(message)) phaseNumber += 1
  }
  // Unknown id — no phase to attribute it to.
  return 0
}

/**
 * Compute the pre/post token delta + effectiveness for every compaction
 * boundary in the log. Prefers the boundary part's own `preTokens`/`postTokens`
 * and falls back to the surrounding assistant turns' window occupancy. Boundaries
 * with no resolvable pre-token figure still emit a row (delta/effectiveness 0)
 * so the UI can show the reset without dividing by zero.
 */
export function computeCompactionTokenDeltas(messages: UIMessage[]): CompactionTokenDelta[] {
  const deltas: CompactionTokenDelta[] = []
  let phaseNumber = 0

  for (let i = 0; i < messages.length; i++) {
    const part = boundaryPart(messages[i])
    if (!part) continue
    phaseNumber += 1

    const pre = part.preTokens ?? tokensBefore(messages, i) ?? 0
    const post = part.postTokens ?? tokensAfter(messages, i) ?? 0
    const delta = Math.max(0, pre - post)
    const effectiveness = pre > 0 ? Math.min(1, Math.max(0, delta / pre)) : 0

    deltas.push({
      boundaryId: messages[i].id,
      phaseNumber,
      preCompactionTokens: pre,
      postCompactionTokens: post,
      delta,
      effectiveness,
      trigger: part.trigger,
      strategy: part.strategy,
    })
  }

  return deltas
}

/**
 * Whether the NEXT turn is the first one after a compaction boundary — i.e. the
 * most recent boundary has no assistant turn following it yet. Returns the phase
 * number that turn opens (= total boundary count), or `null` when no recovery is
 * pending. Stateless: once the assistant responds in the new phase, an assistant
 * message appears after the boundary and this returns `null` again, so a send
 * hook calling it per turn injects the recovery preamble exactly once.
 */
export function pendingRecoveryPhase(messages: UIMessage[]): number | null {
  let lastBoundaryIndex = -1
  let boundaryCount = 0
  for (let i = 0; i < messages.length; i++) {
    if (boundaryPart(messages[i])) {
      lastBoundaryIndex = i
      boundaryCount += 1
    }
  }
  if (lastBoundaryIndex === -1) return null
  for (let i = lastBoundaryIndex + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") return null
  }
  return boundaryCount
}

/**
 * Index the latest compaction delta by boundary id, for O(1) UI lookup from a
 * boundary marker.
 */
export function indexDeltasByBoundary(
  deltas: CompactionTokenDelta[]
): Map<string, CompactionTokenDelta> {
  return new Map(deltas.map((d) => [d.boundaryId, d]))
}
