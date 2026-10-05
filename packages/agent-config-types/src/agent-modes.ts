// Run-mode vocabularies shared by every engine and host.
//
// A leaf with no imports: the sidecar's wire types read these without pulling
// in `./index` (which reaches into app types) or the Claude Agent SDK, so a
// host built without the SDK still type-checks the wire it accepts (ADR-0217).
// `./index` re-exports everything here.

/**
 * Every permission mode the Agent SDK accepts.
 *
 * Declared once because it was previously written out by hand at each use site
 * and the copies disagreed: `SendOptions.permissionMode` listed six values
 * while `AgentExecutionHandle.setPermissionMode` listed four, so `dontAsk` and
 * `auto` could be set when a session STARTED but never switched to mid-session
 * — with nothing in the types saying why.
 *
 * `dontAsk` and `auto` are the autonomous end of the range and belong behind an
 * Advanced affordance in UI; the safety-ordered cycle in
 * `components/chat/permission-mode-indicator.tsx` deliberately does not include
 * them.
 */
export type AgentPermissionMode =
  "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto"

/** Every {@link AgentPermissionMode}, in escalation order. */
export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  "plan",
  "default",
  "acceptEdits",
  "dontAsk",
  "auto",
  "bypassPermissions",
]

/** An on-disk settings layer a run may load. */
export type AgentSettingSource = "user" | "project" | "local"

/** A named reasoning effort level. */
export type AgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max"
