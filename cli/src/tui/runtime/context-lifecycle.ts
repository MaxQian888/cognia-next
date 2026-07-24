/**
 * When a changed setting actually takes effect on an external backend.
 *
 * The built-in sidecar re-reads resolved `SendOptions` on every send, so any
 * change lands on the next turn and nobody had to think about layers. ACP and
 * the Codex app-server do not work that way: instructions, roots, model,
 * permission mode and the MCP/tool surface are consumed ONCE at `session/new`,
 * and reasoning effort / native skill roots are read even earlier, when the
 * agent process is registered.
 *
 * Without one rule for that, `/mode`, `/skill`, `/mcp`, `/tools`, `/add-dir`,
 * plugin toggles and a system-prompt edit each behaved differently — some
 * applied next turn, some silently did nothing while the TUI showed them as
 * active. This module is the single answer, so every command site can ask rather
 * than guess.
 */

/** Where a changed field has to be applied for it to be true. */
export type ContextLayer =
  /** Rides the next message. Nothing to restart. */
  | "turn"
  /** Applied to the live protocol session in place, when the adapter allows. */
  | "live"
  /** Baked into `session/new` — the protocol session must be recreated. */
  | "session"
  /** Read when the agent process is registered — the backend must reconnect. */
  | "connect"

export interface ContextFieldLifecycle {
  /** The user-facing setting or command that changes this field. */
  field: string
  layer: ContextLayer
  /** Why it lands in that layer — shown by `/doctor`. */
  reason: string
}

/**
 * The table. Ordered from cheapest to most disruptive so a summary reads well.
 *
 * `session`-layer entries are the ones that force a restart of the external
 * agent's conversational context; the session detects that itself by comparing
 * the resolved context version, so this table describes behaviour rather than
 * driving it — which is precisely why it must stay accurate.
 */
export const CONTEXT_FIELD_LIFECYCLE: readonly ContextFieldLifecycle[] = [
  {
    field: "Twin context",
    layer: "turn",
    reason: "per-turn recall rides the message itself",
  },
  {
    field: "Attachments",
    layer: "turn",
    reason: "resolved from the prompt each time",
  },
  {
    field: "Permission mode",
    layer: "live",
    reason: "switched on the live session when the adapter supports it",
  },
  {
    field: "Model",
    layer: "live",
    reason: "switched on the live session; otherwise applies next turn",
  },
  {
    field: "System prompt",
    layer: "session",
    reason: "session/new consumed it — a second copy would conflict",
  },
  { field: "Agent mode", layer: "session", reason: "changes the resolved prompt and tool policy" },
  { field: "Skills", layer: "session", reason: "the skill catalog is part of the prompt" },
  { field: "Output style", layer: "session", reason: "composed into the system prompt" },
  { field: "MCP servers", layer: "session", reason: "attached at session/new" },
  { field: "Cognia tools", layer: "session", reason: "the tool host is attached at session/new" },
  { field: "Plugin tools", layer: "session", reason: "changes the projected tool manifest" },
  { field: "Working roots", layer: "session", reason: "session/new fixes the workspace" },
  {
    field: "Thinking level",
    layer: "connect",
    reason: "Codex reads reasoning effort when the agent is registered",
  },
  {
    field: "External skill roots",
    layer: "connect",
    reason: "Codex scans them when the agent is registered",
  },
]

/** The layer a field applies at, or undefined when it is not in the table. */
export function layerForField(field: string): ContextLayer | undefined {
  return CONTEXT_FIELD_LIFECYCLE.find((entry) => entry.field === field)?.layer
}

/** Fields grouped by layer — what `/doctor` prints. */
export function fieldsByLayer(layer: ContextLayer): string[] {
  return CONTEXT_FIELD_LIFECYCLE.filter((entry) => entry.layer === layer).map((e) => e.field)
}

/**
 * The one-line notice shown before the external agent's context is recreated.
 *
 * It has to say what is KEPT as well as what restarts: the TUI transcript stays
 * on screen either way, so without this the user cannot tell whether the agent
 * still remembers the conversation above.
 */
export const CONTEXT_RESTART_NOTICE =
  "Session settings changed — restarting the external agent's context. Your transcript is kept; the agent starts this turn fresh."

/** Does changing this field require dropping and reconnecting the backend? */
export function requiresReconnect(field: string): boolean {
  return layerForField(field) === "connect"
}
