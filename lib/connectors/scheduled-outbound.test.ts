/** @jest-environment jsdom */
/**
 * Tests for lib/connectors/scheduled-outbound.ts.
 *
 * The G2 upgrade replaced the Phase-1 stub of `handleScheduledDigest`
 * with a real AI loop (resolveSendOptions → safeSendPrompt → segments →
 * enqueue). We mock the heavy upstream deps (build-options, char/settings
 * lookups, runtime.findSession) so the tests stay in-process and exercise
 * the new pipeline deterministically via `__setDigestSendPromptForTesting`.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import type { ChatSession } from "@cognia/agent-config-types"
import {
  __setDigestSendPromptForTesting,
  installScheduledOutboundHandlers,
} from "./scheduled-outbound"
import { PiiGateBlocked } from "@/lib/connectors/ai-loop/safe-send-prompt"

// ── module mocks (hoisted) ──────────────────────────────────────────────────

const registeredExecutors = new Map<
  string,
  (
    task: unknown,
    execution: unknown,
    signal?: AbortSignal
  ) => Promise<{ success: boolean; output?: Record<string, unknown>; error?: string }>
>()

jest.mock("@/lib/scheduler/task-scheduler", () => ({
  registerTaskExecutor: jest.fn(
    (
      type: string,
      fn: (task: unknown, execution: unknown, signal?: AbortSignal) => Promise<{ success: boolean }>
    ) => {
      registeredExecutors.set(type, fn)
    }
  ),
  getTaskScheduler: jest.fn(() => ({
    triggerEventTask: jest.fn().mockResolvedValue(undefined),
  })),
}))

jest.mock("@cognia/logging", () => {
  const stub = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { loggers: { scheduler: stub, app: stub }, createLogger: () => stub }
})

const mockSession: ChatSession = {
  id: "sess_1",
  title: "Test conversation",
  kind: "direct",
  characterId: "char_001",
  platformBinding: {
    platform: "discord",
    adapterId: "adp_discord",
    conversationKey: "discord:adp_discord:ch_test",
    conversationRef: { platform: "discord", adapterId: "adp_discord", channelId: "ch_test" },
    deliveryTarget: {
      address: {
        conversationKey: "discord:adp_discord:ch_test",
        platform: "discord",
        adapterId: "adp_discord",
        scopeKind: "channel",
        containerId: "ch_test",
      },
      conversationRef: { platform: "discord", adapterId: "adp_discord", channelId: "ch_test" },
      refreshedAt: 1,
    },
  },
  createdAt: 0,
  updatedAt: 0,
}

let sessionLookup: jest.Mock = jest.fn(async (_key: string) => mockSession)
let resolveSendOptionsImpl: jest.Mock = jest.fn(async () => ({
  systemPrompt: "",
  allowedTools: [],
  mcpServers: [],
  anthropicTools: [],
  containerSkillIds: [],
}))
let getAdapterImpl: jest.Mock = jest.fn(async () => undefined)
let readOverrideImpl: jest.Mock = jest.fn(async () => undefined)
let getCharacterImpl: jest.Mock = jest.fn(async () => undefined)
// Real getSettings() returns AppSettings (never undefined; falls back to
// DEFAULTS). A stubbed active project id lets resolveScopeProjectId — used by
// enqueueOutbound — short-circuit without hitting the (unmocked) saveSettings.
let getSettingsImpl: jest.Mock = jest.fn(async () => ({ activeProjectId: "proj_test" }))
let tryBuildTwinDepsImpl: jest.Mock = jest.fn(async () => undefined)

jest.mock("./runtime", () => ({
  findSessionByConversationKey: (k: string) => sessionLookup(k),
}))
jest.mock("@/lib/claude/build-options", () => ({
  __esModule: true,
  resolveSendOptions: (opts: unknown) => resolveSendOptionsImpl(opts),
}))
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  __esModule: true,
  tryBuildTwinDeps: () => tryBuildTwinDepsImpl(),
}))
// See runtime.test.ts: memory deps are mocked so the real builder (which calls
// tryBuildTwinDeps) doesn't pollute the twin call-count assertions.
let tryBuildMemoryDepsImpl: jest.Mock = jest.fn(async () => undefined)
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  __esModule: true,
  tryBuildMemoryDeps: (...a: unknown[]) => tryBuildMemoryDepsImpl(...a),
}))
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: (id: string) => getAdapterImpl(id),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: (k: string) => readOverrideImpl(k),
}))
jest.mock("@/lib/db/characters", () => ({
  getCharacter: (id: string) => getCharacterImpl(id),
  // The real schema seed calls seedBuiltInCharacters during getDb() open; an
  // undefined export throws inside the populate hook and aborts the version
  // transaction, breaking every subsequent write (empty outboundQueue).
  seedBuiltInCharacters: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsImpl(),
}))

// A durable-queue write CAN fail on a long-lived host (closed DB during shutdown,
// quota, upgrade in flight) and both executors have to report that rather than
// claim success. The real implementation stays in place for every other test —
// only this flag diverts it — so the queue assertions elsewhere keep their teeth.
let enqueueFailure: Error | null = null
jest.mock("@/lib/db/outbound-jobs", () => {
  const actual = jest.requireActual("@/lib/db/outbound-jobs")
  return {
    ...actual,
    enqueueOutbound: (...args: unknown[]) =>
      enqueueFailure
        ? Promise.reject(enqueueFailure)
        : (actual.enqueueOutbound as (...a: unknown[]) => unknown)(...args),
  }
})

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTask(payload?: Record<string, unknown>) {
  return { id: "t1", payload }
}

function makeExecution(input?: Record<string, unknown>) {
  return { id: "e1", input }
}

async function callExecutor(type: string, task: unknown, execution: unknown) {
  const fn = registeredExecutors.get(type)
  if (!fn) throw new Error(`Executor not registered: ${type}`)
  return fn(task, execution, new AbortController().signal)
}

/** Drive an executor with an already-aborted signal (host shutting down). */
async function callExecutorAborted(type: string, task: unknown, execution: unknown) {
  const fn = registeredExecutors.get(type)
  if (!fn) throw new Error(`Executor not registered: ${type}`)
  const controller = new AbortController()
  controller.abort()
  return fn(task, execution, controller.signal)
}

// ── lifecycle ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  // fake-indexeddb persists across tests when the singleton isn't dropped;
  // delete the active DB so Dexie reopens at v38 and every test starts
  // with empty outboundQueue / connectorAudit tables.
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  registeredExecutors.clear()
  sessionLookup = jest.fn(async (_key: string) => mockSession)
  resolveSendOptionsImpl = jest.fn(async () => ({
    systemPrompt: "",
    allowedTools: [],
    mcpServers: [],
    anthropicTools: [],
    containerSkillIds: [],
  }))
  getAdapterImpl = jest.fn(async () => undefined)
  readOverrideImpl = jest.fn(async () => undefined)
  getCharacterImpl = jest.fn(async () => undefined)
  getSettingsImpl = jest.fn(async () => ({ activeProjectId: "proj_test" }))
  tryBuildTwinDepsImpl = jest.fn(async () => undefined)
  tryBuildMemoryDepsImpl = jest.fn(async () => undefined)
  enqueueFailure = null
  __setDigestSendPromptForTesting(null)
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe("installScheduledOutboundHandlers", () => {
  it("registers both executor types", () => {
    installScheduledOutboundHandlers()
    expect(registeredExecutors.has("connection:outbound:send")).toBe(true)
    expect(registeredExecutors.has("connection:scheduled:digest")).toBe(true)
  })
})

describe("connection:outbound:send executor", () => {
  beforeEach(() => installScheduledOutboundHandlers())

  it("enqueues an outbound job from execution.input", async () => {
    const conversationKey = "discord:adp_d:chat_1"
    const payload = {
      adapterId: "adp_d",
      conversationKey,
      segments: [{ type: "text", text: "hello scheduled" }],
      idempotencyKey: "idem_001",
    }
    await getDb().connectorConversationStates.put({
      conversationKey,
      adapterId: "adp_d",
      activationStatus: "inactive",
      deliveryReadiness: "unknown",
      deliveryTarget: {
        address: {
          conversationKey,
          platform: "discord",
          adapterId: "adp_d",
          scopeKind: "channel",
          containerId: "chat_1",
        },
        conversationRef: { platform: "discord", adapterId: "adp_d", channelId: "chat_1" },
        refreshedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution(payload)
    )
    expect(result.success).toBe(true)
    const jobs = await getDb()
      .outboundQueue.filter((j) => j.conversationKey === conversationKey)
      .toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].request.conversationRef.platform).toBe("discord")
  })

  // The host aborts in-flight executions on shutdown / cancel-previous. Sending
  // anyway would post a message the operator already cancelled.
  it("does not enqueue when the run was already aborted", async () => {
    const result = await callExecutorAborted(
      "connection:outbound:send",
      makeTask(),
      makeExecution({
        adapterId: "adp_d",
        conversationKey: "discord:adp_d:chat_abort",
        segments: [{ type: "text", text: "should not send" }],
      })
    )
    expect(result).toEqual({ success: false, error: "Outbound send aborted" })
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  // A scheduled send has no inbound event to resolve a target from, so a missing
  // persisted target must fail loud rather than guess a destination.
  it("fails when the conversation has no persisted delivery target", async () => {
    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution({
        adapterId: "adp_d",
        conversationKey: "discord:adp_d:chat_unknown",
        segments: [{ type: "text", text: "nowhere to go" }],
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("No persisted delivery target")
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  it("fails when the persisted target belongs to a different adapter", async () => {
    const conversationKey = "discord:adp_other:chat_2"
    await getDb().connectorConversationStates.put({
      conversationKey,
      adapterId: "adp_other",
      activationStatus: "inactive",
      deliveryReadiness: "unknown",
      deliveryTarget: {
        address: {
          conversationKey,
          platform: "discord",
          adapterId: "adp_other",
          scopeKind: "channel",
          containerId: "chat_2",
        },
        conversationRef: { platform: "discord", adapterId: "adp_other", channelId: "chat_2" },
        refreshedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution({
        adapterId: "adp_d",
        conversationKey,
        segments: [{ type: "text", text: "wrong adapter" }],
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("No persisted delivery target")
  })

  // `execution.input` is the per-run snapshot; `task.payload` is the persisted
  // configuration. A run created without an input snapshot (a manual "run now",
  // a rehydrated row) must still send, using the task's own payload.
  it("falls back to task.payload when the execution carries no input", async () => {
    const conversationKey = "discord:adp_d:chat_from_task"
    await getDb().connectorConversationStates.put({
      conversationKey,
      adapterId: "adp_d",
      activationStatus: "inactive",
      deliveryReadiness: "unknown",
      deliveryTarget: {
        address: {
          conversationKey,
          platform: "discord",
          adapterId: "adp_d",
          scopeKind: "channel",
          containerId: "chat_from_task",
        },
        conversationRef: { platform: "discord", adapterId: "adp_d", channelId: "chat_from_task" },
        refreshedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await callExecutor(
      "connection:outbound:send",
      makeTask({
        adapterId: "adp_d",
        conversationKey,
        segments: [{ type: "text", text: "from the task row" }],
      }),
      makeExecution()
    )
    expect(result.success).toBe(true)
    const [job] = await getDb()
      .outboundQueue.filter((j) => j.conversationKey === conversationKey)
      .toArray()
    // No idempotencyKey in the payload → one is generated so a retry cannot
    // double-post.
    expect(job.idempotencyKey).toMatch(/[0-9a-f-]{36}/)
  })

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["missing adapterId", { conversationKey: "k", segments: [] }],
    ["missing conversationKey", { adapterId: "a", segments: [] }],
    ["segments not an array", { adapterId: "a", conversationKey: "k", segments: "x" }],
  ])("rejects a malformed send payload (%s)", async (_label, payload) => {
    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution(payload as never)
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("Invalid connection:outbound:send payload")
  })

  // Dexie and platform SDKs can reject with a non-Error value; the executor must
  // still produce a readable reason instead of "[object Object]" or undefined.
  it("stringifies a non-Error rejection from the queue write", async () => {
    const conversationKey = "discord:adp_d:chat_weird"
    await getDb().connectorConversationStates.put({
      conversationKey,
      adapterId: "adp_d",
      activationStatus: "inactive",
      deliveryReadiness: "unknown",
      deliveryTarget: {
        address: {
          conversationKey,
          platform: "discord",
          adapterId: "adp_d",
          scopeKind: "channel",
          containerId: "chat_weird",
        },
        conversationRef: { platform: "discord", adapterId: "adp_d", channelId: "chat_weird" },
        refreshedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    })
    enqueueFailure = "plain string failure" as unknown as Error

    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution({
        adapterId: "adp_d",
        conversationKey,
        segments: [{ type: "text", text: "x" }],
      })
    )
    expect(result).toEqual({ success: false, error: "plain string failure" })
  })

  it("reports a queue-write failure instead of claiming the send succeeded", async () => {
    const conversationKey = "discord:adp_d:chat_fail"
    await getDb().connectorConversationStates.put({
      conversationKey,
      adapterId: "adp_d",
      activationStatus: "inactive",
      deliveryReadiness: "unknown",
      deliveryTarget: {
        address: {
          conversationKey,
          platform: "discord",
          adapterId: "adp_d",
          scopeKind: "channel",
          containerId: "chat_fail",
        },
        conversationRef: { platform: "discord", adapterId: "adp_d", channelId: "chat_fail" },
        refreshedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    })
    enqueueFailure = new Error("database is closed")

    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution({
        adapterId: "adp_d",
        conversationKey,
        segments: [{ type: "text", text: "never queued" }],
      })
    )
    expect(result).toEqual({ success: false, error: "database is closed" })
  })

  it("derives platform from the conversationKey (not hardcoded telegram)", async () => {
    await getDb().connectorConversationStates.put({
      conversationKey: "slack:adp_sl:ch_xyz",
      adapterId: "adp_sl",
      activationStatus: "inactive",
      deliveryReadiness: "unknown",
      deliveryTarget: {
        address: {
          conversationKey: "slack:adp_sl:ch_xyz",
          platform: "slack",
          adapterId: "adp_sl",
          scopeKind: "channel",
          containerId: "ch_xyz",
        },
        conversationRef: { platform: "slack", adapterId: "adp_sl", channelId: "ch_xyz" },
        refreshedAt: 1,
      },
      createdAt: 1,
      updatedAt: 1,
    })
    await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution({
        adapterId: "adp_sl",
        conversationKey: "slack:adp_sl:ch_xyz",
        segments: [{ type: "text", text: "x" }],
      })
    )
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs[0].request.conversationRef.platform).toBe("slack")
  })

  it("returns error for invalid payload", async () => {
    const result = await callExecutor(
      "connection:outbound:send",
      makeTask(),
      makeExecution({ wrong: "field" })
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid/)
  })
})

describe("connection:scheduled:digest executor — full AI loop", () => {
  beforeEach(() => installScheduledOutboundHandlers())

  it("drives sendPrompt with resolveSendOptions and enqueues the projected segments", async () => {
    const digestSender = jest.fn(async () => ({
      text: "Hello from the model.",
      messageId: "msg-001",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    }))
    __setDigestSendPromptForTesting(digestSender as never)

    const payload = {
      adapterId: "adp_discord",
      conversationKey: "discord:adp_discord:ch_test",
      characterId: "char_001",
      prompt: "Give me the daily summary",
    }
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution(payload)
    )
    expect(result.success).toBe(true)
    expect(result.output?.assistantMessageId).toBe("msg-001")

    // sendPrompt called with session id + safe-send context
    expect(digestSender).toHaveBeenCalledWith(
      "sess_1",
      "Give me the daily summary",
      expect.any(Object),
      { adapterId: "adp_discord", conversationKey: "discord:adp_discord:ch_test" }
    )

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].request.segments).toEqual([{ type: "markdown", md: "Hello from the model." }])
    expect(jobs[0].idempotencyKey).toBe("airun:msg-001")
  })

  it("does not run the AI turn when the execution was already aborted", async () => {
    const digestSender = jest.fn()
    __setDigestSendPromptForTesting(digestSender as never)
    const result = await callExecutorAborted(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "Give me the daily summary",
      })
    )
    expect(result).toEqual({ success: false, error: "Scheduled digest aborted" })
    expect(digestSender).not.toHaveBeenCalled()
  })

  // The turn already cost tokens by this point, so a target mismatch here is worth
  // reporting distinctly from the pre-turn checks.
  it("fails after the turn when the session has no usable delivery target", async () => {
    sessionLookup = jest.fn(async () => ({
      ...mockSession,
      platformBinding: { ...mockSession.platformBinding, deliveryTarget: undefined },
    }))
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "text",
        messageId: "msg-no-target",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )

    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "Give me the daily summary",
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("no persisted delivery target")
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  it("falls back to task.payload when the execution carries no input", async () => {
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "from the task row",
        messageId: "msg-task-payload",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "Give me the daily summary",
      }),
      makeExecution()
    )
    expect(result.success).toBe(true)
    expect(result.output?.assistantMessageId).toBe("msg-task-payload")
  })

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["missing characterId", { adapterId: "a", conversationKey: "k", prompt: "p" }],
    ["missing prompt", { adapterId: "a", conversationKey: "k", characterId: "c" }],
    ["missing conversationKey", { adapterId: "a", characterId: "c", prompt: "p" }],
    ["missing adapterId", { conversationKey: "k", characterId: "c", prompt: "p" }],
  ])("rejects a malformed digest payload (%s)", async (_label, payload) => {
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution(payload as never)
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain("Invalid connection:scheduled:digest payload")
  })

  it("stringifies a non-Error rejection from the AI turn", async () => {
    __setDigestSendPromptForTesting(
      jest.fn(async () => {
        throw "sidecar vanished"
      }) as never
    )
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "Give me the daily summary",
      })
    )
    expect(result).toEqual({ success: false, error: "sidecar vanished" })
  })

  it("reports a queue-write failure after a successful turn", async () => {
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "text the operator will never see",
        messageId: "msg-queue-fail",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )
    enqueueFailure = new Error("quota exceeded")

    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "Give me the daily summary",
      })
    )
    expect(result).toEqual({ success: false, error: "quota exceeded" })
  })

  it.each([
    ["muted", "inbound.deferred_muted"],
    ["manual_mode", "inbound.deferred_manual_mode"],
  ])("audits %s suppression with its own kind", async (reason, expectedKind) => {
    resolveSendOptionsImpl = jest.fn(async () => ({
      systemPrompt: "",
      allowedTools: [],
      mcpServers: [],
      anthropicTools: [],
      containerSkillIds: [],
      suppressedReason: reason,
    }))
    const digestSender = jest.fn()
    __setDigestSendPromptForTesting(digestSender as never)

    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "Give me the daily summary",
      })
    )
    // Suppression is a success: policy was honoured, nothing was sent.
    expect(result).toEqual({ success: true, output: { suppressed: reason } })
    expect(digestSender).not.toHaveBeenCalled()
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.map((a) => a.kind)).toContain(expectedKind)
  })

  // An empty prompt cannot ground anything, so the twin/memory builders are
  // skipped rather than paying for a recall that has no query.
  it("skips the twin and memory handshakes for a blank prompt", async () => {
    getCharacterImpl = jest.fn(async () => ({ id: "char_001", twinId: "twin_1" }))
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "ok",
        messageId: "msg-blank",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )

    await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "   ",
      })
    )
    expect(tryBuildTwinDepsImpl).not.toHaveBeenCalled()
    expect(tryBuildMemoryDepsImpl).not.toHaveBeenCalled()
  })

  // A digest that fired from a missed slot must say so: landing at 09:12 without
  // a note reads as the 09:12 state. See `lib/scheduler/catchup-policy.ts`.
  describe("late (catch-up) delivery", () => {
    const payload = {
      adapterId: "adp_discord",
      conversationKey: "discord:adp_discord:ch_test",
      characterId: "char_001",
      prompt: "Give me the daily summary",
    }

    beforeEach(() => {
      __setDigestSendPromptForTesting(
        jest.fn(async () => ({
          text: "Hello from the model.",
          messageId: "msg-late",
          a2uiSurfaces: {},
          a2uiSurfaceOrder: [],
        })) as never
      )
    })

    it("prefixes a delayed note naming the slot it was scheduled for", async () => {
      const result = await callExecutor("connection:scheduled:digest", makeTask(), {
        ...makeExecution(payload),
        triggerSource: "catch-up",
        scheduledFor: new Date("2026-07-30T09:00:00.000Z"),
      })
      expect(result.success).toBe(true)

      const [job] = await getDb().outboundQueue.toArray()
      const md = (job.request.segments[0] as { md: string }).md
      expect(md).toContain("Delayed")
      expect(md).toMatch(/7\/30\/26/)
      // The model's own text is preserved, not replaced.
      expect(md).toContain("Hello from the model.")
    })

    it("labels a backfilled run the same way", async () => {
      await callExecutor("connection:scheduled:digest", makeTask(), {
        ...makeExecution(payload),
        triggerSource: "backfill",
        scheduledFor: new Date("2026-07-30T09:00:00.000Z"),
      })
      const [job] = await getDb().outboundQueue.toArray()
      expect((job.request.segments[0] as { md: string }).md).toContain("Delayed")
    })

    it("leaves an on-time run unlabelled", async () => {
      await callExecutor("connection:scheduled:digest", makeTask(), {
        ...makeExecution(payload),
        triggerSource: "schedule",
        scheduledFor: new Date("2026-07-30T09:00:00.000Z"),
      })
      const [job] = await getDb().outboundQueue.toArray()
      expect((job.request.segments[0] as { md: string }).md).toBe("Hello from the model.")
    })

    // Without a slot there is nothing honest to claim, so no note is added even
    // though the trigger source says the run was late.
    it("skips the note when the execution carries no scheduled slot", async () => {
      await callExecutor("connection:scheduled:digest", makeTask(), {
        ...makeExecution(payload),
        triggerSource: "catch-up",
      })
      const [job] = await getDb().outboundQueue.toArray()
      expect((job.request.segments[0] as { md: string }).md).toBe("Hello from the model.")
    })

    it("localises the note from AppSettings", async () => {
      getSettingsImpl = jest.fn(async () => ({ activeProjectId: "proj_test", language: "zh-CN" }))
      await callExecutor("connection:scheduled:digest", makeTask(), {
        ...makeExecution(payload),
        triggerSource: "catch-up",
        scheduledFor: new Date("2026-07-30T09:00:00.000Z"),
      })
      const [job] = await getDb().outboundQueue.toArray()
      expect((job.request.segments[0] as { md: string }).md).toContain("延迟送达")
    })
  })

  it("projects A2UI surfaces alongside text", async () => {
    const surface = {
      components: {
        root: { id: "root", component: "Card", title: "Daily", children: [] },
      },
      dataModel: {},
      rootId: "root",
    }
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "Open the card for details.",
        messageId: "msg-with-surface",
        a2uiSurfaces: { sfc1: surface },
        a2uiSurfaceOrder: ["sfc1"],
      })) as never
    )
    await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "x",
      })
    )
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs[0].request.segments.map((s) => s.type)).toEqual(["a2ui", "markdown"])
    const a2ui = jobs[0].request.segments[0] as { surfaceId: string; plainTextMirror: string }
    expect(a2ui.surfaceId).toBe("sfc1")
    expect(a2ui.plainTextMirror).toBe("# Daily")
  })

  it("fails loud when no ChatSession is bound to the conversationKey", async () => {
    sessionLookup = jest.fn(async () => undefined)
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_unbound",
        characterId: "char_001",
        prompt: "x",
      })
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No ChatSession/)
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.reason === "session_missing")).toBe(true)
  })

  it("honours the suppression gate from resolveSendOptions and skips sendPrompt", async () => {
    resolveSendOptionsImpl = jest.fn(async () => ({
      systemPrompt: "",
      allowedTools: [],
      mcpServers: [],
      anthropicTools: [],
      containerSkillIds: [],
      suppressedReason: "quiet_hours",
    }))
    const digestSender = jest.fn()
    __setDigestSendPromptForTesting(digestSender as never)

    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "x",
      })
    )
    expect(result.success).toBe(true)
    expect(result.output?.suppressed).toBe("quiet_hours")
    expect(digestSender).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "inbound.deferred_quiet_hours")).toBe(true)
  })

  it("prefers the per-conversation override's quietHours over the adapter default", async () => {
    getAdapterImpl = jest.fn(async () => ({
      quietHours: { from: "22:00", to: "06:00", tz: "UTC" },
    }))
    readOverrideImpl = jest.fn(async () => ({
      quietHours: { from: "12:00", to: "13:00", tz: "UTC" },
    }))
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "ok",
        messageId: "m",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )

    await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "x",
      })
    )

    expect(resolveSendOptionsImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxPolicy: expect.objectContaining({
          quietHours: { from: "12:00", to: "13:00", tz: "UTC" },
        }),
      })
    )
  })

  it("falls back to the adapter's quietHours when there is no override", async () => {
    getAdapterImpl = jest.fn(async () => ({
      quietHours: { from: "22:00", to: "06:00", tz: "UTC" },
    }))
    readOverrideImpl = jest.fn(async () => undefined)
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "ok",
        messageId: "m",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )

    await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "x",
      })
    )

    expect(resolveSendOptionsImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxPolicy: expect.objectContaining({
          quietHours: { from: "22:00", to: "06:00", tz: "UTC" },
        }),
      })
    )
  })

  it("audits + fails when the PII gate blocks the prompt", async () => {
    __setDigestSendPromptForTesting(
      jest.fn(async () => {
        throw new PiiGateBlocked("prompt", "adp_discord", "discord:adp_discord:ch_test")
      }) as never
    )
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "leak: user@example.com",
      })
    )
    expect(result.success).toBe(false)
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.reason === "pii_blocked")).toBe(true)
  })

  it("returns error for invalid digest payload", async () => {
    const result = await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({ adapterId: "a" })
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid/)
  })

  it("injects twin deps into resolveSendOptions when the character is twin-bound", async () => {
    getCharacterImpl = jest.fn(async () => ({ id: "char_001", name: "Twinned", twinId: "twin_42" }))
    const twinDeps = { store: {}, embedding: {}, vectorBackend: "native" }
    tryBuildTwinDepsImpl = jest.fn(async () => twinDeps)
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "ok",
        messageId: "m",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )

    await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "summarise",
      })
    )

    expect(tryBuildTwinDepsImpl).toHaveBeenCalledTimes(1)
    expect(resolveSendOptionsImpl).toHaveBeenCalledWith(
      expect.objectContaining({ twinDeps, twinUserMessage: "summarise" })
    )
  })

  it("skips the twin lookup when the character has no twinId", async () => {
    getCharacterImpl = jest.fn(async () => ({ id: "char_001", name: "Plain" }))
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "ok",
        messageId: "m",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )

    await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "summarise",
      })
    )

    expect(tryBuildTwinDepsImpl).not.toHaveBeenCalled()
    expect(resolveSendOptionsImpl).toHaveBeenCalledWith(
      expect.objectContaining({ twinDeps: undefined, twinUserMessage: undefined })
    )
  })

  it("injects memory recall deps into resolveSendOptions (parity with direct chat)", async () => {
    getCharacterImpl = jest.fn(async () => ({ id: "char_001", name: "Plain" }))
    const memoryDeps = { loadCandidates: jest.fn(), loadProcedural: jest.fn(), touch: jest.fn() }
    tryBuildMemoryDepsImpl = jest.fn(async () => memoryDeps)
    __setDigestSendPromptForTesting(
      jest.fn(async () => ({
        text: "ok",
        messageId: "m",
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      })) as never
    )

    await callExecutor(
      "connection:scheduled:digest",
      makeTask(),
      makeExecution({
        adapterId: "adp_discord",
        conversationKey: "discord:adp_discord:ch_test",
        characterId: "char_001",
        prompt: "summarise",
      })
    )

    expect(tryBuildMemoryDepsImpl).toHaveBeenCalledTimes(1)
    expect(resolveSendOptionsImpl).toHaveBeenCalledWith(
      expect.objectContaining({ memoryDeps, memoryUserMessage: "summarise" })
    )
  })
})
