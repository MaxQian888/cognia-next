import { z } from "zod"
import {
  __resetSharedBuiltInSkillRegistry,
  registerBuiltInSkill,
} from "@/lib/skills/built-in/registry"
import { initializePluginPermissions } from "./permission-api"
import { createSkillsAPI } from "./skills-api"

beforeEach(() => {
  __resetSharedBuiltInSkillRegistry()
  initializePluginPermissions("office", ["builtin-skills:invoke"])
  registerBuiltInSkill({
    id: "lark.sheets.read",
    family: "lark.sheets",
    label: { en: "Read", "zh-CN": "读取" },
    description: { en: "Read", "zh-CN": "读取" },
    platforms: ["lark"],
    mutation: "read",
    imAccess: "always",
    mcpToolName: "lark_sheets_read",
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  })
})

it("lists only manifest-allowlisted built-in skills", () => {
  expect(createSkillsAPI("office", ["lark.sheets.*"]).listBuiltIns()).toEqual([
    expect.objectContaining({ id: "lark.sheets.read" }),
  ])
  expect(createSkillsAPI("office", ["lark.calendar.*"]).listBuiltIns()).toEqual([])
})

it("runs a built-in skill as the plugin's doing, for what it delivers (ADR-0239)", async () => {
  let seen: unknown
  registerBuiltInSkill({
    id: "lark.sheets.peek",
    family: "lark.sheets",
    label: { en: "Peek", "zh-CN": "查看" },
    description: { en: "Peek", "zh-CN": "查看" },
    platforms: "any",
    mutation: "read",
    imAccess: "always",
    mcpToolName: "lark_sheets_peek",
    inputSchema: z.object({}),
    execute: async (_args, ctx) => {
      seen = ctx.outboundAuthorization
      return { ok: true }
    },
  })
  await createSkillsAPI("office", ["lark.sheets.*"]).invokeBuiltIn(
    "lark.sheets.peek",
    {},
    { sessionId: "s1" }
  )
  expect(seen).toEqual({ kind: "plugin", pluginId: "office" })
})

it("rejects invocation outside the manifest allowlist", async () => {
  await expect(
    createSkillsAPI("office", ["lark.calendar.*"]).invokeBuiltIn(
      "lark.sheets.read",
      {},
      { sessionId: "s1" }
    )
  ).rejects.toThrow("not allowlisted")
})
