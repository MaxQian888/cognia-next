import type { ExternalAgentLifecycleErrorCode } from "@/types/agent/external-agent-lifecycle"
import type { AgentReadinessState } from "./agent-readiness"

export type ReadinessRemedy =
  | "open-runtimes"
  | "edit-credentials"
  | "open-plugins"
  | "consent"
  | "use-shared-state"
  | "edit-session-limit"
  | "enable"
  | "retry"
  | "connect"

const LIFECYCLE_REMEDIES: Record<ExternalAgentLifecycleErrorCode, ReadinessRemedy | null> = {
  runtime_missing: "open-runtimes",
  version_unsupported: "open-runtimes",
  version_uncertified: "open-runtimes",
  integrity_failed: "open-runtimes",
  credential_missing: "edit-credentials",
  adapter_unavailable: "open-plugins",
  active_sessions: null,
  runtime_referenced: null,
  consent_required: "consent",
  platform_unsupported: null,
  state_isolation_unsupported: "use-shared-state",
  session_limit_reached: "edit-session-limit",
}

/** One actionable remedy for the current gate, independent of UI and locale. */
export function getReadinessRemedy(
  reasonCode: ExternalAgentLifecycleErrorCode | undefined,
  state: AgentReadinessState
): ReadinessRemedy | null {
  if (reasonCode) return LIFECYCLE_REMEDIES[reasonCode]
  if (state === "disabled") return "enable"
  if (state === "error") return "retry"
  if (state === "off") return "connect"
  return null
}
