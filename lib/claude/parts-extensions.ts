// Part type extensions specific to cognia-next.
//
// AI SDK's UIMessage parts is an open-ended array — registries that don't
// know our `type: "a2ui"` value will simply ignore it. We declare the shape
// here so adapter / message renderer / a2ui-part can share a single source
// of truth without leaking into the AI SDK's own typings.

/**
 * Source of an A2UI message inside a chat assistant turn.
 *
 * - `codeblock` — extracted from a fenced ```a2ui``` block (or generic JSON
 *   block whose content satisfies `detectA2UIContent`).
 * - `tool-result` — a tool-call result whose payload parsed as A2UI messages
 *   (replaces the bare tool result so the user sees the surface, not raw JSON).
 * - `acp-stream` — emitted as a JSON-line by an external ACP-over-stdio agent
 *   and sniffed by the external-agent-store's stdout handler.
 * - `mcp-bridge` — dispatched by the in-process / standalone MCP server when
 *   an agent calls one of the `a2ui_*` tools.
 */
export type A2UIPartSource = "codeblock" | "tool-result" | "acp-stream" | "mcp-bridge"

/**
 * A2UI message part attached to an assistant `UIMessage`. The surface itself
 * lives in `useA2UIStore`; this part only carries a pointer plus a copy of
 * the original payload so the surface can be re-hydrated on reload.
 */
export interface A2UIPart {
  type: "a2ui"
  /** Stable surface identifier — same one persisted in `a2uiSurfaces`. */
  surfaceId: string
  /**
   * Raw a2ui payload (codeblock body, tool-result text, or stringified
   * MCP tool args). The renderer feeds this back through `processMessage`
   * after a cold hydrate to rebuild the surface deterministically.
   */
  content: string
  source: A2UIPartSource
  /** Tool-call id when `source === "tool-result"`. */
  toolUseId?: string
}

export function isA2UIPart(part: unknown): part is A2UIPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "a2ui" &&
    typeof (part as { surfaceId?: unknown }).surfaceId === "string" &&
    typeof (part as { content?: unknown }).content === "string"
  )
}

// ---- Phase 8 chat-render parts -----------------------------------------

import type { SubAgentStatus } from "@/types/agent/sub-agent"

/**
 * SubagentPart — emitted by `lib/claude/subagent-bridge.ts` whenever the
 * runtime store receives a SubAgent event. The renderer subscribes to the
 * runtime store for live `progress` / `logs` updates; this part carries
 * just the stable identity bits + status snapshot used for sort/group.
 */
export interface SubagentPart {
  type: "subagent"
  /** Matches `SubAgent.id` in the runtime store. */
  subagentId: string
  /** Session this subagent was spawned from (i.e., the assistant turn). */
  parentSessionId: string
  name: string
  status: SubAgentStatus
  /** 0..100 — kept on the part so it survives a cold reload. */
  progress: number
  /** Epoch ms; serialized so it round-trips through Dexie. */
  startedAt: number
  completedAt?: number
  summary?: string
  toolUseId?: string
}

export function isSubagentPart(part: unknown): part is SubagentPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "subagent" &&
    typeof (part as { subagentId?: unknown }).subagentId === "string"
  )
}

/**
 * AgentTeamDispatchPart — emitted when a supervisor turn contains a
 * `<dispatch to="…">…</dispatch>` directive (parsed by
 * `lib/claude/team-router.ts:parseDispatches`). One part per dispatch tag,
 * appended after the visible (stripped) text. The renderer shows a
 * from→to banner with the task body.
 */
export interface AgentTeamDispatchPart {
  type: "agent-team-dispatch"
  /** Sender character id (the supervisor). */
  from: string
  /** Target character id resolved against the team's member list. */
  to: string
  /** Display name of the target — used when characterById lookup fails. */
  toName: string
  task: string
  sessionId: string
}

export function isAgentTeamDispatchPart(part: unknown): part is AgentTeamDispatchPart {
  const p = part as { type?: unknown; to?: unknown; task?: unknown }
  return (
    typeof part === "object" &&
    part !== null &&
    p.type === "agent-team-dispatch" &&
    typeof p.to === "string" &&
    typeof p.task === "string"
  )
}
