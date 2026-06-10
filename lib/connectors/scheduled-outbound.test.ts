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
import type { ChatSession } from "@/lib/claude/types"
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

jest.mock("@/lib/logging", () => {
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
let getSettingsImpl: jest.Mock = jest.fn(async () => undefined)
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
jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: (id: string) => getAdapterImpl(id),
}))
jest.mock("@/lib/db/conversation-overrides", () => ({
  readForResolution: (k: string) => readOverrideImpl(k),
}))
jest.mock("@/lib/db/characters", () => ({
  getCharacter: (id: string) => getCharacterImpl(id),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: () => getSettingsImpl(),
}))

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
  getSettingsImpl = jest.fn(async () => undefined)
  tryBuildTwinDepsImpl = jest.fn(async () => undefined)
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

  it("derives platform from the conversationKey (not hardcoded telegram)", async () => {
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
})
