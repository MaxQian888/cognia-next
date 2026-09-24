/**
 * computeAgentReadiness — the "can this agent run and will work reach it" model
 * behind the settings page's rail dots, overview rows, and inspector strip.
 *
 * The execution gate (`getExternalAgentExecutionBlock`) is mocked: it is
 * covered by its own suite, and keeping it a mock here is what pins the model
 * to the gate's contract rather than to whichever protocols happen to be
 * registered in the test environment.
 */

import type {
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"

import type { ExternalAgentExecutionBlockAssessment } from "./config/config-normalizer"
import { computeAgentReadiness } from "./agent-readiness"

const mockExecutionBlock = jest.fn<
  ExternalAgentExecutionBlockAssessment | null,
  [ExternalAgentConfig]
>(() => null)
jest.mock("./config/config-normalizer", () => ({
  getExternalAgentExecutionBlock: (agent: ExternalAgentConfig, _reach?: unknown) =>
    mockExecutionBlock(agent),
}))

const BASE_AGENT: ExternalAgentConfig = {
  id: "a1",
  name: "Agent",
  protocol: "acp",
  transport: "stdio",
  enabled: true,
}

const VALIDITY_OK: ExternalAgentValiditySnapshot = {
  executable: true,
  checkedAt: new Date(0),
  source: "connect",
  sessionExtensions: {
    "session/list": { state: "unknown" },
    "session/fork": { state: "unknown" },
    "session/resume": { state: "unknown" },
  },
}

function readiness(
  overrides: Partial<Parameters<typeof computeAgentReadiness>[0]> = {},
  agent: Partial<ExternalAgentConfig> = {}
) {
  return computeAgentReadiness({
    agent: { ...BASE_AGENT, ...agent },
    connectionStatus: "disconnected",
    delegatedRuleCount: 0,
    ...overrides,
  })
}

function stepStates(r: ReturnType<typeof computeAgentReadiness>) {
  return Object.fromEntries(r.steps.map((s) => [s.id, s.state]))
}

describe("computeAgentReadiness", () => {
  beforeEach(() => mockExecutionBlock.mockReset().mockReturnValue(null))

  it("is fully ready for a connected, routed agent", () => {
    const r = readiness({ connectionStatus: "connected", delegatedRuleCount: 2 })
    expect(r.state).toBe("connected")
    expect(r.nextAction).toBeNull()
    expect(stepStates(r)).toEqual({
      configured: "done",
      runnable: "done",
      connected: "done",
      routed: "done",
    })
  })

  it("treats a deliberately disabled agent as off, never as a failure", () => {
    const r = readiness({}, { enabled: false })
    expect(r.state).toBe("disabled")
    expect(r.blockReason).toBeNull()
    expect(r.nextAction).toBe("enable")
    // The gate is not even asked: a disabled verdict is a user choice.
    expect(mockExecutionBlock).not.toHaveBeenCalled()
    expect(stepStates(r)).toEqual({
      configured: "done",
      runnable: "off",
      connected: "off",
      routed: "todo",
    })
  })

  it("marks runnable as failed with the gate's reason when blocked", () => {
    mockExecutionBlock.mockReturnValue({ code: "transport_blocked", reason: "needs a Host" })
    const r = readiness()
    expect(r.state).toBe("blocked")
    expect(r.blockReason).toBe("needs a Host")
    expect(r.nextAction).toBe("inspect")
    expect(stepStates(r)).toEqual({
      configured: "done",
      runnable: "failed",
      connected: "todo",
      routed: "todo",
    })
  })

  it("renders a transient block as still-checking, not as a settled failure", () => {
    // A plugin adapter mid-registration or a Host mid-handshake resolves on
    // its own; flagging it failed invites a fix the user does not need to make.
    mockExecutionBlock.mockReturnValue({
      code: "protocol_unsupported",
      reason: "adapter registering",
      transient: true,
    })
    const r = readiness()
    expect(r.state).toBe("blocked")
    expect(r.blockTransient).toBe(true)
    expect(stepStates(r).runnable).toBe("current")
  })

  it("prefers the runtime validity verdict over the static gate", () => {
    const validity: ExternalAgentValiditySnapshot = {
      ...VALIDITY_OK,
      executable: false,
      blockingReason: "binary missing on PATH",
    }
    const r = readiness({ validity })
    expect(r.state).toBe("blocked")
    expect(r.blockReason).toBe("binary missing on PATH")
    expect(stepStates(r).runnable).toBe("failed")
  })

  it("a settled runtime verdict is not softened by a transient gate", () => {
    mockExecutionBlock.mockReturnValue({
      code: "transport_blocked",
      reason: "gate says wait",
      transient: true,
    })
    const r = readiness({ validity: { ...VALIDITY_OK, executable: false } })
    expect(r.blockTransient).toBe(false)
    expect(stepStates(r).runnable).toBe("failed")
  })

  it("maps error and in-flight connection statuses onto the connected step", () => {
    expect(stepStates(readiness({ connectionStatus: "error" })).connected).toBe("failed")
    expect(readiness({ connectionStatus: "error" }).nextAction).toBe("retry")
    for (const s of ["connecting", "reconnecting"] as ExternalAgentConnectionStatus[]) {
      const r = readiness({ connectionStatus: s })
      expect(r.state).toBe("connecting")
      expect(r.nextAction).toBeNull()
      expect(stepStates(r).connected).toBe("current")
    }
  })

  it("offers connect to a runnable but disconnected agent", () => {
    const r = readiness({ connectionStatus: "disconnected" })
    expect(r.state).toBe("off")
    expect(r.nextAction).toBe("connect")
    expect(stepStates(r).connected).toBe("todo")
  })

  it("nudges a connected agent with no routing toward a delegation rule", () => {
    const r = readiness({ connectionStatus: "connected" })
    expect(r.state).toBe("connected")
    expect(r.nextAction).toBe("add-rule")
    expect(stepStates(r).routed).toBe("todo")
  })

  it("counts routing as configured even while disconnected", () => {
    const r = readiness({ delegatedRuleCount: 1 })
    expect(stepStates(r).routed).toBe("done")
  })

  it("defaults a missing connection status to disconnected", () => {
    const r = readiness({ connectionStatus: undefined })
    expect(r.state).toBe("off")
    expect(stepStates(r).connected).toBe("todo")
  })
})
