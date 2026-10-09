import type { AgentBuilderDraft } from "@cognia/agent-config-types"
import {
  BUILDER_PERMISSION_MODES,
  DRAFT_DESCRIPTION_MAX,
  DRAFT_INSTRUCTIONS_MAX,
  DRAFT_NAME_MAX,
  DRAFT_STARTER_MAX,
  DRAFT_STARTERS_MAX,
  applyDraftPatch,
  draftIssues,
  isDraftEmpty,
  renderDraftForModel,
  type DraftCatalogs,
  type DraftPatch,
} from "./draft-ops"

const catalogs: DraftCatalogs = {
  skills: [
    { id: "sk1", name: "Skill One", description: "first" },
    { id: "sk2", name: "Skill Two" },
  ],
  pluginSkills: [{ id: "ps1", name: "Plugin Skill" }],
  mcpServers: [
    { id: "m1", name: "Server One", enabled: true, transport: "stdio" },
    { id: "m2", name: "Server Two" },
  ],
  knowledgeBases: [{ id: "kb1", name: "Docs" }],
}

const apply = (patch: DraftPatch, current: AgentBuilderDraft = {}) =>
  applyDraftPatch(current, patch, catalogs)

describe("constants", () => {
  it("never lets the builder pick a mode that skips approvals", () => {
    expect([...BUILDER_PERMISSION_MODES]).toEqual(["default", "acceptEdits", "plan", "auto"])
    expect(BUILDER_PERMISSION_MODES).not.toContain("bypassPermissions")
    expect(BUILDER_PERMISSION_MODES).not.toContain("dontAsk")
  })

  it("allows at most three conversation starters", () => {
    expect(DRAFT_STARTERS_MAX).toBe(3)
  })
})

describe("applyDraftPatch: purity and shape", () => {
  it("returns an empty result for an empty patch and does not mutate the input", () => {
    const current: AgentBuilderDraft = { name: "Keep" }
    const result = apply({}, current)
    expect(result.changed).toEqual([])
    expect(result.rejected).toEqual([])
    expect(result.draft).toEqual({ name: "Keep" })
    expect(result.draft).not.toBe(current)
  })

  it("does not mutate the draft it was given", () => {
    const current: AgentBuilderDraft = { name: "Old", persona: { tone: "calm" } }
    const snapshot = JSON.parse(JSON.stringify(current))
    apply({ name: "New", persona_tone: "warm" }, current)
    expect(current).toEqual(snapshot)
  })

  it("lists changed fields in patch order", () => {
    const result = apply({
      name: "A",
      description: "d",
      avatar_emoji: "🤖",
      avatar_color: "red",
      instructions: "You do things.",
    })
    expect(result.changed).toEqual([
      "name",
      "description",
      "avatar_emoji",
      "avatar_color",
      "instructions",
    ])
    expect(result.draft).toMatchObject({
      name: "A",
      description: "d",
      avatarEmoji: "🤖",
      avatarColor: "red",
      systemPrompt: "You do things.",
    })
  })

  it("rejects only the failing field and still applies the rest", () => {
    const result = apply({ name: "Good", skill_ids: ["nope"], description: "fine" })
    expect(result.changed).toEqual(["name", "description"])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].field).toBe("skill_ids")
    expect(result.draft.skillIds).toBeUndefined()
    expect(result.draft.name).toBe("Good")
  })
})

describe("applyDraftPatch: text fields", () => {
  it("trims name and accepts exactly the max length", () => {
    const ok = apply({ name: `  ${"n".repeat(DRAFT_NAME_MAX)}  ` })
    expect(ok.draft.name).toHaveLength(DRAFT_NAME_MAX)
    expect(ok.rejected).toEqual([])
  })

  it("rejects an over-long name and keeps the previous one", () => {
    const result = apply({ name: "n".repeat(DRAFT_NAME_MAX + 1) }, { name: "prev" })
    expect(result.draft.name).toBe("prev")
    expect(result.changed).toEqual([])
    expect(result.rejected).toEqual([
      { field: "name", reason: `longer than ${DRAFT_NAME_MAX} characters` },
    ])
  })

  it("ignores a non-string name", () => {
    const result = apply({ name: 5 } as unknown as DraftPatch, { name: "prev" })
    expect(result.changed).toEqual([])
    expect(result.draft.name).toBe("prev")
  })

  it("clears the description when it is blank, rejects an over-long one", () => {
    const cleared = apply({ description: "   " }, { description: "was" })
    expect(cleared.changed).toEqual(["description"])
    expect(cleared.draft.description).toBeUndefined()

    const tooLong = apply({ description: "d".repeat(DRAFT_DESCRIPTION_MAX + 1) })
    expect(tooLong.rejected).toEqual([
      { field: "description", reason: `longer than ${DRAFT_DESCRIPTION_MAX} characters` },
    ])
    expect(apply({ description: "d".repeat(DRAFT_DESCRIPTION_MAX) }).rejected).toEqual([])
  })

  it("accepts a ZWJ emoji sequence by counting code points rather than UTF-16 units", () => {
    // 3 code points (6 UTF-16 units), still within the four-code-point allowance.
    expect(apply({ avatar_emoji: "👩‍💻" }).draft.avatarEmoji).toBe("👩‍💻")
    expect(apply({ avatar_emoji: "🚀" }).draft.avatarEmoji).toBe("🚀")
    expect(apply({ avatar_emoji: "🚀🚀🚀🚀" }).draft.avatarEmoji).toBe("🚀🚀🚀🚀")
  })

  it("rejects an emoji field of more than four code points and clears on blank", () => {
    const bad = apply({ avatar_emoji: "abcde" })
    expect(bad.rejected).toEqual([{ field: "avatar_emoji", reason: "use a single emoji" }])
    expect(bad.draft.avatarEmoji).toBeUndefined()
    const cleared = apply({ avatar_emoji: "" }, { avatarEmoji: "🚀" })
    expect(cleared.changed).toEqual(["avatar_emoji"])
    expect(cleared.draft.avatarEmoji).toBeUndefined()
  })

  it("ignores a blank avatar colour instead of clearing it", () => {
    const result = apply({ avatar_color: "  " }, { avatarColor: "blue" })
    expect(result.changed).toEqual([])
    expect(result.draft.avatarColor).toBe("blue")
  })

  it("keeps instructions verbatim (untrimmed) and enforces the max length", () => {
    const text = "  You are X.  \n"
    expect(apply({ instructions: text }).draft.systemPrompt).toBe(text)
    expect(apply({ instructions: "" }).changed).toEqual(["instructions"])
    const tooLong = apply({ instructions: "i".repeat(DRAFT_INSTRUCTIONS_MAX + 1) })
    expect(tooLong.rejected).toEqual([
      { field: "instructions", reason: `longer than ${DRAFT_INSTRUCTIONS_MAX} characters` },
    ])
    expect(apply({ instructions: "i".repeat(DRAFT_INSTRUCTIONS_MAX) }).rejected).toEqual([])
  })
})

describe("applyDraftPatch: persona", () => {
  it("builds the persona from tone, personality and opening message under one change entry", () => {
    const result = apply({
      persona_tone: " warm ",
      persona_personality: "curious",
      opening_message: "Hi!",
    })
    expect(result.changed).toEqual(["persona"])
    expect(result.draft.persona).toEqual({
      tone: "warm",
      personality: "curious",
      openingMessage: "Hi!",
    })
  })

  it("merges into an existing persona and leaves unpatched members alone", () => {
    const result = apply({ persona_tone: "dry" }, { persona: { tone: "warm", personality: "p" } })
    expect(result.draft.persona).toEqual({ tone: "dry", personality: "p" })
  })

  it("clears a member with a blank string and drops the persona when nothing remains", () => {
    const partial = apply({ persona_tone: "" }, { persona: { tone: "warm", personality: "p" } })
    expect(partial.draft.persona).toMatchObject({ personality: "p" })
    expect(partial.draft.persona?.tone).toBeUndefined()

    const gone = apply({ persona_tone: "" }, { persona: { tone: "warm" } })
    expect(gone.changed).toEqual(["persona"])
    expect(gone.draft.persona).toBeUndefined()
  })

  it("stores conversation starters as de-duplicated, trimmed exemplar prompts", () => {
    const result = apply({ conversation_starters: [" a ", "a", "b", "", 3 as unknown as string] })
    expect(result.draft.persona?.exemplarPrompts).toEqual(["a", "b"])
  })

  it("accepts exactly the max number of starters and rejects one more", () => {
    const ok = apply({ conversation_starters: ["1", "2", "3"] })
    expect(ok.rejected).toEqual([])
    expect(ok.draft.persona?.exemplarPrompts).toEqual(["1", "2", "3"])

    const tooMany = apply({ conversation_starters: ["1", "2", "3", "4"] })
    expect(tooMany.rejected).toEqual([
      { field: "conversation_starters", reason: `at most ${DRAFT_STARTERS_MAX}` },
    ])
    expect(tooMany.changed).toEqual([])
    expect(tooMany.draft.persona).toBeUndefined()
  })

  it("counts duplicates once before applying the starter cap", () => {
    const result = apply({ conversation_starters: ["1", "1", "2", "3", "3"] })
    expect(result.rejected).toEqual([])
    expect(result.draft.persona?.exemplarPrompts).toEqual(["1", "2", "3"])
  })

  it("rejects a starter that is too long", () => {
    const result = apply({ conversation_starters: ["x".repeat(DRAFT_STARTER_MAX + 1)] })
    expect(result.rejected).toEqual([
      {
        field: "conversation_starters",
        reason: `each at most ${DRAFT_STARTER_MAX} characters`,
      },
    ])
    expect(apply({ conversation_starters: ["x".repeat(DRAFT_STARTER_MAX)] }).rejected).toEqual([])
  })

  it("clears starters with an empty list", () => {
    const result = apply(
      { conversation_starters: [] },
      { persona: { exemplarPrompts: ["a"], tone: "t" } }
    )
    expect(result.draft.persona).toEqual({ tone: "t", exemplarPrompts: undefined })
  })

  it("ignores a non-array starters value", () => {
    const result = apply({ conversation_starters: "x" } as unknown as DraftPatch)
    expect(result.changed).toEqual([])
    expect(result.rejected).toEqual([])
  })

  it("still applies the persona members when only the starters are rejected", () => {
    const result = apply({ persona_tone: "warm", conversation_starters: ["1", "2", "3", "4"] })
    expect(result.changed).toEqual(["persona"])
    expect(result.draft.persona).toEqual({ tone: "warm" })
    expect(result.rejected.map((r) => r.field)).toEqual(["conversation_starters"])
  })
})

describe("applyDraftPatch: capability ids", () => {
  it("sets skills that exist and clears them with an empty list", () => {
    const set = apply({ skill_ids: ["sk1", "sk2", "sk1"] })
    expect(set.draft.skillIds).toEqual(["sk1", "sk2"])
    expect(set.changed).toEqual(["skill_ids"])
    const cleared = apply({ skill_ids: [] }, { skillIds: ["sk1"] })
    expect(cleared.changed).toEqual(["skill_ids"])
    expect(cleared.draft.skillIds).toBeUndefined()
  })

  it("rejects unknown skill ids naming all of them, and keeps the existing value", () => {
    const result = apply({ skill_ids: ["sk1", "x", "y"] }, { skillIds: ["sk2"] })
    expect(result.draft.skillIds).toEqual(["sk2"])
    expect(result.changed).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].field).toBe("skill_ids")
    expect(result.rejected[0].reason).toContain("unknown id(s): x, y")
    expect(result.rejected[0].reason).toContain("agent_builder_list_catalog")
  })

  it("validates plugin skills against the plugin skill catalog, not the skill catalog", () => {
    expect(apply({ plugin_skill_ids: ["ps1"] }).draft.pluginSkillIds).toEqual(["ps1"])
    const result = apply({ plugin_skill_ids: ["sk1"] })
    expect(result.rejected[0]).toMatchObject({ field: "plugin_skill_ids" })
    expect(result.draft.pluginSkillIds).toBeUndefined()
  })

  it("validates knowledge bases and clears with an empty list", () => {
    expect(apply({ knowledge_base_ids: ["kb1"] }).draft.knowledgeBaseIds).toEqual(["kb1"])
    expect(apply({ knowledge_base_ids: ["zzz"] }).rejected[0]).toMatchObject({
      field: "knowledge_base_ids",
    })
    expect(
      apply({ knowledge_base_ids: [] }, { knowledgeBaseIds: ["kb1"] }).draft.knowledgeBaseIds
    ).toBeUndefined()
  })

  it("restricts MCP servers to known ids", () => {
    expect(apply({ mcp_server_ids: ["m1"] }).draft.mcpServerIds).toEqual(["m1"])
    const bad = apply({ mcp_server_ids: ["m9"] }, { mcpServerIds: ["m1"] })
    expect(bad.rejected[0]).toMatchObject({ field: "mcp_server_ids" })
    expect(bad.draft.mcpServerIds).toEqual(["m1"])
  })

  it("treats null as 'every enabled MCP server' and an empty list the same way", () => {
    const nulled = apply({ mcp_server_ids: null }, { mcpServerIds: ["m1"] })
    expect(nulled.changed).toEqual(["mcp_server_ids"])
    expect(nulled.draft.mcpServerIds).toBeUndefined()
    const empty = apply({ mcp_server_ids: [] }, { mcpServerIds: ["m1"] })
    expect(empty.changed).toEqual(["mcp_server_ids"])
    expect(empty.draft.mcpServerIds).toBeUndefined()
  })
})

describe("applyDraftPatch: models", () => {
  it("sets execute, plan and utility routing and mirrors execute into model", () => {
    const result = apply({ model: " m-exec ", plan_model: "m-plan", utility_model: "m-util" })
    expect(result.changed).toEqual(["model"])
    expect(result.draft.modelRouting).toEqual({
      execute: "m-exec",
      plan: "m-plan",
      utility: "m-util",
    })
    expect(result.draft.model).toBe("m-exec")
  })

  it("keeps routing members that the patch does not mention", () => {
    const result = apply(
      { plan_model: "p2" },
      { model: "e", modelRouting: { execute: "e", plan: "p", utility: "u" } }
    )
    expect(result.draft.modelRouting).toEqual({ execute: "e", plan: "p2", utility: "u" })
    expect(result.draft.model).toBe("e")
  })

  it("clears everything when all routing members end up empty", () => {
    const result = apply({ model: "" }, { model: "e", modelRouting: { execute: "e" } })
    expect(result.changed).toEqual(["model"])
    expect(result.draft.modelRouting).toBeUndefined()
    expect(result.draft.model).toBeUndefined()
  })

  it("keeps the routing but clears model when only execute is emptied", () => {
    const result = apply({ model: "" }, { model: "e", modelRouting: { execute: "e", plan: "p" } })
    expect(result.draft.modelRouting).toEqual({ execute: undefined, plan: "p", utility: undefined })
    expect(result.draft.model).toBeUndefined()
  })
})

describe("applyDraftPatch: permission mode", () => {
  it.each(["default", "acceptEdits", "plan", "auto"] as const)("accepts %s", (mode) => {
    const result = apply({ permission_mode: mode })
    expect(result.draft.permissionMode).toBe(mode)
    expect(result.changed).toEqual(["permission_mode"])
  })

  it("inherit clears the mode", () => {
    const result = apply({ permission_mode: "inherit" }, { permissionMode: "plan" })
    expect(result.changed).toEqual(["permission_mode"])
    expect(result.draft.permissionMode).toBeUndefined()
  })

  it.each(["bypassPermissions", "dontAsk", "yolo"])(
    "refuses %s and leaves the mode alone",
    (mode) => {
      const result = apply({ permission_mode: mode as never }, { permissionMode: "plan" })
      expect(result.draft.permissionMode).toBe("plan")
      expect(result.changed).toEqual([])
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0].field).toBe("permission_mode")
      expect(result.rejected[0].reason).toContain("default, acceptEdits, plan, auto")
      expect(result.rejected[0].reason).toContain("set by the user")
    }
  )
})

describe("applyDraftPatch: execution policy", () => {
  it("sets effort and max turns under one 'execution' entry", () => {
    const result = apply({ effort: "high", max_turns: 20 })
    expect(result.changed).toEqual(["execution"])
    expect(result.draft.executionPolicy).toMatchObject({ effort: "high", maxTurns: 20 })
  })

  it("preserves existing env bindings", () => {
    const envBindings = [{ name: "TOKEN" }] as never
    const result = apply({ effort: "low" }, { executionPolicy: { envBindings } })
    expect(result.draft.executionPolicy).toEqual({ envBindings, effort: "low" })
  })

  it("inherit and null clear the values, dropping the policy when nothing is left", () => {
    const result = apply(
      { effort: "inherit", max_turns: null },
      { executionPolicy: { effort: "max", maxTurns: 5 } }
    )
    expect(result.changed).toEqual(["execution"])
    expect(result.draft.executionPolicy).toBeUndefined()
  })

  it("keeps the policy when env bindings remain after clearing", () => {
    const envBindings = [{ name: "TOKEN" }] as never
    const result = apply({ effort: "inherit" }, { executionPolicy: { effort: "max", envBindings } })
    expect(result.draft.executionPolicy).toMatchObject({ envBindings })
    expect(result.draft.executionPolicy?.effort).toBeUndefined()
  })

  it.each(["low", "medium", "high", "xhigh", "max"] as const)("accepts effort %s", (effort) => {
    expect(apply({ effort }).draft.executionPolicy?.effort).toBe(effort)
  })

  it("rejects an unknown effort without touching the policy", () => {
    const result = apply({ effort: "turbo" as never }, { executionPolicy: { effort: "low" } })
    expect(result.rejected).toEqual([
      { field: "effort", reason: "must be one of low, medium, high, xhigh, max or inherit" },
    ])
    expect(result.changed).toEqual([])
    expect(result.draft.executionPolicy).toEqual({ effort: "low" })
  })

  it.each([0, 101, 1.5, -2, Number.NaN, "5"])("rejects max_turns %p", (value) => {
    const result = apply({ max_turns: value as never })
    expect(result.rejected).toEqual([
      { field: "max_turns", reason: "an integer from 1 to 100, or null" },
    ])
    expect(result.changed).toEqual([])
  })

  it.each([1, 100])("accepts max_turns boundary %p", (value) => {
    expect(apply({ max_turns: value }).draft.executionPolicy?.maxTurns).toBe(value)
  })

  it("applies neither effort nor max_turns when one of them is invalid", () => {
    const bad = apply({ effort: "high", max_turns: 0 })
    expect(bad.draft.executionPolicy).toBeUndefined()
    expect(bad.changed).toEqual([])
    expect(bad.rejected.map((r) => r.field)).toEqual(["max_turns"])
  })
})

describe("applyDraftPatch: tools and flags", () => {
  it("sets allowed and disallowed tool lists de-duplicated, clearing on empty", () => {
    const set = apply({ allowed_tools: ["Read", "Read", " Grep "], disallowed_tools: ["Bash"] })
    expect(set.draft.allowedTools).toEqual(["Read", "Grep"])
    expect(set.draft.disallowedTools).toEqual(["Bash"])
    expect(set.changed).toEqual(["allowed_tools", "disallowed_tools"])
    const cleared = apply(
      { allowed_tools: [], disallowed_tools: [] },
      { allowedTools: ["Read"], disallowedTools: ["Bash"] }
    )
    expect(cleared.draft.allowedTools).toBeUndefined()
    expect(cleared.draft.disallowedTools).toBeUndefined()
  })

  it("stores boolean flags as true and clears them on false", () => {
    const on = apply({ enable_browser_tools: true, enable_computer_use: true, brief_mode: true })
    expect(on.draft).toMatchObject({
      enableBrowserTools: true,
      enableComputerUse: true,
      briefMode: true,
    })
    expect(on.changed).toEqual(["enable_browser_tools", "enable_computer_use", "brief_mode"])
    const off = apply(
      { enable_browser_tools: false, enable_computer_use: false, brief_mode: false },
      { enableBrowserTools: true, enableComputerUse: true, briefMode: true }
    )
    expect(off.draft.enableBrowserTools).toBeUndefined()
    expect(off.draft.enableComputerUse).toBeUndefined()
    expect(off.draft.briefMode).toBeUndefined()
    expect(off.changed).toHaveLength(3)
  })

  it("ignores non-boolean flags", () => {
    const result = apply({ brief_mode: "yes" } as unknown as DraftPatch)
    expect(result.changed).toEqual([])
  })
})

describe("applyDraftPatch: memory", () => {
  it("starts from the all-on default policy and flips only the named switches", () => {
    const result = apply({ memory: { forget: false, auto_learn: false } })
    expect(result.changed).toEqual(["memory"])
    expect(result.draft.memoryPolicy).toEqual({
      operations: { recall: true, create: true, update: true, forget: false },
      readableScopes: ["global", "workspace", "character", "agent"],
      writableScopes: ["global", "workspace", "character", "agent"],
      autoLearn: false,
    })
  })

  it("builds on the existing policy, preserving scopes", () => {
    const existing = {
      operations: { recall: false, create: false, update: true, forget: true },
      readableScopes: ["global"],
      writableScopes: [],
      autoLearn: false,
    } as never
    const result = apply({ memory: { recall: true } }, { memoryPolicy: existing })
    expect(result.draft.memoryPolicy).toEqual({
      operations: { recall: true, create: false, update: true, forget: true },
      readableScopes: ["global"],
      writableScopes: [],
      autoLearn: false,
    })
  })

  it("ignores non-boolean members", () => {
    const result = apply({ memory: { recall: "no" } } as unknown as DraftPatch)
    expect(result.draft.memoryPolicy?.operations.recall).toBe(true)
  })

  it("does not touch memory when the patch value is not an object", () => {
    const result = apply({ memory: null } as unknown as DraftPatch)
    expect(result.changed).toEqual([])
    expect(result.draft.memoryPolicy).toBeUndefined()
  })
})

describe("isDraftEmpty", () => {
  it("is true for an empty draft and one holding only blanks", () => {
    expect(isDraftEmpty({})).toBe(true)
    expect(isDraftEmpty({ name: undefined, description: "", skillIds: [] })).toBe(true)
  })

  it("is false once any field carries a value", () => {
    expect(isDraftEmpty({ name: "x" })).toBe(false)
    expect(isDraftEmpty({ skillIds: ["a"] })).toBe(false)
    expect(isDraftEmpty({ briefMode: false })).toBe(false)
    expect(isDraftEmpty({ runtime: { kind: "builtin" } })).toBe(false)
  })
})

describe("draftIssues", () => {
  it("asks for a name first, then instructions, then is clean", () => {
    expect(draftIssues({})).toEqual([{ code: "nameRequired" }])
    expect(draftIssues({ name: "   ", systemPrompt: "x" })).toEqual([{ code: "nameRequired" }])
    expect(draftIssues({ name: "A" })).toEqual([{ code: "systemPromptRequired" }])
    expect(draftIssues({ name: "A", systemPrompt: "  " })).toEqual([
      { code: "systemPromptRequired" },
    ])
    expect(draftIssues({ name: "A", systemPrompt: "You do X." })).toEqual([])
  })

  it("reports invalid max turns and environment binding problems", () => {
    const base = { name: "A", systemPrompt: "x" }
    expect(draftIssues({ ...base, executionPolicy: { maxTurns: 0 } })).toEqual([
      { code: "maxTurnsInvalid" },
    ])
    expect(
      draftIssues({ ...base, executionPolicy: { envBindings: [{ name: "1bad" }] as never } })
    ).toEqual([{ code: "envNameInvalid", name: "1bad" }])
    expect(
      draftIssues({
        ...base,
        executionPolicy: { envBindings: [{ name: "A_B" }, { name: " A_B " }] as never },
      })
    ).toEqual([{ code: "envNameDuplicate", name: "A_B" }])
  })
})

describe("renderDraftForModel", () => {
  it("renders an empty draft with blank strings, empty lists and the missing codes", () => {
    const view = renderDraftForModel({}, catalogs)
    expect(view).toMatchObject({
      name: "",
      description: "",
      avatar_emoji: "",
      avatar_color: "",
      instructions: "",
      persona_tone: "",
      persona_personality: "",
      opening_message: "",
      conversation_starters: [],
      skills: [],
      plugin_skills: [],
      mcp_servers: "all-enabled",
      knowledge_bases: [],
      model: "",
      plan_model: "",
      utility_model: "",
      permission_mode: "inherit",
      effort: "inherit",
      max_turns: null,
      allowed_tools: [],
      disallowed_tools: [],
      enable_browser_tools: false,
      enable_computer_use: false,
      brief_mode: false,
      memory: "default",
      runtime: "app-default",
      missing: ["nameRequired"],
    })
  })

  it("pairs ids with catalog names, using null for ids no longer in the catalog", () => {
    const view = renderDraftForModel(
      {
        skillIds: ["sk1", "gone"],
        pluginSkillIds: ["ps1"],
        mcpServerIds: ["m2"],
        knowledgeBaseIds: ["kb1"],
      },
      catalogs
    )
    expect(view.skills).toEqual([
      { id: "sk1", name: "Skill One" },
      { id: "gone", name: null },
    ])
    expect(view.plugin_skills).toEqual([{ id: "ps1", name: "Plugin Skill" }])
    expect(view.mcp_servers).toEqual([{ id: "m2", name: "Server Two" }])
    expect(view.knowledge_bases).toEqual([{ id: "kb1", name: "Docs" }])
  })

  it("shows an empty (not 'all-enabled') MCP list when the draft sets one", () => {
    expect(renderDraftForModel({ mcpServerIds: [] }, catalogs).mcp_servers).toEqual([])
  })

  it("renders a complete draft including routing, policy, memory and runtime", () => {
    const view = renderDraftForModel(
      {
        name: "Aide",
        description: "Helps",
        avatarEmoji: "🤖",
        avatarColor: "red",
        systemPrompt: "You help.",
        persona: {
          tone: "warm",
          personality: "kind",
          openingMessage: "Hello",
          exemplarPrompts: ["q"],
        },
        model: "legacy",
        modelRouting: { execute: "e", plan: "p", utility: "u" },
        permissionMode: "plan",
        executionPolicy: { effort: "high", maxTurns: 7 },
        allowedTools: ["Read"],
        disallowedTools: ["Bash"],
        enableBrowserTools: true,
        enableComputerUse: true,
        briefMode: true,
        memoryPolicy: {
          operations: { recall: true, create: false, update: true, forget: false },
          readableScopes: ["global"],
          writableScopes: ["global"],
          autoLearn: false,
        },
        runtime: { kind: "builtin" },
      },
      catalogs
    )
    expect(view).toMatchObject({
      name: "Aide",
      description: "Helps",
      avatar_emoji: "🤖",
      avatar_color: "red",
      instructions: "You help.",
      persona_tone: "warm",
      persona_personality: "kind",
      opening_message: "Hello",
      conversation_starters: ["q"],
      model: "e",
      plan_model: "p",
      utility_model: "u",
      permission_mode: "plan",
      effort: "high",
      max_turns: 7,
      allowed_tools: ["Read"],
      disallowed_tools: ["Bash"],
      enable_browser_tools: true,
      enable_computer_use: true,
      brief_mode: true,
      memory: { recall: true, create: false, update: true, forget: false, auto_learn: false },
      runtime: { kind: "builtin" },
      missing: [],
    })
  })

  it("falls back to the plain model when no routing exists", () => {
    expect(renderDraftForModel({ model: "solo" }, catalogs).model).toBe("solo")
  })

  it("round-trips: a patch applied then rendered shows what was written", () => {
    const { draft } = apply({
      name: "Rev",
      instructions: "You review.",
      skill_ids: ["sk2"],
      mcp_server_ids: ["m1"],
    })
    const view = renderDraftForModel(draft, catalogs)
    expect(view.name).toBe("Rev")
    expect(view.skills).toEqual([{ id: "sk2", name: "Skill Two" }])
    expect(view.mcp_servers).toEqual([{ id: "m1", name: "Server One" }])
    expect(view.missing).toEqual([])
  })
})
