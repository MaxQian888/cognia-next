/**
 * Which Squad, if any, runs this turn.
 *
 * Two inputs, in priority order, mirroring the shape
 * `lib/connectors/policy-resolve.ts` uses for the IM lane:
 *
 *  1. **The turn's own choice.** The composer's executor selector writes an
 *     `orchestration` axis for one send and then resets (a sticky override
 *     would quietly become a session-level switch, and then nothing on screen
 *     names what the conversation is bound to).
 *  2. **The conversation's default** — `ChatSession.squadId`, the storage of
 *     record. The composition axis only ever *carries* the id; the column owns
 *     it, which is what lets the binding survive a reload and a second device.
 *
 * The override has to be able to point *down* as well as up: a conversation
 * bound to a Squad must still be able to send one plain turn. So an override
 * that names any non-`team` policy opts this turn out, while an override with
 * no `orchestration` at all means "inherit" and falls through to the session.
 */

import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"

export interface TurnSquadSources {
  /**
   * The composition selected for THIS turn only. Absent on an ordinary send.
   */
  turnOverride?: AgentCompositionSelectionV1 | null
  /** The conversation row. Only `squadId` is read. */
  session?: { squadId?: string } | null
}

export type TurnSquadSource = "turn-override" | "session"

export interface TurnSquadDecision {
  /** The Squad to run, or `null` for an ordinary single-agent turn. */
  squadId: string | null
  /**
   * Why. `"turn-override"` with a `null` squadId means the user explicitly
   * sent one plain turn from a Squad-bound conversation — worth distinguishing
   * from "never had a Squad" so the caller can say so.
   */
  source: TurnSquadSource | "none"
}

const NO_SQUAD: TurnSquadDecision = { squadId: null, source: "none" }

export function resolveTurnSquad(sources: TurnSquadSources): TurnSquadDecision {
  const override = sources.turnOverride
  const orchestration = override?.orchestration

  if (orchestration !== undefined) {
    if (orchestration !== "team") {
      // An explicit non-team choice for this turn. Beats the session default
      // rather than being merged with it.
      return { squadId: null, source: "turn-override" }
    }
    const ref = override?.orchestrationRef?.trim()
    // `team` with no target is not a Squad turn. It is a half-made selection —
    // treating it as "the session's Squad" would silently run something the
    // user did not pick.
    if (ref) return { squadId: ref, source: "turn-override" }
    return { squadId: null, source: "turn-override" }
  }

  const bound = sources.session?.squadId?.trim()
  if (bound) return { squadId: bound, source: "session" }
  return NO_SQUAD
}
