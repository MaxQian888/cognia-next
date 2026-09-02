import { TemplateCatalog } from "@/lib/templates/catalog"
import { createTemplateDefinition } from "@/lib/templates/contracts"
import type { TemplateRuntime } from "@/lib/templates/runtime"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import type { AgentTeam, AgentTeamTemplate, AgentTeammate } from "@/types/agent/agent-team"

import {
  LIST_MAX_ITEMS,
  READ_CONTENT_MAX_CHARS,
  TEMPLATE_BUILTIN_PLUGIN_ID,
  TEMPLATE_READ_TOOL_NAMES,
  TEMPLATE_TOOL_NAMES,
  TEMPLATE_WRITE_TOOL_NAMES,
  buildTemplateManifestEntries,
  isTemplateBuiltinTool,
  runTemplateBuiltinTool,
  type TemplateToolDeps,
} from "./template-builtin-tools"

const ctx = { sessionId: "s1" }

async function definition(overrides: Partial<Parameters<typeof createTemplateDefinition>[0]> = {}) {
  return createTemplateDefinition({
    id: "user.workflow.one",
    domain: "workflow",
    status: "published",
    revision: 1,
    version: "1.0.0",
    metadata: { name: "Nightly digest", description: "Summarise the day", tags: ["ops"] },
    payload: { nodes: [] },
    inputs: [],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["desktop", "web"] },
    provenance: { source: "user", trust: "unsigned" },
    ...overrides,
  })
}

const squadTemplate: AgentTeamTemplate = {
  id: "tpl-1",
  name: "Reviewers",
  description: "Two reviewers",
  category: "review",
  teammates: [
    { name: "Alpha", description: "" },
    { name: "Beta", description: "" },
  ],
}

const team = {
  id: "team-1",
  name: "Alpha squad",
  description: "",
  task: "Ship it",
  status: "idle",
  projectId: "proj-1",
} as AgentTeam

const teammate = {
  id: "mate-1",
  teamId: "team-1",
  name: "Alpha",
  role: "member",
  status: "idle",
} as AgentTeammate

const chatRow: ChatTemplateRow = {
  id: "ct-1",
  name: "Standup",
  description: "Daily standup prompt",
  body: "What did {{who}} do yesterday?",
  params: [{ id: "who", label: "Who", required: true, kind: "text" }],
  revision: 3,
  usageCount: 4,
  lastUsedAt: 20,
  createdAt: 1,
  updatedAt: 10,
}

interface PreflightInput {
  definitionId: string
  platform: string
}

interface Harness {
  deps: TemplateToolDeps
  catalog: TemplateCatalog
  consent: jest.Mock
  preflight: jest.Mock
  instantiate: jest.Mock
  applySquadTemplate: jest.Mock
  publishSquadTemplate: jest.Mock
  saveAsTemplate: jest.Mock
  teams: Record<string, AgentTeam>
}

function harness(overrides: Partial<TemplateToolDeps> = {}): Harness {
  const catalog = new TemplateCatalog()
  const consent = jest.fn(async () => true)
  const preflight = jest.fn(async (input: PreflightInput) => ({
    definitionId: input.definitionId,
    definitionHash: "h",
    platform: input.platform,
    status: "ready",
    bindings: [],
    issues: [{ code: "x.warn", severity: "warning", message: "heads up" }],
    operations: [],
    requiresConfirmation: false,
  }))
  const instantiate = jest.fn(async () => ({
    resources: [{ domain: "workflow", id: "wf-9" }],
    rollbackToken: null,
  }))
  const runtime: TemplateRuntime = {
    catalog,
    repository: {} as TemplateRuntime["repository"],
    service: { preflight, instantiate } as unknown as TemplateRuntime["service"],
  }
  const teams: Record<string, AgentTeam> = { [team.id]: team }
  const applySquadTemplate = jest.fn(async () => {
    teams["team-2"] = { ...team, id: "team-2", name: "Reviewers" }
    return { teamId: "team-2", via: "platform" as const }
  })
  const publishSquadTemplate = jest.fn(async () => undefined)
  const saveAsTemplate = jest.fn(
    (teamId: string, name: string, category?: AgentTeamTemplate["category"]) =>
      teamId in teams
        ? { ...squadTemplate, id: "tpl-new", name, category: category ?? "general" }
        : null
  )
  const deps: TemplateToolDeps = {
    runtime,
    platform: "desktop",
    consent,
    chatTemplates: {
      list: async () => [chatRow],
      get: async (id) => (id === chatRow.id ? chatRow : undefined),
    },
    squads: {
      teams: () => teams,
      teammates: (teamId) => (teamId === team.id ? [teammate] : []),
      templates: () => ({ [squadTemplate.id]: squadTemplate }),
      createTeam: jest.fn(),
      addTeammate: jest.fn(),
      createTask: jest.fn(),
      saveAsTemplate,
    },
    applySquadTemplate,
    publishSquadTemplate,
    ...overrides,
  }
  return {
    deps,
    catalog,
    consent,
    preflight,
    instantiate,
    applySquadTemplate,
    publishSquadTemplate,
    saveAsTemplate,
    teams,
  }
}

describe("tool surface", () => {
  it("recognises every shipped name and nothing else", () => {
    for (const name of TEMPLATE_TOOL_NAMES) expect(isTemplateBuiltinTool(name)).toBe(true)
    for (const name of ["template_delete", "squad_delete", "artifact_create", "nope"]) {
      expect(isTemplateBuiltinTool(name)).toBe(false)
    }
    expect([...TEMPLATE_READ_TOOL_NAMES, ...TEMPLATE_WRITE_TOOL_NAMES].sort()).toEqual(
      [...TEMPLATE_TOOL_NAMES].sort()
    )
  })

  it("declares a manifest entry per tool, each with a closed schema", () => {
    const entries = buildTemplateManifestEntries()
    expect(entries.map((e) => e.name).sort()).toEqual([...TEMPLATE_TOOL_NAMES].sort())
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(20)
      expect(entry.jsonSchema.additionalProperties).toBe(false)
      expect(entry.pluginId).toBe(TEMPLATE_BUILTIN_PLUGIN_ID)
    }
  })
})

describe("template_list / template_get", () => {
  it("lists the catalog with domain and text filters", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [
      await definition(),
      await definition({ id: "user.skill.two", domain: "skill", metadata: { name: "Lint" } }),
    ])
    const all = (await runTemplateBuiltinTool("template_list", {}, h.deps, ctx)) as {
      templates: Array<{ id: string }>
      total: number
    }
    expect(all.total).toBe(2)
    const skills = (await runTemplateBuiltinTool(
      "template_list",
      { domain: "skill" },
      h.deps,
      ctx
    )) as {
      templates: Array<{
        id: string
        domain: string
      }>
    }
    expect(skills.templates).toEqual([expect.objectContaining({ id: "user.skill.two" })])
    const byText = (await runTemplateBuiltinTool(
      "template_list",
      { query: "digest" },
      h.deps,
      ctx
    )) as { templates: Array<{ id: string }> }
    expect(byText.templates.map((t) => t.id)).toEqual(["user.workflow.one"])
  })

  it("refuses an unknown domain and caps the listing", async () => {
    const h = harness()
    expect(await runTemplateBuiltinTool("template_list", { domain: "bogus" }, h.deps, ctx)).toEqual(
      expect.objectContaining({ ok: false, code: "invalid_arguments" })
    )
    const many = await Promise.all(
      Array.from({ length: LIST_MAX_ITEMS + 5 }, (_, i) =>
        definition({ id: `user.workflow.${i}`, metadata: { name: `W${i}` } })
      )
    )
    h.catalog.replaceSource("user", many)
    const result = (await runTemplateBuiltinTool("template_list", {}, h.deps, ctx)) as {
      templates: unknown[]
      total: number
      truncated: boolean
    }
    expect(result.templates).toHaveLength(LIST_MAX_ITEMS)
    expect(result.total).toBe(LIST_MAX_ITEMS + 5)
    expect(result.truncated).toBe(true)
  })

  it("reads one definition with its payload truncated", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [
      await definition({ payload: { blob: "x".repeat(READ_CONTENT_MAX_CHARS + 10) } }),
    ])
    const result = (await runTemplateBuiltinTool(
      "template_get",
      { id: "user.workflow.one" },
      h.deps,
      ctx
    )) as {
      ok: boolean
      truncated: boolean
      payloadLength: number
      tags: string[]
      version: string
    }
    expect(result.ok).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.payloadLength).toBeGreaterThan(READ_CONTENT_MAX_CHARS)
    expect(result.tags).toEqual(["ops"])
    expect(result.version).toBe("1.0.0")
    expect(await runTemplateBuiltinTool("template_get", { id: "missing" }, h.deps, ctx)).toEqual(
      expect.objectContaining({ ok: false, code: "not_found" })
    )
    expect(await runTemplateBuiltinTool("template_get", {}, h.deps, ctx)).toEqual(
      expect.objectContaining({ ok: false, code: "invalid_arguments" })
    )
  })
})

describe("template_instantiate", () => {
  it("preflights, asks the user, then instantiates with the user's answer", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [await definition()])
    const result = (await runTemplateBuiltinTool(
      "template_instantiate",
      { id: "user.workflow.one", bindings: { slot: "res-1" } },
      h.deps,
      ctx
    )) as {
      ok: boolean
      resources: unknown[]
      warnings: unknown[]
    }
    expect(h.preflight).toHaveBeenCalledWith({
      definitionId: "user.workflow.one",
      version: "1.0.0",
      platform: "desktop",
      bindings: { slot: "res-1" },
    })
    expect(h.consent).toHaveBeenCalledWith("templates:instantiate", "instantiate:user.workflow.one")
    expect(h.instantiate).toHaveBeenCalledWith({
      plan: expect.objectContaining({ status: "ready" }),
      confirmed: true,
    })
    expect(result.ok).toBe(true)
    expect(result.resources).toEqual([{ domain: "workflow", id: "wf-9" }])
    expect(result.warnings).toHaveLength(1)
  })

  it("does not ask when the preflight is blocked, and does not write when declined", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [await definition()])
    h.preflight.mockResolvedValueOnce({
      status: "blocked",
      issues: [{ code: "platform.unsupported", severity: "blocker", message: "not here" }],
    })
    const blocked = await runTemplateBuiltinTool(
      "template_instantiate",
      { id: "user.workflow.one" },
      h.deps,
      ctx
    )
    expect(blocked).toEqual(
      expect.objectContaining({
        ok: false,
        code: "preflight_blocked",
        issues: [{ code: "platform.unsupported", message: "not here" }],
      })
    )
    expect(h.consent).not.toHaveBeenCalled()

    h.consent.mockResolvedValueOnce(false)
    const declined = await runTemplateBuiltinTool(
      "template_instantiate",
      { id: "user.workflow.one" },
      h.deps,
      ctx
    )
    expect(declined).toEqual(expect.objectContaining({ ok: false, code: "consent_denied" }))
    expect(h.instantiate).not.toHaveBeenCalled()
  })

  it("refuses a catalog-only domain and malformed bindings", async () => {
    const h = harness()
    h.catalog.replaceSource("user", [
      await definition({ id: "chat.one", domain: "chatTemplate", metadata: { name: "C" } }),
      await definition(),
    ])
    expect(
      await runTemplateBuiltinTool("template_instantiate", { id: "chat.one" }, h.deps, ctx)
    ).toEqual(expect.objectContaining({ ok: false, code: "catalog_only" }))
    expect(
      await runTemplateBuiltinTool(
        "template_instantiate",
        { id: "user.workflow.one", bindings: ["nope"] },
        h.deps,
        ctx
      )
    ).toEqual(expect.objectContaining({ ok: false, code: "invalid_arguments" }))
    expect(h.preflight).not.toHaveBeenCalled()
  })
})

describe("chat_template_list / chat_template_get", () => {
  it("lists with a text filter and reads the body", async () => {
    const h = harness()
    const list = (await runTemplateBuiltinTool("chat_template_list", {}, h.deps, ctx)) as {
      templates: Array<{
        id: string
        parameters: unknown[]
      }>
    }
    expect(list.templates).toEqual([
      expect.objectContaining({ id: "ct-1", parameters: [expect.objectContaining({ id: "who" })] }),
    ])
    const none = (await runTemplateBuiltinTool(
      "chat_template_list",
      { query: "zzz" },
      h.deps,
      ctx
    )) as { templates: unknown[] }
    expect(none.templates).toEqual([])

    const one = (await runTemplateBuiltinTool(
      "chat_template_get",
      { id: "ct-1" },
      h.deps,
      ctx
    )) as {
      ok: boolean
      body: string
      revision: number
    }
    expect(one.ok).toBe(true)
    expect(one.body).toBe(chatRow.body)
    expect(one.revision).toBe(3)
    expect(await runTemplateBuiltinTool("chat_template_get", { id: "x" }, h.deps, ctx)).toEqual(
      expect.objectContaining({ ok: false, code: "not_found" })
    )
  })
})

describe("squad tools", () => {
  it("lists squads with teammates plus the templates available", async () => {
    const h = harness()
    const result = (await runTemplateBuiltinTool("squad_list", {}, h.deps, ctx)) as {
      squads: Array<{
        teamId: string
        teammates: Array<{ name: string }>
      }>
      templates: Array<{
        templateId: string
        teammates: string[]
      }>
    }
    expect(result.squads).toEqual([
      expect.objectContaining({
        teamId: "team-1",
        teammates: [expect.objectContaining({ name: "Alpha" })],
      }),
    ])
    expect(result.templates).toEqual([
      expect.objectContaining({ templateId: "tpl-1", teammates: ["Alpha", "Beta"] }),
    ])
    const filtered = (await runTemplateBuiltinTool(
      "squad_list",
      { status: "executing" },
      h.deps,
      ctx
    )) as { squads: unknown[] }
    expect(filtered.squads).toEqual([])
  })

  it("applies a squad template through the platform after consent", async () => {
    const h = harness()
    const result = await runTemplateBuiltinTool(
      "squad_apply_template",
      { templateId: "tpl-1" },
      h.deps,
      ctx
    )
    expect(h.consent).toHaveBeenCalledWith("templates:instantiate", "instantiate:tpl-1")
    expect(h.applySquadTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        template: squadTemplate,
        platform: "desktop",
        runtime: h.deps.runtime,
      })
    )
    expect(result).toEqual(
      expect.objectContaining({ ok: true, teamId: "team-2", via: "platform", name: "Reviewers" })
    )
  })

  it("does not create a squad when the user declines or the template is unknown", async () => {
    const h = harness()
    h.consent.mockResolvedValueOnce(false)
    expect(
      await runTemplateBuiltinTool("squad_apply_template", { templateId: "tpl-1" }, h.deps, ctx)
    ).toEqual(expect.objectContaining({ ok: false, code: "consent_denied" }))
    expect(
      await runTemplateBuiltinTool("squad_apply_template", { templateId: "nope" }, h.deps, ctx)
    ).toEqual(expect.objectContaining({ ok: false, code: "not_found" }))
    expect(h.applySquadTemplate).not.toHaveBeenCalled()
  })

  it("saves a squad as a template only after library-write consent, then mirrors it", async () => {
    const h = harness()
    const result = await runTemplateBuiltinTool(
      "squad_save_as_template",
      { teamId: "team-1", name: "My reviewers", category: "review" },
      h.deps,
      ctx
    )
    expect(h.consent).toHaveBeenCalledWith("templates:library:write", "library-write:My reviewers")
    expect(h.saveAsTemplate).toHaveBeenCalledWith("team-1", "My reviewers", "review")
    expect(h.publishSquadTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tpl-new", name: "My reviewers" })
    )
    expect(result).toEqual(
      expect.objectContaining({ ok: true, templateId: "tpl-new", mirroredToCatalog: true })
    )
  })

  it("leaves nothing behind when the user declines the library write", async () => {
    const h = harness()
    h.consent.mockResolvedValueOnce(false)
    expect(
      await runTemplateBuiltinTool(
        "squad_save_as_template",
        { teamId: "team-1", name: "Nope" },
        h.deps,
        ctx
      )
    ).toEqual(expect.objectContaining({ ok: false, code: "consent_denied" }))
    expect(h.saveAsTemplate).not.toHaveBeenCalled()
    expect(h.publishSquadTemplate).not.toHaveBeenCalled()
  })

  it("reports a failed mirror without failing the save, and validates arguments", async () => {
    const h = harness()
    h.publishSquadTemplate.mockRejectedValueOnce(new Error("offline"))
    expect(
      await runTemplateBuiltinTool(
        "squad_save_as_template",
        { teamId: "team-1", name: "Mirror" },
        h.deps,
        ctx
      )
    ).toEqual(expect.objectContaining({ ok: true, mirroredToCatalog: false }))
    expect(
      await runTemplateBuiltinTool(
        "squad_save_as_template",
        { teamId: "team-1", name: "Bad", category: "cooking" },
        h.deps,
        ctx
      )
    ).toEqual(expect.objectContaining({ ok: false, code: "invalid_arguments" }))
    expect(
      await runTemplateBuiltinTool(
        "squad_save_as_template",
        { teamId: "ghost", name: "X" },
        h.deps,
        ctx
      )
    ).toEqual(expect.objectContaining({ ok: false, code: "not_found" }))
  })
})

describe("failure contract", () => {
  it("never throws: a rejecting dependency becomes a structured failure", async () => {
    const h = harness({
      chatTemplates: {
        list: async () => {
          throw new Error("dexie closed")
        },
        get: async () => undefined,
      },
    })
    expect(await runTemplateBuiltinTool("chat_template_list", {}, h.deps, ctx)).toEqual({
      ok: false,
      code: "tool_failed",
      error: "dexie closed",
    })
    expect(await runTemplateBuiltinTool("what_is_this", {}, h.deps, ctx)).toEqual(
      expect.objectContaining({ ok: false, code: "invalid_arguments" })
    )
  })
})
