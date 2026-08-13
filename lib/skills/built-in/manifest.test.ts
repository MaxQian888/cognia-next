/**
 * Tests for lib/skills/built-in/manifest.ts.
 */

import { z } from "zod"
import {
  buildBuiltInSkillManifest,
  summariseSkillCapabilities,
  BUILTIN_SKILLS_PLUGIN_ID,
} from "./manifest"
import { registerBuiltInSkill, __resetSharedBuiltInSkillRegistry } from "./registry"
import type { BuiltInSkill } from "./types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { __setLarkCliCapabilityDiagnosticsForTests } from "./lark/capabilities"

const hitlSurface = () => ({
  components: { btn: { component: "Button" } },
  dataModel: {},
  rootId: "root",
})

function mkSkill(overrides: Partial<BuiltInSkill> = {}): BuiltInSkill {
  return {
    id: "lark.calendar.list_events",
    family: "lark.calendar",
    label: { en: "List events", "zh-CN": "列出日程" },
    description: { en: "List events", "zh-CN": "列出" },
    platforms: ["lark"],
    mutation: "read",
    imAccess: "always",
    mcpToolName: "lark_calendar_list_events",
    inputSchema: z.object({ calendarId: z.string() }),
    execute: async () => ({ events: [] }),
    ...overrides,
  }
}

function mkOverride(fields: Partial<ConversationOverrideRow> = {}): ConversationOverrideRow {
  return {
    id: "co_x",
    conversationKey: "lark:lark-1:oc_x",
    sessionId: "s_x",
    createdAt: 0,
    updatedAt: 0,
    ...fields,
  }
}

beforeEach(() => {
  __resetSharedBuiltInSkillRegistry()
  __setLarkCliCapabilityDiagnosticsForTests({
    certifiedVersion: "1.0.83",
    detectedVersion: "1.0.83",
    ready: true,
    missingCommands: [],
    missingFlags: {},
    affectedSkillIds: [],
  })
})

describe("buildBuiltInSkillManifest — platform filter", () => {
  it("fails closed for certified Lark skills when the CLI capability probe is blocked", () => {
    __setLarkCliCapabilityDiagnosticsForTests({
      certifiedVersion: "1.0.83",
      detectedVersion: "1.0.84",
      ready: false,
      missingCommands: [],
      missingFlags: {},
      affectedSkillIds: ["lark.calendar.list_events"],
      message: "version mismatch",
    })
    registerBuiltInSkill(mkSkill())

    expect(buildBuiltInSkillManifest({})).toEqual([])
  })

  it("includes 'any' skills on every platform", () => {
    registerBuiltInSkill(
      mkSkill({ id: "x.any", family: "x", platforms: "any", mcpToolName: "x_any" })
    )
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "telegram", adapterId: "tg-1", conversationKey: "k" },
    })
    expect(m.map((e) => e.skillId)).toEqual(["x.any"])
  })

  it("filters by explicit platform list", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.a", family: "lark", platforms: ["lark"] }))
    registerBuiltInSkill(
      mkSkill({
        id: "slack.b",
        family: "slack",
        platforms: ["slack"],
        mcpToolName: "slack_b",
      })
    )
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
    })
    expect(m.map((e) => e.skillId)).toEqual(["lark.a"])
  })

  it("exposes every skill when there is no imBinding (desktop in-app)", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.a", platforms: ["lark"] }))
    registerBuiltInSkill(
      mkSkill({
        id: "slack.b",
        family: "slack",
        platforms: ["slack"],
        mcpToolName: "slack_b",
      })
    )
    const m = buildBuiltInSkillManifest({})
    expect(m.map((e) => e.skillId).sort()).toEqual(["lark.a", "slack.b"])
  })
})

describe("buildBuiltInSkillManifest — imAccess filter", () => {
  it("drops 'blocked' skills in IM sessions", () => {
    registerBuiltInSkill(mkSkill({ id: "x.blk", imAccess: "blocked" }))
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
    })
    expect(m).toEqual([])
  })

  it("keeps 'blocked' skills in non-IM (desktop) sessions", () => {
    registerBuiltInSkill(mkSkill({ id: "x.blk", imAccess: "blocked" }))
    const m = buildBuiltInSkillManifest({})
    expect(m.map((e) => e.skillId)).toEqual(["x.blk"])
  })

  it("'opt-in' skills require an explicit string[] allowlist", () => {
    registerBuiltInSkill(
      mkSkill({
        id: "x.destr",
        mutation: "destructive",
        imAccess: "opt-in",
        hitlSurface,
      })
    )
    // No override → blocked
    expect(
      buildBuiltInSkillManifest({
        imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      })
    ).toEqual([])
    // "all" sentinel is not enough for opt-in
    expect(
      buildBuiltInSkillManifest({
        imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
        imOverrideRow: mkOverride({ allowedBuiltInSkillIds: "all" }),
      })
    ).toEqual([])
    // Explicit allowlist that doesn't include the skill → still blocked at the allowed-list filter.
    expect(
      buildBuiltInSkillManifest({
        imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
        imOverrideRow: mkOverride({ allowedBuiltInSkillIds: ["other.skill"] }),
      })
    ).toEqual([])
    // Explicit allowlist with the skill → passes
    expect(
      buildBuiltInSkillManifest({
        imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
        imOverrideRow: mkOverride({ allowedBuiltInSkillIds: ["x.destr"] }),
      }).map((e) => e.skillId)
    ).toEqual(["x.destr"])
  })

  it("'readonly' skills require any allowlist (including 'all')", () => {
    registerBuiltInSkill(mkSkill({ id: "x.ro", imAccess: "readonly" }))
    // No override → blocked
    expect(
      buildBuiltInSkillManifest({
        imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      })
    ).toEqual([])
    // "all" sentinel passes for readonly
    expect(
      buildBuiltInSkillManifest({
        imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
        imOverrideRow: mkOverride({ allowedBuiltInSkillIds: "all" }),
      }).map((e) => e.skillId)
    ).toEqual(["x.ro"])
  })
})

describe("buildBuiltInSkillManifest — allowedList filter", () => {
  it("intersects the conversation list with the adapter skill ceiling", () => {
    registerBuiltInSkill(mkSkill())
    expect(
      buildBuiltInSkillManifest({
        imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
        imOverrideRow: mkOverride({ allowedBuiltInSkillIds: "all" }),
        imAdapterRow: { builtInSkillCeiling: [] },
      })
    ).toEqual([])
  })

  it("blocks everything when allowedBuiltInSkillIds === []", () => {
    registerBuiltInSkill(mkSkill())
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      imOverrideRow: mkOverride({ allowedBuiltInSkillIds: [] }),
    })
    expect(m).toEqual([])
  })

  it("family.* wildcard matches every skill in the family", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.calendar.list" }))
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.freebusy",
        mcpToolName: "lark_calendar_freebusy",
      })
    )
    registerBuiltInSkill(
      mkSkill({
        id: "lark.doc.search",
        family: "lark.doc",
        mcpToolName: "lark_doc_search",
      })
    )
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      imOverrideRow: mkOverride({ allowedBuiltInSkillIds: ["lark.calendar.*"] }),
    })
    expect(m.map((e) => e.skillId).sort()).toEqual(["lark.calendar.freebusy", "lark.calendar.list"])
  })

  it("exact match also works", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.calendar.list" }))
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.freebusy",
        mcpToolName: "lark_calendar_freebusy",
      })
    )
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      imOverrideRow: mkOverride({
        allowedBuiltInSkillIds: ["lark.calendar.freebusy"],
      }),
    })
    expect(m.map((e) => e.skillId)).toEqual(["lark.calendar.freebusy"])
  })
})

describe("buildBuiltInSkillManifest — requires filter", () => {
  it("drops a skill whose required capability the channel doesn't declare", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.cal.create", requires: ["rich-card.lark"] }))
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      channelCapabilities: ["send.text"],
    })
    expect(m).toEqual([])
  })

  it("keeps a skill when the channel declares every required capability", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.cal.create", requires: ["rich-card.lark"] }))
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      channelCapabilities: ["send.text", "rich-card.lark"],
    })
    expect(m.map((e) => e.skillId)).toEqual(["lark.cal.create"])
  })

  it("ignores requires in non-IM (desktop) sessions", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.cal.create", requires: ["rich-card.lark"] }))
    const m = buildBuiltInSkillManifest({})
    expect(m.map((e) => e.skillId)).toEqual(["lark.cal.create"])
  })

  it("passes skills with no requires regardless of channel capabilities", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.cal.list" }))
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      channelCapabilities: [],
    })
    expect(m.map((e) => e.skillId)).toEqual(["lark.cal.list"])
  })

  it("passes a skill declaring an empty requires array", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.cal.list", requires: [] }))
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
      channelCapabilities: [],
    })
    expect(m.map((e) => e.skillId)).toEqual(["lark.cal.list"])
  })

  it("drops a requires-bearing skill when channelCapabilities is omitted in IM", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.cal.create", requires: ["rich-card.lark"] }))
    const m = buildBuiltInSkillManifest({
      imBinding: { platform: "lark", adapterId: "lark-1", conversationKey: "k" },
    })
    expect(m).toEqual([])
  })
})

describe("buildBuiltInSkillManifest — manifest shape", () => {
  it("entries carry name, description, jsonSchema, pluginId, skillId", () => {
    registerBuiltInSkill(mkSkill())
    const [entry] = buildBuiltInSkillManifest({})
    expect(entry.name).toBe("lark_calendar_list_events")
    expect(entry.description).toBe("List events")
    expect(entry.pluginId).toBe(BUILTIN_SKILLS_PLUGIN_ID)
    expect(entry.skillId).toBe("lark.calendar.list_events")
    expect(typeof entry.jsonSchema).toBe("object")
    // Zod 4 emits JSON Schema with `properties`.
    expect((entry.jsonSchema as { properties?: object }).properties).toBeDefined()
  })
})

describe("summariseSkillCapabilities", () => {
  it("groups mutations per family in stable order", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.calendar.list", mutation: "read" }))
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create",
        mutation: "write",
        mcpToolName: "lark_calendar_create",
        hitlSurface,
      })
    )
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.delete",
        mutation: "destructive",
        mcpToolName: "lark_calendar_delete",
        hitlSurface,
      })
    )
    registerBuiltInSkill(
      mkSkill({
        id: "lark.doc.search",
        family: "lark.doc",
        mutation: "read",
        mcpToolName: "lark_doc_search",
      })
    )
    const caps = summariseSkillCapabilities("lark")
    expect(caps).toHaveLength(2)
    expect(caps[0]).toEqual({
      family: "lark.calendar",
      mutations: ["read", "write", "destructive"],
    })
    expect(caps[1]).toEqual({ family: "lark.doc", mutations: ["read"] })
  })

  it("returns [] when no skills target the platform", () => {
    registerBuiltInSkill(mkSkill({ id: "lark.a", platforms: ["lark"] }))
    expect(summariseSkillCapabilities("telegram")).toEqual([])
  })
})
