// AgentExecutionService (ADR-0090 Phase 6): rail routing, fail-before-spend,
// explicit-only completion fallback with degradedReason.

import { AGENT_CAPABILITY_IDS } from "@cognia/agent-config-types/agent-execution"

import {
  executeAgentTurn,
  AgentCapabilityUnsatisfiedError,
  AgentHostUnavailableError,
} from "./agent-execution-service"
import { RUNTIME_CAPABILITIES } from "./resolve-agent-execution-spec"

/**
 * A capability the Claude rail genuinely does not serve, read off the table
 * instead of written down. These cases used `steer`, which the rail turned out
 * to support all along — so they were asserting fail-closed against a
 * capability that should never have failed.
 */
const UNSERVED_BY_CLAUDE = (() => {
  const served = new Set(RUNTIME_CAPABILITIES["claude-agent-sdk"])
  const id = AGENT_CAPABILITY_IDS.find((c) => !served.has(c))
  if (!id) throw new Error("claude-agent-sdk now serves every capability — pick a new probe")
  return id
})()

const workspaceLease = jest.fn(
  async (_input: unknown, execute: (cwd: string) => Promise<unknown>) => ({
    value: await execute("/isolated"),
    taskWorkspaceRunId: "workspace-run-1",
    executionRoot: "/isolated",
  })
)

jest.mock("@/lib/task-workspace/run-lease", () => ({
  withTaskWorkspaceRun: (...args: unknown[]) =>
    workspaceLease(...(args as [unknown, (cwd: string) => Promise<unknown>])),
}))

jest.mock("@/lib/ai/agent/agent-executor", () => ({
  runAgentRail: jest.fn(async () => ({
    text: "agent-rail",
    channel: "sidecar",
    toolsAvailable: true,
  })),
  runCompletionRail: jest.fn(async () => ({
    text: "completion-rail",
    channel: "text",
    toolsAvailable: false,
  })),
}))

jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: jest.fn(async () => undefined),
}))

import { runAgentRail, runCompletionRail } from "@/lib/ai/agent/agent-executor"
import { trackEvent } from "@/lib/telemetry/events/track-event"

const agentRail = runAgentRail as jest.Mock
const completionRail = runCompletionRail as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

it("routes an intentional completion (toolsEnabled absent) to the completion rail and stamps the spec", async () => {
  const result = await executeAgentTurn(
    "p",
    { model: "claude-opus-4-8" },
    { isTauri: true, isHeadlessHost: false }
  )
  expect(completionRail).toHaveBeenCalledTimes(1)
  expect(agentRail).not.toHaveBeenCalled()
  expect(result.text).toBe("completion-rail")
  expect(result.runtime).toBe("claude-agent-sdk")
  expect(result.routeKind).toBe("direct")
  expect(result.executionFingerprint).toEqual(expect.any(String))
  expect(result.degradedReason).toBeUndefined()
})

it("routes a tool-enabled run on a Tauri host to the agent rail", async () => {
  const result = await executeAgentTurn(
    "p",
    { toolsEnabled: true },
    { isTauri: true, isHeadlessHost: false }
  )
  expect(agentRail).toHaveBeenCalledTimes(1)
  expect(completionRail).not.toHaveBeenCalled()
  expect(result.channel).toBe("sidecar")
  // Legacy toolsEnabled:true without explicit policy is a migrated mapping.
  expect(result.legacyMigrated).toBe(true)
})

it("treats a headless agent host as a real host (no isTauri dependence)", async () => {
  await executeAgentTurn("p", { toolsEnabled: true }, { isTauri: false, isHeadlessHost: true })
  expect(agentRail).toHaveBeenCalledTimes(1)
  expect(completionRail).not.toHaveBeenCalled()
})

it("degrades to completion only under the explicit legacy fallback policy, carrying degradedReason", async () => {
  const result = await executeAgentTurn(
    "p",
    { toolsEnabled: true },
    { isTauri: false, isHeadlessHost: false }
  )
  expect(agentRail).not.toHaveBeenCalled()
  expect(completionRail).toHaveBeenCalledTimes(1)
  expect(result.degradedReason).toBe("legacy-completion-fallback")
  expect(result.legacyMigrated).toBe(true)
})

it("fails closed (AgentHostUnavailableError) when no host exists and fallback is forbidden", async () => {
  await expect(
    executeAgentTurn(
      "p",
      { toolsEnabled: true },
      { isTauri: false, isHeadlessHost: false, prohibitCompletionFallback: true }
    )
  ).rejects.toBeInstanceOf(AgentHostUnavailableError)
  expect(agentRail).not.toHaveBeenCalled()
  expect(completionRail).not.toHaveBeenCalled()
})

it("fails closed on requireTools with no host (no-fallback mapping)", async () => {
  await expect(
    executeAgentTurn(
      "p",
      { toolsEnabled: true },
      { isTauri: false, isHeadlessHost: false },
      { requireTools: true }
    )
  ).rejects.toBeInstanceOf(AgentHostUnavailableError)
  expect(completionRail).not.toHaveBeenCalled()
})

it("fails BEFORE any rail spend when a hard-required capability is unsatisfied", async () => {
  await expect(
    executeAgentTurn(
      "p",
      { toolsEnabled: true },
      { isTauri: true, isHeadlessHost: false },
      { policy: { requires: [UNSERVED_BY_CLAUDE] } }
    )
  ).rejects.toBeInstanceOf(AgentCapabilityUnsatisfiedError)
  expect(agentRail).not.toHaveBeenCalled()
  expect(completionRail).not.toHaveBeenCalled()
  // Fail-before-spend also means no "resolved" telemetry for a rejected turn.
  expect(trackEvent).not.toHaveBeenCalledWith("agent.execution.resolved", expect.anything())
})

it("emits agent.execution.resolved with surface/runtime/route enums only", async () => {
  await executeAgentTurn(
    "p",
    { toolsEnabled: true },
    { isTauri: true, isHeadlessHost: false },
    { surface: "workflow-agent-turn" }
  )
  expect(trackEvent).toHaveBeenCalledWith("agent.execution.resolved", {
    surface: "workflow-agent-turn",
    runtime: "claude-agent-sdk",
    routeKind: "direct",
    executionKind: "agent",
    legacyMigrated: true,
  })
})

it("openAgentSession returns a handle bound to ONE frozen spec (capability gates included)", async () => {
  const { openAgentSession } = await import("./agent-execution-service")
  const { handle, spec } = await openAgentSession({
    sessionId: "s-42",
    environment: { isTauri: true, isHeadlessHost: false },
    legacy: { toolsEnabled: true, modelId: "claude-opus-4-8" },
  })
  expect(handle.sessionId).toBe("s-42")
  expect(handle.spec).toBe(spec)
  expect(spec.identity.sessionId).toBe("s-42")
  expect(spec.runtimeAdapter).toBe("claude-agent-sdk")
  // The handle's frozen bindings come from THIS resolution.
  await expect(handle.setModel("some-other-model")).rejects.toThrow(/frozen bindings/)
})

it("openAgentSession fails closed on unsatisfied hard capabilities before creating a handle", async () => {
  const { openAgentSession } = await import("./agent-execution-service")
  await expect(
    openAgentSession({
      sessionId: "s-43",
      environment: { isTauri: true, isHeadlessHost: false },
      legacy: { toolsEnabled: true },
      options: { policy: { requires: [UNSERVED_BY_CLAUDE] } },
    })
  ).rejects.toBeInstanceOf(AgentCapabilityUnsatisfiedError)
})

it("threads the caller session id into the resolved identity fingerprint deterministically", async () => {
  const a = await executeAgentTurn(
    "p",
    { sessionId: "s-1", toolsEnabled: true },
    { isTauri: true, isHeadlessHost: false }
  )
  const b = await executeAgentTurn(
    "p",
    { sessionId: "s-1", toolsEnabled: true },
    { isTauri: true, isHeadlessHost: false }
  )
  expect(a.executionFingerprint).toBe(b.executionFingerprint)
})

it("runs managed filesystem work through one Task Workspace lease", async () => {
  const result = await executeAgentTurn(
    "p",
    { sessionId: "session-1", cwd: "/repo", toolsEnabled: true },
    { isTauri: true, isHeadlessHost: false },
    {
      surface: "workflow-agent-turn",
      identity: { runId: "execution-1", attemptId: "attempt-1", turnId: "turn-1" },
      taskWorkspace: { enabled: true, agentId: "workflow-agent", agentKind: "workflow" },
    }
  )

  expect(workspaceLease).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceRoot: "/repo",
      runId: "execution-1",
      attemptId: "attempt-1",
      surface: "workflow-agent-turn",
    }),
    expect.any(Function)
  )
  expect(agentRail).toHaveBeenCalledWith("p", expect.objectContaining({ cwd: "/isolated" }))
  expect(result.taskWorkspaceRunId).toBe("workspace-run-1")
  expect(result.trackingUnavailable).toBeUndefined()
})

describe("openAgentSession dormancy label (CLAUDE.md working rule 7)", () => {
  it("still has no production caller, which is what the docblock claims", async () => {
    // Rule 7: intentional dormancy must be labelled at the type AND pinned by a
    // test. `openAgentSession` carries an "INTENTIONALLY DORMANT until Phase 7"
    // docblock, and it is the only caller of `createAgentExecutionHandle` — so
    // the entire handle path is currently test-only. A comment alone rots; this
    // fails the day someone wires a real caller, forcing the label to be
    // removed in the same change rather than left behind as a lie.
    const { execFileSync } = await import("node:child_process")
    const out = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-E",
        "openAgentSession|createAgentExecutionHandle",
        "--",
        "*.ts",
        "*.tsx",
        ":!*.test.ts",
        ":!*.test.tsx",
      ],
      { encoding: "utf8", cwd: process.cwd() }
    )

    const callers = out
      .split("\n")
      .filter(Boolean)
      // The two files that DEFINE the path are not callers of it.
      .filter(
        (f) =>
          !f.endsWith("lib/ai/agent/execution/agent-execution-service.ts") &&
          !f.endsWith("lib/ai/agent/execution/agent-execution-handle.ts")
      )

    expect(callers).toEqual([])
  })
})
