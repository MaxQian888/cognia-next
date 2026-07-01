/**
 * Tests for lib/connectors/runtime.ts — Task 37 + IM completion §A.
 *
 * Verifies that installRuntime wires the bus routeHandler correctly for all
 * 5 route decisions plus the new suppression / capture branches:
 *   - "ai-run" (happy path)  → ChatSession + StoredMessage + runAndCapture
 *                              invoked → outbound job with REAL assistant
 *                              text + outbound.ai_run_enqueued audit.
 *   - "ai-run" (suppressed)  → no runAndCapture call, no outbound enqueue,
 *                              an `inbound.deferred_*` audit row.
 *   - "ai-run" (capture err) → no outbound enqueue, an `adapter.error`
 *                              audit row.
 *   - "manual-store"         → ChatSession + StoredMessage, no outbound.
 *   - "draft-prepare"        → ChatSession + StoredMessage + draft row.
 *   - "store-only"           → ChatSession + StoredMessage, no outbound / draft.
 *   - "drop"                 → nothing inserted.
 *
 * Also verifies session reuse across events with the same conversationKey
 * and that edit / delete / system events short-circuit through the bus
 * (the runtime's defensive `kind` guard).
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance, getAdapterInstance } from "@/lib/db/adapter-instances"
import { upsertByConversationKey, readForResolution } from "@/lib/db/conversation-overrides"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { installRuntime, inboundEventToSendContent, type RunAndCaptureFn } from "./runtime"
import { getBus, __resetBusForTesting } from "./bus"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"

// Twin runtime deps loader is mocked so the ai-run path can be probed for the
// twin handshake without standing up a real vector store. Returns undefined by
// default (= twin runtime disabled), matching production when unconfigured.
let tryBuildTwinDepsImpl: jest.Mock = jest.fn(async () => undefined)
jest.mock("@/lib/twin/runtime/build-deps", () => ({
  __esModule: true,
  tryBuildTwinDeps: () => tryBuildTwinDepsImpl(),
}))

// Memory read-deps are mocked so the connector tests stay focused: the real
// builder transitively calls tryBuildTwinDeps, which would pollute the twin
// call-count assertions. Default → no backend (memory recall is a no-op).
let tryBuildMemoryDepsImpl: jest.Mock = jest.fn(async () => undefined)
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  __esModule: true,
  tryBuildMemoryDeps: (...a: unknown[]) => tryBuildMemoryDepsImpl(...a),
}))

// Team dispatch is mocked so the team-branch can be probed without importing
// the heavy Agent-Team graph. Returns `started: true` by default.
const mockStartTeamRunFromIM = jest.fn(async (..._args: unknown[]) => ({ started: true as const }))
jest.mock("./team-dispatch", () => ({
  __esModule: true,
  startTeamRunFromIM: (...args: unknown[]) => mockStartTeamRunFromIM(...(args as [])),
}))

// Workflow dispatch is mocked so the workflow-branch can be probed without
// importing the heavy orchestrator. Returns `{ ok: true }` by default.
const mockStartWorkflowFromIM = jest.fn(async (..._args: unknown[]) => ({
  ok: true as const,
  runId: "run_x",
}))
jest.mock("@/lib/workflow/runtime/start-from-im", () => ({
  __esModule: true,
  startWorkflowFromIM: (...args: unknown[]) => mockStartWorkflowFromIM(...(args as [])),
}))

// Plugin IM rate-source gate is mocked so the rate-block branch can be probed.
// Default: null (no block) so every other ai-run test is unaffected.
const mockEvaluateImRate = jest.fn(async () => null as unknown)
jest.mock("@/lib/connectors/im-rate/registry", () => ({
  __esModule: true,
  evaluateImRate: (...args: unknown[]) => mockEvaluateImRate(...(args as [])),
}))

// Spy on the agent-trace root-span close while keeping the rest of the emitter
// real (resolveSendOptions still mints a real root span via startSpan).
jest.mock("@cognia/agent-trace/emitter", () => ({
  ...jest.requireActual("@cognia/agent-trace/emitter"),
  endSpan: jest.fn(),
}))
import { endSpan as endSpanImport } from "@cognia/agent-trace/emitter"
const endSpanMock = endSpanImport as jest.Mock

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<NormalizedInboundEvent> & { conversationKey?: string }
): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId: "adapter_1",
    selfId: "bot_1",
    messageId: overrides.messageId ?? crypto.randomUUID(),
    conversationRef: { platform: "telegram", adapterId: "adapter_1" },
    conversationKey: overrides.conversationKey ?? "telegram:adapter_1:chat_42",
    sender: {
      id: "u_alice",
      platform: "telegram",
      adapterId: "adapter_1",
      remoteUserId: "u_alice",
      displayName: "Alice",
    },
    channel: { id: "ch_42", name: "Direct with Alice", kind: "private" },
    segments: [{ type: "text", text: "hello runtime" }],
    plainText: "hello runtime",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  }
}

const RESOLVED: ResolvedBinding = {
  mode: "auto",
  characterId: "char_abc",
  trigger: {
    rules: [{ kind: "private-default" }],
    blockers: [],
    storeUnmatchedInDraftMode: false,
  },
}

/**
 * Invoke the bus routeHandler directly (bypasses the full bus pipeline so we
 * don't need to seed the dedup ledger). Adapter rows ARE created where the
 * test needs them so the runtime's inboxPolicy lookup has data to read.
 */
async function callHandler(
  event: NormalizedInboundEvent,
  decision: RouteDecision,
  resolved: ResolvedBinding = RESOLVED
): Promise<void> {
  const bus = getBus()
  if (!bus.routeHandler) throw new Error("routeHandler not installed")
  // Mirror the bus: it fetches the adapter + override rows once and threads
  // them into the handler. Read the seeded rows here so the inboxPolicy /
  // team / workflow branches still exercise their inputs. The bus guarantees a
  // non-null adapter row before calling the handler (it returns early on a
  // missing adapter), so synthesize a minimal one when a test didn't seed one.
  const adapterRow =
    (await getAdapterInstance(event.adapterId)) ?? ({ id: event.adapterId } as AdapterInstanceRow)
  const override = (await readForResolution(event.conversationKey)) ?? null
  await bus.routeHandler(event, decision, resolved, override, adapterRow)
}

/**
 * Seed an adapter row matching the event's adapterId so the runtime's
 * inboxPolicy lookup picks up `quietHours` / `muted` defaults.
 */
async function seedAdapter(
  adapterId: string,
  patch: Partial<{ quietHours?: { from: string; to: string; tz: string }; muted?: boolean }> = {}
): Promise<void> {
  await createAdapterInstance({
    type: "telegram",
    displayName: "test",
    enabled: true,
    transportMode: "long-poll",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    ...patch,
  } as unknown as Parameters<typeof createAdapterInstance>[0])
  // The DB row's id is auto-generated. Tests that need a specific id
  // override the row directly:
  await getDb()
    .adapterInstances.toCollection()
    .modify((r) => {
      r.id = adapterId
    })
}

const DEFAULT_RUN_AND_CAPTURE: RunAndCaptureFn = jest.fn(async () => ({
  text: "Hello back from Claude!",
  messageId: "uuid-asst-1",
}))

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  const bus = getBus()
  mockEvaluateImRate.mockReset()
  mockEvaluateImRate.mockResolvedValue(null)
  ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockClear()
  ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockResolvedValue({
    text: "Hello back from Claude!",
    messageId: "uuid-asst-1",
  })
  tryBuildTwinDepsImpl = jest.fn(async () => undefined)
  tryBuildMemoryDepsImpl = jest.fn(async () => undefined)
  endSpanMock.mockClear()
  installRuntime(bus, { runAndCapture: DEFAULT_RUN_AND_CAPTURE })
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe("installRuntime — ai-run (happy path)", () => {
  it("creates a ChatSession with platformBinding", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].platformBinding?.conversationKey).toBe("telegram:adapter_1:chat_ai")
    expect(sessions[0].platformBinding?.platform).toBe("telegram")
    expect(sessions[0].characterId).toBe("char_abc")
  })

  it("inserts a user StoredMessage with platformMessage metadata", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_ai",
      messageId: "msg_ai_1",
    })
    await callHandler(event, "ai-run")

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")
    expect(messages[0].metadata?.platformMessage?.messageId).toBe("msg_ai_1")
    expect(messages[0].metadata?.platformMessage?.platform).toBe("telegram")
  })

  it("invokes runAndCapture with the session id and event content", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
    const [sessionId, content] = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0]
    expect(typeof sessionId).toBe("string")
    expect(sessionId.length).toBeGreaterThan(0)
    expect(content).toBe("hello runtime")
  })

  it("wires a HITL onPermissionRequest responder + raised timeout into the capture options", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const cap = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][3] as {
      onPermissionRequest?: unknown
      timeoutMs?: number
    }
    expect(typeof cap.onPermissionRequest).toBe("function")
    expect(cap.timeoutMs).toBeGreaterThan(5 * 60 * 1000)
  })

  it("enqueues an outbound job with the captured assistant text projected as markdown", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adapter_1")
    expect(jobs[0].status).toBe("pending")
    // G2 reroutes captured text through `assistantReplyToSegments`,
    // which emits a `markdown` segment (preserves rich-text intent;
    // adapters degrade via `defaultDegradeChain("markdown") → ["markdown", "text"]`).
    expect(jobs[0].request.segments[0]).toMatchObject({
      type: "markdown",
      md: "Hello back from Claude!",
    })
  })

  it("uses the captured messageId as the outbound idempotency key", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs[0].idempotencyKey).toBe("airun:uuid-asst-1")
  })

  it("writes an outbound.ai_run_enqueued audit entry with the message id", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const audits = await getDb().connectorAudit.toArray()
    const aiRunAudits = audits.filter((a) => a.kind === "outbound.ai_run_enqueued")
    expect(aiRunAudits).toHaveLength(1)
    expect(aiRunAudits[0].message).toBe("uuid-asst-1")
    expect(aiRunAudits[0].idempotencyKey).toBe("airun:uuid-asst-1")
  })
})

describe("installRuntime — ai-run (streamReply weaving)", () => {
  it("passes onPartial to runAndCapture when the target adapter implements streamReply", async () => {
    const streamReply = jest.fn(async () => undefined)
    // A capture mock that drives two partial chunks through cap.onPartial,
    // mirroring how runAndCaptureAssistantReply fires it during a turn.
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _content, _opts, cap) => {
      await cap?.onPartial?.("partial one")
      await cap?.onPartial?.("partial one two")
      return { text: "final text", messageId: "uuid-stream-1" }
    })
    __resetBusForTesting()
    const bus = getBus()
    installRuntime(bus, { runAndCapture: capturing })
    // Register a stub adapter for the event's adapterId so the runtime
    // detects the streamReply capability.
    bus.registerAdapter({
      id: "adapter_1",
      get meta() {
        return {
          type: "telegram" as const,
          displayName: "stub",
          version: "0",
          capabilities: [],
          transportModes: ["stub" as const],
          configSchema: {},
        }
      },
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ state: "running" as const }),
      send: async () => ({ ok: true }),
      streamReply,
      a2uiCapability: () => ({}) as never,
    })

    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_stream",
      conversationRef: { platform: "telegram", adapterId: "adapter_1", chatId: "c1" },
    })
    await callHandler(event, "ai-run")

    // onPartial fired twice → streamReply called twice with the growing text.
    expect(streamReply).toHaveBeenCalledTimes(2)
    expect(streamReply).toHaveBeenNthCalledWith(1, {
      conversationRef: event.conversationRef,
      text: "partial one",
    })
    expect(streamReply).toHaveBeenNthCalledWith(2, {
      conversationRef: event.conversationRef,
      text: "partial one two",
    })
    // Final authoritative message still enqueued for durable delivery.
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].idempotencyKey).toBe("airun:uuid-stream-1")
  })

  it("does not pass onPartial when the adapter has no streamReply (but still wires HITL)", async () => {
    let receivedCap: { onPartial?: unknown; onPermissionRequest?: unknown } | undefined
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _content, _opts, cap) => {
      receivedCap = cap as typeof receivedCap
      return { text: "final", messageId: "uuid-nostream" }
    })
    __resetBusForTesting()
    const bus = getBus()
    installRuntime(bus, { runAndCapture: capturing })
    // No adapter registered for adapter_1 → getAdapter returns undefined.
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_nostream" })
    await callHandler(event, "ai-run")
    // cap is always defined now (HITL responder), but onPartial is absent
    // without a streaming adapter.
    expect(receivedCap?.onPartial).toBeUndefined()
    expect(typeof receivedCap?.onPermissionRequest).toBe("function")
  })
})

describe("installRuntime — ai-run (live-activity card wiring)", () => {
  it("omits onEvent when liveActivity override is false", async () => {
    let receivedCap: { onEvent?: unknown } | undefined
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _content, _opts, cap) => {
      receivedCap = cap as typeof receivedCap
      return { text: "final", messageId: "uuid-noactivity" }
    })
    __resetBusForTesting()
    const bus = getBus()
    installRuntime(bus, { runAndCapture: capturing })
    bus.registerAdapter({
      id: "adapter_1",
      get meta() {
        return {
          type: "telegram" as const,
          displayName: "stub",
          version: "0",
          capabilities: [],
          transportModes: ["stub" as const],
          configSchema: {},
        }
      },
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ state: "running" as const }),
      send: async () => ({ ok: true }),
      edit: jest.fn(async () => ({ ok: true })),
      a2uiCapability: () => ({}) as never,
    })
    await upsertByConversationKey({
      conversationKey: "telegram:adapter_1:chat_liveoff",
      sessionId: "ses_placeholder",
      liveActivity: false,
    })
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_liveoff" })
    await callHandler(event, "ai-run")
    expect(receivedCap?.onEvent).toBeUndefined()
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.filter((a) => a.kind === "activity.card_dispatched")).toHaveLength(0)
  })

  it("appends progress lines (no cumulative card) when the adapter has no edit()", async () => {
    let receivedCap: { onEvent?: unknown } | undefined
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _content, _opts, cap) => {
      receivedCap = cap as typeof receivedCap
      // Fire a tool-call event as the real capture loop would.
      await cap?.onEvent?.({ type: "tool-call", toolName: "bash", input: {} })
      return { text: "final", messageId: "uuid-append" }
    })
    __resetBusForTesting()
    const bus = getBus()
    installRuntime(bus, { runAndCapture: capturing })
    // No edit() on the adapter (none registered) → APPEND mode (workflow⇄IM
    // visibility parity): one compact progress line per boundary, NOT the
    // cumulative card.
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_append" })
    await callHandler(event, "ai-run")
    expect(typeof receivedCap?.onEvent).toBe("function")
    const audits = await getDb().connectorAudit.toArray()
    // Append mode emits card_appended, never the cumulative card_dispatched.
    expect(audits.filter((a) => a.kind === "activity.card_dispatched")).toHaveLength(0)
    expect(audits.some((a) => a.kind === "activity.card_appended")).toBe(true)
    // The append lines go through the outbound queue with an `activity:…:append:` key.
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs.some((j) => j.request.metadata?.idempotencyKey?.includes(":append:"))).toBe(true)
  })

  it("dispatches a live-activity card when an edit-capable adapter fires tool-call events", async () => {
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _content, _opts, cap) => {
      await cap?.onEvent?.({ type: "tool-call", toolName: "bash", input: {} })
      return { text: "final", messageId: "uuid-activity" }
    })
    __resetBusForTesting()
    const bus = getBus()
    installRuntime(bus, { runAndCapture: capturing })
    bus.registerAdapter({
      id: "adapter_1",
      get meta() {
        return {
          type: "telegram" as const,
          displayName: "stub",
          version: "0",
          capabilities: [],
          transportModes: ["stub" as const],
          configSchema: {},
        }
      },
      start: async () => undefined,
      stop: async () => undefined,
      health: () => ({ state: "running" as const }),
      send: async () => ({ ok: true }),
      edit: jest.fn(async () => ({ ok: true })),
      a2uiCapability: () => ({}) as never,
    })
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_activity" })
    await callHandler(event, "ai-run")
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.filter((a) => a.kind === "activity.card_dispatched")).toHaveLength(1)
    const jobs = await getDb().outboundQueue.toArray()
    // At least one activity card job (the entry frame) plus the final reply.
    const activityJobs = jobs.filter(
      (j) =>
        typeof j.request.metadata?.idempotencyKey === "string" &&
        (j.request.metadata.idempotencyKey as string).startsWith("activity:")
    )
    expect(activityJobs.length).toBeGreaterThanOrEqual(1)
    expect(activityJobs[0].request.segments[0]).toMatchObject({ type: "a2ui" })
  })
})

describe("installRuntime — ai-run (twin injection)", () => {
  it("builds twin deps when the bound character is twin-bound", async () => {
    await getDb().characters.put({ id: "char_abc", name: "Twinned", twinId: "twin_1" } as never)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_twin" })
    await callHandler(event, "ai-run")
    expect(tryBuildTwinDepsImpl).toHaveBeenCalledTimes(1)
  })

  it("skips the twin lookup when the bound character has no twinId", async () => {
    await getDb().characters.put({ id: "char_abc", name: "Plain" } as never)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_notwin" })
    await callHandler(event, "ai-run")
    expect(tryBuildTwinDepsImpl).not.toHaveBeenCalled()
  })

  it("builds memory recall deps for the inbound turn (parity with direct chat)", async () => {
    // Memory is character-agnostic (global store), so it is built even for a
    // non-twin character — this is the connector↔direct recall parity fix.
    await getDb().characters.put({ id: "char_abc", name: "Plain" } as never)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_mem" })
    await callHandler(event, "ai-run")
    expect(tryBuildMemoryDepsImpl).toHaveBeenCalledTimes(1)
  })
})

describe("installRuntime — ai-run (suppression gate)", () => {
  it("skips capture + enqueue and writes inbound.deferred_muted when adapter is muted", async () => {
    await seedAdapter("adapter_muted", { muted: true })
    const event = makeEvent({
      adapterId: "adapter_muted",
      conversationKey: "telegram:adapter_muted:chat_x",
      conversationRef: { platform: "telegram", adapterId: "adapter_muted" },
    })
    await callHandler(event, "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.some((a) => a.kind === "inbound.deferred_muted")).toBe(true)
  })

  it("skips capture and writes inbound.deferred_manual_mode when override mode is manual", async () => {
    await upsertByConversationKey({
      conversationKey: "telegram:adapter_1:chat_manual_override",
      sessionId: "ses_placeholder",
      mode: "manual",
    })
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_manual_override",
    })
    await callHandler(event, "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.some((a) => a.kind === "inbound.deferred_manual_mode")).toBe(true)
  })
})

describe("installRuntime — ai-run (capture failure)", () => {
  it("writes an adapter.error audit and skips outbound enqueue when runAndCapture rejects", async () => {
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(new Error("sidecar died"))
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_err" })
    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    // No AI-reply job is enqueued. (A failed turn MAY emit a single
    // activity-card terminal line on a no-edit adapter — append mode — so we
    // assert there's no NON-activity outbound, not zero outbound.)
    const nonActivity = jobs.filter(
      (j) => !j.request.metadata?.idempotencyKey?.startsWith("activity:")
    )
    expect(nonActivity).toHaveLength(0)
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.some((a) => a.kind === "outbound.ai_run_enqueued")).toBe(false)
    const errAudits = audits.filter((a) => a.kind === "adapter.error")
    expect(errAudits).toHaveLength(1)
    expect(errAudits[0].reason).toBe("ai_run_capture_failed")
    expect(errAudits[0].message).toContain("sidecar died")
  })
})

describe("installRuntime — ai-run (plugin IM rate-source gate)", () => {
  it("suppresses the turn and audits plugin.rate_blocked when a source blocks", async () => {
    mockEvaluateImRate.mockResolvedValueOnce({ reason: "cap_hit", key: "tg:rate" })
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_rate" })
    await callHandler(event, "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    expect(await getDb().outboundQueue.count()).toBe(0)
    const audits = await getDb().connectorAudit.toArray()
    const blocked = audits.find((a) => a.kind === "plugin.rate_blocked")
    expect(blocked?.reason).toBe("cap_hit")
    expect(blocked?.fields?.key).toBe("tg:rate")
  })

  it("proceeds normally when no source blocks (default)", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_norate" })
    await callHandler(event, "ai-run")
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
  })
})

describe("installRuntime — ai-run (team dispatch branch)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { upsertByConversationKey } = require("@/lib/db/conversation-overrides")

  beforeEach(() => {
    mockStartTeamRunFromIM.mockClear()
    mockStartTeamRunFromIM.mockResolvedValue({ started: true })
    mockStartWorkflowFromIM.mockClear()
    mockStartWorkflowFromIM.mockResolvedValue({ ok: true, runId: "run_x" })
  })

  it("routes to the team runtime (not runAndCapture) when the conversation has a teamId", async () => {
    const key = "telegram:adapter_1:chat_team"
    await seedAdapter("adapter_1")
    const event = makeEvent({ conversationKey: key })
    // Create a session first so the override has a valid sessionId link.
    const session = { id: "s_team", platformConversationKey: key } as never
    await getDb().sessions.add({
      id: "s_team",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    void session
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_team", teamId: "team_r" })

    await callHandler(event, "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    expect(mockStartTeamRunFromIM).toHaveBeenCalledTimes(1)
    const arg = mockStartTeamRunFromIM.mock.calls[0][0] as unknown as {
      teamId: string
      goal: string
      conversationKey: string
    }
    expect(arg.teamId).toBe("team_r")
    expect(arg.goal).toBe("hello runtime")
    expect(arg.conversationKey).toBe(key)

    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "team.dispatched")).toBe(true)
    // No outbound enqueue from the runtime — the progress-runner owns fan-out.
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  it("writes adapter.error when team dispatch reports a failure", async () => {
    const key = "telegram:adapter_1:chat_team_fail"
    await seedAdapter("adapter_1")
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)
    await getDb().sessions.add({
      id: "s_team2",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_team2", teamId: "ghost" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "adapter.error" && r.reason === "team_not_found")).toBe(
      true
    )
  })

  it("routes to the workflow orchestrator when the conversation has a workflowId", async () => {
    const key = "telegram:adapter_1:chat_wf"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_wf",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_wf", workflowId: "wf_n" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    expect(mockStartWorkflowFromIM).toHaveBeenCalledTimes(1)
    const arg = mockStartWorkflowFromIM.mock.calls[0][0] as unknown as {
      workflowId: string
      runParams: { message: string }
      triggeredFrom: { source: string; conversationKey: string }
    }
    expect(arg.workflowId).toBe("wf_n")
    expect(arg.runParams.message).toBe("hello runtime")
    expect(arg.triggeredFrom.source).toBe("im")
    expect(arg.triggeredFrom.conversationKey).toBe(key)

    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "workflow.dispatched")).toBe(true)
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  it("teamId wins when both teamId and workflowId are set", async () => {
    const key = "telegram:adapter_1:chat_both"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_both",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({
      conversationKey: key,
      sessionId: "s_both",
      teamId: "team_r",
      workflowId: "wf_n",
    })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(mockStartTeamRunFromIM).toHaveBeenCalledTimes(1)
    expect(mockStartWorkflowFromIM).not.toHaveBeenCalled()
  })

  it("writes adapter.error when workflow dispatch reports not-found", async () => {
    const key = "telegram:adapter_1:chat_wf_fail"
    await seedAdapter("adapter_1")
    mockStartWorkflowFromIM.mockResolvedValueOnce({
      ok: false,
      reason: "workflow-not-found",
      workflowId: "ghost",
    } as never)
    await getDb().sessions.add({
      id: "s_wf2",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_wf2", workflowId: "ghost" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "adapter.error" && r.reason === "workflow-not-found")).toBe(
      true
    )
  })
})

describe("installRuntime — manual-store", () => {
  it("creates ChatSession and StoredMessage; no outbound job", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_manual" })
    await callHandler(event, "manual-store")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe("user")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
  })
})

describe("installRuntime — draft-prepare", () => {
  it("creates ChatSession, StoredMessage, and a ConnectorDraft", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft" })
    await callHandler(event, "draft-prepare")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)

    const drafts = await getDb().connectorDrafts.toArray()
    expect(drafts).toHaveLength(1)
    expect(drafts[0].status).toBe("pending")
    expect(drafts[0].conversationKey).toBe("telegram:adapter_1:chat_draft")
    expect(drafts[0].sourceMessageId).toBe(messages[0].id)
  })
})

describe("installRuntime — store-only", () => {
  it("creates ChatSession and StoredMessage; no outbound job, no draft", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_store" })
    await callHandler(event, "store-only")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)

    const drafts = await getDb().connectorDrafts.toArray()
    expect(drafts).toHaveLength(0)
  })
})

describe("installRuntime — drop", () => {
  it("does NOT insert ChatSession or StoredMessage", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_drop" })
    await callHandler(event, "drop")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(0)

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(0)
  })
})

describe("installRuntime — edit / delete / system kinds", () => {
  it("does not write a new StoredMessage for kind=edit events (bus owns the path)", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_edit",
      kind: "edit",
      replacesMessageId: "old_msg_id",
    })
    await callHandler(event, "ai-run")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(0)
    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(0)
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
  })

  it("does not write a new StoredMessage for kind=system events", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_sys",
      kind: "system",
      systemKind: "read_indicator",
    })
    await callHandler(event, "ai-run")

    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(0)
  })
})

describe("installRuntime — session reuse", () => {
  it("reuses existing session on second event with same conversationKey", async () => {
    const key = "telegram:adapter_1:chat_reuse"
    const event1 = makeEvent({ conversationKey: key, messageId: "msg_1" })
    const event2 = makeEvent({ conversationKey: key, messageId: "msg_2" })

    await callHandler(event1, "manual-store")
    await callHandler(event2, "manual-store")

    const sessions = await getDb().sessions.toArray()
    // Must have exactly one session
    expect(sessions).toHaveLength(1)

    const messages = await getDb().messages.toArray()
    // Both messages must belong to the same session
    expect(messages).toHaveLength(2)
    expect(messages[0].sessionId).toBe(sessions[0].id)
    expect(messages[1].sessionId).toBe(sessions[0].id)
  })

  it("uses channel.name as session title when present", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_named",
      channel: { id: "ch_x", name: "My Group", kind: "group" },
    })
    await callHandler(event, "store-only")
    const sessions = await getDb().sessions.toArray()
    expect(sessions[0].title).toBe("My Group")
  })

  it("falls back to sender.displayName when channel.name is absent", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_noname",
      channel: { id: "ch_x", kind: "private" },
      sender: {
        id: "u_alice",
        platform: "telegram",
        adapterId: "adapter_1",
        remoteUserId: "u_alice",
        displayName: "Alice",
      },
    })
    await callHandler(event, "store-only")
    const sessions = await getDb().sessions.toArray()
    expect(sessions[0].title).toBe("Alice")
  })
})

describe("inboundEventToSendContent", () => {
  it("collapses a single text segment to a plain string", () => {
    const event = makeEvent({
      segments: [{ type: "text", text: "single" }],
      plainText: "single",
    })
    expect(inboundEventToSendContent(event)).toBe("single")
  })

  it("joins multiple text + markdown segments with newlines", () => {
    const event = makeEvent({
      segments: [
        { type: "text", text: "hello" },
        { type: "markdown", md: "**bold**" },
      ],
      plainText: "hello\n**bold**",
    })
    expect(inboundEventToSendContent(event)).toBe("hello\n**bold**")
  })

  it("falls back to plainText when segments are empty", () => {
    const event = makeEvent({ segments: [], plainText: "fallback" })
    expect(inboundEventToSendContent(event)).toBe("fallback")
  })

  it("emits [empty] when both segments and plainText are empty", () => {
    const event = makeEvent({ segments: [], plainText: "" })
    expect(inboundEventToSendContent(event)).toBe("[empty]")
  })

  it("renders image segments without inline data as text markers", () => {
    const event = makeEvent({
      segments: [{ type: "image", url: "https://example.com/p.png" }],
      plainText: "",
    })
    expect(inboundEventToSendContent(event)).toBe("[image: https://example.com/p.png]")
  })

  it("emits the inbound OCR text alongside the image marker (ADR-0024)", () => {
    const event = makeEvent({
      segments: [{ type: "image", url: "https://example.com/p.png", ocrText: "RECEIPT $9" }],
      plainText: "",
    })
    // url-only image → [image: url] marker, then the OCR text as its own block.
    expect(inboundEventToSendContent(event)).toBe("[image: https://example.com/p.png]\nRECEIPT $9")
  })

  it("preserves base64 image segments as image blocks (multimodal)", () => {
    const event = makeEvent({
      segments: [
        { type: "text", text: "look:" },
        {
          type: "image",
          url: "ignored",
          // @ts-expect-error - dataBase64 is an extension field used by adapters
          //  that surface inline image bytes
          dataBase64: "AAA",
          mimeType: "image/jpeg",
        },
      ],
      plainText: "look:",
    })
    const out = inboundEventToSendContent(event)
    expect(Array.isArray(out)).toBe(true)
    if (Array.isArray(out)) {
      expect(out[0]).toEqual({ type: "text", text: "look:" })
      expect(out[1]).toEqual({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "AAA" },
      })
    }
  })
})

describe("installRuntime — ai-run (agent-trace root span)", () => {
  const HEX32 = /^[0-9a-f]{32}$/
  const HEX16 = /^[0-9a-f]{16}$/

  it("opens a connector root span and threads its trace ids into the capture sendOptions", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const sendOptions = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][2] as {
      traceId?: string
      spanId?: string
    }
    expect(sendOptions.traceId).toMatch(HEX32)
    expect(sendOptions.spanId).toMatch(HEX16)
  })

  it("ends the root span with the captured token usage + cost on success", async () => {
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockResolvedValueOnce({
      text: "hi",
      messageId: "m-usage",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        totalCostUsd: 0.003,
      },
    })
    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" }), "ai-run")

    expect(endSpanMock).toHaveBeenCalledWith(
      expect.stringMatching(HEX16),
      expect.objectContaining({
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationTokens: 2,
          cacheReadTokens: 5,
        },
        costUsdEstimate: 0.003,
        metadata: { assistantMessageId: "m-usage" },
      })
    )
  })

  it("ends the root span with an error when the capture throws", async () => {
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(new Error("boom"))
    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" }), "ai-run")

    expect(endSpanMock).toHaveBeenCalledWith(
      expect.stringMatching(HEX16),
      expect.objectContaining({
        errorType: "ai_run_capture_failed",
        errorMessage: "boom",
      })
    )
  })
})
