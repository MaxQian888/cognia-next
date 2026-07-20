// Mock the existing per-domain stores so the adapter behaviour can be
// asserted without touching Dexie or hitting Tauri.

jest.mock("@/lib/db/mcp-servers", () => ({
  bulkImportMcpServers: jest.fn(),
}))

jest.mock("@/lib/db/prompt-presets", () => ({
  createPreset: jest.fn(),
}))

jest.mock("@/lib/db/skills", () => ({
  createSkill: jest.fn(),
  listSkills: jest.fn(),
}))

import { bulkImportMcpServers } from "@/lib/db/mcp-servers"
import { createPreset } from "@/lib/db/prompt-presets"
import { createSkill, listSkills } from "@/lib/db/skills"

import {
  fromCcswitchUsageScript,
  fromCcswitchMcp,
  importCcswitchMcp,
  importCcswitchPrompts,
  importCcswitchSkills,
} from "./import"

const mBulk = bulkImportMcpServers as jest.Mock
const mPreset = createPreset as jest.Mock
const mCreateSkill = createSkill as jest.Mock
const mListSkills = listSkills as jest.Mock

beforeEach(() => {
  jest.resetAllMocks()
  mBulk.mockResolvedValue({ created: 0, updated: 0, skipped: 0, errored: [] })
  mListSkills.mockResolvedValue([])
})

describe("fromCcswitchUsageScript", () => {
  it("converts a Kimi token-plan template without carrying executable code", () => {
    const result = fromCcswitchUsageScript({
      id: "kimi",
      kind: "claude",
      name: "Kimi Coding",
      apiKey: "sk-kimi",
      baseUrl: "https://api.kimi.com/coding",
      usageScript: {
        enabled: true,
        language: "javascript",
        code: "throw new Error('must never run')",
        templateType: "token_plan",
        codingPlanProvider: "kimi",
        autoQueryInterval: 15,
      },
    })

    expect(result).toEqual({
      ok: true,
      source: expect.objectContaining({
        id: "ccswitch:claude:kimi",
        name: "Kimi Coding",
        baseUrl: "https://api.kimi.com",
        token: "sk-kimi",
        enabled: false,
        refreshIntervalMs: 15 * 60 * 1000,
        request: expect.objectContaining({ path: "/coding/v1/usages" }),
        extract: expect.objectContaining({ kind: "window" }),
      }),
    })
    if (result.ok) {
      expect(result.source).not.toHaveProperty("code")
      expect(result.source.request).not.toHaveProperty("code")
    }
  })

  it("maps GLM and MiniMax token-plan metadata to declarative windows", () => {
    const glm = fromCcswitchUsageScript({
      id: "glm",
      kind: "claude",
      name: "GLM",
      apiKey: "glm-key",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      usageScript: { templateType: "token_plan", codingPlanProvider: "zhipu" },
    })
    const minimax = fromCcswitchUsageScript({
      id: "minimax",
      kind: "claude",
      name: "MiniMax",
      apiKey: "minimax-key",
      baseUrl: "https://api.minimaxi.com/anthropic",
      usageScript: { templateType: "token_plan", codingPlanProvider: "minimax" },
    })

    expect(glm).toMatchObject({
      ok: true,
      source: {
        request: {
          path: "/api/monitor/usage/quota/limit",
          headers: { Authorization: "{{token}}" },
        },
        extract: { kind: "window", windows: [{ select: { equals: 3 } }, { select: { equals: 6 } }] },
      },
    })
    expect(minimax).toMatchObject({
      ok: true,
      source: {
        request: { path: "/v1/token_plan/remains" },
        extract: { kind: "window", windows: [{ invert: true }, { invert: true }] },
      },
    })
  })

  it("maps GLM Team's organization and project headers without JavaScript", () => {
    const result = fromCcswitchUsageScript({
      id: "glm-team",
      kind: "claude",
      name: "GLM Team",
      apiKey: "team-key",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      usageScript: {
        templateType: "token_plan",
        codingPlanProvider: "zhipu_team",
        teamOrganizationId: "org-1",
        teamProjectId: "project-1",
        code: "ignored()",
      },
    })

    expect(result).toMatchObject({
      ok: true,
      source: {
        request: {
          path: "/api/monitor/usage/quota/limit?type=2",
          headers: {
            Authorization: "{{token}}",
            "bigmodel-organization": "org-1",
            "bigmodel-project": "project-1",
          },
        },
      },
    })
  })

  it("preserves ZenMux's exact quota endpoint and fractional utilization scale", () => {
    const result = fromCcswitchUsageScript({
      id: "zen",
      name: "ZenMux",
      apiKey: "zen-key",
      baseUrl: "https://zenmux.example/v1/chat",
      usageScript: {
        templateType: "token_plan",
        codingPlanProvider: "zenmux",
        baseUrl: "https://billing.zenmux.example/api/quota?team=one",
      },
    })

    expect(result).toMatchObject({
      ok: true,
      source: {
        baseUrl: "https://billing.zenmux.example",
        request: { path: "/api/quota?team=one" },
        extract: {
          kind: "window",
          windows: [
            { usedPctPath: "data.quota_5_hour.usage_percentage", usedPctScale: 100 },
            { usedPctPath: "data.quota_7_day.usage_percentage", usedPctScale: 100 },
          ],
        },
      },
    })
  })

  it("uses New-API's dedicated access token and user header", () => {
    const result = fromCcswitchUsageScript({
      id: "relay",
      name: "Relay",
      apiKey: "inference-key",
      baseUrl: "https://relay.example/v1",
      usageScript: {
        templateType: "newapi",
        accessToken: "dashboard-token",
        userId: "42",
      },
    })

    expect(result).toMatchObject({
      ok: true,
      source: {
        token: "dashboard-token",
        enabled: false,
        request: { path: "/api/user/self", headers: { "New-Api-User": "42" } },
      },
    })
  })

  it("rejects arbitrary scripts and native-only token plans", () => {
    const arbitrary = fromCcswitchUsageScript({
      id: "custom",
      name: "Custom",
      apiKey: "key",
      baseUrl: "https://relay.example",
      usageScript: { templateType: "custom", code: "fetch('https://evil.example')" },
    })
    const volcengine = fromCcswitchUsageScript({
      id: "volc",
      name: "Volcengine",
      apiKey: "key",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
      usageScript: { templateType: "token_plan", codingPlanProvider: "volcengine" },
    })

    expect(arbitrary).toEqual({ ok: false, reason: "unsupported-template" })
    expect(volcengine).toEqual({ ok: false, reason: "unsupported-provider" })
  })
})

describe("fromCcswitchMcp", () => {
  it("normalizes transport and strips duplicate hint", () => {
    const draft = fromCcswitchMcp({
      id: "m1",
      name: "fetch",
      transport: "STDIO",
      config: { command: "uvx", args: ["mcp-server-fetch"], type: "stdio" },
    })
    expect(draft.transport).toBe("stdio")
    expect(draft.config).toEqual({ command: "uvx", args: ["mcp-server-fetch"] })
  })

  it("falls back to stdio when transport is unrecognized", () => {
    const draft = fromCcswitchMcp({
      id: "m1",
      name: "x",
      transport: "lol",
      config: {},
    })
    expect(draft.transport).toBe("stdio")
  })

  it("infers transport from config.type when top-level is missing", () => {
    const draft = fromCcswitchMcp({
      id: "m1",
      name: "x",
      config: { type: "http", url: "https://e" },
    })
    expect(draft.transport).toBe("http")
    expect(draft.config).toEqual({ url: "https://e" })
  })

  it("treats non-object config as empty", () => {
    const draft = fromCcswitchMcp({ id: "m1", name: "x", config: "garbage" })
    expect(draft.config).toEqual({})
  })

  it("handles missing config", () => {
    const draft = fromCcswitchMcp({ id: "m1", name: "x" })
    expect(draft.config).toEqual({})
    expect(draft.transport).toBe("stdio")
  })
})

describe("importCcswitchMcp", () => {
  it("forwards drafts and re-keys the bulk-import summary", async () => {
    mBulk.mockResolvedValue({
      created: 2,
      updated: 1,
      skipped: 1,
      errored: [{ name: "bad", error: "x" }],
    })
    const summary = await importCcswitchMcp(
      [
        { id: "1", name: "a", config: { command: "x" } },
        { id: "2", name: "b", config: { command: "y" } },
      ],
      "overwrite"
    )
    expect(mBulk).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "a" }),
        expect.objectContaining({ name: "b" }),
      ]),
      "overwrite"
    )
    expect(summary).toEqual({
      imported: 2,
      updated: 1,
      skipped: 1,
      errored: [{ name: "bad", error: "x" }],
    })
  })

  it("drops drafts with empty names", async () => {
    await importCcswitchMcp([{ id: "1", name: "  ", config: {} }])
    expect(mBulk).toHaveBeenCalledWith([], "skip")
  })
})

describe("importCcswitchPrompts", () => {
  it("creates one preset per valid prompt", async () => {
    mPreset.mockResolvedValue({})
    const summary = await importCcswitchPrompts([
      { id: "1", name: "Code review", content: "review", description: "gentle" },
      { id: "2", name: "Quick", content: "answer briefly" },
    ])
    expect(mPreset).toHaveBeenCalledTimes(2)
    expect(mPreset).toHaveBeenNthCalledWith(1, {
      name: "Code review",
      content: "review",
      description: "gentle",
      category: "general",
    })
    expect(summary.imported).toBe(2)
    expect(summary.errored).toEqual([])
  })

  it("errors out missing-name / missing-content rows", async () => {
    const summary = await importCcswitchPrompts([
      { id: "1", name: "", content: "x" },
      { id: "2", name: "Solo", content: "" },
    ])
    expect(mPreset).not.toHaveBeenCalled()
    expect(summary.imported).toBe(0)
    expect(summary.errored).toHaveLength(2)
  })

  it("forwards underlying creation failures", async () => {
    mPreset.mockRejectedValueOnce(new Error("preset boom"))
    const summary = await importCcswitchPrompts([{ id: "1", name: "x", content: "y" }])
    expect(summary.imported).toBe(0)
    expect(summary.errored[0]).toEqual({ name: "x", error: "preset boom" })
  })
})

describe("importCcswitchSkills", () => {
  it("creates skills with content and skips collisions", async () => {
    mListSkills.mockResolvedValue([{ name: "existing" } as never])
    mCreateSkill.mockResolvedValue({})
    const summary = await importCcswitchSkills([
      { id: "1", name: "fresh", content: "# body" },
      { id: "2", name: "existing", content: "..." },
    ])
    expect(mCreateSkill).toHaveBeenCalledTimes(1)
    expect(mCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: "fresh", content: "# body" })
    )
    expect(summary.imported).toBe(1)
    expect(summary.skipped).toEqual([{ name: "existing", reason: "name already in use" }])
  })

  it("skips skills with no inline content", async () => {
    const summary = await importCcswitchSkills([
      { id: "1", name: "external", content: "", sourcePath: "/tmp/x.md" },
    ])
    expect(mCreateSkill).not.toHaveBeenCalled()
    expect(summary.skipped[0].reason).toMatch(/external file/i)
  })

  it("flags missing names as errors", async () => {
    const summary = await importCcswitchSkills([{ id: "1", name: "  ", content: "x" }])
    expect(summary.errored).toHaveLength(1)
  })

  it("forwards creation failures", async () => {
    mCreateSkill.mockRejectedValueOnce(new Error("dexie boom"))
    const summary = await importCcswitchSkills([{ id: "1", name: "ok", content: "x" }])
    expect(summary.imported).toBe(0)
    expect(summary.errored[0]).toEqual({ name: "ok", error: "dexie boom" })
  })
})
