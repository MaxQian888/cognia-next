import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import { buildTeamRiskInput } from "./risk-input"

const team = (config: Partial<AgentTeam["config"]> = {}): AgentTeam =>
  ({
    id: "team-1",
    name: "Test",
    description: "",
    task: "ship the thing",
    status: "idle",
    config,
    leadId: "lead-1",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    createdAt: new Date(),
  }) as unknown as AgentTeam

const worker = (id: string, config: Partial<AgentTeammate["config"]> = {}): AgentTeammate =>
  ({
    id,
    teamId: "team-1",
    name: id,
    description: "",
    role: "teammate",
    status: "idle",
    config,
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  }) as unknown as AgentTeammate

const task = (id: string, description: string): AgentTeamTask =>
  ({ id, teamId: "team-1", title: id, description }) as unknown as AgentTeamTask

const build = (over: Partial<Parameters<typeof buildTeamRiskInput>[0]> = {}) =>
  buildTeamRiskInput({ team: team(), workers: [], tasks: [], ...over })

describe("buildTeamRiskInput", () => {
  it("carries the objective and task descriptions", () => {
    const input = build({ tasks: [task("t1", "do A"), task("t2", "do B")] })
    expect(input.objective).toBe("ship the thing")
    expect(input.taskDescriptions).toEqual(["do A", "do B"])
  })

  it("drops empty task descriptions rather than feeding the classifier blanks", () => {
    expect(build({ tasks: [task("t1", "")] }).taskDescriptions).toEqual([])
  })

  it("tolerates a team with no objective", () => {
    // `task` is typed required, but the store hydrates rows from Dexie — the
    // type is a claim about writers, not a guarantee about what comes back.
    const noTask = { ...team(), task: undefined } as unknown as AgentTeam
    expect(build({ team: noTask }).objective).toBe("")
  })

  it("unions explicit teammate tools across workers, deduplicated", () => {
    const input = build({
      workers: [
        worker("w1", { tools: ["bash", "read"] }),
        worker("w2", { tools: ["bash", "write"] }),
      ],
    })
    expect(input.toolIds.sort()).toEqual(["bash", "read", "write"])
  })

  it("includes resolved native tools a teammate never named in tools", () => {
    // The point of reading both: the team bundle grants `computer` without the
    // teammate's `tools` allowlist ever mentioning it.
    const input = build({
      team: team({ capabilities: { nativeAnthropicToolIds: ["computer"] } }),
      workers: [worker("w1", { tools: ["read"] })],
    })
    expect(input.toolIds.sort()).toEqual(["computer", "read"])
  })

  it("applies the teammate capability overlay when resolving native tools", () => {
    const input = build({
      team: team({ capabilities: { nativeAnthropicToolIds: ["computer"] } }),
      workers: [
        worker("w1", { capabilities: { nativeAnthropicToolIds: { remove: ["computer"] } } }),
      ],
    })
    expect(input.toolIds).toEqual([])
  })

  it("unions mcp / skill / subagent / external-agent ids into capabilityIds", () => {
    const input = build({
      team: team({
        capabilities: {
          mcpServerIds: ["keyring"],
          skillIds: ["s1"],
          subagentIds: ["sa1"],
          externalAgentPresetIds: ["ea1"],
          // Not a capability the classifier judges — must not leak in.
          characterPackIds: ["cp1"],
        },
      }),
      workers: [worker("w1")],
    })
    expect(input.capabilityIds.sort()).toEqual(["ea1", "keyring", "s1", "sa1"])
  })

  it("returns empty ids for a roster with no workers", () => {
    const input = build({ workers: [] })
    expect(input.toolIds).toEqual([])
    expect(input.capabilityIds).toEqual([])
  })

  describe("sandbox posture", () => {
    it("is off by default", () => {
      expect(build({ workers: [worker("w1")] }).sandboxEnabled).toBe(false)
    })

    it("follows the team default", () => {
      expect(
        build({ team: team({ sandboxEnabled: true }), workers: [worker("w1")] }).sandboxEnabled
      ).toBe(true)
    })

    it("turns on when any single teammate enables it", () => {
      expect(
        build({ workers: [worker("w1"), worker("w2", { sandboxEnabled: true })] }).sandboxEnabled
      ).toBe(true)
    })

    it("turns OFF when a worker opts out of the team default — partial coverage is no coverage", () => {
      // The classifier downgrades on sandbox coverage; one unsandboxed worker
      // means the run's blast radius is unconfined, so it must not downgrade.
      const input = build({
        team: team({ sandboxEnabled: true }),
        workers: [worker("w1"), worker("w2", { sandboxEnabled: false })],
      })
      expect(input.sandboxEnabled).toBe(false)
    })
  })
})
