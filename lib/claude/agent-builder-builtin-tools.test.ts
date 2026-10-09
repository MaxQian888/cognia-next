import type { AgentBuilderSessionState, Character, ChatSession } from "@cognia/agent-config-types"
import {
  BUILDER_PERMISSION_MODES,
  applyDraftPatch,
  renderDraftForModel,
  type DraftCatalogs,
  type DraftPatch,
} from "@/lib/agents/builder/draft-ops"
import { AGENT_AVATAR_COLORS } from "@/lib/agents/editor-state"
import {
  AGENT_BUILDER_BUILTIN_PLUGIN_ID,
  AGENT_BUILDER_TOOL_NAMES as T,
  CATALOG_KINDS,
  buildAgentBuilderManifestEntries,
  isAgentBuilderBuiltinTool,
  runAgentBuilderBuiltinTool,
  type AgentBuilderToolDeps,
} from "./agent-builder-builtin-tools"

const CATALOGS: DraftCatalogs = {
  skills: [
    { id: "sk-review", name: "Code Review", description: "Reviews diffs" },
    { id: "sk-write", name: "Writer" },
  ],
  pluginSkills: [{ id: "plug:lint", name: "Lint", description: "" }],
  mcpServers: [
    { id: "mcp-gh", name: "GitHub", enabled: true, transport: "stdio" },
    { id: "mcp-off", name: "Offline", enabled: false },
  ],
  knowledgeBases: [{ id: "kb-1", name: "Handbook", description: "Team handbook" }],
}

const MODELS = [
  { id: "claude-opus", name: "Opus" },
  { id: "claude-haiku", name: "Haiku" },
]

function builderState(overrides: Partial<AgentBuilderSessionState> = {}): AgentBuilderSessionState {
  return {
    draft: { name: "Reviewer", skillIds: ["sk-review"] },
    revision: 3,
    editedBy: "user",
    status: "drafting",
    updatedAt: 1,
    ...overrides,
  }
}

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "b1",
    title: "Builder",
    createdAt: 1,
    updatedAt: 1,
    kind: "agent-builder",
    agentBuilder: builderState(),
    ...overrides,
  } as ChatSession
}

function deps(
  row: ChatSession | undefined = session(),
  overrides: Partial<AgentBuilderToolDeps> = {}
): AgentBuilderToolDeps {
  return {
    getSession: jest.fn(async () => row),
    catalogs: jest.fn(async () => CATALOGS),
    models: jest.fn(() => MODELS),
    writeDraft: jest.fn(async (_sessionId: string, patch: DraftPatch, catalogs: DraftCatalogs) => {
      const current = row?.agentBuilder ?? builderState()
      const outcome = applyDraftPatch(current.draft, patch, catalogs)
      return {
        state: {
          ...current,
          draft: outcome.draft,
          revision: current.revision + 1,
          editedBy: "agent" as const,
        },
        changed: outcome.changed,
        rejected: outcome.rejected,
      }
    }),
    createAgent: jest.fn(async (): Promise<Character> => ({
      id: "char_new",
      name: "Reviewer",
      systemPrompt: "Review code.",
      avatarColor: "#000",
      createdAt: 1,
      updatedAt: 1,
    })),
    ...overrides,
  }
}

const run = (
  name: string,
  args: Record<string, unknown> = {},
  d: AgentBuilderToolDeps | undefined = deps()
) => runAgentBuilderBuiltinTool(name, args, d, { sessionId: "b1" })

describe("manifest", () => {
  it("declares the four builder tools under the builder plugin id", () => {
    const entries = buildAgentBuilderManifestEntries()
    expect(entries.map((e) => e.name)).toEqual([
      "agent_builder_get_draft",
      "agent_builder_list_catalog",
      "agent_builder_update_draft",
      "agent_builder_create_agent",
    ])
    for (const e of entries) {
      expect(e.pluginId).toBe(AGENT_BUILDER_BUILTIN_PLUGIN_ID)
      expect(e.description.length).toBeGreaterThan(0)
      expect(e.jsonSchema).toMatchObject({ type: "object", additionalProperties: false })
    }
  })

  it("requires a catalog kind from the closed list", () => {
    const list = buildAgentBuilderManifestEntries().find((e) => e.name === T.listCatalog)!
    expect(list.jsonSchema.required).toEqual(["kind"])
    const props = list.jsonSchema.properties as Record<string, { enum?: string[] }>
    expect(props.kind.enum).toEqual([...CATALOG_KINDS])
  })

  it("constrains the patch schema to the editor's vocabularies", () => {
    const update = buildAgentBuilderManifestEntries().find((e) => e.name === T.updateDraft)!
    const props = update.jsonSchema.properties as Record<string, Record<string, unknown>>
    expect(props.avatar_color.enum).toEqual([...AGENT_AVATAR_COLORS])
    expect(props.permission_mode.enum).toEqual([...BUILDER_PERMISSION_MODES, "inherit"])
    expect(props.mcp_server_ids.anyOf).toEqual([
      { type: "array", items: { type: "string" } },
      { type: "null" },
    ])
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["name", "instructions", "skill_ids", "knowledge_base_ids", "memory"])
    )
  })

  it("builds independent entries on every call", () => {
    expect(buildAgentBuilderManifestEntries()).not.toBe(buildAgentBuilderManifestEntries())
  })
})

describe("isAgentBuilderBuiltinTool", () => {
  it("is true only for the builder tool names", () => {
    for (const name of Object.values(T)) expect(isAgentBuilderBuiltinTool(name)).toBe(true)
    expect(isAgentBuilderBuiltinTool("spawn_thread")).toBe(false)
    expect(isAgentBuilderBuiltinTool("mcp__cognia-plugin-tools__agent_builder_get_draft")).toBe(
      false
    )
    expect(isAgentBuilderBuiltinTool("")).toBe(false)
  })
})

describe("runAgentBuilderBuiltinTool guards", () => {
  it("rejects an unknown tool name without reading the session", async () => {
    const d = deps()
    expect(await run("agent_builder_delete_everything", {}, d)).toEqual({
      ok: false,
      error: "unknown agent builder tool: agent_builder_delete_everything",
    })
    expect(d.getSession).not.toHaveBeenCalled()
  })

  it("fails when host dependencies are unavailable", async () => {
    expect(
      await runAgentBuilderBuiltinTool(T.getDraft, {}, undefined, { sessionId: "b1" })
    ).toEqual({
      ok: false,
      error: "Agent builder host dependencies are unavailable",
    })
  })

  it("refuses a session that is not an agent builder", async () => {
    const d = deps(session({ kind: undefined }))
    const result = await run(T.updateDraft, { name: "X" }, d)
    expect(result).toEqual({
      ok: false,
      error: "These tools only work in an agent builder conversation.",
    })
    expect(d.writeDraft).not.toHaveBeenCalled()
  })

  it("refuses a missing session and a builder session without draft state", async () => {
    const missing = await run(
      T.getDraft,
      {},
      deps(session(), { getSession: jest.fn(async () => undefined) })
    )
    expect(missing).toEqual({
      ok: false,
      error: "These tools only work in an agent builder conversation.",
    })
    const noState = await run(T.getDraft, {}, deps(session({ agentBuilder: undefined })))
    expect(noState).toEqual({
      ok: false,
      error: "These tools only work in an agent builder conversation.",
    })
  })

  it("passes the calling session id to the lookup", async () => {
    const d = deps()
    await runAgentBuilderBuiltinTool(T.getDraft, {}, d, { sessionId: "other" })
    expect(d.getSession).toHaveBeenCalledWith("other")
  })

  it("refuses edits, listing and creation once the agent was created", async () => {
    const d = deps(
      session({ agentBuilder: builderState({ status: "created", createdCharacterId: "char_9" }) })
    )
    for (const name of [T.updateDraft, T.listCatalog, T.createAgent]) {
      expect(await run(name, { kind: "skills", name: "Y" }, d)).toEqual({
        ok: false,
        error: "The agent was already created (id char_9). Further edits happen in its Settings.",
      })
    }
    expect(d.writeDraft).not.toHaveBeenCalled()
    expect(d.createAgent).not.toHaveBeenCalled()
  })

  it("names an unknown id when a created state lost its character id", async () => {
    const d = deps(session({ agentBuilder: builderState({ status: "created" }) }))
    expect(await run(T.createAgent, {}, d)).toEqual({
      ok: false,
      error: "The agent was already created (id unknown). Further edits happen in its Settings.",
    })
  })

  it("still reads the draft once created", async () => {
    const d = deps(
      session({ agentBuilder: builderState({ status: "created", createdCharacterId: "c" }) })
    )
    expect(await run(T.getDraft, {}, d)).toMatchObject({ ok: true, status: "created" })
  })

  it("turns a thrown Error into a tool error", async () => {
    const d = deps(session(), {
      getSession: jest.fn(async () => Promise.reject(new Error("db closed"))),
    })
    expect(await run(T.getDraft, {}, d)).toEqual({ ok: false, error: "db closed" })
  })

  it("stringifies a thrown non-Error", async () => {
    const d = deps(session(), {
      createAgent: jest.fn(async () => {
        throw "boom"
      }),
    })
    expect(await run(T.createAgent, {}, d)).toEqual({ ok: false, error: "boom" })
  })
})

describe("agent_builder_get_draft", () => {
  it("returns the status, revision, last editor and the rendered draft", async () => {
    const row = session()
    expect(await run(T.getDraft, {}, deps(row))).toEqual({
      ok: true,
      status: "drafting",
      revision: 3,
      last_edited_by: "user",
      draft: renderDraftForModel(row.agentBuilder!.draft, CATALOGS),
    })
  })

  it("resolves referenced ids to catalog names", async () => {
    const result = (await run(T.getDraft)) as { draft: { skills: unknown } }
    expect(result.draft.skills).toEqual([{ id: "sk-review", name: "Code Review" }])
  })
})

describe("agent_builder_list_catalog", () => {
  it("rejects a missing, non-string or unknown kind", async () => {
    const error = `kind must be one of ${CATALOG_KINDS.join(", ")}`
    expect(await run(T.listCatalog, {})).toEqual({ ok: false, error })
    expect(await run(T.listCatalog, { kind: 3 })).toEqual({ ok: false, error })
    expect(await run(T.listCatalog, { kind: "tools" })).toEqual({ ok: false, error })
  })

  it("lists skills with descriptions only where present", async () => {
    expect(await run(T.listCatalog, { kind: "skills" })).toEqual({
      ok: true,
      kind: "skills",
      items: [
        { id: "sk-review", name: "Code Review", description: "Reviews diffs" },
        { id: "sk-write", name: "Writer" },
      ],
      total: 2,
    })
  })

  it("drops an empty description from plugin skills", async () => {
    expect(await run(T.listCatalog, { kind: "plugin_skills" })).toEqual({
      ok: true,
      kind: "plugin_skills",
      items: [{ id: "plug:lint", name: "Lint" }],
      total: 1,
    })
  })

  it("carries the enabled flag for MCP servers, false included, but not the transport", async () => {
    expect(await run(T.listCatalog, { kind: "mcp_servers" })).toEqual({
      ok: true,
      kind: "mcp_servers",
      items: [
        { id: "mcp-gh", name: "GitHub", enabled: true },
        { id: "mcp-off", name: "Offline", enabled: false },
      ],
      total: 2,
    })
  })

  it("lists knowledge bases", async () => {
    expect(await run(T.listCatalog, { kind: "knowledge_bases" })).toMatchObject({
      items: [{ id: "kb-1", name: "Handbook", description: "Team handbook" }],
      total: 1,
    })
  })

  it("lists models from the model source without reading the catalogs", async () => {
    const d = deps()
    expect(await run(T.listCatalog, { kind: "models" }, d)).toEqual({
      ok: true,
      kind: "models",
      items: MODELS,
      total: 2,
    })
    expect(d.catalogs).not.toHaveBeenCalled()
  })

  it("filters case-insensitively on name, id or description, trimming the query", async () => {
    expect(await run(T.listCatalog, { kind: "skills", query: "  REVIEW " })).toMatchObject({
      items: [{ id: "sk-review" }],
      total: 1,
    })
    expect(await run(T.listCatalog, { kind: "skills", query: "sk-wr" })).toMatchObject({
      items: [{ id: "sk-write" }],
    })
    expect(await run(T.listCatalog, { kind: "knowledge_bases", query: "team" })).toMatchObject({
      total: 1,
    })
    expect(await run(T.listCatalog, { kind: "models", query: "haiku" })).toMatchObject({
      items: [{ id: "claude-haiku", name: "Haiku" }],
      total: 1,
    })
    expect(await run(T.listCatalog, { kind: "skills", query: "nothing-matches" })).toMatchObject({
      items: [],
      total: 0,
    })
  })

  it("treats a blank or non-string query as no filter", async () => {
    expect(await run(T.listCatalog, { kind: "skills", query: "   " })).toMatchObject({ total: 2 })
    expect(await run(T.listCatalog, { kind: "skills", query: 7 })).toMatchObject({ total: 2 })
  })

  it("caps items at 200 but reports the full total", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}` }))
    const result = (await run(
      T.listCatalog,
      { kind: "models" },
      deps(session(), { models: () => many })
    )) as {
      items: unknown[]
      total: number
    }
    expect(result.items).toHaveLength(200)
    expect(result.total).toBe(250)
  })
})

describe("agent_builder_update_draft", () => {
  it("writes the patch for the calling session with the live catalogs", async () => {
    const d = deps()
    const result = await run(T.updateDraft, { name: "Code Reviewer", skill_ids: ["sk-write"] }, d)
    expect(d.writeDraft).toHaveBeenCalledWith(
      "b1",
      { name: "Code Reviewer", skill_ids: ["sk-write"] },
      CATALOGS
    )
    expect(result).toMatchObject({
      ok: true,
      applied: ["name", "skill_ids"],
      rejected: [],
      revision: 4,
    })
    expect((result as { draft: { name: string } }).draft.name).toBe("Code Reviewer")
  })

  it("rejects unknown ids, keeps the valid fields and points at the valid set", async () => {
    const result = (await run(T.updateDraft, {
      description: "Reviews pull requests",
      skill_ids: ["sk-review", "sk-ghost"],
    })) as {
      ok: boolean
      applied: string[]
      rejected: Array<{ field: string; reason: string }>
      draft: { description: string; skills: unknown }
    }
    expect(result.ok).toBe(false)
    expect(result.applied).toEqual(["description"])
    expect(result.rejected).toEqual([
      {
        field: "skill_ids",
        reason: "unknown id(s): sk-ghost. Call agent_builder_list_catalog for the valid ids.",
      },
    ])
    expect(result.draft.description).toBe("Reviews pull requests")
    // The rejected field kept its previous value.
    expect(result.draft.skills).toEqual([{ id: "sk-review", name: "Code Review" }])
  })

  it("renders the returned draft against the same catalogs", async () => {
    const d = deps(session(), {
      writeDraft: jest.fn(async () => ({
        state: builderState({ draft: { knowledgeBaseIds: ["kb-1"] }, revision: 9 }),
        changed: ["knowledge_base_ids"],
        rejected: [],
      })),
    })
    const result = (await run(T.updateDraft, { knowledge_base_ids: ["kb-1"] }, d)) as {
      revision: number
      draft: { knowledge_bases: unknown }
    }
    expect(result.revision).toBe(9)
    expect(result.draft.knowledge_bases).toEqual([{ id: "kb-1", name: "Handbook" }])
  })

  it("reports a write failure as a tool error", async () => {
    const d = deps(session(), {
      writeDraft: jest.fn(async () => {
        throw new Error("This draft was already created as an agent.")
      }),
    })
    expect(await run(T.updateDraft, { name: "X" }, d)).toEqual({
      ok: false,
      error: "This draft was already created as an agent.",
    })
  })
})

describe("agent_builder_create_agent", () => {
  it("creates the agent for the calling session and returns its id and name", async () => {
    const d = deps()
    expect(await run(T.createAgent, {}, d)).toEqual({
      ok: true,
      agent_id: "char_new",
      name: "Reviewer",
    })
    expect(d.createAgent).toHaveBeenCalledWith("b1")
  })

  it("surfaces an invalid draft as a tool error", async () => {
    const d = deps(session(), {
      createAgent: jest.fn(async () => {
        throw new Error("The draft is not ready: missing-instructions.")
      }),
    })
    expect(await run(T.createAgent, {}, d)).toEqual({
      ok: false,
      error: "The draft is not ready: missing-instructions.",
    })
  })
})
