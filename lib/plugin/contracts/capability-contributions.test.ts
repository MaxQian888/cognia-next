import { getContributionsForCapability, getAllContributions } from "./capability-contributions"

describe("getContributionsForCapability", () => {
  it("returns tool entries with id + name", () => {
    const manifest = {
      tools: [{ id: "tool-a", name: "Tool A" }, { id: "tool-b" }],
    }
    expect(getContributionsForCapability(manifest, "tools")).toEqual([
      { id: "tool-a", label: "Tool A" },
      { id: "tool-b" },
    ])
  })

  it("resolves native-anthropic-tool by name/type", () => {
    const manifest = {
      nativeAnthropicTools: [
        { name: "computer_20251124", type: "computer_use" },
        { type: "bash_20250124" },
      ],
    }
    expect(getContributionsForCapability(manifest, "native-anthropic-tool")).toEqual([
      { id: "computer_20251124", label: "computer_use" },
      { id: "bash_20250124" },
    ])
  })

  it("resolves connectors with adapter fallback", () => {
    const manifest = {
      connectors: [
        // adapter equals id — label is omitted by entry()'s "label !== id" rule
        { id: "github", adapter: "github" },
        // distinct name — kept as label
        { id: "slack", name: "Slack" },
      ],
    }
    expect(getContributionsForCapability(manifest, "connectors")).toEqual([
      { id: "github" },
      { id: "slack", label: "Slack" },
    ])
  })

  it("resolves external-agent-adapter contributions by id + label", () => {
    // Adapters carry `label` (not `name`), so the chip count is non-zero.
    expect(
      getContributionsForCapability(
        {
          externalAgentAdapters: [{ id: "demo-echo", label: "Demo Echo Protocol" }, { id: "bare" }],
        },
        "external-agent-adapter"
      )
    ).toEqual([{ id: "demo-echo", label: "Demo Echo Protocol" }, { id: "bare" }])
  })

  it("resolves workflow node executors via the workflows block", () => {
    const manifest = {
      workflows: {
        nodeExecutors: [{ id: "node-a" }, { id: "node-b", name: "Node B" }],
        triggers: [{ id: "trig-a" }],
      },
    }
    expect(getContributionsForCapability(manifest, "workflow")).toEqual([
      { id: "node-a" },
      { id: "node-b", label: "Node B" },
    ])
    expect(getContributionsForCapability(manifest, "workflow-trigger")).toEqual([{ id: "trig-a" }])
  })

  it("counts the overlay capabilities (character-pack/subagent/team-template/shared-memory/workflow-template)", () => {
    const manifest = {
      characterPacks: [{ id: "pack-a", name: "Pack A" }],
      subagents: [{ id: "sub-a" }, { id: "sub-b" }],
      agentTeamTemplates: [{ id: "team-a", name: "Team A" }],
      sharedMemoryAdapters: [{ id: "mem-a" }],
      workflowTemplates: [{ id: "wf-a" }],
    }
    expect(getContributionsForCapability(manifest, "character-pack")).toEqual([
      { id: "pack-a", label: "Pack A" },
    ])
    expect(getContributionsForCapability(manifest, "subagent")).toEqual([
      { id: "sub-a" },
      { id: "sub-b" },
    ])
    expect(getContributionsForCapability(manifest, "agent-team-template")).toEqual([
      { id: "team-a", label: "Team A" },
    ])
    expect(getContributionsForCapability(manifest, "shared-memory-adapter")).toEqual([
      { id: "mem-a" },
    ])
    expect(getContributionsForCapability(manifest, "workflow-template")).toEqual([{ id: "wf-a" }])
  })

  it("keys fonts by family and scheduled tasks by name (no id field)", () => {
    expect(
      getContributionsForCapability({ fonts: [{ family: "Inter" }, { family: "Mono" }] }, "fonts")
    ).toEqual([{ id: "Inter" }, { id: "Mono" }])
    expect(
      getContributionsForCapability(
        { scheduledTasks: [{ name: "daily" }, { name: "hourly" }] },
        "scheduler"
      )
    ).toEqual([{ id: "daily" }, { id: "hourly" }])
  })

  it("resolves cli-tools and chat-middleware contributions", () => {
    expect(
      getContributionsForCapability(
        { cliTools: [{ id: "rg", name: "ripgrep" }, { id: "fd" }] },
        "cli-tools"
      )
    ).toEqual([{ id: "rg", label: "ripgrep" }, { id: "fd" }])
    expect(
      getContributionsForCapability(
        { chatMiddlewares: [{ id: "mw-a", name: "Redactor" }] },
        "chat-middleware"
      )
    ).toEqual([{ id: "mw-a", label: "Redactor" }])
  })

  it("returns [] for capabilities with no manifest contribution surface", () => {
    expect(getContributionsForCapability({}, "tools")).toEqual([])
    expect(getContributionsForCapability({}, "hooks")).toEqual([])
    expect(getContributionsForCapability({}, "unknown")).toEqual([])
  })

  it("tolerates missing manifest entirely", () => {
    expect(getContributionsForCapability(null, "tools")).toEqual([])
    expect(getContributionsForCapability(undefined, "tools")).toEqual([])
  })

  it("does not double-emit a label that equals the id", () => {
    const manifest = { tools: [{ id: "same", name: "same" }] }
    expect(getContributionsForCapability(manifest, "tools")).toEqual([{ id: "same" }])
  })
})

describe("getAllContributions", () => {
  it("preserves capability order and reports zero counts for unmapped capabilities", () => {
    const manifest = {
      tools: [{ id: "a" }, { id: "b" }],
      skills: [{ id: "s1" }],
    }
    expect(getAllContributions(["tools", "hooks", "skills"], manifest)).toEqual([
      { capability: "tools", entries: [{ id: "a" }, { id: "b" }], count: 2 },
      { capability: "hooks", entries: [], count: 0 },
      { capability: "skills", entries: [{ id: "s1" }], count: 1 },
    ])
  })

  it("handles an empty capabilities list", () => {
    expect(getAllContributions([], { tools: [{ id: "a" }] })).toEqual([])
  })
})
