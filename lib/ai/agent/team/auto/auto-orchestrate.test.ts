import { AutoOrchestrationPiiError, planAutoOrchestration } from "./auto-orchestrate"
import { EMPTY_CAPABILITY_CATALOG, gatherCapabilityCatalog } from "./capability-catalog"
import { gatherTwinRoster } from "./twin-roster"
import type { LlmClient } from "@/lib/twin/distill/llm"

jest.mock("./capability-catalog", () => {
  const actual = jest.requireActual("./capability-catalog")
  return { ...actual, gatherCapabilityCatalog: jest.fn(actual.gatherCapabilityCatalog) }
})
const mockGather = gatherCapabilityCatalog as jest.MockedFunction<typeof gatherCapabilityCatalog>
// The default impl passes through to the real catalog gatherer; individual
// tests override one call with mockImplementationOnce / mockRejectedValueOnce.

jest.mock("./twin-roster", () => {
  const actual = jest.requireActual("./twin-roster")
  return { ...actual, gatherTwinRoster: jest.fn(actual.gatherTwinRoster) }
})
const mockGatherTwins = gatherTwinRoster as jest.MockedFunction<typeof gatherTwinRoster>
// Same pass-through-by-default pattern as mockGather above.

const NOW = new Date("2026-06-14T00:00:00Z")

/** A client that returns canned responses per stage, keyed by a system-prompt probe. */
function stagedClient(responses: { assess?: string; roster?: string; tasks?: string }): LlmClient {
  return {
    complete: async (_prompt, options) => {
      const sys = options?.system ?? ""
      if (sys.includes("routing assessor")) return responses.assess ?? "{}"
      if (sys.includes("compose a small specialist team")) return responses.roster ?? "{}"
      if (sys.includes("decompose an objective")) return responses.tasks ?? "{}"
      return "{}"
    },
  }
}

describe("planAutoOrchestration", () => {
  it("chains the three stages into a complete proposal", async () => {
    const proposal = await planAutoOrchestration({
      objective: "Review the billing module for bugs",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      client: stagedClient({
        assess:
          '{"recommendedPattern":"parallel_specialists","confidence":0.8,"reason":"r","factors":{"taskComplexity":"moderate","specializationNeeded":true,"contextIsolationNeeded":false,"delegationCandidate":false,"budgetPressure":"low"}}',
        roster: JSON.stringify({
          teammates: [
            { name: "Lead", description: "lead" },
            { name: "Bug Hunter", specialization: "bugs", description: "finds bugs" },
          ],
        }),
        tasks: JSON.stringify({
          tasks: [
            { title: "Scan", description: "scan code", assignedTo: 1, dependencies: [] },
            { title: "Report", description: "write report", assignedTo: 0, dependencies: [0] },
          ],
        }),
      }),
    })
    expect(proposal.assessment.recommendedPattern).toBe("parallel_specialists")
    expect(proposal.roster).toHaveLength(2)
    expect(proposal.roster[0].role).toBe("lead")
    expect(proposal.tasks).toHaveLength(2)
    expect(proposal.tasks[1].dependencies).toEqual([0])
    expect(proposal.objective).toBe("Review the billing module for bugs")
  })

  it("redacts PII from the objective before it reaches the model", async () => {
    const seen: string[] = []
    const client: LlmClient = {
      complete: async (prompt, options) => {
        seen.push(prompt)
        if ((options?.system ?? "").includes("routing assessor"))
          return '{"recommendedPattern":"manager_worker"}'
        return "{}"
      },
    }
    const proposal = await planAutoOrchestration({
      objective: "Email the report to alice@example.com",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      client,
    })
    expect(proposal.objective).not.toContain("alice@example.com")
    expect(seen.join("\n")).not.toContain("alice@example.com")
  })

  it("fails CLOSED if the PII gate reports a residual leak", async () => {
    await expect(
      planAutoOrchestration({
        objective: "deploy the service",
        catalog: EMPTY_CAPABILITY_CATALOG,
        client: stagedClient({}),
        piiGate: () => ({ redacted: "deploy the service", leaked: true }),
      })
    ).rejects.toBeInstanceOf(AutoOrchestrationPiiError)
  })

  it("uses the default gate to redact real PII end-to-end", async () => {
    const proposal = await planAutoOrchestration({
      objective: "Email the report to alice@example.com now",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      client: stagedClient({ assess: '{"recommendedPattern":"manager_worker"}' }),
    })
    // Default gate redacted the email but did not flag a residual leak.
    expect(proposal.objective).not.toContain("alice@example.com")
  })

  it("still produces a proposal when every stage fails open", async () => {
    const throwing: LlmClient = {
      complete: async () => {
        throw new Error("network")
      },
    }
    const proposal = await planAutoOrchestration({
      objective: "do something useful",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      client: throwing,
    })
    expect(proposal.roster.length).toBeGreaterThanOrEqual(2)
    expect(proposal.tasks.length).toBeGreaterThanOrEqual(1)
    expect(proposal.assessment.reason).toMatch(/Heuristic/)
  })

  it("gathers a catalog when none is provided", async () => {
    mockGather.mockResolvedValueOnce({ ...EMPTY_CAPABILITY_CATALOG, skillIds: ["s1"] })
    const proposal = await planAutoOrchestration({
      objective: "simple task",
      now: () => NOW,
      client: stagedClient({ assess: '{"recommendedPattern":"single_agent_recommended"}' }),
    })
    expect(mockGather).toHaveBeenCalled()
    expect(proposal.assessment.recommendedPattern).toBe("single_agent_recommended")
  })

  it("fails open to an empty catalog when enumeration throws", async () => {
    mockGather.mockRejectedValueOnce(new Error("registry down"))
    const proposal = await planAutoOrchestration({
      objective: "do work",
      now: () => NOW,
      client: stagedClient({ assess: '{"recommendedPattern":"manager_worker"}' }),
    })
    expect(proposal.assessment.recommendedPattern).toBe("manager_worker")
  })

  it("honors preferredPattern over the routing assessment and feeds it to compose", async () => {
    let rosterPrompt = ""
    const client: LlmClient = {
      complete: async (prompt, options) => {
        const sys = options?.system ?? ""
        if (sys.includes("routing assessor"))
          return '{"recommendedPattern":"single_agent_recommended","confidence":0.9,"reason":"r","factors":{"taskComplexity":"simple","specializationNeeded":false,"contextIsolationNeeded":false,"delegationCandidate":false,"budgetPressure":"low"}}'
        if (sys.includes("compose a small specialist team")) {
          rosterPrompt = prompt
          return JSON.stringify({ teammates: [{ name: "Lead", description: "lead" }] })
        }
        return "{}"
      },
    }
    const proposal = await planAutoOrchestration({
      objective: "ship it",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      preferredPattern: "ultracode_orchestration",
      client,
    })
    // Override wins over the model's "single_agent_recommended"…
    expect(proposal.assessment.recommendedPattern).toBe("ultracode_orchestration")
    // …and reaches the roster-composition prompt.
    expect(rosterPrompt).toContain("pattern=ultracode_orchestration")
  })

  it("populates proposal.executor from the assessed pattern", async () => {
    const proposal = await planAutoOrchestration({
      objective: "ship it",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      client: stagedClient({ assess: '{"recommendedPattern":"single_agent_recommended"}' }),
    })
    expect(proposal.executor?.kind).toBe("single-send")
    expect(proposal.executor?.fromPattern).toBe("single_agent_recommended")
  })

  it("forwards an explicit twinRoster to composeRoster and includes it on the proposal", async () => {
    let rosterPrompt = ""
    const client: LlmClient = {
      complete: async (prompt, options) => {
        const sys = options?.system ?? ""
        if (sys.includes("routing assessor")) return '{"recommendedPattern":"manager_worker"}'
        if (sys.includes("compose a small specialist team")) {
          rosterPrompt = prompt
          return JSON.stringify({
            teammates: [{ name: "Lead", description: "lead", twinId: "tw1" }],
          })
        }
        return "{}"
      },
    }
    const proposal = await planAutoOrchestration({
      objective: "ship it",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      twinRoster: [{ twinId: "tw1", name: "Alice", expertise: "security" }],
      client,
    })
    expect(rosterPrompt).toContain("tw1")
    expect(proposal.twinRoster).toEqual([{ twinId: "tw1", name: "Alice", expertise: "security" }])
    expect(proposal.roster[0].twinId).toBe("tw1")
  })

  it("omits proposal.twinRoster when an explicit empty twinRoster is passed", async () => {
    const proposal = await planAutoOrchestration({
      objective: "ship it",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      twinRoster: [],
      client: stagedClient({ assess: '{"recommendedPattern":"manager_worker"}' }),
    })
    expect(proposal.twinRoster).toBeUndefined()
  })

  it("gathers the twin roster via gatherTwinRoster when omitted", async () => {
    mockGatherTwins.mockResolvedValueOnce([{ twinId: "tw2", name: "Bob", expertise: "docs" }])
    const proposal = await planAutoOrchestration({
      objective: "ship it",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      client: stagedClient({ assess: '{"recommendedPattern":"manager_worker"}' }),
    })
    expect(mockGatherTwins).toHaveBeenCalled()
    expect(proposal.twinRoster).toEqual([{ twinId: "tw2", name: "Bob", expertise: "docs" }])
  })

  it("routes to council/ensemble when the operator passes a consensus signal", async () => {
    const council = await planAutoOrchestration({
      objective: "decide the architecture",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      consensusSignal: { consensusNeeded: true },
      client: stagedClient({ assess: '{"recommendedPattern":"manager_worker"}' }),
    })
    expect(council.executor?.kind).toBe("council")

    const ensemble = await planAutoOrchestration({
      objective: "verify this proof",
      catalog: EMPTY_CAPABILITY_CATALOG,
      now: () => NOW,
      consensusSignal: { verificationNeeded: true },
      client: stagedClient({ assess: '{"recommendedPattern":"manager_worker"}' }),
    })
    expect(ensemble.executor?.kind).toBe("ensemble")
  })
})
