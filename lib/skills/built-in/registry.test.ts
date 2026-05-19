/**
 * Tests for lib/skills/built-in/registry.ts.
 */

import { z } from "zod"
import {
  createBuiltInSkillRegistry,
  platformAllows,
  registerBuiltInSkill,
  getSharedBuiltInSkillRegistry,
  __resetSharedBuiltInSkillRegistry,
} from "./registry"
import type { BuiltInSkill } from "./types"

function mkSkill(overrides: Partial<BuiltInSkill> = {}): BuiltInSkill {
  return {
    id: "lark.calendar.list_events",
    family: "lark.calendar",
    label: { en: "List events", "zh-CN": "列出日程" },
    description: { en: "List upcoming events", "zh-CN": "列出即将到来的日程" },
    platforms: ["lark"],
    mutation: "read",
    imAccess: "always",
    mcpToolName: "lark_calendar_list_events",
    inputSchema: z.object({ calendarId: z.string() }),
    execute: async () => ({ events: [] }),
    ...overrides,
  }
}

describe("createBuiltInSkillRegistry", () => {
  it("registers and retrieves a skill by id", () => {
    const reg = createBuiltInSkillRegistry()
    const skill = mkSkill()
    reg.register(skill)
    expect(reg.has(skill.id)).toBe(true)
    expect(reg.get(skill.id)).toBe(skill)
  })

  it("throws on duplicate id", () => {
    const reg = createBuiltInSkillRegistry()
    reg.register(mkSkill())
    expect(() => reg.register(mkSkill())).toThrow(/duplicate skill id/)
  })

  it("rejects write/destructive skill without hitlSurface", () => {
    const reg = createBuiltInSkillRegistry()
    expect(() =>
      reg.register(
        mkSkill({
          id: "lark.calendar.create_event",
          mutation: "write",
        })
      )
    ).toThrow(/no hitlSurface/)
    expect(() =>
      reg.register(
        mkSkill({
          id: "lark.calendar.delete_event",
          mutation: "destructive",
        })
      )
    ).toThrow(/no hitlSurface/)
  })

  it("accepts write/destructive skill when hitlSurface is provided", () => {
    const reg = createBuiltInSkillRegistry()
    const surface = () => ({
      components: { btn: { component: "Button" } },
      dataModel: {},
      rootId: "root",
    })
    expect(() =>
      reg.register(
        mkSkill({
          id: "lark.calendar.create_event",
          mutation: "write",
          hitlSurface: surface,
        })
      )
    ).not.toThrow()
  })

  it("unregister returns true on success, false on missing", () => {
    const reg = createBuiltInSkillRegistry()
    reg.register(mkSkill())
    expect(reg.unregister("lark.calendar.list_events")).toBe(true)
    expect(reg.unregister("does.not.exist")).toBe(false)
  })

  it("families() preserves insertion order, drops empty families on unregister", () => {
    const reg = createBuiltInSkillRegistry()
    reg.register(mkSkill({ id: "lark.calendar.list", family: "lark.calendar" }))
    reg.register(
      mkSkill({
        id: "lark.doc.search",
        family: "lark.doc",
        mcpToolName: "lark_doc_search",
      })
    )
    reg.register(
      mkSkill({
        id: "lark.calendar.freebusy",
        family: "lark.calendar",
        mcpToolName: "lark_calendar_freebusy",
      })
    )
    expect(reg.families()).toEqual(["lark.calendar", "lark.doc"])

    reg.unregister("lark.calendar.list")
    // Family still has one skill — should remain.
    expect(reg.families()).toEqual(["lark.calendar", "lark.doc"])

    reg.unregister("lark.calendar.freebusy")
    expect(reg.families()).toEqual(["lark.doc"])
  })

  it("listByFamily filters by family", () => {
    const reg = createBuiltInSkillRegistry()
    reg.register(mkSkill({ id: "lark.calendar.a", family: "lark.calendar" }))
    reg.register(
      mkSkill({
        id: "lark.doc.search",
        family: "lark.doc",
        mcpToolName: "lark_doc_search",
      })
    )
    expect(reg.listByFamily("lark.calendar").map((s) => s.id)).toEqual(["lark.calendar.a"])
  })

  it("listByPlatform filters via platformAllows", () => {
    const reg = createBuiltInSkillRegistry()
    reg.register(mkSkill({ id: "lark.calendar.a", platforms: ["lark"] }))
    reg.register(
      mkSkill({
        id: "x.any",
        family: "x",
        platforms: "any",
        mcpToolName: "x_any",
      })
    )
    reg.register(
      mkSkill({
        id: "slack.canvas",
        family: "slack.canvas",
        platforms: ["slack"],
        mcpToolName: "slack_canvas",
      })
    )
    expect(
      reg
        .listByPlatform("lark")
        .map((s) => s.id)
        .sort()
    ).toEqual(["lark.calendar.a", "x.any"])
    expect(
      reg
        .listByPlatform("slack")
        .map((s) => s.id)
        .sort()
    ).toEqual(["slack.canvas", "x.any"])
  })

  it("listByMutation filters by mutation tier", () => {
    const reg = createBuiltInSkillRegistry()
    const hitlSurface = () => ({
      components: {},
      dataModel: {},
      rootId: "root",
    })
    reg.register(mkSkill({ id: "a.read", mutation: "read" }))
    reg.register(
      mkSkill({
        id: "a.write",
        mutation: "write",
        hitlSurface,
        mcpToolName: "a_write",
      })
    )
    reg.register(
      mkSkill({
        id: "a.destr",
        mutation: "destructive",
        hitlSurface,
        mcpToolName: "a_destr",
      })
    )
    expect(reg.listByMutation("write").map((s) => s.id)).toEqual(["a.write"])
    expect(reg.listByMutation("destructive").map((s) => s.id)).toEqual(["a.destr"])
  })

  it("clear() empties the registry", () => {
    const reg = createBuiltInSkillRegistry()
    reg.register(mkSkill())
    reg.clear()
    expect(reg.list()).toEqual([])
    expect(reg.families()).toEqual([])
  })
})

describe("platformAllows", () => {
  it("returns true for 'any'", () => {
    expect(platformAllows(mkSkill({ platforms: "any" }), "telegram")).toBe(true)
  })

  it("returns true when platform is in the list", () => {
    expect(platformAllows(mkSkill({ platforms: ["lark"] }), "lark")).toBe(true)
  })

  it("returns false when platform is not in the list", () => {
    expect(platformAllows(mkSkill({ platforms: ["lark"] }), "telegram")).toBe(false)
  })
})

describe("shared registry helpers", () => {
  beforeEach(() => {
    __resetSharedBuiltInSkillRegistry()
  })

  it("registerBuiltInSkill writes to the shared singleton", () => {
    registerBuiltInSkill(mkSkill())
    expect(getSharedBuiltInSkillRegistry().has("lark.calendar.list_events")).toBe(true)
  })

  it("__resetSharedBuiltInSkillRegistry wipes state between tests", () => {
    registerBuiltInSkill(mkSkill())
    __resetSharedBuiltInSkillRegistry()
    expect(getSharedBuiltInSkillRegistry().list()).toEqual([])
  })
})
