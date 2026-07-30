/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

import type { Character, Skill, Team } from "@cognia/agent-config-types"
import type { PluginRow } from "@/lib/db/plugin-types"
import type { TwinDraft } from "@/types/twin"
import { templateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"

// Mock each lib/db source. The hook only calls these when the active
// category demands them; tests can assert on the call counts to confirm the
// "inactive categories pay no cost" invariant.
const listCharactersMock = jest.fn<Promise<Character[]>, []>()
const listTeamsMock = jest.fn<Promise<Team[]>, []>()
const listSkillsMock = jest.fn<Promise<Skill[]>, []>()
const listPluginsMock = jest.fn<Promise<PluginRow[]>, []>()
const sortByMock = jest.fn<Promise<TwinDraft[]>, [string]>()
const twinSourcesSortByMock = jest.fn<Promise<unknown[]>, [string]>()

jest.mock("@/lib/db/characters", () => ({
  listCharacters: () => listCharactersMock(),
}))
jest.mock("@/lib/db/teams", () => ({
  listTeams: () => listTeamsMock(),
}))
jest.mock("@/lib/db/skills", () => ({
  listSkills: () => listSkillsMock(),
}))
jest.mock("@/lib/db/plugins", () => ({
  listPlugins: () => listPluginsMock(),
}))
jest.mock("@/lib/db/mcp-servers", () => ({
  listMcpServers: jest.fn().mockResolvedValue([]),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    twinDrafts: {
      toCollection: () => ({
        sortBy: (field: string) => sortByMock(field),
      }),
    },
    twinSources: {
      toCollection: () => ({
        sortBy: (field: string) => twinSourcesSortByMock(field),
      }),
    },
  }),
}))
// Phase 3 synchronous registries — stub so the existing tests for the
// other categories don't accidentally touch real shared state.
jest.mock("@/lib/connectors/adapter-metadata", () => ({
  listConnectorMetadata: jest.fn(() => []),
}))
jest.mock("@/lib/ocr/registry", () => ({
  getSharedOcrRegistry: jest.fn(() => ({ list: () => [] })),
}))
jest.mock("@/lib/workflow/copilot-templates", () => ({
  listCopilotTemplates: jest.fn(() => []),
}))
// New synchronous registries (WF1) — stub so tests control their content and
// don't pull in the real runtime stores / agent-definition modules.
jest.mock("@/lib/claude/mcp-presets", () => ({
  MCP_PRESETS: [
    {
      id: "filesystem",
      name: "Filesystem",
      description: "Read/write files",
      transport: "stdio",
      tags: ["files"],
    },
    {
      id: "github",
      name: "GitHub",
      description: "Repos and PRs",
      transport: "stdio",
      tags: ["dev"],
    },
  ],
}))
jest.mock("@/lib/slash-commands/registry", () => ({
  listSlashCommands: jest.fn(() => [
    { id: "help", name: "help", description: "Show help", source: "builtin" },
    {
      id: "gitx.status",
      name: "gitx.status",
      description: "Git status",
      source: "plugin",
      pluginId: "gitx",
    },
  ]),
  subscribeSlashCommands: jest.fn(() => () => {}),
  getSlashCommandsVersion: jest.fn(() => 0),
}))
jest.mock("@/types/agent/agent-team", () => ({
  BUILT_IN_TEAM_TEMPLATES: [
    {
      id: "parallel-review",
      name: "Parallel Review",
      description: "Split review",
      category: "review",
      teammates: [{ name: "a" }, { name: "b" }],
    },
  ],
}))
jest.mock("@/lib/plugin/registries/agent-team-template-registry", () => ({
  listAgentTeamTemplateEntries: jest.fn(() => []),
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  getAvailablePresets: jest.fn(() => ["codex", "claude-code"]),
  getPresetDisplayInfo: jest.fn((id: string) => ({
    name: id === "codex" ? "Codex" : "Claude Code",
    description: `${id} agent`,
    tags: ["cli"],
  })),
}))
jest.mock("@/lib/claude/agents/subagents", () => ({
  resolveDispatchableSubagents: jest.fn(() => [
    {
      id: "workflow-designer",
      def: {
        id: "workflow-designer",
        name: "Workflow Designer",
        description: "designs",
        prompt: "",
      },
    },
  ]),
}))

// Inline useLiveQuery mock: invoke the querier exactly once per mount via a
// ref-gated guard. The real dexie-react-hooks implementation subscribes to
// Dexie and re-fires on table changes; tests don't mutate Dexie, so a single
// fire is sufficient — and avoids the `useEffect([querier])` dependency churn
// that would consume `mockResolvedValueOnce` mocks on every re-render.
jest.mock("dexie-react-hooks", () => {
  const React = jest.requireActual("react") as typeof import("react")
  return {
    useLiveQuery: (querier: () => unknown | Promise<unknown>) => {
      const querierRef = React.useRef(querier)
      querierRef.current = querier
      const [value, setValue] = React.useState<unknown>(undefined)
      // Schedule the read inside an effect so the microtask is registered
      // against React's tree — keeps state updates wrapped in act() during
      // the surrounding test's `flush()` / `afterEach` drain.
      React.useEffect(() => {
        let cancelled = false
        Promise.resolve(querierRef.current()).then((resolved) => {
          if (!cancelled) setValue(resolved)
        })
        return () => {
          cancelled = true
        }
      }, [])
      return value
    },
  }
})

import { useDiscoverQuery } from "./use-discover-query"

const mkChar = (id: string, name: string, description = ""): Character =>
  ({
    id,
    name,
    description,
    systemPrompt: "",
    avatarColor: "#abc",
    avatarEmoji: "🐙",
    isBuiltIn: false,
  }) as unknown as Character

const mkTeam = (id: string, name: string, description = ""): Team =>
  ({
    id,
    name,
    description,
    avatarColor: "#def",
    members: [],
    orchestration: "round_robin",
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Team

const mkSkill = (id: string, name: string, description = ""): Skill =>
  ({
    id,
    name,
    description,
    content: "",
  }) as unknown as Skill

const mkPlugin = (id: string, name: string): PluginRow =>
  ({
    id,
    name,
    version: "1.0.0",
    status: "enabled",
    source: "builtin",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: `builtin://${id}`,
    manifest: {},
    createdAt: 0,
    updatedAt: 0,
  }) as PluginRow

const mkDraft = (id: string, name: string, kind: "character" | "skill" = "character"): TwinDraft =>
  ({
    id,
    twinId: "twin_default",
    jobId: "job_default",
    kind,
    payload: { kind, data: { name } },
    provenance: { chunkIds: [], rationale: "" },
    status: "pending",
    createdAt: 0,
  }) as unknown as TwinDraft

const flush = async () => {
  // Resolve the queued microtasks the mocked useLiveQuery schedules. React 19
  // requires state updates to be wrapped in act(); doing it here keeps every
  // call-site free of the boilerplate.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  listCharactersMock.mockReset()
  listTeamsMock.mockReset()
  listSkillsMock.mockReset()
  listPluginsMock.mockReset()
  sortByMock.mockReset()
  twinSourcesSortByMock.mockReset()
})

afterEach(async () => {
  // Drain any pending state updates the mocked useLiveQuery scheduled but
  // the test didn't explicitly flush (e.g. the loading-state test). Without
  // this React 19 emits "update not wrapped in act" warnings when the
  // microtask fires after the test body completes.
  await act(async () => {
    await Promise.resolve()
  })
})

describe("useDiscoverQuery", () => {
  it("reports loading=true before the first read resolves", () => {
    listCharactersMock.mockResolvedValueOnce([])
    const { result } = renderHook(() => useDiscoverQuery("characters", ""))
    expect(result.current.loading).toBe(true)
    expect(result.current.items).toEqual([])
  })

  it("loads characters, sorts by name, and wraps in {kind, id, data}", async () => {
    listCharactersMock.mockResolvedValueOnce([
      mkChar("c2", "Beta"),
      mkChar("c1", "Alpha"),
      mkChar("c3", "Gamma"),
    ])
    const { result, rerender } = renderHook(() => useDiscoverQuery("characters", ""))
    await flush()
    rerender()
    expect(result.current.loading).toBe(false)
    expect(result.current.items.map((i) => i.id)).toEqual(["c1", "c2", "c3"])
    expect(result.current.items[0]).toEqual({
      kind: "character",
      id: "c1",
      data: expect.objectContaining({ name: "Alpha" }),
    })
  })

  it("filters by name OR description, case-insensitive", async () => {
    listCharactersMock.mockResolvedValueOnce([
      mkChar("c1", "Alpha", "talkative"),
      mkChar("c2", "Beta", "silent"),
      mkChar("c3", "Gamma talkative chatter", ""),
    ])
    const { result, rerender } = renderHook(() => useDiscoverQuery("characters", "TALK"))
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id).sort()).toEqual(["c1", "c3"])
  })

  it("loads teams when category=teams", async () => {
    listTeamsMock.mockResolvedValueOnce([mkTeam("t1", "Beta"), mkTeam("t2", "Alpha")])
    const { result, rerender } = renderHook(() => useDiscoverQuery("teams", ""))
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["t2", "t1"])
    expect(result.current.items[0]).toEqual(expect.objectContaining({ kind: "team", id: "t2" }))
  })

  it("loads skills when category=skills", async () => {
    listSkillsMock.mockResolvedValueOnce([mkSkill("s1", "Coder", "writes code")])
    const { result, rerender } = renderHook(() => useDiscoverQuery("skills", "code"))
    await flush()
    rerender()
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0]).toEqual(expect.objectContaining({ kind: "skill", id: "s1" }))
  })

  it("loads plugins, sorts by name with id fallback", async () => {
    listPluginsMock.mockResolvedValueOnce([
      mkPlugin("p1", "Zebra"),
      { ...mkPlugin("p2", ""), name: "" } as PluginRow, // falls back to id sort
      mkPlugin("p3", "Aardvark"),
    ])
    const { result, rerender } = renderHook(() => useDiscoverQuery("plugins", ""))
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["p3", "p2", "p1"])
  })

  it("loads twin drafts and reports newest-first (already reversed by querier)", async () => {
    sortByMock.mockResolvedValueOnce([
      mkDraft("d1", "Old"),
      mkDraft("d2", "Mid"),
      mkDraft("d3", "New"),
    ])
    const { result, rerender } = renderHook(() => useDiscoverQuery("twinDrafts", ""))
    await flush()
    rerender()
    expect(sortByMock).toHaveBeenCalledWith("createdAt")
    // The querier reverses the sortBy result before returning.
    expect(result.current.items.map((i) => i.id)).toEqual(["d3", "d2", "d1"])
  })

  it("does not call the inactive category's data source", async () => {
    // Active category is "characters"; the other source functions must not be
    // invoked because their queriers short-circuit to Promise.resolve([]).
    listCharactersMock.mockResolvedValueOnce([])
    renderHook(() => useDiscoverQuery("characters", ""))
    await flush()
    expect(listCharactersMock).toHaveBeenCalledTimes(1)
    expect(listTeamsMock).not.toHaveBeenCalled()
    expect(listSkillsMock).not.toHaveBeenCalled()
    expect(listPluginsMock).not.toHaveBeenCalled()
    expect(sortByMock).not.toHaveBeenCalled()
  })

  it("returns an empty list with loading=false for unknown categories", async () => {
    const { result } = renderHook(() =>
      // The default branch must stay safe for hand-crafted ids the URL hook
      // would normally reject. Cast is intentional — TypeScript enforces the
      // union but production code should still degrade gracefully.
      useDiscoverQuery("alien-cat" as never, "")
    )
    expect(result.current.items).toEqual([])
    expect(result.current.loading).toBe(false)
  })

  // ── Phase 3 categories ──────────────────────────────────────────────────

  it("connector category reads from the synchronous metadata registry", async () => {
    const adapterMetadataMock = jest.requireMock("@/lib/connectors/adapter-metadata") as {
      listConnectorMetadata: jest.Mock
    }
    adapterMetadataMock.listConnectorMetadata.mockReturnValueOnce([
      { type: "telegram", iconName: "Send", status: "stable", oauth: false, richMessages: true },
      {
        type: "discord",
        iconName: "MessageCircle",
        status: "stable",
        oauth: true,
        richMessages: true,
      },
    ])
    const { result } = renderHook(() => useDiscoverQuery("connectors", ""))
    // Synchronous registry — no flush required.
    expect(result.current.items.map((i) => i.id)).toEqual(["telegram", "discord"])
    expect(result.current.items[0]).toEqual(expect.objectContaining({ kind: "connector" }))
    expect(result.current.loading).toBe(false)
  })

  it("ocrProvider category reads from getSharedOcrRegistry().list()", async () => {
    const registryMock = jest.requireMock("@/lib/ocr/registry") as {
      getSharedOcrRegistry: jest.Mock
    }
    registryMock.getSharedOcrRegistry.mockReturnValueOnce({
      list: () => [
        { id: "tesseract", label: "Tesseract", category: "local", credentialKeys: [] },
        {
          id: "anthropic-vision",
          label: "Claude Vision",
          category: "llm-vision",
          credentialKeys: ["anthropicApiKey"],
        },
      ],
    })
    const { result } = renderHook(() => useDiscoverQuery("ocrProviders", ""))
    expect(result.current.items.map((i) => i.id)).toEqual(["anthropic-vision", "tesseract"])
    expect(result.current.loading).toBe(false)
  })

  it("workflowTemplates category reads from listCopilotTemplates()", async () => {
    const templatesMock = jest.requireMock("@/lib/workflow/copilot-templates") as {
      listCopilotTemplates: jest.Mock
    }
    templatesMock.listCopilotTemplates.mockReturnValueOnce([
      {
        id: "github-pr",
        label: { en: "GitHub PR", "zh-CN": "GitHub PR" },
        description: { en: "Review pull requests", "zh-CN": "评审 PR" },
        slots: [],
        build: () => ({}),
      },
    ])
    const { result } = renderHook(() => useDiscoverQuery("workflowTemplates", ""))
    expect(result.current.items.map((i) => i.id)).toEqual(["github-pr"])
    expect(result.current.items[0]).toEqual(expect.objectContaining({ kind: "workflowTemplate" }))
  })

  it("mcpTools category reads from listMcpServers (Dexie-backed)", async () => {
    const dbMock = jest.requireMock("@/lib/db/mcp-servers") as {
      listMcpServers: jest.Mock
    }
    dbMock.listMcpServers.mockResolvedValueOnce([
      {
        id: "mcp_x",
        name: "Brave search",
        transport: "stdio",
        config: {},
        enabled: true,
        appsEnabled: {},
        createdAt: 0,
        updatedAt: 0,
      },
    ])
    const { result, rerender } = renderHook(() => useDiscoverQuery("mcpTools", ""))
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["mcp_x"])
    expect(result.current.items[0]).toEqual(expect.objectContaining({ kind: "mcpServer" }))
  })

  it("workflowTemplate search matches en + zh-CN + tags + description", async () => {
    const templatesMock = jest.requireMock("@/lib/workflow/copilot-templates") as {
      listCopilotTemplates: jest.Mock
    }
    templatesMock.listCopilotTemplates.mockReturnValue([
      {
        id: "t1",
        label: { en: "Alpha", "zh-CN": "阿尔法" },
        description: { en: "first one", "zh-CN": "第一个" },
        tags: ["beta"],
        slots: [],
        build: () => ({}),
      },
      {
        id: "t2",
        label: { en: "Beta", "zh-CN": "贝塔" },
        description: { en: "second one", "zh-CN": "第二个" },
        slots: [],
        build: () => ({}),
      },
    ])
    // English label hit
    const { result: a } = renderHook(() => useDiscoverQuery("workflowTemplates", "alpha"))
    expect(a.current.items.map((i) => i.id)).toEqual(["t1"])
    // Chinese label hit
    const { result: b } = renderHook(() => useDiscoverQuery("workflowTemplates", "贝塔"))
    expect(b.current.items.map((i) => i.id)).toEqual(["t2"])
    // Tag hit
    const { result: c } = renderHook(() => useDiscoverQuery("workflowTemplates", "beta"))
    // Both: t1 has tag "beta", t2 has label "Beta"
    expect(c.current.items.map((i) => i.id).sort()).toEqual(["t1", "t2"])
  })

  // ── Phase 6 — sort + filter ─────────────────────────────────────────────

  it("filter=builtin keeps only built-in characters", async () => {
    listCharactersMock.mockResolvedValueOnce([
      { ...mkChar("c1", "Alpha"), isBuiltIn: true } as unknown as Character,
      mkChar("c2", "Beta"),
      { ...mkChar("c3", "Gamma"), isBuiltIn: true } as unknown as Character,
    ])
    const { result, rerender } = renderHook(() =>
      useDiscoverQuery("characters", "", { filter: "builtin" })
    )
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["c1", "c3"])
  })

  it("filter=enabled keeps only non-disabled skills", async () => {
    listSkillsMock.mockResolvedValueOnce([
      { ...mkSkill("s1", "Active"), status: "enabled" } as unknown as Skill,
      { ...mkSkill("s2", "Off"), status: "disabled" } as unknown as Skill,
    ])
    const { result, rerender } = renderHook(() =>
      useDiscoverQuery("skills", "", { filter: "enabled" })
    )
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["s1"])
  })

  it("filter=enabled keeps only enabled plugins", async () => {
    listPluginsMock.mockResolvedValueOnce([
      { ...mkPlugin("p1", "On"), enabled: true },
      { ...mkPlugin("p2", "Off"), enabled: false },
    ])
    const { result, rerender } = renderHook(() =>
      useDiscoverQuery("plugins", "", { filter: "enabled" })
    )
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["p1"])
  })

  it("sort=recent orders plugins by updatedAt desc", async () => {
    listPluginsMock.mockResolvedValueOnce([
      { ...mkPlugin("p1", "Older"), updatedAt: 100 },
      { ...mkPlugin("p2", "Newer"), updatedAt: 500 },
      { ...mkPlugin("p3", "Middle"), updatedAt: 300 },
    ])
    const { result, rerender } = renderHook(() =>
      useDiscoverQuery("plugins", "", { sort: "recent" })
    )
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["p2", "p3", "p1"])
  })

  it("filter=installed keeps only stable connectors", async () => {
    const adapterMetadataMock = jest.requireMock("@/lib/connectors/adapter-metadata") as {
      listConnectorMetadata: jest.Mock
    }
    adapterMetadataMock.listConnectorMetadata.mockReturnValueOnce([
      { type: "telegram", iconName: "Send", status: "stable", oauth: false, richMessages: true },
      { type: "wecom", iconName: "Building2", status: "planned", oauth: true, richMessages: true },
      { type: "github", iconName: "Github", status: "beta", oauth: true, richMessages: false },
    ])
    const { result } = renderHook(() => useDiscoverQuery("connectors", "", { filter: "installed" }))
    expect(result.current.items.map((i) => i.id)).toEqual(["telegram"])
  })

  // ── Favorites pseudo-category + filter ──────────────────────────────────

  it("favorites view aggregates favorited items across kinds", async () => {
    listCharactersMock.mockResolvedValueOnce([mkChar("c1", "Alpha"), mkChar("c2", "Beta")])
    listSkillsMock.mockResolvedValueOnce([mkSkill("s1", "One"), mkSkill("s2", "Two")])
    // The favorites view flips every Dexie source live; resolve the rest so it
    // reports loading=false.
    listTeamsMock.mockResolvedValue([])
    listPluginsMock.mockResolvedValue([])
    sortByMock.mockResolvedValue([])
    twinSourcesSortByMock.mockResolvedValue([])
    const favoriteKeys = new Set(["character:c1", "skill:s2"])
    const { result, rerender } = renderHook(() =>
      useDiscoverQuery("favorites", "", { favoriteKeys })
    )
    await flush()
    rerender()
    expect(result.current.loading).toBe(false)
    expect(result.current.items.map((i) => `${i.kind}:${i.id}`).sort()).toEqual([
      "character:c1",
      "skill:s2",
    ])
  })

  it("favorites view is empty when nothing is favorited", async () => {
    listCharactersMock.mockResolvedValueOnce([mkChar("c1", "Alpha")])
    listTeamsMock.mockResolvedValue([])
    listPluginsMock.mockResolvedValue([])
    listSkillsMock.mockResolvedValue([])
    sortByMock.mockResolvedValue([])
    twinSourcesSortByMock.mockResolvedValue([])
    const { result, rerender } = renderHook(() =>
      useDiscoverQuery("favorites", "", { favoriteKeys: new Set() })
    )
    await flush()
    rerender()
    expect(result.current.items).toEqual([])
  })

  it("filter=favorites narrows a normal category to starred items", async () => {
    listCharactersMock.mockResolvedValueOnce([
      mkChar("c1", "Alpha"),
      mkChar("c2", "Beta"),
      mkChar("c3", "Gamma"),
    ])
    const { result, rerender } = renderHook(() =>
      useDiscoverQuery("characters", "", {
        filter: "favorites",
        favoriteKeys: new Set(["character:c2"]),
      })
    )
    await flush()
    rerender()
    expect(result.current.items.map((i) => i.id)).toEqual(["c2"])
  })

  describe("WF1 registry-backed categories (synchronous)", () => {
    it("lists slash commands, sorted by name, wrapped as slashCommand", () => {
      const { result } = renderHook(() => useDiscoverQuery("slashCommands", ""))
      expect(result.current.loading).toBe(false)
      expect(result.current.items.map((i) => i.id)).toEqual(["gitx.status", "help"])
      expect(result.current.items[1]).toEqual({
        kind: "slashCommand",
        id: "help",
        data: expect.objectContaining({ name: "help" }),
      })
    })

    it("filter=builtin narrows slash commands to builtin source", () => {
      const { result } = renderHook(() =>
        useDiscoverQuery("slashCommands", "", { filter: "builtin" })
      )
      expect(result.current.items.map((i) => i.id)).toEqual(["help"])
    })

    it("searches slash commands by description", () => {
      const { result } = renderHook(() => useDiscoverQuery("slashCommands", "git status"))
      expect(result.current.items.map((i) => i.id)).toEqual(["gitx.status"])
    })

    it("lists mcp presets and filters by tag", () => {
      const all = renderHook(() => useDiscoverQuery("mcpPresets", ""))
      expect(all.result.current.items.map((i) => i.id)).toEqual(["filesystem", "github"])
      const dev = renderHook(() => useDiscoverQuery("mcpPresets", "dev"))
      expect(dev.result.current.items.map((i) => i.id)).toEqual(["github"])
    })

    it("lists team templates (built-in) with a normalized shape", () => {
      const { result } = renderHook(() => useDiscoverQuery("teamTemplates", ""))
      expect(result.current.items[0]).toEqual({
        kind: "teamTemplate",
        id: "parallel-review",
        data: expect.objectContaining({ isBuiltIn: true, teammateCount: 2 }),
      })
    })

    it("prefers the live unified AgentTeam catalog when it is populated", async () => {
      const definition = await createTemplateDefinition({
        id: "team.review",
        domain: "agentTeam",
        status: "published",
        revision: 1,
        version: "1.0.0",
        metadata: { name: "Unified review", description: "Review", category: "review" },
        payload: {
          team: { name: "Unified review", description: "Review", task: "", config: {} },
          lead: { localId: "lead", name: "Lead", description: "", config: {} },
          teammates: [{ localId: "reviewer", name: "Reviewer", description: "", config: {} }],
          tasks: [],
          twinSlots: [],
        },
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["desktop", "web", "mobile"] },
        provenance: { source: "built-in", trust: "built-in" },
      })
      templateCatalog.replaceSource("test:discover", [definition])

      const { result } = renderHook(() => useDiscoverQuery("teamTemplates", ""))

      expect(result.current.items).toEqual([
        expect.objectContaining({
          kind: "teamTemplate",
          id: "team.review@1.0.0",
          data: expect.objectContaining({ name: "Unified review", teammateCount: 1 }),
        }),
      ])
      templateCatalog.removeSource("test:discover")
    })

    it("combines external-agent presets and subagents under agentPresets", () => {
      const { result } = renderHook(() => useDiscoverQuery("agentPresets", ""))
      const kinds = new Set(result.current.items.map((i) => i.kind))
      expect(kinds.has("externalAgentPreset")).toBe(true)
      expect(kinds.has("subagent")).toBe(true)
      expect(result.current.items.some((i) => i.id === "codex")).toBe(true)
      expect(result.current.items.some((i) => i.id === "workflow-designer")).toBe(true)
    })

    it("favorites aggregates the new registry kinds", async () => {
      listCharactersMock.mockResolvedValueOnce([])
      listTeamsMock.mockResolvedValueOnce([])
      listSkillsMock.mockResolvedValueOnce([])
      listPluginsMock.mockResolvedValueOnce([])
      sortByMock.mockResolvedValue([])
      twinSourcesSortByMock.mockResolvedValue([])
      const { result, rerender } = renderHook(() =>
        useDiscoverQuery("favorites", "", {
          favoriteKeys: new Set(["mcpPreset:github", "subagent:workflow-designer"]),
        })
      )
      await flush()
      rerender()
      const ids = result.current.items.map((i) => `${i.kind}:${i.id}`)
      expect(ids).toEqual(
        expect.arrayContaining(["mcpPreset:github", "subagent:workflow-designer"])
      )
    })
  })
})
