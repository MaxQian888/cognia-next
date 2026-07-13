/** @jest-environment jsdom */
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
import type { AdapterInstanceRow, DispatchRule } from "@/lib/db/connector-types"
import {
  installRuntime,
  inboundEventToSendContent,
  insertInboundMessage,
  shouldEmbedInboundText,
  type RunAndCaptureFn,
} from "./runtime"
import { notifyConversationOverIM } from "@/lib/notifications/conversation-notify"
import { registerRunningAdapter, __resetLifecycleForTesting } from "./lifecycle"
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

// The embedding provider is mocked so the PII-embed-gate tests can assert
// that NOTHING (neither the runtime's precompute nor applyTwinContext's
// fallback) ever embeds leaky inbound text. Covers every importer of
// `generateEmbedding` in the graph (runtime.ts AND lib/twin/runtime).
const mockGenerateEmbedding = jest.fn(async () => ({ embedding: [0.1, 0.2] }))
jest.mock("@cognia/provider-embedding/embedding", () => ({
  __esModule: true,
  generateEmbedding: (...a: unknown[]) => mockGenerateEmbedding(...(a as [])),
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

// The capture-failure path fire-and-forgets a dynamic import of the
// notifications runtime (`notifyConversationOverIM`). Left real, that chain
// settles AFTER its test ends and the Dexie write lands while the NEXT
// test's beforeEach is deleting the DB — jest then attributes the stray
// rejection to whichever test happens to be running (observed as an
// empty-body failure a couple of tests downstream). Stub it so the chain
// settles immediately and never touches Dexie.
jest.mock("@/lib/notifications/conversation-notify", () => ({
  __esModule: true,
  notifyConversationOverIM: jest.fn(async () => undefined),
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
  patch: Partial<{
    quietHours?: { from: string; to: string; tz: string }
    muted?: boolean
    defaultTeamId?: string
    dispatchRules?: DispatchRule[]
  }> = {}
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
      adapterId?: string
      conversationKey?: string
    }
    expect(typeof cap.onPermissionRequest).toBe("function")
    expect(cap.timeoutMs).toBeGreaterThan(5 * 60 * 1000)
    // Connector context rides on `cap` so the injected PII gate can attribute
    // blocks + usage to the right conversation.
    expect(cap.adapterId).toBe("adapter_1")
    expect(cap.conversationKey).toBe("telegram:adapter_1:chat_ai")
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

describe("shouldEmbedInboundText — PII gate before the twin/memory embed", () => {
  it("embeds clean, non-empty inbound text", () => {
    expect(shouldEmbedInboundText("hello runtime")).toBe(true)
  })

  it("skips empty / whitespace-only text", () => {
    expect(shouldEmbedInboundText("")).toBe(false)
    expect(shouldEmbedInboundText("   ")).toBe(false)
  })

  it("skips text that would leak PII into the embedding provider", () => {
    // Same red line safeSendPrompt enforces for the LLM leg — never embed PII.
    expect(shouldEmbedInboundText("see alice@example.com")).toBe(false)
  })
})

describe("installRuntime — ai-run (PII embed gate covers the fallback legs)", () => {
  const LEAKY_TEXT = "please email alice@example.com about this"
  const TWIN_DEPS = { embedding: { provider: "transformersjs", model: "m" }, store: {} }

  /**
   * Memory deps whose vector leg records every embed request. The candidate
   * list must be non-empty: `retrieveMemories` returns before the vector leg
   * (and thus before `deps.embed`) when there is nothing to rank.
   */
  function memoryDepsWithEmbedSpy(): { deps: Record<string, unknown>; embed: jest.Mock } {
    const embed = jest.fn(async () => [0.5, 0.6])
    return {
      embed,
      deps: {
        loadCandidates: async () => [
          {
            id: "mem_1",
            type: "semantic",
            status: "active",
            text: "the user prefers runtime hello messages",
            source: "user",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        loadProcedural: async () => [],
        touch: async () => undefined,
        embed,
        vectorSearch: jest.fn(async () => []),
      },
    }
  }

  beforeEach(() => {
    mockGenerateEmbedding.mockClear()
  })

  it("clean inbound still precomputes one shared query embedding (twin leg unchanged)", async () => {
    await getDb().characters.put({ id: "char_abc", name: "Twinned", twinId: "twin_1" } as never)
    tryBuildTwinDepsImpl = jest.fn(async () => TWIN_DEPS)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_embed_clean" })
    await callHandler(event, "ai-run")
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
    expect(mockGenerateEmbedding).toHaveBeenCalledWith("hello runtime", TWIN_DEPS.embedding)
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
  })

  it("leaky inbound never reaches the embedding provider — precompute AND twin fallback", async () => {
    // Regression: gating only the precomputed embed was not enough —
    // resolveSendOptions used to receive `twinUserMessage: event.plainText`
    // anyway, and applyTwinContext falls back to generateEmbedding(userMessage)
    // when precomputedQueryEmbedding is absent, embedding the exact text the
    // gate blocked. The runtime now withholds the twin/memory user-message
    // levers entirely on a leak.
    await getDb().characters.put({ id: "char_abc", name: "Twinned", twinId: "twin_1" } as never)
    tryBuildTwinDepsImpl = jest.fn(async () => TWIN_DEPS)
    const { deps, embed } = memoryDepsWithEmbedSpy()
    tryBuildMemoryDepsImpl = jest.fn(async () => deps)
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_embed_leak",
      plainText: LEAKY_TEXT,
      segments: [{ type: "text", text: LEAKY_TEXT }],
    })
    await callHandler(event, "ai-run")
    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalled()
    // The turn itself still runs (degrades to no-RAG); the LLM-leg PII gate
    // lives in the injected safeSendPrompt wrapper, one step later.
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
  })

  it("memory retriever embeds inbound text only when the PII gate passes (non-twin character)", async () => {
    // Non-twin characters never precompute a turn embedding, so before the fix
    // the memory retriever embedded inbound text ungated on EVERY turn.
    await getDb().characters.put({ id: "char_abc", name: "Plain" } as never)
    const clean = memoryDepsWithEmbedSpy()
    tryBuildMemoryDepsImpl = jest.fn(async () => clean.deps)
    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_mem_c" }), "ai-run")
    expect(clean.embed).toHaveBeenCalledWith("hello runtime")

    const leaky = memoryDepsWithEmbedSpy()
    tryBuildMemoryDepsImpl = jest.fn(async () => leaky.deps)
    await callHandler(
      makeEvent({
        conversationKey: "telegram:adapter_1:chat_mem_l",
        plainText: LEAKY_TEXT,
        segments: [{ type: "text", text: LEAKY_TEXT }],
      }),
      "ai-run"
    )
    expect(leaky.embed).not.toHaveBeenCalled()
    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
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

  it("does NOT write a duplicate ai_run_capture_failed audit when the PII gate blocks", async () => {
    // The PII gate (`safeSendPrompt`) throws `PiiGateBlocked` and has already
    // written the precise `pii_blocked` audit. The runtime must detect it by
    // name and skip the generic capture-failure row (no double-audit, no
    // mislabel), while still skipping outbound enqueue.
    const piiErr = new Error("PII gate blocked auto-mode send")
    piiErr.name = "PiiGateBlocked"
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(piiErr)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_pii" })
    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    const nonActivity = jobs.filter(
      (j) => !j.request.metadata?.idempotencyKey?.startsWith("activity:")
    )
    expect(nonActivity).toHaveLength(0)
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.some((a) => a.reason === "ai_run_capture_failed")).toBe(false)
    expect(audits.some((a) => a.kind === "outbound.ai_run_enqueued")).toBe(false)
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

  // PII red-line: the team/workflow branches forward `event.plainText` straight
  // into their runtimes, bypassing `safeSendPrompt`. The runtime now gates that
  // text with the real `hasNoLeakingPii` before dispatch (fail-closed).
  it("blocks team dispatch + audits pii_blocked when inbound text leaks PII", async () => {
    const key = "telegram:adapter_1:chat_team_pii"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_team_pii",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({
      conversationKey: key,
      sessionId: "s_team_pii",
      teamId: "team_r",
    })

    await callHandler(
      makeEvent({
        conversationKey: key,
        segments: [{ type: "text", text: "email me at alice@corp.com" }],
        plainText: "email me at alice@corp.com",
      }),
      "ai-run"
    )

    expect(mockStartTeamRunFromIM).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "adapter.error" && r.reason === "pii_blocked")).toBe(true)
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  it("blocks workflow dispatch + audits pii_blocked when inbound text leaks PII", async () => {
    const key = "telegram:adapter_1:chat_wf_pii"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_wf_pii",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({
      conversationKey: key,
      sessionId: "s_wf_pii",
      workflowId: "wf_n",
    })

    await callHandler(
      makeEvent({
        conversationKey: key,
        segments: [{ type: "text", text: "reach bob@corp.com about it" }],
        plainText: "reach bob@corp.com about it",
      }),
      "ai-run"
    )

    expect(mockStartWorkflowFromIM).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "adapter.error" && r.reason === "pii_blocked")).toBe(true)
    expect(await getDb().outboundQueue.count()).toBe(0)
  })

  it("still dispatches to the team when inbound text is PII-clean", async () => {
    const key = "telegram:adapter_1:chat_team_clean"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_team_clean",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({
      conversationKey: key,
      sessionId: "s_team_clean",
      teamId: "team_r",
    })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(mockStartTeamRunFromIM).toHaveBeenCalledTimes(1)
  })

  // ── instance-level defaultTeamId (W1) ──────────────────────────────────────

  it("dispatches to the bot's defaultTeamId when no conversation override binds a team", async () => {
    const key = "telegram:adapter_1:chat_inst_team"
    await seedAdapter("adapter_1", { defaultTeamId: "team_bot" })
    await getDb().sessions.add({
      id: "s_inst",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    expect(mockStartTeamRunFromIM).toHaveBeenCalledTimes(1)
    expect((mockStartTeamRunFromIM.mock.calls[0][0] as { teamId: string }).teamId).toBe("team_bot")
    const audit = await getDb().connectorAudit.toArray()
    const dispatched = audit.find((r) => r.kind === "team.dispatched")
    expect(dispatched?.fields?.teamSource).toBe("instance-default")
  })

  it("conversation override teamId beats the bot defaultTeamId", async () => {
    const key = "telegram:adapter_1:chat_inst_vs_override"
    await seedAdapter("adapter_1", { defaultTeamId: "team_bot" })
    await getDb().sessions.add({
      id: "s_iv",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_iv", teamId: "team_chat" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect((mockStartTeamRunFromIM.mock.calls[0][0] as { teamId: string }).teamId).toBe("team_chat")
  })

  it("teamDisabled suppresses the bot defaultTeamId → single-character ai-run", async () => {
    const key = "telegram:adapter_1:chat_team_off"
    await seedAdapter("adapter_1", { defaultTeamId: "team_bot" })
    await getDb().sessions.add({
      id: "s_off",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_off", teamDisabled: true })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(mockStartTeamRunFromIM).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
  })

  it("stale instance-default team (team_not_found) falls through to single-character ai-run", async () => {
    const key = "telegram:adapter_1:chat_inst_stale"
    await seedAdapter("adapter_1", { defaultTeamId: "ghost_team" })
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)
    await getDb().sessions.add({
      id: "s_stale",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    // The deleted bot-default team must not brick the instance: audit + run
    // the normal single-character path.
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
    const audit = await getDb().connectorAudit.toArray()
    expect(
      audit.some((r) => r.kind === "adapter.error" && r.reason === "instance_default_team_missing")
    ).toBe(true)
  })

  it("stale OVERRIDE team keeps the audit+stop behaviour (no fallthrough)", async () => {
    const key = "telegram:adapter_1:chat_override_stale"
    await seedAdapter("adapter_1")
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)
    await getDb().sessions.add({
      id: "s_ostale",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_ostale", teamId: "ghost" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "adapter.error" && r.reason === "team_not_found")).toBe(
      true
    )
  })

  it("PII gate covers instance-default team dispatch (fail-closed)", async () => {
    const key = "telegram:adapter_1:chat_inst_pii"
    await seedAdapter("adapter_1", { defaultTeamId: "team_bot" })
    await getDb().sessions.add({
      id: "s_ipii",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)

    await callHandler(
      makeEvent({
        conversationKey: key,
        segments: [{ type: "text", text: "email me at alice@corp.com" }],
        plainText: "email me at alice@corp.com",
      }),
      "ai-run"
    )

    expect(mockStartTeamRunFromIM).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    const pii = audit.find((r) => r.kind === "adapter.error" && r.reason === "pii_blocked")
    expect(pii?.fields?.teamSource).toBe("instance-default")
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

describe("installRuntime — ai-run (dispatch rules W3)", () => {
  beforeEach(() => {
    mockStartTeamRunFromIM.mockClear()
    mockStartTeamRunFromIM.mockResolvedValue({ started: true })
    mockStartWorkflowFromIM.mockClear()
    mockStartWorkflowFromIM.mockResolvedValue({ ok: true, runId: "run_x" })
  })

  const TEAM_RULE: DispatchRule = {
    id: "rule_team",
    name: "Runtime keyword",
    match: { keywords: ["runtime"] },
    action: { teamId: "team_rule" },
  }

  it("routes to the rule's team when no override binds one (audits rule_matched + teamSource rule)", async () => {
    const key = "telegram:adapter_1:chat_rule_team"
    await seedAdapter("adapter_1", { dispatchRules: [TEAM_RULE] })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    expect(mockStartTeamRunFromIM).toHaveBeenCalledTimes(1)
    expect((mockStartTeamRunFromIM.mock.calls[0][0] as { teamId: string }).teamId).toBe("team_rule")
    const audit = await getDb().connectorAudit.toArray()
    const dispatched = audit.find((r) => r.kind === "team.dispatched")
    expect(dispatched?.fields?.teamSource).toBe("rule")
    const matched = audit.find((r) => r.kind === "dispatch.rule_matched")
    expect(matched?.fields).toMatchObject({
      ruleId: "rule_team",
      ruleName: "Runtime keyword",
      teamId: "team_rule",
    })
    expect(typeof matched?.fields?.sourceMessageId).toBe("string")
  })

  it("conversation override teamId beats a matching rule (no rule_matched audit)", async () => {
    const key = "telegram:adapter_1:chat_rule_vs_override"
    await seedAdapter("adapter_1", { dispatchRules: [TEAM_RULE] })
    await getDb().sessions.add({
      id: "s_rvo",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_rvo", teamId: "team_over" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect((mockStartTeamRunFromIM.mock.calls[0][0] as { teamId: string }).teamId).toBe("team_over")
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.find((r) => r.kind === "team.dispatched")?.fields?.teamSource).toBe("override")
    expect(audit.some((r) => r.kind === "dispatch.rule_matched")).toBe(false)
  })

  it("rule team beats the instance defaultTeamId", async () => {
    const key = "telegram:adapter_1:chat_rule_vs_inst"
    await seedAdapter("adapter_1", { defaultTeamId: "team_bot", dispatchRules: [TEAM_RULE] })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect((mockStartTeamRunFromIM.mock.calls[0][0] as { teamId: string }).teamId).toBe("team_rule")
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.find((r) => r.kind === "team.dispatched")?.fields?.teamSource).toBe("rule")
  })

  it("a non-matching rule falls through to the instance defaultTeamId", async () => {
    const key = "telegram:adapter_1:chat_rule_miss"
    await seedAdapter("adapter_1", {
      defaultTeamId: "team_bot",
      dispatchRules: [{ id: "r_miss", match: { keywords: ["deploy"] }, action: { teamId: "t" } }],
    })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect((mockStartTeamRunFromIM.mock.calls[0][0] as { teamId: string }).teamId).toBe("team_bot")
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.find((r) => r.kind === "team.dispatched")?.fields?.teamSource).toBe(
      "instance-default"
    )
    expect(audit.some((r) => r.kind === "dispatch.rule_matched")).toBe(false)
  })

  it("teamDisabled suppresses a rule-sourced team → single-character ai-run", async () => {
    const key = "telegram:adapter_1:chat_rule_team_off"
    await seedAdapter("adapter_1", { dispatchRules: [TEAM_RULE] })
    await getDb().sessions.add({
      id: "s_rto",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({ conversationKey: key, sessionId: "s_rto", teamDisabled: true })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(mockStartTeamRunFromIM).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "dispatch.rule_matched")).toBe(false)
  })

  it("rule workflowId routes to the workflow orchestrator when no team resolved", async () => {
    const key = "telegram:adapter_1:chat_rule_wf"
    await seedAdapter("adapter_1", {
      dispatchRules: [
        { id: "rule_wf", match: { keywords: ["runtime"] }, action: { workflowId: "wf_rule" } },
      ],
    })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    expect(mockStartTeamRunFromIM).not.toHaveBeenCalled()
    expect(mockStartWorkflowFromIM).toHaveBeenCalledTimes(1)
    expect((mockStartWorkflowFromIM.mock.calls[0][0] as { workflowId: string }).workflowId).toBe(
      "wf_rule"
    )
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.find((r) => r.kind === "workflow.dispatched")?.fields?.workflowId).toBe("wf_rule")
    const matched = audit.find((r) => r.kind === "dispatch.rule_matched")
    expect(matched?.fields).toMatchObject({ ruleId: "rule_wf", workflowId: "wf_rule" })
  })

  it("PII gate covers a rule-sourced team (fail-closed, teamSource rule)", async () => {
    const key = "telegram:adapter_1:chat_rule_pii"
    await seedAdapter("adapter_1", {
      dispatchRules: [{ id: "r_pii", match: {}, action: { teamId: "team_rule" } }],
    })

    await callHandler(
      makeEvent({
        conversationKey: key,
        segments: [{ type: "text", text: "email me at alice@corp.com" }],
        plainText: "email me at alice@corp.com",
      }),
      "ai-run"
    )

    expect(mockStartTeamRunFromIM).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    const pii = audit.find((r) => r.kind === "adapter.error" && r.reason === "pii_blocked")
    expect(pii?.fields?.teamSource).toBe("rule")
    // Blocked before dispatch → the rule never "decided" a routed turn.
    expect(audit.some((r) => r.kind === "dispatch.rule_matched")).toBe(false)
  })

  it("rule characterId retargets the send-options persona but not the session binding", async () => {
    const key = "telegram:adapter_1:chat_rule_char"
    // The resolved binding's character has no twin; the rule's character is
    // twin-bound — a twin-deps build proves the rule character was the one
    // loaded into the send options.
    await getDb().characters.put({ id: "char_abc", name: "Plain" } as never)
    await getDb().characters.put({ id: "char_rule", name: "Twinned", twinId: "twin_r" } as never)
    await seedAdapter("adapter_1", {
      dispatchRules: [
        { id: "rule_char", match: { keywords: ["runtime"] }, action: { characterId: "char_rule" } },
      ],
    })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
    expect(tryBuildTwinDepsImpl).toHaveBeenCalledTimes(1)
    // Session creation keeps the resolved binding's character.
    const sessions = await getDb().sessions.toArray()
    expect(sessions[0].characterId).toBe("char_abc")
    const audit = await getDb().connectorAudit.toArray()
    const matched = audit.find((r) => r.kind === "dispatch.rule_matched")
    expect(matched?.fields).toMatchObject({ ruleId: "rule_char", characterId: "char_rule" })
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

  it("runs a REAL capture and stores the generated reply (not a placeholder)", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft_real" })
    await callHandler(event, "draft-prepare")

    // The draft-prepare branch now drives the same capture the ai-run path
    // uses, so the drafted reply is the model's actual output.
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
    const drafts = await getDb().connectorDrafts.toArray()
    // `assistantReplyToSegments` projects plain assistant text as a markdown
    // segment (same projection the ai-run outbound path uses).
    expect(drafts[0].segments).toEqual([{ type: "markdown", md: "Hello back from Claude!" }])

    // No reply is sent — a draft awaits human approval — and the prepare is audited.
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)
    const audits = await getDb().connectorAudit.toArray()
    const prepared = audits.find((a) => a.kind === "draft.prepared")
    expect(prepared?.fields?.draftId).toBe(drafts[0].id)
  })

  it("denies ask-tier tool permissions by default (no human in the loop at draft time)", async () => {
    let seenPermission: unknown
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _prompt, _opts, cap) => {
      seenPermission = cap?.onPermissionRequest?.({ toolName: "bash" } as never)
      return { text: "drafted", messageId: "asst-draft-perm" }
    })
    installRuntime(getBus(), { runAndCapture: capturing })

    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft_perm" })
    await callHandler(event, "draft-prepare")

    await expect(Promise.resolve(seenPermission)).resolves.toEqual({ decision: "deny" })
  })

  it("does NOT persist a draft when the capture rejects (real error → adapter.error)", async () => {
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(new Error("sidecar died"))
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft_err" })
    await callHandler(event, "draft-prepare")

    const drafts = await getDb().connectorDrafts.toArray()
    expect(drafts).toHaveLength(0)
    const audits = await getDb().connectorAudit.toArray()
    const err = audits.find((a) => a.kind === "adapter.error")
    expect(err?.reason).toBe("draft_prepare_capture_failed")
    expect(err?.message).toContain("sidecar died")
  })

  it("stores an explicit text mirror when the reply projects to no segments", async () => {
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockResolvedValueOnce({
      text: "",
      messageId: "empty-1",
    })
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft_empty" })
    await callHandler(event, "draft-prepare")

    const drafts = await getDb().connectorDrafts.toArray()
    expect(drafts).toHaveLength(1)
    // Empty text + no surfaces → keep the draft non-empty via a text mirror.
    expect(drafts[0].segments).toEqual([{ type: "text", text: "" }])
  })

  it("does NOT persist a draft (or double-audit) when the PII gate blocks", async () => {
    const piiErr = new Error("PII gate blocked draft send")
    piiErr.name = "PiiGateBlocked"
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(piiErr)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft_pii" })
    await callHandler(event, "draft-prepare")

    const drafts = await getDb().connectorDrafts.toArray()
    expect(drafts).toHaveLength(0)
    const audits = await getDb().connectorAudit.toArray()
    // The PII gate already wrote its own row; the runtime must not add a
    // duplicate draft_prepare_capture_failed audit.
    expect(audits.some((a) => a.reason === "draft_prepare_capture_failed")).toBe(false)
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

  it("surfaces a file segment's name and extracted text (ADR-0009 rich media)", () => {
    const event = makeEvent({
      segments: [
        {
          type: "file",
          url: "file_k",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 0,
          ocrText: "Q3 revenue up 12%",
        },
      ],
      plainText: "",
    })
    expect(inboundEventToSendContent(event)).toBe("[file: report.pdf]\nQ3 revenue up 12%")
  })

  it("shows a file marker with just the name when no text was extracted", () => {
    const event = makeEvent({
      segments: [
        {
          type: "file",
          url: "file_k",
          name: "archive.zip",
          mimeType: "application/zip",
          sizeBytes: 0,
        },
      ],
      plainText: "",
    })
    expect(inboundEventToSendContent(event)).toBe("[file: archive.zip]")
  })

  it("hands back a voice transcript when present, else a marker", () => {
    expect(
      inboundEventToSendContent(
        makeEvent({
          segments: [{ type: "voice", url: "v_k", transcript: "hi there" }],
          plainText: "",
        })
      )
    ).toBe("hi there")
    expect(
      inboundEventToSendContent(
        makeEvent({ segments: [{ type: "voice", url: "v_k" }], plainText: "" })
      )
    ).toBe("[voice message]")
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

  it("delegates cost/usage to the provider child span (no double-book) when a provider is set", async () => {
    // With a provider override configured (the default here), `safeSendPrompt`
    // records a `recordProviderOutcome` child span under this root that already
    // carries the LLM cost/usage. To avoid double-booking in the trace, the
    // root span closes with metadata only — NOT usage/cost.
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

    const successCall = endSpanMock.mock.calls.find(
      ([, payload]) =>
        (payload as { metadata?: { assistantMessageId?: string } })?.metadata
          ?.assistantMessageId === "m-usage"
    )
    expect(successCall).toBeDefined()
    const payload = successCall![1] as { usage?: unknown; costUsdEstimate?: unknown }
    expect(payload.usage).toBeUndefined()
    expect(payload.costUsdEstimate).toBeUndefined()
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
    // Drain the capture-failure path's fire-and-forget tail (notification
    // import chain, telemetry writes) INSIDE this test, while the Dexie
    // instance is still alive. Without this, the tail settles during the
    // NEXT test — right as its beforeEach deletes the DB — and jest
    // attributes the stray rejection to whichever test is running then
    // (observed as a deterministic empty-body failure downstream).
    await new Promise((r) => setTimeout(r, 250))
  })
})

// ── respond-via bot (multi-bot cross-account send) ───────────────────────────

/** Put an adapterInstances row with an explicit id (no id-rewrite races). */
async function putInstance(id: string, patch: Partial<AdapterInstanceRow> = {}): Promise<void> {
  await getDb().adapterInstances.put({
    id,
    type: "telegram",
    displayName: `Instance ${id}`,
    enabled: true,
    transportMode: "long-poll",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as AdapterInstanceRow)
}

// NOTE: unit coverage for `resolveRespondViaTarget` lives in
// `runtime.respond-via.test.ts` — a light suite that doesn't stand up the
// full installRuntime harness. Only the end-to-end ai-run wiring is here.

describe("installRuntime — ai-run respond-via rule", () => {
  it("delivers the reply through the rule's respondViaAdapterId sibling", async () => {
    await seedAdapter("adapter_1", {
      dispatchRules: [{ id: "r_via", match: {}, action: { respondViaAdapterId: "adapter_2" } }],
    })
    await putInstance("adapter_2")
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_42" })
    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adapter_2")
    expect(jobs[0].conversationKey).toBe("telegram:adapter_2:chat_42")
    expect(jobs[0].request.conversationRef.adapterId).toBe("adapter_2")
    // The enqueue audit stays on the RECEIVING adapter and carries the hop.
    const audits = await getDb().connectorAudit.toArray()
    const enq = audits.find((a) => a.kind === "outbound.ai_run_enqueued")
    expect(enq!.adapterId).toBe("adapter_1")
    expect(enq!.fields).toMatchObject({ respondViaAdapterId: "adapter_2" })
  })

  it("falls back to the receiving bot when the rule's target is invalid", async () => {
    await seedAdapter("adapter_1", {
      dispatchRules: [{ id: "r_via", match: {}, action: { respondViaAdapterId: "ghost" } }],
    })
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_42" })
    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adapter_1")
    expect(jobs[0].conversationKey).toBe("telegram:adapter_1:chat_42")
    const audits = await getDb().connectorAudit.toArray()
    const decision = audits.find((a) => a.kind === "dispatch.respond_via")
    expect(decision!.fields).toMatchObject({ applied: false, reason: "not_found" })
  })

  it("suppresses platform streaming when respond-via rewires the reply to a sibling", async () => {
    // The RECEIVING adapter must not stream partial frames it never finalizes
    // (the sibling posts the final) — the user would see an orphaned preview
    // plus a duplicate final from another bot.
    await seedAdapter("adapter_1", {
      dispatchRules: [{ id: "r_via", match: {}, action: { respondViaAdapterId: "adapter_2" } }],
    })
    await putInstance("adapter_2")
    const streamReply = jest.fn(async () => undefined)
    let receivedCap: { onPartial?: unknown } | undefined
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _content, _opts, cap) => {
      receivedCap = cap as typeof receivedCap
      return { text: "final", messageId: "uuid-via-stream" }
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
      streamReply,
      a2uiCapability: () => ({}) as never,
    })

    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_42" }), "ai-run")

    // onPartial suppressed: the reply target moved off the receiving adapter.
    expect(receivedCap?.onPartial).toBeUndefined()
    expect(streamReply).not.toHaveBeenCalled()
    // The final reply is still delivered — through the sibling.
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adapter_2")
  })

  it("keeps streaming when respond-via falls back to the receiving bot", async () => {
    await seedAdapter("adapter_1", {
      dispatchRules: [{ id: "r_via", match: {}, action: { respondViaAdapterId: "ghost" } }],
    })
    const streamReply = jest.fn(async () => undefined)
    const capturing: RunAndCaptureFn = jest.fn(async (_sid, _content, _opts, cap) => {
      await cap?.onPartial?.("partial")
      return { text: "final", messageId: "uuid-via-fallback" }
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
      streamReply,
      a2uiCapability: () => ({}) as never,
    })

    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_42" }), "ai-run")

    // Invalid target → fallback to the receiving bot → streaming stays wired.
    expect(streamReply).toHaveBeenCalledTimes(1)
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].adapterId).toBe("adapter_1")
  })
})

describe("installRuntime — ai-run (dispatch-failure IM notification)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { upsertByConversationKey: upsertOverride } = require("@/lib/db/conversation-overrides")
  const notifyMock = notifyConversationOverIM as jest.Mock
  const flushNotify = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  beforeEach(() => {
    notifyMock.mockClear()
    mockStartTeamRunFromIM.mockClear()
    mockStartWorkflowFromIM.mockClear()
  })

  it("notifies the conversation when an explicitly bound team fails to dispatch", async () => {
    const key = "telegram:adapter_1:chat_teamfail_notify"
    await seedAdapter("adapter_1")
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)
    await getDb().sessions.add({
      id: "s_tf",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertOverride({ conversationKey: key, sessionId: "s_tf", teamId: "ghost" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")
    await flushNotify()

    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: key,
        level: "error",
        dedupeKey: `dispatch-error:${key}`,
      })
    )
  })

  it("notifies the conversation when workflow dispatch fails", async () => {
    const key = "telegram:adapter_1:chat_wffail_notify"
    await seedAdapter("adapter_1")
    mockStartWorkflowFromIM.mockResolvedValueOnce({
      ok: false,
      reason: "workflow_dispatch_failed",
    } as never)
    await getDb().sessions.add({
      id: "s_wff",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertOverride({ conversationKey: key, sessionId: "s_wff", workflowId: "wf_ghost" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")
    await flushNotify()

    expect(notifyMock).toHaveBeenCalledTimes(1)
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: key,
        level: "error",
        dedupeKey: `dispatch-error:${key}`,
      })
    )
  })

  it("does NOT notify when a stale instance-default team falls through to a live reply", async () => {
    const key = "telegram:adapter_1:chat_staleteam_notify"
    await seedAdapter("adapter_1", { defaultTeamId: "ghost" })
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")
    await flushNotify()

    // The turn fell through to the single-character reply — no silence, so no
    // failure notice either.
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledTimes(1)
    expect(notifyMock).not.toHaveBeenCalled()
  })

  it("still does not notify on successful team dispatch", async () => {
    const key = "telegram:adapter_1:chat_teamok_notify"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_tok",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertOverride({ conversationKey: key, sessionId: "s_tok", teamId: "team_r" })

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")
    await flushNotify()

    expect(mockStartTeamRunFromIM).toHaveBeenCalledTimes(1)
    expect(notifyMock).not.toHaveBeenCalled()
  })
})

describe("installRuntime — ai-run (adapter teardown abort propagation)", () => {
  const stubAdapterHandle = {
    id: "adapter_1",
    stop: async () => undefined,
  } as never

  afterEach(() => {
    __resetLifecycleForTesting()
  })

  it("threads the running adapter's abort signal into the capture options", async () => {
    const adapterAc = new AbortController()
    registerRunningAdapter("adapter_1", {
      adapter: stubAdapterHandle,
      abortController: adapterAc,
      restart: async () => undefined,
    })
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_signal" })
    await callHandler(event, "ai-run")

    const cap = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][3] as {
      signal?: AbortSignal
    }
    expect(cap.signal).toBe(adapterAc.signal)
  })

  it("omits the signal when the adapter has no lifecycle entry (web/test hosts)", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_nosignal" })
    await callHandler(event, "ai-run")
    const cap = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][3] as {
      signal?: AbortSignal
    }
    expect(cap.signal).toBeUndefined()
  })

  it("aborting the adapter signal halts an in-flight capture (audited, no enqueue)", async () => {
    const adapterAc = new AbortController()
    registerRunningAdapter("adapter_1", {
      adapter: stubAdapterHandle,
      abortController: adapterAc,
      restart: async () => undefined,
    })
    const capturing: RunAndCaptureFn = jest.fn(
      (_sid, _content, _opts, cap) =>
        new Promise((_resolve, reject) => {
          // Mirrors runAndCaptureAssistantReply's abort handling: reject when
          // the threaded signal fires.
          cap!.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted by signal")),
            { once: true }
          )
          // Teardown fires while the turn is in flight.
          setTimeout(() => adapterAc.abort(), 0)
        })
    )
    __resetBusForTesting()
    const bus = getBus()
    installRuntime(bus, { runAndCapture: capturing })

    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_abort" }), "ai-run")

    // The rejected capture takes the failure branch: audit row, and no AI
    // reply is enqueued. (The failed-turn activity terminal line legitimately
    // enqueues its own `activity:*` job, so filter on the reply key.)
    const audits = await getDb().connectorAudit.toArray()
    expect(
      audits.some((a) => a.kind === "adapter.error" && a.reason === "ai_run_capture_failed")
    ).toBe(true)
    const jobs = await getDb().outboundQueue.toArray()
    expect(
      jobs.filter((j) =>
        String(j.request.metadata?.idempotencyKey ?? "").startsWith("airun:")
      )
    ).toHaveLength(0)
  })

  it("threads the adapter signal into draft-prepare captures too", async () => {
    const adapterAc = new AbortController()
    registerRunningAdapter("adapter_1", {
      adapter: stubAdapterHandle,
      abortController: adapterAc,
      restart: async () => undefined,
    })
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_draft_signal" })
    await callHandler(event, "draft-prepare")
    const cap = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][3] as {
      signal?: AbortSignal
    }
    expect(cap.signal).toBe(adapterAc.signal)
  })
})

describe("insertInboundMessage — session recency bump", () => {
  it("bumps the bound session's updatedAt to the inserted message's timestamp", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_bump" })
    await callHandler(event, "manual-store")
    const session = (await getDb().sessions.toArray())[0]
    expect(session).toBeDefined()

    await insertInboundMessage(
      makeEvent({ conversationKey: "telegram:adapter_1:chat_bump" }),
      session.id,
      9_999_999_999_999
    )
    const bumped = await getDb().sessions.get(session.id)
    expect(bumped!.updatedAt).toBe(9_999_999_999_999)
  })
})
