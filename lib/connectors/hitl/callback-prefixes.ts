/** Wire namespaces for buttons whose binding is recorded by the surface author. */
export const TOOL_APPROVE_PREFIX = "tapa:"
export const TOOL_DENY_PREFIX = "tapd:"
export const TOOL_ALLOW_SESSION_PREFIX = "taps:"
/** "Allow for this request" on an outbound tool card (ADR-0239). */
export const TOOL_ALLOW_REQUEST_PREFIX = "tapr:"
export const PLAN_APPROVE_PREFIX = "plna:"
export const PLAN_REJECT_PREFIX = "plnr:"
export const MEDIA_GRANT_SESSION_PREFIX = "mgs:"
export const MEDIA_GRANT_ALWAYS_PREFIX = "mga:"
export const MEDIA_GRANT_DENY_PREFIX = "mgd:"
export const WF_APPROVE_PREFIX = "wfapp:"
export const WF_CANCEL_PREFIX = "wfcan:"
// Fan-out producer: plugins/workflow-ai/src/tools/run-by-name-tools.ts.
export const WF_FANOUT_APPROVE_PREFIX = "wffanoutapp:"
export const WF_FANOUT_CANCEL_PREFIX = "wffanoutcan:"
export const SKILL_INVOKE_PREFIX = "skill_invoke:"

const CALLBACK_ACTIONS = {
  [TOOL_APPROVE_PREFIX]: "approve",
  [TOOL_DENY_PREFIX]: "cancel",
  [TOOL_ALLOW_SESSION_PREFIX]: "approve",
  [TOOL_ALLOW_REQUEST_PREFIX]: "approve",
  [PLAN_APPROVE_PREFIX]: "approve",
  [PLAN_REJECT_PREFIX]: "cancel",
  [MEDIA_GRANT_SESSION_PREFIX]: "approve",
  [MEDIA_GRANT_ALWAYS_PREFIX]: "approve",
  [MEDIA_GRANT_DENY_PREFIX]: "cancel",
  [WF_APPROVE_PREFIX]: "approve",
  [WF_CANCEL_PREFIX]: "cancel",
  [WF_FANOUT_APPROVE_PREFIX]: "approve",
  [WF_FANOUT_CANCEL_PREFIX]: "cancel",
  [SKILL_INVOKE_PREFIX]: "approve",
} as const

export const CALLBACK_PREFIXES: readonly string[] = Object.keys(CALLBACK_ACTIONS)

export function namespacedCallbackAction(value: unknown): "approve" | "cancel" | undefined {
  if (typeof value !== "string") return undefined
  const prefix = CALLBACK_PREFIXES.find((prefix) => value.startsWith(prefix))
  return prefix ? CALLBACK_ACTIONS[prefix as keyof typeof CALLBACK_ACTIONS] : undefined
}
