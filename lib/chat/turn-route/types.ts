/**
 * A turn addressed to a runtime: the shapes, and the one reader of the
 * persisted copy.
 *
 * A direct-chat message that STARTS with `@claude`, `@codex` or `@<Squad
 * member>` runs THIS turn on that runtime instead of the conversation's own.
 * Only the leading token counts; `@codex` anywhere else is an ordinary mention
 * and routes nothing. See `parse.ts` (reading the token), `resolve.ts` (which
 * lane answers) and `snapshot.ts` (the stores those two read, at send time).
 *
 * Pure: no store, no React.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"

/** The two virtual runtimes every direct chat can address. */
export type RouteRuntime = "claude" | "codex"

export type TurnRouteTarget =
  /** `@claude` (the builtin lane) or `@codex` (a configured Codex agent). */
  | { kind: "runtime"; runtime: RouteRuntime }
  /** One turn in THIS conversation, answered as that Squad member. */
  | { kind: "squadMember"; squadId: string; teammateId: string }

export interface TurnRoute {
  target: TurnRouteTarget
  /** The handle as the target list spells it (lowercase), without the `@`. */
  handle: string
  /** What the route reads as: the runtime or the member's display name. */
  label: string
}

/**
 * Why an addressed turn cannot run. Each maps to one sentence the composer
 * shows before sending and one the send path records if it gets that far.
 *
 *  - `not-configured` — no agent of that family exists on this device or host.
 *  - `disabled`       — one exists, but the External Agents switch is off.
 *  - `blocked`        — every candidate is blocked for a reason that will not
 *                       clear by itself (a missing binary, a disabled agent).
 *  - `transient`      — every candidate is blocked for a reason that may (a
 *                       Host still handshaking, a plugin adapter not loaded).
 *  - `member-missing` — the Squad or the member is gone.
 *  - `member-runtime` — the member runs on an external runtime that is not
 *                       available here.
 */
export type RouteLaneFailure =
  "not-configured" | "disabled" | "blocked" | "transient" | "member-missing" | "member-runtime"

export type RouteLane =
  | {
      ok: true
      runtimeRef: AgentRuntimeRef
      /** Present when the turn runs AS a Squad member (its persona and model). */
      member?: { team: AgentTeam; teammate: AgentTeammate }
    }
  | {
      ok: false
      reason: RouteLaneFailure
      /** The runtime's own wording for a block, shown verbatim. */
      detail?: string
      /** The preset id the route needed, when one is involved. */
      runtime?: string
    }

const ROUTE_RUNTIMES: ReadonlySet<string> = new Set<RouteRuntime>(["claude", "codex"])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

/** Structural check for a route read back from anything persisted or passed around. */
export function isTurnRoute(value: unknown): value is TurnRoute {
  if (!value || typeof value !== "object") return false
  const route = value as Partial<TurnRoute>
  if (!isNonEmptyString(route.handle) || !isNonEmptyString(route.label)) return false
  const target = route.target as Partial<Record<string, unknown>> | undefined
  if (!target || typeof target !== "object") return false
  if (target.kind === "runtime") {
    return typeof target.runtime === "string" && ROUTE_RUNTIMES.has(target.runtime)
  }
  if (target.kind === "squadMember") {
    return isNonEmptyString(target.squadId) && isNonEmptyString(target.teammateId)
  }
  return false
}

/**
 * The route a user message was sent with (`metadata.turnRoute`), or null.
 *
 * `regenerate` re-issues the turn through this, so the new reply comes from the
 * runtime the question was addressed to rather than from whatever the
 * conversation is on now. A malformed value reads as no route: re-running an
 * old turn on the conversation's own lane is the honest fallback, never a guess
 * at a runtime.
 */
export function readTurnRoute(metadata: unknown): TurnRoute | null {
  if (!metadata || typeof metadata !== "object") return null
  const route = (metadata as { turnRoute?: unknown }).turnRoute
  return isTurnRoute(route) ? route : null
}

/**
 * Can a turn in this conversation be addressed to a runtime at all?
 *
 * Only a direct chat has a lane of its own to leave for one turn, and the
 * new-chat composer (no session yet) is one about to be created. Everything
 * else is refused, both where the `@` panel decides whether to offer route
 * rows and where the send path decides whether to honour one:
 *   - a team room routes `@Name` through its own router;
 *   - a shared transcript's turn runs wherever the collaboration server says;
 *   - an IM-bound conversation answers on the platform's runtime;
 *   - workflow and workbench panels are not conversations with a runtime chip.
 */
export function isRoutableSession(
  session: Pick<ChatSession, "kind" | "collaboration" | "platformBinding"> | null | undefined
): boolean {
  if (!session) return true
  return (
    (session.kind ?? "direct") === "direct" && !session.collaboration && !session.platformBinding
  )
}
