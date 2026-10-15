import {
  EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES,
  type ExternalAgentLifecycleErrorCode,
} from "@/types/agent/external-agent-lifecycle"
import type { AgentReadinessState } from "./agent-readiness"
import { getReadinessRemedy, type ReadinessRemedy } from "./readiness-remedy"

const remedies: Record<ExternalAgentLifecycleErrorCode, ReadinessRemedy | null> = {
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

describe("getReadinessRemedy", () => {
  it.each(EXTERNAL_AGENT_LIFECYCLE_ERROR_CODES)("maps %s to its targeted remedy", (code) => {
    expect(getReadinessRemedy(code, "blocked")).toBe(remedies[code])
  })

  it.each<[AgentReadinessState, ReadinessRemedy | null]>([
    ["disabled", "enable"],
    ["error", "retry"],
    ["off", "connect"],
    ["blocked", null],
    ["connected", null],
    ["connecting", null],
  ])("maps %s without a lifecycle verdict", (state, remedy) => {
    expect(getReadinessRemedy(undefined, state)).toBe(remedy)
  })

  it("keeps the targeted remedy when lifecycle reconciliation disables an agent", () => {
    expect(getReadinessRemedy("adapter_unavailable", "disabled")).toBe("open-plugins")
    expect(getReadinessRemedy("consent_required", "disabled")).toBe("consent")
  })

  it("does not offer retry for a lifecycle reason with no supported remedy", () => {
    expect(getReadinessRemedy("platform_unsupported", "error")).toBeNull()
    expect(getReadinessRemedy("runtime_missing", "error")).toBe("open-runtimes")
  })
})
