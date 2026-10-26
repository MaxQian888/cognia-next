import type { Character, McpServer, Skill } from "@cognia/agent-config-types"
import type { HarnessSnapshotV1 } from "@/types/harness/snapshot"
import { captureHarness, HarnessCaptureError, unsupportedReason, type CaptureDeps } from "./capture"

const skill = (over: Partial<Skill>): Skill =>
  ({
    id: "s-report",
    name: "Report",
    slug: "report",
    description: "Write reports",
    content: "Write report.md",
    status: "enabled",
    source: "custom",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as Skill

const agent: Character = {
  id: "agent-1",
  name: "Analyst",
  avatarColor: "oklch(0.6 0 0)",
  systemPrompt: "Be careful.",
  skillIds: ["s-report", "s-builtin", "s-off", "s-missing", "s-report"],
  mcpServerIds: ["mcp-b", "mcp-a", "mcp-dead"],
  model: "m",
  providerId: "p",
  harness: { memory: "Use report.md", adoptedSnapshotId: "snap-parent" },
  createdAt: 1,
  updatedAt: 1,
}

function deps(over: Partial<CaptureDeps> = {}): CaptureDeps & { stored: HarnessSnapshotV1[] } {
  const stored: HarnessSnapshotV1[] = []
  let id = 0
  return {
    stored,
    resolveCharacter: async (cid) => (cid === agent.id ? agent : undefined),
    listSkills: async (ids) =>
      [
        skill({}),
        skill({ id: "s-builtin", name: "Built in", isBuiltIn: true }),
        skill({ id: "s-off", name: "Off", status: "disabled" }),
      ].filter((s) => ids.includes(s.id)),
    listResources: async () => [],
    listEnabledMcpServers: async () => [{ id: "mcp-a" }, { id: "mcp-b" }] as McpServer[],
    isBuiltInSkill: (s) => Boolean(s.isBuiltIn),
    findSnapshotByHash: async (_cid, hash) => stored.find((s) => s.contentHash === hash),
    putSnapshot: async (s) => {
      stored.push(s)
    },
    appVersion: "1.0.0",
    newId: () => `snap-${++id}`,
    now: () => 42,
    ...over,
  }
}

describe("captureHarness", () => {
  it("captures editable skills, carries the rest by id and links the adopted parent", async () => {
    const d = deps()
    const captured = await captureHarness(agent.id, { scope: "task", projectId: "proj" }, d)
    expect(captured.reused).toBe(false)
    expect(captured.carriedSkillIds).toEqual(["s-builtin", "s-off", "s-missing"])
    expect(captured.skills.map((s) => s.skill.id)).toEqual(["s-report"])
    expect(captured.enabledMcpServerIds).toEqual(["mcp-a", "mcp-b"])
    expect(captured.snapshot).toMatchObject({
      id: "snap-1",
      characterId: "agent-1",
      projectId: "proj",
      scope: "task",
      parentId: "snap-parent",
      origin: { kind: "captured" },
      createdAt: 42,
    })
    expect(captured.snapshot.components.memory).toBe("Use report.md")
    expect(captured.snapshot.components.skills.map((s) => s.key)).toEqual(["report"])
    expect(captured.snapshot.runtimeFingerprint).toMatch(/^hrf1-/)
    expect(d.stored).toHaveLength(1)
  })

  it("reuses an identical capture", async () => {
    const d = deps()
    const first = await captureHarness(agent.id, { scope: "task" }, d)
    const second = await captureHarness(agent.id, { scope: "task" }, d)
    expect(second.reused).toBe(true)
    expect(second.snapshot.id).toBe(first.snapshot.id)
    expect(d.stored).toHaveLength(1)
  })

  it("takes a new snapshot when the runtime changed", async () => {
    const d = deps()
    await captureHarness(agent.id, { scope: "task" }, d)
    const later = await captureHarness(agent.id, { scope: "task" }, { ...d, appVersion: "2.0.0" })
    expect(later.reused).toBe(false)
    expect(d.stored).toHaveLength(2)
  })

  it("refuses unknown agents and external runtimes", async () => {
    await expect(captureHarness("nope", { scope: "task" }, deps())).rejects.toMatchObject({
      code: "agent-not-found",
    })
    const external = { ...agent, runtime: { kind: "external" } } as unknown as Character
    await expect(
      captureHarness(agent.id, { scope: "task" }, deps({ resolveCharacter: async () => external }))
    ).rejects.toBeInstanceOf(HarnessCaptureError)
    expect(unsupportedReason(external)).toMatch(/external runtime/)
    expect(unsupportedReason(agent)).toBeNull()
    expect(unsupportedReason({ ...agent, runtime: { kind: "builtin" } } as Character)).toBeNull()
  })
})
