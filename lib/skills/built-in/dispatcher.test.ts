/** @jest-environment jsdom */
/**
 * Tests for lib/skills/built-in/dispatcher.ts — trust-model gates and
 * execution pipeline. Mocks PII redact + audit append + binding write
 * so the dispatcher path is exercised in isolation.
 */

import "fake-indexeddb/auto"
import { z } from "zod"

// Desktop consent surface (W2 dual-channel HITL) — mocked so tests control
// the approve/deny outcome instead of waiting on a real dialog + TTL.
const mockDesktopApproval = jest.fn()
jest.mock("./desktop-hitl", () => ({
  requestDesktopSkillApproval: (...a: unknown[]) => mockDesktopApproval(...a),
}))

import { runBuiltInSkill } from "./dispatcher"
import { registerBuiltInSkill, __resetSharedBuiltInSkillRegistry } from "./registry"
import type { BuiltInSkill, BuiltInSkillContext } from "./types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

const hitlSurface = () => ({
  components: { btn: { component: "Button" } },
  dataModel: {},
  rootId: "sfc_confirm",
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
    execute: async (args: unknown) => ({ ok: true, args }),
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

const imBinding = {
  adapterId: "lark-1",
  platform: "lark" as const,
  conversationKey: "lark:lark-1:oc_x",
}

const desktopCtx: BuiltInSkillContext = {
  sessionId: "s_x",
}

const imCtx: BuiltInSkillContext = {
  sessionId: "s_x",
  imBinding,
}

beforeEach(async () => {
  __resetSharedBuiltInSkillRegistry()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("runBuiltInSkill — unknown skill", () => {
  it("returns denied with reason 'unknown_skill'", async () => {
    const r = await runBuiltInSkill("does.not.exist", {}, desktopCtx)
    expect(r).toEqual({
      status: "denied",
      reason: "unknown_skill",
      message: expect.stringContaining("does.not.exist"),
    })
  })
})

describe("runBuiltInSkill — arg validation", () => {
  it("denies on invalid args with reason 'invalid_args'", async () => {
    registerBuiltInSkill(mkSkill())
    const r = await runBuiltInSkill("lark.calendar.list_events", {}, desktopCtx)
    expect(r.status).toBe("denied")
    if (r.status === "denied") {
      expect(r.reason).toBe("invalid_args")
    }
  })

  it("passes when args match the schema", async () => {
    registerBuiltInSkill(mkSkill())
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { calendarId: "cal_1" },
      desktopCtx
    )
    expect(r.status).toBe("ok")
    if (r.status === "ok") {
      expect(r.data).toEqual({ ok: true, args: { calendarId: "cal_1" } })
    }
  })
})

describe("runBuiltInSkill — PII gate", () => {
  it("denies when args contain PII (email)", async () => {
    registerBuiltInSkill(
      mkSkill({
        inputSchema: z.object({ note: z.string() }),
      })
    )
    // hasNoLeakingPii rejects email-like strings.
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { note: "Email me at alice@example.com tonight" },
      desktopCtx
    )
    expect(r.status).toBe("denied")
    if (r.status === "denied") {
      expect(r.reason).toBe("pii_blocked")
    }
  })
})

describe("runBuiltInSkill — read tier in IM", () => {
  it("executes a read skill without HITL", async () => {
    registerBuiltInSkill(mkSkill())
    const r = await runBuiltInSkill("lark.calendar.list_events", { calendarId: "cal_1" }, imCtx)
    expect(r.status).toBe("ok")
  })

  it("respects allowedBuiltInSkillIds = []", async () => {
    registerBuiltInSkill(mkSkill())
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { calendarId: "cal_1" },
      { ...imCtx, imOverrideRow: mkOverride({ allowedBuiltInSkillIds: [] }) }
    )
    expect(r.status).toBe("denied")
    if (r.status === "denied") {
      expect(r.reason).toBe("channel_blocks_all_builtin_skills")
    }
  })

  it("respects family.* wildcard in allowedBuiltInSkillIds", async () => {
    registerBuiltInSkill(mkSkill())
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { calendarId: "cal_1" },
      {
        ...imCtx,
        imOverrideRow: mkOverride({ allowedBuiltInSkillIds: ["lark.calendar.*"] }),
      }
    )
    expect(r.status).toBe("ok")
  })

  it("denies when skill is not in allowedBuiltInSkillIds", async () => {
    registerBuiltInSkill(mkSkill())
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { calendarId: "cal_1" },
      {
        ...imCtx,
        imOverrideRow: mkOverride({ allowedBuiltInSkillIds: ["other.skill"] }),
      }
    )
    expect(r.status).toBe("denied")
    if (r.status === "denied") {
      expect(r.reason).toBe("not_allowed_for_channel")
    }
  })
})

describe("runBuiltInSkill — piiArgFields exemption (identifier-lookup fields)", () => {
  it("allows emails inside a declared piiArgFields field (im.resolve_contact pattern)", async () => {
    registerBuiltInSkill(
      mkSkill({
        inputSchema: z.object({ emails: z.array(z.string()), adapterId: z.string().optional() }),
        piiArgFields: ["emails"],
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { emails: ["alice@example.com"] },
      desktopCtx
    )
    expect(r.status).toBe("ok")
  })

  it("still blocks PII in fields NOT declared in piiArgFields", async () => {
    registerBuiltInSkill(
      mkSkill({
        inputSchema: z.object({ emails: z.array(z.string()), note: z.string().optional() }),
        piiArgFields: ["emails"],
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { emails: [], note: "reach me at bob@example.com" },
      desktopCtx
    )
    expect(r).toMatchObject({ status: "denied", reason: "pii_blocked" })
  })
})

describe("runBuiltInSkill — write tier HITL routing", () => {
  it("returns pending_hitl in IM by default", async () => {
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create_event",
        mutation: "write",
        hitlSurface,
        mcpToolName: "lark_calendar_create_event",
      })
    )
    const r = await runBuiltInSkill("lark.calendar.create_event", { calendarId: "cal_1" }, imCtx)
    expect(r.status).toBe("pending_hitl")
    if (r.status === "pending_hitl") {
      expect(r.surfaceId).toBe("sfc_confirm")
      expect(r.bindingId).toMatch(/^lark-1:skill_invoke:lark\.calendar\.create_event:/)
    }
    // Binding row was written.
    const bindings = await getDb()
      .connectorCallbackBindings.where("kind")
      .equals("skill_invoke")
      .toArray()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].payload?.skillId).toBe("lark.calendar.create_event")
    // No running inbound job in this harness → confirm button is scoped to
    // configured operators only (plan 2026-07-24 Phase 2).
    expect(bindings[0].actorScope).toEqual({ mode: "operators" })
  })

  it("scopes the confirm binding to the current turn's sender when a job is running", async () => {
    const { enqueueConnectorInboundJob, claimConnectorInboundJob } =
      await import("@/lib/db/connector-inbound-jobs")
    const job = await enqueueConnectorInboundJob(
      {
        platform: "lark",
        adapterId: "lark-1",
        selfId: "bot",
        messageId: "om_turn",
        conversationRef: { platform: "lark", adapterId: "lark-1", channelId: "oc_1" },
        conversationKey: imCtx.imBinding!.conversationKey,
        sender: {
          id: "lark:ou_turn_user",
          platform: "lark",
          adapterId: "lark-1",
          remoteUserId: "ou_turn_user",
        },
        channel: { id: imCtx.imBinding!.conversationKey, kind: "group" },
        segments: [{ type: "text", text: "do it" }],
        plainText: "do it",
        mentions: { selfMentioned: false, users: [] },
        timestamp: Date.now(),
        raw: {},
      },
      "queue"
    )
    await claimConnectorInboundJob(job.id, { leaseOwner: "test", leaseMs: 60_000 })

    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create_event",
        mutation: "write",
        hitlSurface,
        mcpToolName: "lark_calendar_create_event",
      })
    )
    const r = await runBuiltInSkill("lark.calendar.create_event", { calendarId: "cal_1" }, imCtx)
    expect(r.status).toBe("pending_hitl")
    const bindings = await getDb()
      .connectorCallbackBindings.where("kind")
      .equals("skill_invoke")
      .toArray()
    expect(bindings[0].actorScope).toEqual({
      mode: "initiator",
      allowedUserIds: ["ou_turn_user"],
    })
  })

  it("executes without HITL when requireHitlForWrites = false", async () => {
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create_event",
        mutation: "write",
        hitlSurface,
        mcpToolName: "lark_calendar_create_event",
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.create_event",
      { calendarId: "cal_1" },
      {
        ...imCtx,
        imOverrideRow: mkOverride({ requireHitlForWrites: false }),
      }
    )
    expect(r.status).toBe("ok")
  })

  it("executes immediately when hitlBypass = true (callback re-fire)", async () => {
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create_event",
        mutation: "write",
        hitlSurface,
        mcpToolName: "lark_calendar_create_event",
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.create_event",
      { calendarId: "cal_1" },
      { ...imCtx, hitlBypass: true }
    )
    expect(r.status).toBe("ok")
  })

  // W2 dual-channel HITL: the former "desktop skips HITL" v1 shortcut is
  // gone — desktop writes now suspend on the chat tool-approval dialog.
  it("write tier in a desktop session executes after the consent dialog approves", async () => {
    mockDesktopApproval.mockResolvedValueOnce({ approved: true, reason: "user" })
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create_event",
        mutation: "write",
        hitlSurface,
        mcpToolName: "lark_calendar_create_event",
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.create_event",
      { calendarId: "cal_1" },
      desktopCtx
    )
    expect(r.status).toBe("ok")
    expect(mockDesktopApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s_x",
        skill: expect.objectContaining({ id: "lark.calendar.create_event" }),
      })
    )
  })

  it("write tier in a desktop session is denied when the consent dialog declines", async () => {
    mockDesktopApproval.mockResolvedValueOnce({ approved: false, reason: "user" })
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create_event",
        mutation: "write",
        hitlSurface,
        mcpToolName: "lark_calendar_create_event",
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.create_event",
      { calendarId: "cal_1" },
      desktopCtx
    )
    expect(r).toMatchObject({ status: "denied", reason: "hitl_rejected" })
  })

  it("write tier in a desktop session is denied with a retry hint on TTL expiry", async () => {
    mockDesktopApproval.mockResolvedValueOnce({ approved: false, reason: "expired" })
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.create_event",
        mutation: "write",
        hitlSurface,
        mcpToolName: "lark_calendar_create_event",
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.create_event",
      { calendarId: "cal_1" },
      desktopCtx
    )
    expect(r).toMatchObject({ status: "denied", reason: "hitl_rejected" })
    if (r.status === "denied") expect(r.message).toMatch(/timed out/)
    expect(mockDesktopApproval).toHaveBeenCalledTimes(1)
  })
})

describe("runBuiltInSkill — destructive tier", () => {
  it("requires explicit allowlist opt-in", async () => {
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.delete_event",
        mutation: "destructive",
        imAccess: "opt-in",
        hitlSurface,
        mcpToolName: "lark_calendar_delete_event",
      })
    )
    // No override → blocked.
    let r = await runBuiltInSkill("lark.calendar.delete_event", { calendarId: "cal_1" }, imCtx)
    expect(r.status).toBe("denied")

    // Allowlist present → renders confirm card (does NOT auto-execute).
    r = await runBuiltInSkill(
      "lark.calendar.delete_event",
      { calendarId: "cal_1" },
      {
        ...imCtx,
        imOverrideRow: mkOverride({
          allowedBuiltInSkillIds: ["lark.calendar.delete_event"],
        }),
      }
    )
    expect(r.status).toBe("pending_hitl")
  })

  it("HITL is mandatory even when requireHitlForWrites = false", async () => {
    registerBuiltInSkill(
      mkSkill({
        id: "lark.calendar.delete_event",
        mutation: "destructive",
        imAccess: "opt-in",
        hitlSurface,
        mcpToolName: "lark_calendar_delete_event",
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.delete_event",
      { calendarId: "cal_1" },
      {
        ...imCtx,
        imOverrideRow: mkOverride({
          allowedBuiltInSkillIds: ["lark.calendar.delete_event"],
          requireHitlForWrites: false,
        }),
      }
    )
    expect(r.status).toBe("pending_hitl")
  })
})

describe("runBuiltInSkill — error surface", () => {
  it("catches execute() throws and returns error", async () => {
    registerBuiltInSkill(
      mkSkill({
        execute: async () => {
          throw new Error("upstream 500")
        },
      })
    )
    const r = await runBuiltInSkill(
      "lark.calendar.list_events",
      { calendarId: "cal_1" },
      desktopCtx
    )
    expect(r).toEqual({ status: "error", message: "upstream 500" })
  })
})
