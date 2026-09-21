/**
 * @jest-environment jsdom
 */
import {
  applyAskUserCallback,
  askUserTerminalSurface,
  buildAskUserSurface,
  refreshAskUserCard,
  runImAskUser,
  settleAskUserCard,
} from "./ask-user-question"
import { settleApprovalCard } from "./approval-card-state"
import {
  awaitAskUser,
  getPendingAskUser,
  getPendingAskUserBySurface,
  pendingAskUserCount,
  resolveAskUser,
  __resetAskUserRegistryForTesting,
  type PendingAskUserMeta,
} from "./ask-user-registry"
import { __resetImElicitationForTesting } from "./im-elicitation-context"
import type { ImElicitationContext } from "./im-elicitation-context"
import type { ConversationReference } from "@/types/connectors/event"
import type {
  ConnectorCallbackBindingRow,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"

jest.mock("./approval-card-state", () => ({
  settleApprovalCard: jest.fn(async () => undefined),
}))

const mockedSettle = jest.mocked(settleApprovalCard)

const larkRef: ConversationReference = {
  platform: "lark",
  adapterId: "adp-1",
  channelId: "oc_1",
}

const telegramRef: ConversationReference = {
  platform: "telegram",
  adapterId: "tg-1",
  channelId: "chat_9",
}

function ctx(partial: Partial<ImElicitationContext> = {}): ImElicitationContext {
  return {
    sessionId: "sess-1",
    adapterId: "adp-1",
    conversationKey: "lark:adp-1:oc_1",
    conversationRef: larkRef,
    initiatorUserId: "ou_user1",
    runId: "run-1",
    ...partial,
  }
}

const singleArgs = {
  question: "Pick one",
  options: [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ],
}

/** Injectable deps — everything injectable is stubbed so no test hits Dexie. */
function deps() {
  return {
    enqueue: jest.fn(async (_job: unknown) => ({ id: "job-1" }) as never),
    recordBinding: jest.fn(async (_row: unknown) => undefined as never),
    audit: jest.fn(async () => undefined as never),
    waitForDelivery: jest.fn(async () => undefined as never),
  }
}

beforeEach(() => {
  __resetAskUserRegistryForTesting()
  __resetImElicitationForTesting()
  jest.clearAllMocks()
})

const BINDING = {
  sessionId: "sess-1",
  toolUseId: "use-1",
  actorScope: { mode: "conversation" as const },
  expiresAt: Date.now() + 60_000,
}

describe("buildAskUserSurface", () => {
  const request: AskUserRequest = {
    question: "Pick colors",
    options: [
      { value: "red", label: "Red" },
      { value: "blue", label: "Blue" },
    ],
    multiSelect: true,
    allowText: true,
  }

  it("emits toggle buttons + submit + skip for multi-select with text", () => {
    const surface = buildAskUserSurface({ request, binding: BINDING })
    const opt0 = surface.components.opt_0 as Record<string, unknown>
    expect(opt0.component).toBe("Button")
    expect(opt0.action).toBe("toggle")
    expect(opt0.bindingKind).toBe("ask_user")
    expect(opt0.bindingPayload).toEqual({
      sessionId: "sess-1",
      toolUseId: "use-1",
      op: "toggle",
      value: "red",
    })
    expect(opt0.bindingActorScope).toEqual({ mode: "conversation" })
    expect(opt0.bindingExpiresAt).toBe(BINDING.expiresAt)
    const submit = surface.components.submit as Record<string, unknown>
    expect(submit.bindingPayload).toMatchObject({ op: "submit" })
    const skip = surface.components.skip as Record<string, unknown>
    expect(skip.bindingPayload).toMatchObject({ op: "skip" })
    const text = surface.components.answer_text as Record<string, unknown>
    expect(text.component).toBe("TextField")
    expect(text.bindingPayload).toMatchObject({ op: "submit_text" })
  })

  it("emits select buttons (no submit) for single-select", () => {
    const surface = buildAskUserSurface({
      request: { ...request, multiSelect: false, allowText: false },
      binding: BINDING,
    })
    const opt0 = surface.components.opt_0 as Record<string, unknown>
    expect(opt0.action).toBe("select")
    expect(opt0.bindingPayload).toMatchObject({ op: "select", value: "red" })
    expect(surface.components.submit).toBeUndefined()
    expect(surface.components.answer_text).toBeUndefined()
    expect(surface.components.skip).toBeDefined()
  })

  it("marks toggled options on repaint", () => {
    const surface = buildAskUserSurface({
      request,
      binding: BINDING,
      selected: ["blue"],
    })
    const opt0 = surface.components.opt_0 as Record<string, unknown>
    const opt1 = surface.components.opt_1 as Record<string, unknown>
    expect(opt0.text).toBe("Red")
    expect(opt0.variant).toBeUndefined()
    expect(opt1.text).toBe("✓ Blue")
    expect(opt1.variant).toBe("primary")
  })

  it("keeps a fallback mirror for non-card platforms", () => {
    const surface = buildAskUserSurface({ request, binding: BINDING })
    const fallback = (surface.widget as Record<string, unknown>).fallbackText as string
    expect(fallback).toContain("Pick colors")
    expect(fallback).toContain("1) Red")
    expect(fallback).toContain("[跳过 / Skip]")
  })

  it("renders a text-only card when no options were offered", () => {
    const surface = buildAskUserSurface({
      request: { question: "Why?", options: [], multiSelect: false, allowText: true },
      binding: BINDING,
    })
    expect(surface.components.opts).toBeUndefined()
    expect(surface.components.submit).toBeUndefined()
    expect(surface.components.answer_text).toBeDefined()
    expect(surface.components.skip).toBeDefined()
  })
})

describe("askUserTerminalSurface", () => {
  const request: AskUserRequest = {
    question: "Pick one",
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ],
    multiSelect: false,
    allowText: true,
  }

  it("echoes the answer with option labels on answered", () => {
    const surface = askUserTerminalSurface({
      request,
      state: "answered",
      answer: { selected: ["b"], text: "because", cancelled: false },
    })
    const result = surface.components.result as Record<string, unknown>
    expect(result.text).toContain("Beta")
    expect(result.text).toContain("because")
    // No interactive components remain.
    expect(JSON.stringify(surface.components)).not.toContain('"Button"')
    expect(JSON.stringify(surface.components)).not.toContain('"TextField"')
  })

  it("renders the closed notice for cancelled / expired / failed", () => {
    for (const state of ["cancelled", "expired", "failed"] as const) {
      const surface = askUserTerminalSurface({ request, state })
      expect(surface.components.result).toBeUndefined()
      expect(surface.components.closed).toBeDefined()
      expect(surface.title).toBeDefined()
    }
  })
})

describe("applyAskUserCallback", () => {
  const surfaceId = "au_0123456789abcdef"

  function meta(partial: Partial<PendingAskUserMeta> = {}): PendingAskUserMeta {
    return {
      surfaceId,
      request: {
        question: "Pick colors",
        options: [
          { value: "red", label: "Red" },
          { value: "blue", label: "Blue" },
        ],
        multiSelect: true,
        allowText: true,
      },
      adapterId: "adp-1",
      conversationKey: "lark:adp-1:oc_1",
      conversationRef: larkRef,
      actorScope: { mode: "conversation" },
      ...partial,
    }
  }

  function event(overrides: Partial<ConnectorCallbackEvent> = {}): ConnectorCallbackEvent {
    return {
      platform: "lark",
      adapterId: "adp-1",
      selfId: "bot_1",
      triggerId: `trig_${Math.random().toString(36).slice(2)}`,
      surfaceId,
      actionType: "button",
      value: "",
      originatingMessageId: "om_1",
      conversationKey: "lark:adp-1:oc_1",
      user: {
        id: "id-1",
        platform: "lark",
        adapterId: "adp-1",
        remoteUserId: "ou_user1",
        displayName: "User",
      },
      timestamp: Date.now(),
      raw: {},
      ...overrides,
    }
  }

  function binding(
    payload: Record<string, unknown>,
    kind: ConnectorCallbackBindingRow["kind"] = "ask_user"
  ): ConnectorCallbackBindingRow {
    return {
      id: "adp-1:act-1",
      adapterId: "adp-1",
      actionId: "act-1",
      kind,
      surfaceId,
      createdAt: Date.now(),
      payload: { sessionId: "sess-1", toolUseId: "use-1", ...payload },
    }
  }

  it("select resolves with the tapped option", async () => {
    const d = deps()
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ request: { ...meta().request, multiSelect: false } }),
    })
    const outcome = await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "select", value: "red" }),
      deps: d,
    })
    expect(outcome).toMatchObject({ handled: true, resolved: true, op: "select" })
    await expect(p).resolves.toMatchObject({
      reason: "answered",
      messageId: "om_1",
      answer: { selected: ["red"], cancelled: false },
    })
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "ask_user.answered" }))
  })

  it("rejects a select value the model never offered", async () => {
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ request: { ...meta().request, multiSelect: false } }),
    })
    const outcome = await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "select", value: "injected" }),
      deps: deps(),
    })
    expect(outcome).toMatchObject({ handled: true, resolved: false })
    expect(getPendingAskUser("sess-1", "use-1")).toBeDefined()
    __resetAskUserRegistryForTesting()
    void p
  })

  it("toggle mutates selection and repaints the card without settling", async () => {
    const d = deps()
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "toggle", value: "red" }),
      deps: d,
    })
    await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "toggle", value: "blue" }),
      deps: d,
    })
    // Untoggle red.
    await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "toggle", value: "red" }),
      deps: d,
    })
    expect(getPendingAskUser("sess-1", "use-1")?.selected).toEqual(["blue"])
    // Each toggle repainted the card on the originating message.
    expect(d.enqueue).toHaveBeenCalledTimes(3)
    expect(d.enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ editTargetMessageId: "om_1" }),
      })
    )
    const s = await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "submit" }),
      deps: d,
    })
    expect(s.resolved).toBe(true)
    await expect(p).resolves.toMatchObject({
      answer: { selected: ["blue"], cancelled: false },
    })
  })

  it("submit_text resolves with text plus already-toggled selections", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "toggle", value: "red" }),
      deps: deps(),
    })
    const s = await applyAskUserCallback({
      event: event({ actionType: "input", value: "purple-ish" }),
      binding: binding({ op: "submit_text" }),
      deps: deps(),
    })
    expect(s.resolved).toBe(true)
    await expect(p).resolves.toMatchObject({
      answer: { selected: ["red"], text: "purple-ish", cancelled: false },
    })
  })

  it("submit merges payload.values options that pass validation", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event({
        actionType: "submit",
        payload: { values: ["red", "not-an-option", "blue"] },
      }),
      binding: binding({ op: "submit" }),
      deps: deps(),
    })
    expect(s.resolved).toBe(true)
    await expect(p).resolves.toMatchObject({
      answer: { selected: ["red", "blue"], cancelled: false },
    })
  })

  it("skip cancels the prompt", async () => {
    const d = deps()
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "skip" }),
      deps: d,
    })
    expect(s).toMatchObject({ handled: true, resolved: true, op: "skip" })
    await expect(p).resolves.toMatchObject({
      reason: "cancelled",
      answer: { cancelled: true },
    })
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "ask_user.cancelled" }))
  })

  it("a platform dismiss on a bound row wins over the baked op", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event({ actionType: "dismiss" }),
      binding: binding({ op: "select", value: "red" }),
      deps: deps(),
    })
    expect(s).toMatchObject({ handled: true, resolved: true, op: "skip" })
    await expect(p).resolves.toMatchObject({ reason: "cancelled" })
  })

  it("swallows a stale press on a dead prompt and audits it", async () => {
    const d = deps()
    const s = await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "select", value: "a" }),
      deps: d,
    })
    expect(s).toMatchObject({ handled: true, resolved: false })
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ask_user.answered",
        fields: expect.objectContaining({ resolved: false, stale: true }),
      })
    )
  })

  it("surface-correlates a binding-less text reply (ForceReply) and resolves it", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event({ actionType: "input", value: "typed answer" }),
      surfaceId,
      operatorIds: [],
      deps: deps(),
    })
    expect(s).toMatchObject({ handled: true, resolved: true, op: "submit_text" })
    await expect(p).resolves.toMatchObject({
      reason: "answered",
      answer: { text: "typed answer", cancelled: false },
    })
  })

  it("resolves a Discord modal submit through its modal_open binding", async () => {
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ textComponentId: "answer_text" }),
    })
    const s = await applyAskUserCallback({
      event: event({
        platform: "discord",
        actionType: "submit",
        payload: { answer_text: "modal typed" },
      }),
      binding: binding({}, "modal_open"),
      surfaceId,
      deps: deps(),
    })
    expect(s).toMatchObject({ handled: true, resolved: true, op: "submit_text" })
    await expect(p).resolves.toMatchObject({
      answer: { text: "modal typed", cancelled: false },
    })
  })

  it("denies a binding-less answer from outside the actor scope", async () => {
    const d = deps()
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ actorScope: { mode: "initiator", allowedUserIds: ["ou_other"] } }),
    })
    const s = await applyAskUserCallback({
      event: event({ actionType: "input", value: "nope" }),
      surfaceId,
      operatorIds: [],
      deps: d,
    })
    expect(s).toMatchObject({ handled: true, resolved: false })
    expect(getPendingAskUser("sess-1", "use-1")).toBeDefined()
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "callback.forbidden" }))
    __resetAskUserRegistryForTesting()
    void p
  })

  it("allows a configured operator through the binding-less path", async () => {
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ actorScope: { mode: "initiator", allowedUserIds: ["ou_other"] } }),
    })
    const s = await applyAskUserCallback({
      event: event({ actionType: "input", value: "op answer" }),
      surfaceId,
      operatorIds: ["ou_user1"],
      deps: deps(),
    })
    expect(s.resolved).toBe(true)
    await expect(p).resolves.toMatchObject({ reason: "answered" })
  })

  it("refuses a surface-correlated event from a different adapter", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event({ adapterId: "other-adapter", actionType: "input", value: "x" }),
      surfaceId,
      deps: deps(),
    })
    expect(s.handled).toBe(false)
    expect(getPendingAskUser("sess-1", "use-1")).toBeDefined()
    __resetAskUserRegistryForTesting()
    void p
  })

  it("rejects a toggle value the model never offered", async () => {
    const d = deps()
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "toggle", value: "bogus" }),
      deps: d,
    })
    expect(s).toMatchObject({ handled: true, resolved: false })
    expect(getPendingAskUser("sess-1", "use-1")?.selected).toEqual([])
    expect(d.enqueue).not.toHaveBeenCalled()
    __resetAskUserRegistryForTesting()
    void p
  })

  it("a binding-less dismiss on a live surface skips the prompt", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event({ actionType: "dismiss" }),
      surfaceId,
      deps: deps(),
    })
    expect(s).toMatchObject({ handled: true, resolved: true, op: "skip" })
    await expect(p).resolves.toMatchObject({ reason: "cancelled" })
  })

  it("joins a modal payload array into multi-line text", async () => {
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ textComponentId: "answer_text" }),
    })
    const s = await applyAskUserCallback({
      event: event({ actionType: "submit", payload: { answer_text: ["l1", "l2"] } }),
      binding: binding({}, "modal_open"),
      surfaceId,
      deps: deps(),
    })
    expect(s.resolved).toBe(true)
    await expect(p).resolves.toMatchObject({ answer: { text: "l1\nl2" } })
  })

  it("yields empty text when a modal payload lacks the text component", async () => {
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ textComponentId: "answer_text" }),
    })
    const s = await applyAskUserCallback({
      event: event({ actionType: "submit", payload: { other_field: 7 } }),
      binding: binding({}, "modal_open"),
      surfaceId,
      deps: deps(),
    })
    expect(s.resolved).toBe(true)
    await expect(p).resolves.toMatchObject({ answer: { text: "" } })
  })

  it("ignores a binding-less button press on a live surface", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event({ actionType: "button", value: "whatever" }),
      surfaceId,
      deps: deps(),
    })
    expect(s.handled).toBe(false)
    expect(getPendingAskUser("sess-1", "use-1")).toBeDefined()
    __resetAskUserRegistryForTesting()
    void p
  })

  it("a binding-less input on an anyone-scope prompt resolves for any actor", async () => {
    const p = awaitAskUser("sess-1", "use-1", {
      meta: meta({ actorScope: { mode: "anyone" } }),
    })
    const s = await applyAskUserCallback({
      event: event({
        actionType: "input",
        value: "hi",
        user: { ...event().user, remoteUserId: "random" },
      }),
      surfaceId,
      deps: deps(),
    })
    expect(s.resolved).toBe(true)
    await expect(p).resolves.toMatchObject({ reason: "answered" })
  })

  it("returns unhandled when the surface has no live prompt", async () => {
    const s = await applyAskUserCallback({
      event: event({ actionType: "input", value: "stray" }),
      surfaceId: "au_ffffffffffffffff",
      deps: deps(),
    })
    expect(s.handled).toBe(false)
  })

  it("audits an unknown bound op as unbound without resolving", async () => {
    const d = deps()
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const s = await applyAskUserCallback({
      event: event(),
      binding: binding({ op: "explode" }),
      deps: d,
    })
    expect(s).toMatchObject({ handled: true, resolved: false })
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "callback.unbound",
        reason: "ask_user:unknown_op",
      })
    )
    expect(getPendingAskUser("sess-1", "use-1")).toBeDefined()
    __resetAskUserRegistryForTesting()
    void p
  })
})

describe("settleAskUserCard / refreshAskUserCard", () => {
  function meta(partial: Partial<PendingAskUserMeta> = {}): PendingAskUserMeta {
    return {
      surfaceId: "au_0123456789abcdef",
      request: {
        question: "Pick one",
        options: [{ value: "a", label: "Alpha" }],
        multiSelect: false,
        allowText: false,
      },
      adapterId: "adp-1",
      conversationKey: "lark:adp-1:oc_1",
      conversationRef: larkRef,
      actorScope: { mode: "conversation" },
      ...partial,
    }
  }

  it("delegates to settleApprovalCard on Lark with bilingual detail", async () => {
    await settleAskUserCard(
      meta({ jobId: "job-9" }),
      "answered",
      { selected: ["a"], text: "", cancelled: false },
      "om_5"
    )
    expect(mockedSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        surfaceId: "au_0123456789abcdef",
        jobId: "job-9",
        messageId: "om_5",
        state: "answered",
        detail: expect.stringContaining("Pick one"),
      })
    )
  })

  it.each([
    ["cancelled", "skipped"],
    ["expired", "expired"],
    ["failed", "cancelled"],
  ] as const)("maps %s to the Lark approval frame state %s", async (state, mapped) => {
    await settleAskUserCard(meta(), state)
    expect(mockedSettle).toHaveBeenCalledWith(expect.objectContaining({ state: mapped }))
  })

  it("edits the original card through the governed queue off Lark", async () => {
    const d = deps()
    await settleAskUserCard(
      meta({
        conversationRef: telegramRef,
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:chat_9",
        deliveryTarget: { refreshedAt: 1 } as never,
      }),
      "cancelled",
      undefined,
      "tg-msg-7",
      d
    )
    expect(mockedSettle).not.toHaveBeenCalled()
    expect(d.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "tg-1",
        request: expect.objectContaining({
          editTargetMessageId: "tg-msg-7",
          metadata: expect.objectContaining({
            idempotencyKey: "ask-user-edit:au_0123456789abcdef:cancelled",
          }),
        }),
      })
    )
    const segments = (d.enqueue.mock.calls[0][0] as { request: { segments: unknown[] } }).request
      .segments as Array<{ type: string }>
    expect(segments[0].type).toBe("a2ui")
  })

  it("resolves the platform message id from the delivery receipt when absent", async () => {
    const d = deps()
    d.waitForDelivery.mockResolvedValue({
      platformMessageId: "om-77",
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:chat_9",
      request: {
        conversationRef: telegramRef,
        deliveryTarget: { refreshedAt: 1 },
      },
    } as never)
    await settleAskUserCard(
      meta({
        conversationRef: telegramRef,
        adapterId: "tg-1",
        conversationKey: "telegram:tg-1:chat_9",
        jobId: "job-5",
      }),
      "expired",
      undefined,
      undefined,
      d
    )
    expect(d.waitForDelivery).toHaveBeenCalledWith("job-5", 5000)
    expect(d.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ editTargetMessageId: "om-77" }),
      })
    )
  })

  it("swallows an edit failure with an adapter.error audit", async () => {
    const d = deps()
    d.enqueue.mockRejectedValue(new Error("offline"))
    await expect(
      settleAskUserCard(
        meta({ conversationRef: telegramRef }),
        "answered",
        { selected: [], text: "x", cancelled: false },
        "m-1",
        d
      )
    ).resolves.toBeUndefined()
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ask_user_card_update_failed" })
    )
  })

  it("refreshAskUserCard repaints toggled selections on the same message", async () => {
    const d = deps()
    const m = meta({ conversationRef: telegramRef, adapterId: "tg-1" })
    const p = awaitAskUser("sess-1", "use-1", { meta: m })
    const entry = getPendingAskUser("sess-1", "use-1")!
    entry.selected.push("a")
    await refreshAskUserCard(entry, "om_2", d)
    expect(d.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ editTargetMessageId: "om_2" }),
      })
    )
    __resetAskUserRegistryForTesting()
    void p
  })
})

describe("runImAskUser", () => {
  it("returns cancelled without posting a card while drafting", async () => {
    const d = deps()
    const result = await runImAskUser({
      ctx: ctx({ drafting: true }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    expect(result).toBe(
      "The user was not asked: this turn is preparing a draft and has no live audience."
    )
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(getPendingAskUser("sess-1", "use-1")).toBeUndefined()
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ask_user.cancelled",
        fields: expect.objectContaining({ reason: "drafting" }),
      })
    )
  })

  /** Poll until the pending prompt registers — with a runId the run-interrupt
   *  dynamic import takes a few macrotasks before `awaitAskUser` runs. */
  async function waitForPending(sessionId = "sess-1", toolUseId = "use-1") {
    for (let i = 0; i < 50; i++) {
      const entry = getPendingAskUser(sessionId, toolUseId)
      if (entry) return entry
      await new Promise((r) => setTimeout(r, 1))
    }
    return undefined
  }

  it("pre-records durable bindings, posts the card, and resolves with the answer", async () => {
    const d = deps()
    const resultPromise = runImAskUser({
      ctx: ctx(),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    const pending = await waitForPending()
    expect(pending).toBeDefined()
    // Short surfaceId keeps generated actionIds under Telegram's 64-byte cap.
    expect(pending!.meta.surfaceId).toMatch(/^au_[0-9a-f]{16}$/)
    // Flush microtasks so the pre-record + enqueue chain has run.
    await new Promise((r) => setTimeout(r, 0))
    // One binding row per interactive component, before the card enqueued.
    // singleArgs → two select buttons + skip (allowText is false when options
    // exist and the model did not ask for free text).
    const boundActionIds = d.recordBinding.mock.calls.map(
      (c) => (c[0] as { actionId: string }).actionId
    )
    expect(boundActionIds.length).toBe(3)
    for (const call of d.recordBinding.mock.calls) {
      expect(call[0]).toMatchObject({ kind: "ask_user", adapterId: "adp-1" })
      expect((call[0] as { payload: Record<string, unknown> }).payload).toMatchObject({
        sessionId: "sess-1",
        toolUseId: "use-1",
      })
    }
    const enqueueOrder = d.enqueue.mock.invocationCallOrder[0]
    const lastBindOrder =
      d.recordBinding.mock.invocationCallOrder[d.recordBinding.mock.calls.length - 1]
    expect(lastBindOrder).toBeLessThan(enqueueOrder)
    expect(d.enqueue).toHaveBeenCalledTimes(1)
    const call = d.enqueue.mock.calls[0][0] as {
      adapterId: string
      request: { segments: Array<{ type: string }>; metadata: { idempotencyKey: string } }
    }
    expect(call.adapterId).toBe("adp-1")
    expect(call.request.segments[0].type).toBe("a2ui")
    expect(call.request.metadata.idempotencyKey).toBe("ask-user:sess-1:use-1")
    expect(pending!.meta.jobId).toBe("job-1")
    // Surface lookup works for the binding-less fallback path.
    expect(getPendingAskUserBySurface(pending!.meta.surfaceId)?.toolUseId).toBe("use-1")
    resolveAskUser("sess-1", "use-1", { selected: ["b"], text: "", cancelled: false })
    await expect(resultPromise).resolves.toBe("Selected: Beta")
    expect(getPendingAskUser("sess-1", "use-1")).toBeUndefined()
    // Lark settle delegated to the approval-card command frame.
    expect(mockedSettle).toHaveBeenCalledWith(
      expect.objectContaining({ state: "answered", surfaceId: pending!.meta.surfaceId })
    )
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "ask_user.requested" }))
  })

  it("resolves cancelled with an ask_user.failed audit when delivery throws", async () => {
    const d = deps()
    d.enqueue.mockRejectedValue(new Error("send failed"))
    const result = await runImAskUser({
      ctx: ctx(),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    expect(result).toBe("Error: the question could not be delivered to the conversation.")
    expect(getPendingAskUser("sess-1", "use-1")).toBeUndefined()
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "ask_user.failed" }))
  })

  it("pre-records all five component bindings for a multi-select + text card", async () => {
    const d = deps()
    const resultPromise = runImAskUser({
      ctx: ctx({ runId: undefined }),
      toolUseId: "use-1",
      args: { ...singleArgs, multiSelect: true, allowText: true },
      deps: d,
    })
    await new Promise((r) => setTimeout(r, 0))
    const ops = d.recordBinding.mock.calls.map(
      (c) => (c[0] as { payload: { op: string } }).payload.op
    )
    expect(ops).toEqual(["toggle", "toggle", "submit_text", "submit", "skip"])
    resolveAskUser("sess-1", "use-1", { selected: ["a"], text: "", cancelled: false })
    await expect(resultPromise).resolves.toBe("Selected: Alpha")
  })

  it("falls back to operators actor scope when the turn has no initiator", async () => {
    const d = deps()
    const resultPromise = runImAskUser({
      ctx: ctx({ runId: undefined, initiatorUserId: undefined }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(d.recordBinding.mock.calls[0][0]).toMatchObject({
      actorScope: { mode: "operators" },
    })
    resolveAskUser("sess-1", "use-1", { selected: ["a"], text: "", cancelled: false })
    await resultPromise
  })

  it("honours an explicit actorScope over the initiator default", async () => {
    const d = deps()
    const resultPromise = runImAskUser({
      ctx: ctx({ runId: undefined, actorScope: { mode: "conversation" } }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(d.recordBinding.mock.calls[0][0]).toMatchObject({
      actorScope: { mode: "conversation" },
    })
    resolveAskUser("sess-1", "use-1", { selected: ["a"], text: "", cancelled: false })
    await resultPromise
  })

  it("expires the prompt when the TTL elapses", async () => {
    const d = deps()
    const resultPromise = runImAskUser({
      ctx: ctx({ ttlMs: 1, conversationRef: telegramRef, adapterId: "tg-1" }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    await expect(resultPromise).resolves.toBe("The user dismissed the question without answering.")
    expect(getPendingAskUser("sess-1", "use-1")).toBeUndefined()
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "ask_user.expired" }))
    // Off-Lark settle went through the governed edit seam (async, best-effort).
    await new Promise((r) => setTimeout(r, 0))
  })

  it("settles as aborted when the owning run signal fires", async () => {
    const d = deps()
    const controller = new AbortController()
    const resultPromise = runImAskUser({
      ctx: ctx({ runId: undefined, signal: controller.signal }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(getPendingAskUser("sess-1", "use-1")).toBeDefined()
    controller.abort()
    await expect(resultPromise).resolves.toBe("The user dismissed the question without answering.")
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ask_user.cancelled",
        fields: expect.objectContaining({ reason: "run_aborted" }),
      })
    )
  })

  it("posts nothing when the run signal is already aborted at call time", async () => {
    const d = deps()
    const controller = new AbortController()
    controller.abort()
    const result = await runImAskUser({
      ctx: ctx({ signal: controller.signal }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d,
    })
    expect(result).toBe("The user dismissed the question without answering.")
    expect(d.enqueue).not.toHaveBeenCalled()
    expect(d.recordBinding).not.toHaveBeenCalled()
    expect(getPendingAskUser("sess-1", "use-1")).toBeUndefined()
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ask_user.cancelled",
        fields: expect.objectContaining({ reason: "run_aborted" }),
      })
    )
  })

  it("combines the caller abortSignal with the context signal", async () => {
    const d = deps()
    const caller = new AbortController()
    const owner = new AbortController()
    const resultPromise = runImAskUser({
      ctx: ctx({ runId: undefined, signal: owner.signal }),
      toolUseId: "use-1",
      args: singleArgs,
      signal: caller.signal,
      deps: d,
    })
    await new Promise((r) => setTimeout(r, 0))
    caller.abort()
    await expect(resultPromise).resolves.toBe("The user dismissed the question without answering.")
    expect(pendingAskUserCount()).toBe(0)
  })

  it("supersedes a duplicate registration for the same toolUseId", async () => {
    const d1 = deps()
    const d2 = deps()
    const first = runImAskUser({
      ctx: ctx({ runId: undefined }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d1,
    })
    const second = runImAskUser({
      ctx: ctx({ runId: undefined }),
      toolUseId: "use-1",
      args: singleArgs,
      deps: d2,
    })
    await expect(first).resolves.toBe("The user dismissed the question without answering.")
    await new Promise((r) => setTimeout(r, 0))
    resolveAskUser("sess-1", "use-1", { selected: ["a"], text: "", cancelled: false })
    await expect(second).resolves.toBe("Selected: Alpha")
  })
})
