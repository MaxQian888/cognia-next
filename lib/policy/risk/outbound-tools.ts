/**
 * The one list of agent-callable tools that send something to someone.
 *
 * Two consumers read it, for two different questions:
 *
 * - The risk classifier (ADR-0070) asks what a roster *can reach*. Its
 *   `external-send` surface is {@link RISK_EXTERNAL_SEND_TOOL_IDS}: tools that
 *   can deliver to a recipient the requester did not name.
 * - The outbound policy engine (ADR-0239) asks *who this call delivers to*.
 *   It reviews every tool in {@link OUTBOUND_TOOL_IDS}, including ones whose
 *   usual target is the requester's own thread, because that is a question
 *   about the arguments, not the tool.
 *
 * The risk set is deliberately the smaller one. `team_post_to_chat` is offered
 * to every IM-triggered team; counting it as external-send would fail every
 * headless IM team run closed, which ADR-0070 rejected. The IM built-in skills
 * and the external-bridge send tool can reach arbitrary recipients and belong
 * in the risk set too, but adding them changes plan gating for every team and
 * goal that can use them, so that is a separate change made once the outbound
 * engine's shadow mode shows how many runs it touches. The gap is
 * {@link OUTBOUND_TOOLS_OUTSIDE_RISK}, pinned by `outbound-tools.test.ts`.
 *
 * Leaf module: no imports, so the classifier, the permission options and the
 * engine can all depend on it.
 */

/**
 * A tool id reduced to the name the tool was registered under: the last `__`
 * segment, so `mcp__cognia-tools__send_email` and `send_email` are the same
 * tool, trimmed and lowercased.
 */
export function normalizeToolId(id: string): string {
  const tail = id.split("__").pop() ?? id
  return tail.trim().toLowerCase()
}

/** What the risk classifier counts as `external-send` (ADR-0070). */
export const RISK_EXTERNAL_SEND_TOOL_IDS: ReadonlySet<string> = new Set([
  "connector_send",
  "send_message",
  "send_email",
  // Publishing a Cognia Site puts a URL other people can load in front of the
  // world, and it cannot be unsent: `takeDown` removes the Site, it does not
  // restore the previous version. `build_site` produces an immutable local
  // version and is deliberately absent.
  "deploy_site",
  // An agent publishing a conversation's files as a public link or handing out
  // network-drive access (ADR-0222 §9). `filespace_list` and the revoking
  // tools only read or take access away, and are deliberately absent.
  "filespace_share",
  "filespace_enable_webdav",
])

/**
 * Outbound tools the risk classifier does not count yet. See the module
 * comment for why this is a deliberate, temporary gap.
 */
export const OUTBOUND_TOOLS_OUTSIDE_RISK: ReadonlySet<string> = new Set([
  // Built-in IM skills (`lib/skills/built-in/im/`), by their `mcpToolName`.
  "im_broadcast",
  "im_create_chat",
  "im_dispatch_task",
  // An Agent Team posting into its own IM conversation or a sibling one.
  "team_post_to_chat",
  // The external bridge's one write tool (`lib/external-bridge/mcp-server/`).
  "connectors_send_message",
])

/**
 * Every tool whose call the outbound policy engine reviews (ADR-0239).
 *
 * Not outbound, on purpose: `send_session_message` and `team_send_message`
 * reach another of the user's own sessions or teammates, never a third party;
 * `im_invite_members` and `im_update_chat` change who is in a chat or what it
 * is called without delivering content.
 */
export const OUTBOUND_TOOL_IDS: ReadonlySet<string> = new Set([
  ...RISK_EXTERNAL_SEND_TOOL_IDS,
  ...OUTBOUND_TOOLS_OUTSIDE_RISK,
])

/** True when the outbound policy engine reviews calls to this tool. */
export function isOutboundToolId(id: string): boolean {
  return OUTBOUND_TOOL_IDS.has(normalizeToolId(id))
}

/**
 * Shell tools by registered name: a call runs a command line, which may hold
 * a `gh` write (ADR-0239 phase 2, `lib/policy/action-review/gh-targets.ts`).
 */
export const SHELL_TOOL_IDS: ReadonlySet<string> = new Set([
  "bash",
  "sandbox_bash",
  "shell_execute_advanced",
  "start_process",
])

/**
 * True when a call might write to GitHub (ADR-0239 phase 2): an integration
 * action (`integration__<plugin>__<integration>__<action>`), or a shell tool
 * whose arguments mention `gh` (without `input`, any shell tool). Cheap, for
 * hot paths deciding whether to load the outbound planner at all; the planner
 * decides exactly from the parsed command and the integration registry.
 */
export function mayWriteToGithub(toolName: string, input?: unknown): boolean {
  if (/(^|__)integration__[^_]/.test(toolName.trim().toLowerCase())) return true
  if (!SHELL_TOOL_IDS.has(normalizeToolId(toolName))) return false
  if (input === undefined) return true
  let text: string
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input) ?? "")
  } catch {
    return true
  }
  return /\bgh\b/.test(text)
}

/**
 * True when the outbound policy may review this call: {@link isOutboundToolId}
 * or {@link mayWriteToGithub}.
 */
export function mayBeOutboundCall(toolName: string, input?: unknown): boolean {
  return isOutboundToolId(toolName) || mayWriteToGithub(toolName, input)
}
