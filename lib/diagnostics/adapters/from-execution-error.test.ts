import {
  AgentCapabilityUnsatisfiedError,
  AgentHostUnavailableError,
} from "@/lib/ai/agent/execution/agent-execution-service"
import {
  AgentCapabilityError,
  FrozenModelBindingError,
} from "@/lib/ai/agent/execution/agent-execution-handle"

import { diagnoseDegradedReason, diagnoseExecutionError } from "./from-execution-error"

describe("diagnoseExecutionError", () => {
  it("names the capabilities that failed closed before any spend", () => {
    const out = diagnoseExecutionError(
      new AgentCapabilityUnsatisfiedError(["tools" as never, "streaming" as never])
    )
    expect(out?.code).toBe("capabilityUnsatisfied")
    expect(out?.meta.extra).toEqual({ missing: "tools, streaming" })
  })

  it("maps the per-command capability gate", () => {
    const out = diagnoseExecutionError(
      new AgentCapabilityError("streaming" as never, "claude_send")
    )
    expect(out?.code).toBe("capabilityUnsatisfied")
    expect(out?.meta.extra).toEqual({ capability: "streaming" })
  })

  it("maps an unreachable remote host", () => {
    expect(diagnoseExecutionError(new AgentHostUnavailableError("host-1"))?.code).toBe(
      "hostUnavailable"
    )
  })

  it("maps a model outside the session's frozen bindings", () => {
    expect(diagnoseExecutionError(new FrozenModelBindingError("gpt-9"))?.code).toBe(
      "frozenModelBinding"
    )
  })

  it("returns null for anything else so the funnel keeps looking", () => {
    expect(diagnoseExecutionError(new Error("boom"))).toBeNull()
    expect(diagnoseExecutionError("boom")).toBeNull()
    expect(diagnoseExecutionError(null)).toBeNull()
  })
})

describe("diagnoseDegradedReason", () => {
  it("discloses a run that quietly took a lesser path", () => {
    // The turn produced output, but not on the runtime the user configured —
    // which changes cost and quality, and used to be reported nowhere.
    expect(diagnoseDegradedReason("sidecar-unavailable")?.code).toBe("sidecarUnreachable")
    expect(diagnoseDegradedReason("host-unavailable")?.code).toBe("hostUnavailable")
    expect(diagnoseDegradedReason("legacy-completion-fallback")?.code).toBe("degradedFallback")
    expect(diagnoseDegradedReason("external-agent-unavailable")?.code).toBe("agentUnavailable")
  })

  it("keeps the reason in metadata for telemetry correlation", () => {
    expect(diagnoseDegradedReason("host-unavailable")?.meta.extra).toEqual({
      degradedReason: "host-unavailable",
    })
  })

  it("returns null when the run took the path it was asked to", () => {
    expect(diagnoseDegradedReason(undefined)).toBeNull()
  })
})
