/** @jest-environment jsdom */
/**
 * Decision matrix for the unified callback authorization guard
 * (plan 2026-07-24 Phase 2).
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type {
  ConnectorCallbackBindingRow,
  ConnectorCallbackEvent,
} from "@/types/connectors/interaction"
import {
  authorizeConnectorCallback,
  normalizeRequestedAction,
  notifyCallbackDenied,
} from "./callback-authorization"

const T0 = 1_753_000_000_000

function adapterRow(settings: Record<string, unknown> = {}): AdapterInstanceRow {
  return {
    id: "lk-1",
    type: "lark",
    displayName: "Bot",
    enabled: true,
    transportMode: "stub",
    settings: { larkStrictCallbackAuthorization: "enforce", ...settings },
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
  } as unknown as AdapterInstanceRow
}

function callbackEvent(overrides: Partial<ConnectorCallbackEvent> = {}): ConnectorCallbackEvent {
  return {
    platform: "lark",
    adapterId: "lk-1",
    selfId: "ou_bot",
    triggerId: "act_1",
    surfaceId: "sfc_1",
    actionType: "button",
    value: "approve",
    payload: { action: "approve" },
    conversationKey: "lark:lk-1:oc_1",
    user: { id: "lark:ou_alice", platform: "lark", adapterId: "lk-1", remoteUserId: "ou_alice" },
    timestamp: T0,
    raw: {},
    ...overrides,
  }
}

function binding(
  overrides: Partial<ConnectorCallbackBindingRow> = {}
): ConnectorCallbackBindingRow {
  return {
    id: "lk-1:act_1",
    adapterId: "lk-1",
    actionId: "act_1",
    kind: "wf_approve",
    surfaceId: "sfc_1",
    conversationKey: "lark:lk-1:oc_1",
    createdAt: T0,
    expiresAt: T0 + 1_000_000,
    ...overrides,
  }
}

async function authorize(
  overrides: Partial<Parameters<typeof authorizeConnectorCallback>[0]> = {}
) {
  return authorizeConnectorCallback({
    event: callbackEvent(),
    binding: binding(),
    adapterRow: adapterRow(),
    resolvedConversationKey: "lark:lk-1:oc_1",
    kindClass: "wf_approve",
    now: T0 + 1,
    ...overrides,
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

describe("authorizeConnectorCallback", () => {
  it("mode off: allows everything without evaluation", async () => {
    const decision = await authorize({
      adapterRow: adapterRow({ larkStrictCallbackAuthorization: "off" }),
      binding: binding({ adapterId: "someone-else", consumedAt: T0 }),
    })
    expect(decision).toEqual({ allowed: true, mode: "off" })
  })

  it("denies adapter mismatch", async () => {
    const decision = await authorize({ binding: binding({ adapterId: "lk-2" }) })
    expect(decision).toMatchObject({ allowed: false, reason: "adapter_mismatch", mode: "enforce" })
  })

  it("re-checks binding expiry", async () => {
    const decision = await authorize({ binding: binding({ expiresAt: T0 }), now: T0 + 1 })
    expect(decision).toMatchObject({ allowed: false, reason: "binding_expired" })
  })

  it("denies consumed consume-once bindings but not reusable kinds", async () => {
    const consumed = await authorize({ binding: binding({ consumedAt: T0 }) })
    expect(consumed).toMatchObject({ allowed: false, reason: "binding_consumed" })

    const help = await authorize({
      binding: binding({ kind: "help_quick_command", consumedAt: T0 }),
      kindClass: "help_quick_command",
    })
    expect(help.allowed).toBe(true)
  })

  it("matches conversations at chat level (topic binding vs chat-scoped callback)", async () => {
    // Lark callbacks come back chat-scoped; a binding written inside a topic
    // carries the thread suffix — same chat must still match.
    const topicBound = await authorize({
      binding: binding({ conversationKey: "lark:lk-1:oc_1:omt_9", actorScope: { mode: "anyone" } }),
    })
    expect(topicBound.allowed).toBe(true)

    const otherChat = await authorize({
      binding: binding({ conversationKey: "lark:lk-1:oc_OTHER" }),
    })
    expect(otherChat).toMatchObject({ allowed: false, reason: "conversation_mismatch" })

    const otherThreadSameChat = await authorize({
      event: callbackEvent({ conversationKey: "lark:lk-1:oc_1:omt_2" }),
      binding: binding({ conversationKey: "lark:lk-1:oc_1:omt_9", actorScope: { mode: "anyone" } }),
    })
    expect(otherThreadSameChat).toMatchObject({ allowed: false, reason: "conversation_mismatch" })
  })

  it("fails closed through the principal registry when enabled", async () => {
    const decision = await authorize({
      adapterRow: adapterRow({ larkPrincipalRegistry: true }),
      event: callbackEvent({ identityScope: { tenantKey: "tk_a", appId: "cli_1" } }),
      binding: binding({ actorScope: { mode: "anyone" } }),
    })
    expect(decision).toMatchObject({ allowed: false, reason: "principal_unbound" })
  })

  it("enforces allowedActions only when the event carries an action signal", async () => {
    const forbidden = await authorize({
      binding: binding({ allowedActions: ["cancel"], actorScope: { mode: "anyone" } }),
    })
    expect(forbidden).toMatchObject({ allowed: false, reason: "action_not_allowed" })

    const noSignal = await authorize({
      event: callbackEvent({ value: "", payload: undefined }),
      binding: binding({ allowedActions: ["cancel"], actorScope: { mode: "anyone" } }),
    })
    expect(noSignal.allowed).toBe(true)
  })

  it("actor scope: initiator allows the initiator and configured operators only", async () => {
    const scoped = binding({
      actorScope: { mode: "initiator", allowedUserIds: ["ou_alice"] },
    })
    expect((await authorize({ binding: scoped })).allowed).toBe(true)

    const bystander = callbackEvent({
      user: { id: "lark:ou_bob", platform: "lark", adapterId: "lk-1", remoteUserId: "ou_bob" },
    })
    expect(await authorize({ binding: scoped, event: bystander })).toMatchObject({
      allowed: false,
      reason: "actor_forbidden",
    })

    const operator = await authorize({
      binding: scoped,
      event: bystander,
      adapterRow: adapterRow({ runOperatorUserIds: ["ou_bob"] }),
    })
    expect(operator.allowed).toBe(true)
  })

  it("legacy wf_approve rows fall back to the payload initiator", async () => {
    const legacy = binding({
      payload: { triggeredFrom: { initiator: { remoteUserId: "ou_carol" } } },
    })
    const denied = await authorize({ binding: legacy })
    expect(denied).toMatchObject({ allowed: false, reason: "actor_forbidden" })
    expect((denied as { auditFields: Record<string, unknown> }).auditFields.legacyActorScope).toBe(
      true
    )

    const carol = await authorize({
      binding: legacy,
      event: callbackEvent({
        user: {
          id: "lark:ou_carol",
          platform: "lark",
          adapterId: "lk-1",
          remoteUserId: "ou_carol",
        },
      }),
    })
    expect(carol.allowed).toBe(true)
  })

  it("legacy rows of other kinds fall back to conversation scope", async () => {
    const legacyTool = binding({ kind: "tool_approve", payload: { decision: "allow" } })
    const sameConversation = await authorize({
      binding: legacyTool,
      event: callbackEvent({ value: "", payload: undefined }),
    })
    expect(sameConversation.allowed).toBe(true)
  })

  it("run_control: the conversation must be bound to the claimed run", async () => {
    await getDb().executionRunBindings.put({
      id: "erb_1",
      runId: "run_1",
      adapterId: "lk-1",
      conversationKey: "lark:lk-1:oc_1",
      status: "active",
      createdAt: T0,
      updatedAt: T0,
    } as never)

    const ok = await authorize({
      binding: undefined,
      kindClass: "run_control",
      runId: "run_1",
      event: callbackEvent({ payload: { runId: "run_1", action: "stop", revision: 1 } }),
    })
    expect(ok.allowed).toBe(true)

    const wrongRun = await authorize({
      binding: undefined,
      kindClass: "run_control",
      runId: "run_FORGED",
      event: callbackEvent({ payload: { runId: "run_FORGED", action: "stop", revision: 1 } }),
    })
    expect(wrongRun).toMatchObject({ allowed: false, reason: "run_conversation_mismatch" })
  })

  it("audit mode reports the deny but the caller may proceed", async () => {
    const decision = await authorize({
      adapterRow: adapterRow({ larkStrictCallbackAuthorization: "audit" }),
      binding: binding({ actorScope: { mode: "initiator", allowedUserIds: ["ou_zed"] } }),
    })
    expect(decision).toMatchObject({ allowed: false, mode: "audit", reason: "actor_forbidden" })
  })

  it("audit fields never contain the raw actor id", async () => {
    const decision = await authorize({
      binding: binding({ actorScope: { mode: "initiator", allowedUserIds: ["ou_zed"] } }),
    })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(JSON.stringify(decision.auditFields)).not.toContain("ou_alice")
      expect(decision.auditFields.actorHash).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  it("enforce-mode allow on a consume-once kind exposes consume() that marks the row", async () => {
    const row = binding({ actorScope: { mode: "anyone" } })
    await getDb().connectorCallbackBindings.put(row)
    const decision = await authorize({ binding: row })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.consume).toBeDefined()
      await decision.consume!()
      const stored = await getDb().connectorCallbackBindings.get(row.id)
      expect(stored?.consumedAt).toBe(T0 + 1)
    }
  })

  it("audit-mode allow never consumes (shadow mode must not change behavior)", async () => {
    const decision = await authorize({
      adapterRow: adapterRow({ larkStrictCallbackAuthorization: "audit" }),
      binding: binding({ actorScope: { mode: "anyone" } }),
    })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) expect(decision.consume).toBeUndefined()
  })
})

describe("normalizeRequestedAction", () => {
  it("prefers payload.action, lowercases, and maps dismiss to cancel", () => {
    expect(normalizeRequestedAction(callbackEvent())).toBe("approve")
    expect(normalizeRequestedAction(callbackEvent({ payload: undefined, value: "CANCEL" }))).toBe(
      "cancel"
    )
    expect(
      normalizeRequestedAction(
        callbackEvent({ payload: undefined, value: "", actionType: "dismiss" })
      )
    ).toBe("cancel")
    expect(normalizeRequestedAction(callbackEvent({ payload: undefined, value: "" }))).toBe("")
  })
})

describe("notifyCallbackDenied", () => {
  it("enqueues one bilingual notice keyed to the trigger", async () => {
    const enqueue = jest.fn(async (_input: unknown) => ({}) as never)
    await notifyCallbackDenied(callbackEvent(), "lark:lk-1:oc_1:omt_5", "actor_forbidden", {
      enqueue,
    })
    const input = enqueue.mock.calls[0][0] as {
      request: {
        conversationRef: { channelId: string; threadTs?: string }
        metadata: { idempotencyKey: string }
      }
    }
    expect(input.request.metadata.idempotencyKey).toBe("cb-denied:act_1")
    expect(input.request.conversationRef.channelId).toBe("oc_1")
    expect(input.request.conversationRef.threadTs).toBe("omt_5")
  })

  it("explains each terminal reason instead of leaving a dead button", async () => {
    // Only actor_forbidden used to get a notice; the other ten reasons left
    // the clicker with a button that did nothing at all.
    const cases: Array<[Parameters<typeof notifyCallbackDenied>[2], string]> = [
      ["binding_consumed", "only once"],
      ["binding_expired", "expired"],
      ["principal_unbound", "not linked"],
      ["tenant_disabled", "workspace"],
      ["conversation_mismatch", "another conversation"],
    ]
    for (const [reason, needle] of cases) {
      const enqueue = jest.fn(async (_input: unknown) => ({}) as never)
      await notifyCallbackDenied(callbackEvent(), "lark:lk-1:oc_1", reason, { enqueue })
      const input = enqueue.mock.calls[0][0] as {
        request: { segments: Array<{ text: string }> }
      }
      expect(input.request.segments[0].text).toContain(needle)
    }
  })

  it("falls back to the actor notice for an unrecognized reason", async () => {
    const enqueue = jest.fn(async (_input: unknown) => ({}) as never)
    await notifyCallbackDenied(callbackEvent(), "lark:lk-1:oc_1", "not_a_reason" as never, {
      enqueue,
    })
    const input = enqueue.mock.calls[0][0] as { request: { segments: Array<{ text: string }> } }
    expect(input.request.segments[0].text).toContain("not authorized")
  })
})

/**
 * Structural guard over the binding WRITERS, not the reader.
 *
 * `legacyActorScope` exists for rows written before this guard shipped and
 * returns `{mode:"conversation"}` for most kinds — which the guard has already
 * satisfied by the time it runs, i.e. a no-op. That is correct for the old
 * rows it was written for, and wrong for anything new: a high-privilege
 * binding that forgets `actorScope` silently degrades to "anyone who can see
 * the card". This pins every consume-once writer to an explicit scope so the
 * degradation cannot come back by omission.
 */
describe("high-privilege binding writers", () => {
  const CONSUME_ONCE_SOURCES: Array<{ kind: string; file: string }> = [
    { kind: "tool_approve", file: "lib/connectors/hitl/tool-approval.ts" },
    { kind: "skill_invoke", file: "lib/skills/built-in/dispatcher.ts" },
    { kind: "wf_approve", file: "plugins/workflow-ai/src/tools/run-by-name-tools.ts" },
    { kind: "wf_cancel", file: "plugins/workflow-ai/src/tools/run-by-name-tools.ts" },
    { kind: "wf_fanout_approve", file: "plugins/workflow-ai/src/tools/run-by-name-tools.ts" },
    { kind: "wf_fanout_cancel", file: "plugins/workflow-ai/src/tools/run-by-name-tools.ts" },
  ]

  it.each(CONSUME_ONCE_SOURCES)(
    "$kind is recorded with an explicit actorScope",
    async ({ kind, file }) => {
      const fs = await import("node:fs/promises")
      const path = await import("node:path")
      const source = await fs.readFile(path.join(process.cwd(), file), "utf8")

      // The `kind: "…"` literal and an `actorScope` must both appear in the
      // same binding-record argument object. Call sites spell the function
      // either directly or through an injected `recordBinding` dep.
      const kindIndex = source.indexOf(`kind: "${kind}"`)
      expect(kindIndex).toBeGreaterThan(-1)
      const objectEnd = source.indexOf("})", kindIndex)
      const objectStart = Math.max(
        source.lastIndexOf("recordCallbackBinding({", kindIndex),
        source.lastIndexOf("recordBinding({", kindIndex)
      )
      expect(objectStart).toBeGreaterThan(-1)
      expect(source.slice(objectStart, objectEnd)).toContain("actorScope")
    }
  )

  it("the guard's consume-once set matches the kinds those writers produce", async () => {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const guard = await fs.readFile(
      path.join(process.cwd(), "lib/connectors/callback-authorization.ts"),
      "utf8"
    )
    for (const { kind } of CONSUME_ONCE_SOURCES) {
      expect(guard).toContain(`"${kind}"`)
    }
  })
})
