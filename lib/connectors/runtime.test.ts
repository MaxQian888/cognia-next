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
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createAdapterInstance, getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  enqueueConnectorInboundJob,
  recordConnectorInboundEdit,
  recordConnectorInboundRecall,
} from "@/lib/db/connector-inbound-jobs"
import { parseMatrixEvent } from "./adapters/matrix/parse"
import { parseV11Event, parseV11HistoryMessage } from "./adapters/onebot/v11"
import { upsertByConversationKey, readForResolution } from "@/lib/db/conversation-overrides"
import type { AdapterInstanceRow, DispatchRule } from "@/lib/db/connector-types"
import {
  installRuntime,
  inboundEventToSendContent,
  WITHHELD_MEDIA_MARKER,
  insertInboundMessage,
  resolveRecoveryExecutionSpec,
  shouldEmbedInboundText,
  recentGroupContextBlock,
  withConversationContext,
  incompleteRunStop,
  type RunAndCaptureFn,
} from "./runtime"
import { hasNoLeakingPii } from "@cognia/redact"
import { notifyConversationOverIM } from "@/lib/notifications/conversation-notify"
import { registerRunningAdapter, __resetLifecycleForTesting } from "./lifecycle"
import { getBus, __resetBusForTesting } from "./bus"
import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { MessageSegment } from "@/types/connectors/segment"
import type { RouteDecision } from "./mode-router"
import type { ResolvedBinding } from "./policy-resolve"
import type { AgentExecutionSendSpec } from "@cognia/agent-config-types/agent-execution"
import { computeExecutionFingerprint } from "@/lib/ai/agent/execution/fingerprint"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import * as buildOptions from "@/lib/claude/build-options"
import * as platform from "@/lib/platform/detect"
import * as standaloneMode from "@/lib/runtime/standalone-mode"
import { createManagedWorkspaceContext } from "@/lib/task-workspace/managed-workspace"
import { saveSettings } from "@/lib/db/settings"
import { createPlatformSession } from "./session-bindings"
import { parseQQDispatch } from "./adapters/qq-official/parse"
import { maybeHandleControlCommand } from "./commands/dispatch"
import { listPendingForConversation } from "@/lib/db/outbound-jobs"
import { useChatStore } from "@/stores/chat"

// SWC exports getters; copied descriptors let these focused routing cases spy
// without replacing the real resolver used by the rest of this suite.
jest.mock("@/lib/platform/detect", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/platform/detect"),
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({
  ...jest.requireActual("@/lib/runtime/standalone-mode"),
}))
jest.mock("@/lib/claude/build-options", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/claude/build-options"),
}))
jest.mock("@/lib/db/connector-inbound-jobs", () => ({
  ...jest.requireActual("@/lib/db/connector-inbound-jobs"),
}))
const mockBeforePermissionCeiling = jest.fn(async () => undefined)
jest.mock("@/lib/connectors/im-permission-ceiling", () => {
  const actual = jest.requireActual("@/lib/connectors/im-permission-ceiling")
  return {
    ...actual,
    buildImPermissionCeiling: async (...args: unknown[]) => {
      await mockBeforePermissionCeiling()
      return actual.buildImPermissionCeiling(...args)
    },
  }
})

const mockEnsureSessionScratchWorkspace = jest.fn<Promise<string>, [ChatSession]>()
jest.mock("@/lib/task-workspace/managed-workspace", () => ({
  ...jest.requireActual("@/lib/task-workspace/managed-workspace"),
  ensureSessionScratchWorkspace: (session: ChatSession) =>
    mockEnsureSessionScratchWorkspace(session),
}))

const mockAppendCanonicalEnvelopes = jest.fn<Promise<number>, unknown[]>(async () => 1)
jest.mock("@/lib/ai/agent/recovery/canonical-log", () => ({
  ...jest.requireActual("@/lib/ai/agent/recovery/canonical-log"),
  appendCanonicalEnvelopes: (...args: unknown[]) => mockAppendCanonicalEnvelopes(...(args as [])),
}))

const mockMintSessionRouteTicket = jest.fn<Promise<undefined>, unknown[]>(async () => undefined)
jest.mock("@/lib/gateway/mint-session-ticket", () => ({
  mintSessionRouteTicket: (...args: unknown[]) => mockMintSessionRouteTicket(...(args as [])),
}))

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
  tryBuildMemoryDeps: (...a: Parameters<typeof tryBuildMemoryDepsImpl>) =>
    tryBuildMemoryDepsImpl(...a),
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
const mockStartTeamRunFromIM = jest.fn(async (..._args: unknown[]) => ({
  started: true as const,
  runId: "run_team_default",
}))
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

const mockWaitForExecutionRunPresentationFreeze = jest.fn(
  async (_runId: string, _timeoutMs?: number) => true
)
jest.mock("./run-presentation/runner", () => ({
  __esModule: true,
  waitForExecutionRunPresentationFreeze: (...args: unknown[]) =>
    mockWaitForExecutionRunPresentationFreeze(
      ...(args as Parameters<typeof mockWaitForExecutionRunPresentationFreeze>)
    ),
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
  modeSource: "adapter-default",
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
  resolved: ResolvedBinding = RESOLVED,
  inboundJobId: string = `test:${event.messageId}`
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
  await bus.routeHandler(event, decision, resolved, override, adapterRow, {
    inboundJobId,
    bindExecutionRun: mockBindExecutionRun,
  })
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
    mediaModelPolicy: "local_extract_only",
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
const mockBindExecutionRun = jest.fn(async () => undefined)
const dbFixture = createDbTestFixture({ seeded: false })

// ── setup ─────────────────────────────────────────────────────────────────────

beforeAll(() => dbFixture.initialize())
afterAll(() => dbFixture.dispose())

beforeEach(async () => {
  await dbFixture.restore()
  __resetBusForTesting()
  const bus = getBus()
  mockEvaluateImRate.mockReset()
  mockEvaluateImRate.mockResolvedValue(null)
  mockBeforePermissionCeiling.mockReset().mockResolvedValue(undefined)
  ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockClear()
  ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockResolvedValue({
    text: "Hello back from Claude!",
    messageId: "uuid-asst-1",
  })
  tryBuildTwinDepsImpl = jest.fn(async () => undefined)
  tryBuildMemoryDepsImpl = jest.fn(async () => undefined)
  endSpanMock.mockClear()
  mockBindExecutionRun.mockClear()
  mockWaitForExecutionRunPresentationFreeze.mockClear()
  mockAppendCanonicalEnvelopes.mockClear()
  mockMintSessionRouteTicket.mockClear()
  window.localStorage.removeItem("cognia-agent-execution-flags-v1")
  installRuntime(bus, { runAndCapture: DEFAULT_RUN_AND_CAPTURE })
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe("installRuntime — headless connector workspace routing", () => {
  let resolveOptions: jest.SpyInstance
  let headless: jest.SpyInstance

  function project(id: string, path: string): Project {
    return {
      id,
      name: id,
      roots: [{ id: `${id}-root`, path, isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastAccessedAt: new Date(0),
    }
  }

  beforeEach(() => {
    headless = jest.spyOn(platform, "isHeadlessHost").mockReturnValue(true)
    resolveOptions = jest.spyOn(buildOptions, "resolveSendOptions").mockResolvedValue({
      model: "claude-sonnet-5",
    })
    mockEnsureSessionScratchWorkspace.mockReset()
    mockEnsureSessionScratchWorkspace.mockImplementation(async (session) => {
      const alias = `/host/scratch/${session.id}/primary`
      const context = createManagedWorkspaceContext(session.id, 1, alias, "project-default")
      context.execution!.bundleId = `bundle-${session.id}`
      await getDb().sessions.update(session.id, {
        projectId: "project-default",
        executionContext: context,
      })
      return alias
    })
  })

  afterEach(() => {
    headless.mockRestore()
    resolveOptions.mockRestore()
  })

  it("upgrades an old unbound session before send resolution and journals its managed alias", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:old_unbound" })
    const session = await createPlatformSession(event, undefined)
    await getDb().projects.put(project("project-default", "/default-must-not-run"))
    await saveSettings({ activeProjectId: "project-default" })
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockImplementationOnce(
      async (_sessionId, _content, _opts, cap) => {
        await cap?.onEvent?.({
          type: "tool-call",
          id: "write-result",
          toolName: "Write",
          input: { file_path: `/host/scratch/${session.id}/primary/results/result.txt` },
        })
        return { text: "done", messageId: "scratch-result" }
      }
    )

    await callHandler(event, "ai-run")

    expect(mockEnsureSessionScratchWorkspace).toHaveBeenCalledTimes(1)
    expect(resolveOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        activeProject: null,
        session: expect.objectContaining({
          id: session.id,
          projectId: "project-default",
          executionContext: expect.objectContaining({
            workspaceBinding: { kind: "managed", workspaceId: `managed-workspace:${session.id}` },
            managedWorkspace: expect.objectContaining({
              localRoot: `/host/scratch/${session.id}/primary`,
            }),
          }),
        }),
      })
    )
    const run = await getDb().executionRuns.where("sessionId").equals(session.id).first()
    expect(run?.projectId).toBe("project-default")
    const events = await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()
    expect(events.find((item) => item.type === "tool.started")?.payload).toMatchObject({
      target: { kind: "workspace_path", label: "results/result.txt" },
    })
  })

  it("revalidates and reuses the same scratch binding on later turns", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:scratch_reuse" })
    await callHandler(event, "ai-run")
    const first = resolveOptions.mock.calls[0][0].session as ChatSession
    await callHandler(makeEvent({ conversationKey: event.conversationKey }), "ai-run")
    const second = resolveOptions.mock.calls[1][0].session as ChatSession
    expect(second.id).toBe(first.id)
    expect(second.executionContext?.execution?.bundleId).toBe(
      first.executionContext?.execution?.bundleId
    )
    expect(mockEnsureSessionScratchWorkspace).toHaveBeenCalledTimes(2)
    expect(resolveOptions.mock.calls[1][0].activeProject).toBeNull()
    expect(await getDb().sessions.count()).toBe(1)
  })

  it("uses the bound session's project and journals its supplied host checkout without scratch", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:bound_project" })
    const session = await createPlatformSession(event, undefined)
    const own = project("own-project", "/own-root")
    await getDb().projects.bulkPut([own, project("other-project", "/other-root")])
    await getDb().sessions.update(session.id, { projectId: own.id })
    await saveSettings({ activeProjectId: "other-project" })
    resolveOptions.mockResolvedValueOnce({
      model: "claude-sonnet-5",
      cwd: "/host/project-checkout",
    })
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockImplementationOnce(
      async (_sessionId, _content, _opts, cap) => {
        await cap?.onEvent?.({
          type: "tool-call",
          id: "project-result",
          toolName: "Write",
          input: { file_path: "/host/project-checkout/results/result.txt" },
        })
        return { text: "done", messageId: "project-result" }
      }
    )

    await callHandler(event, "ai-run")

    expect(resolveOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        activeProject: expect.objectContaining({ id: own.id, roots: own.roots }),
      })
    )
    expect(mockEnsureSessionScratchWorkspace).not.toHaveBeenCalled()
    const run = await getDb().executionRuns.where("sessionId").equals(session.id).first()
    const events = await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()
    expect(events.find((item) => item.type === "tool.started")?.payload).toMatchObject({
      target: { kind: "workspace_path", label: "results/result.txt" },
    })
  })

  it("refuses a missing bound project without falling back to scratch or active project", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:missing_project" })
    const session = await createPlatformSession(event, undefined)
    await getDb().sessions.update(session.id, { projectId: "deleted-project" })
    await getDb().projects.put(project("project-default", "/default-root"))
    await saveSettings({ activeProjectId: "project-default" })

    await expect(callHandler(event, "ai-run")).rejects.toThrow(
      "Connector session project unavailable: deleted-project"
    )
    expect(resolveOptions).not.toHaveBeenCalled()
    expect(mockEnsureSessionScratchWorkspace).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
  })

  it("does not capture if the scratch binding was not persisted", async () => {
    mockEnsureSessionScratchWorkspace.mockResolvedValueOnce("/host/scratch/unpersisted")
    await expect(callHandler(makeEvent({}), "ai-run")).rejects.toThrow(
      "Connector session scratch binding unavailable:"
    )
    expect(resolveOptions).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
  })

  it("leaves desktop connector routing unchanged", async () => {
    headless.mockReturnValue(false)
    await callHandler(makeEvent({}), "ai-run")
    expect(mockEnsureSessionScratchWorkspace).not.toHaveBeenCalled()
    expect(resolveOptions.mock.calls[0][0]).not.toHaveProperty("activeProject")
    expect(resolveOptions.mock.calls[0][0].session.executionContext).toBeUndefined()
  })

  it("isolates Feishu threads and a /new rotation within the same thread", async () => {
    const event = (thread: string) =>
      makeEvent({
        platform: "lark",
        conversationKey: `lark:adapter_1:chat:${thread}`,
        conversationRef: {
          platform: "lark",
          adapterId: "adapter_1",
          channelId: "chat",
          channelKind: "private",
          threadRootMessageId: thread,
          threadTs: thread,
          replyInThread: true,
        },
      })
    const firstThread = event("thread-a")
    await callHandler(firstThread, "ai-run")
    await callHandler(event("thread-b"), "ai-run")
    const first = resolveOptions.mock.calls[0][0].session as ChatSession
    const second = resolveOptions.mock.calls[1][0].session as ChatSession

    const newCommand = { ...firstThread, plainText: "/new", messageId: "new-command" }
    expect(
      await maybeHandleControlCommand(
        newCommand,
        { id: "adapter_1", type: "lark" } as AdapterInstanceRow,
        undefined,
        RESOLVED,
        {
          enqueue: jest.fn(async () => undefined) as never,
          audit: jest.fn(async () => undefined) as never,
        }
      )
    ).toBe(true)
    await callHandler({ ...firstThread, messageId: "after-new" }, "ai-run")
    const rotated = resolveOptions.mock.calls[2][0].session as ChatSession
    expect(new Set([first.id, second.id, rotated.id]).size).toBe(3)
    expect(
      new Set(
        [first, second, rotated].map((session) => session.executionContext?.execution?.bundleId)
      ).size
    ).toBe(3)
    expect(rotated.platformConversationKey).toBe(first.platformConversationKey)
  })
})

describe("resolveRecoveryExecutionSpec", () => {
  const existingGateway: AgentExecutionSendSpec = {
    specVersion: 2,
    executionFingerprint: "aexf1-existing",
    runtimeAdapter: "claude-agent-sdk",
    executionKind: "agent",
    route: {
      kind: "gateway",
      endpoint: "http://127.0.0.1:24680/v1",
      ticketId: "ticket-old",
    },
    modelBindings: { primary: "claude-sonnet-5" },
    capabilities: { effective: [], disabledOptional: [] },
    identity: { runId: "run-old", attemptId: "a1" },
    hostRef: "desktop-sidecar",
  }

  it("reuses the initial gateway ticket but fails closed when recovery remint is unavailable", async () => {
    const sendOptions = {
      provider: "anthropic",
      model: "claude-sonnet-5",
      execution: existingGateway,
    }
    await expect(
      resolveRecoveryExecutionSpec(sendOptions as never, "session-1", { runId: "run-old" }, false)
    ).resolves.toBe(existingGateway)
    expect(mockMintSessionRouteTicket).not.toHaveBeenCalled()

    window.localStorage.setItem(
      "cognia-agent-execution-flags-v1",
      JSON.stringify({ gatewayAgentRouteTickets: true })
    )
    await expect(
      resolveRecoveryExecutionSpec(
        sendOptions as never,
        "session-1",
        { runId: "run-old", attemptId: "recovery-1" },
        true,
        "gateway"
      )
    ).rejects.toThrow("recovery_gateway_ticket_remint_failed")
    expect(mockMintSessionRouteTicket).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-1" })
    )

    mockMintSessionRouteTicket.mockClear()
    const provisionalDirect = {
      ...sendOptions,
      execution: {
        ...existingGateway,
        route: { kind: "direct" as const },
      },
    }
    await expect(
      resolveRecoveryExecutionSpec(
        provisionalDirect as never,
        "session-1",
        { runId: "run-old", attemptId: "recovery-2" },
        true,
        "gateway"
      )
    ).rejects.toThrow("recovery_gateway_ticket_remint_failed")
    expect(mockMintSessionRouteTicket).toHaveBeenCalledTimes(1)
  })
})

describe("installRuntime — ai-run (happy path)", () => {
  it.each([
    ["group", "canonical"],
    ["group", "journal"],
    ["reply", "canonical"],
    ["reply", "journal"],
  ] as const)(
    "refuses recalled %s context accepted through %s during capture preparation",
    async (context, acceptance) => {
      const parent = (context === "group" ? groupEvent : makeEvent)({
        messageId: "earlier-context",
        plainText: "WITHDRAWN_CONTEXT_SECRET",
        segments: [{ type: "text", text: "WITHDRAWN_CONTEXT_SECRET" }],
      })
      await callHandler(parent, "manual-store")
      const parentRow = (await getDb().messages.toArray())[0]!
      if (context === "group") {
        const next = await createPlatformSession(parent, undefined)
        await upsertByConversationKey({
          conversationKey: parent.conversationKey,
          sessionId: parentRow.sessionId,
          activeSessionId: next.id,
        })
      }
      const event = {
        ...parent,
        messageId: "current-context-source",
        plainText: "CURRENT_SOURCE",
        segments: [{ type: "text" as const, text: "CURRENT_SOURCE" }],
        ...(context === "reply" ? { replyTo: { messageId: parent.messageId, snippet: "" } } : {}),
      }
      const job = await enqueueConnectorInboundJob(event, "queue")
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const send = jest.fn()
      let preparedPrompt: unknown
      installRuntime(getBus(), {
        runAndCapture: async (_session, prompt, _options, cap) => {
          preparedPrompt = prompt
          entered()
          await blocked
          await cap?.beforeSend?.()
          send(prompt)
          return { text: "stale reply", messageId: "stale-reply" }
        },
      })
      const pending = callHandler(event, "ai-run", RESOLVED, job.id)
      const standalone = jest.spyOn(standaloneMode, "isStandaloneChatMode").mockReturnValue(true)
      try {
        await Promise.race([
          ready,
          pending.then(() => {
            throw new Error("Dispatch finished before capture preparation")
          }),
        ])
        expect(JSON.stringify(preparedPrompt)).toContain("WITHDRAWN_CONTEXT_SECRET")
        const recall = {
          ...parent,
          kind: "delete" as const,
          replacesMessageId: parent.messageId,
          messageId: "context-recall",
          segments: [],
          plainText: "",
        }
        if (acceptance === "canonical") await getBus().dispatchInboundFull(recall)
        else await recordConnectorInboundRecall(recall, Date.now())
        expect(
          (await getDb().sessions.get(parentRow.sessionId))?.runtimeTranscriptGeneration
        ).toBeUndefined()
        release()
        await pending
        expect(send).not.toHaveBeenCalled()
        expect(await getDb().outboundQueue.count()).toBe(0)
        expect((await getDb().connectorInboundJobs.get(job.id))?.status).toBe("recovery_required")
        const current = await getDb()
          .messages.where("platformMessageId")
          .equals(event.messageId)
          .first()
        expect(current?.parts).toEqual([{ type: "text", text: "CURRENT_SOURCE" }])
        expect(current?.metadata?.deletedAt).toBeUndefined()
      } finally {
        release()
        await pending
        standalone.mockRestore()
      }
    }
  )

  it("admits a turn despite unmatched or unrelated pending context mutations", async () => {
    const unrelated = makeEvent({
      conversationKey: "telegram:adapter_1:unrelated-context",
      messageId: "unrelated-parent",
    })
    await callHandler(unrelated, "manual-store")
    await recordConnectorInboundRecall(
      {
        ...unrelated,
        kind: "delete",
        replacesMessageId: unrelated.messageId,
      },
      Date.now()
    )
    const event = makeEvent({ messageId: "unmatched-context-source" })
    await recordConnectorInboundRecall(
      {
        ...event,
        kind: "delete",
        replacesMessageId: "not-yet-received-parent",
      },
      Date.now()
    )
    const send = jest.fn()
    installRuntime(getBus(), {
      runAndCapture: async (_session, prompt, _options, cap) => {
        await cap?.beforeSend?.()
        send(prompt)
        return { text: "current reply", messageId: "current-reply" }
      },
    })
    await callHandler(event, "ai-run")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(["edit", "delete"] as const)(
    "refreshes a local reply parent after a %s during earlier routing preparation",
    async (kind) => {
      const parent = makeEvent({
        messageId: "early-reply-parent",
        plainText: "OUTDATED_REPLY_SECRET",
        segments: [{ type: "text", text: "OUTDATED_REPLY_SECRET" }],
      })
      await callHandler(parent, "manual-store")
      const event = makeEvent({
        messageId: "early-reply-source",
        replyTo: { messageId: parent.messageId, snippet: "" },
      })
      const job = await enqueueConnectorInboundJob(event, "queue")
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      mockBeforePermissionCeiling.mockImplementationOnce(async () => {
        entered()
        await blocked
      })
      const send = jest.fn()
      installRuntime(getBus(), {
        runAndCapture: async (_session, prompt, _options, cap) => {
          await cap?.beforeSend?.()
          send(prompt)
          return { text: "current reply", messageId: "current-reply" }
        },
      })
      const pending = callHandler(event, "ai-run", RESOLVED, job.id)
      try {
        await Promise.race([
          ready,
          pending.then(() => {
            throw new Error("Dispatch finished before routing preparation")
          }),
        ])
        await getBus().dispatchInboundFull({
          ...parent,
          kind,
          messageId: "early-parent-mutation",
          replacesMessageId: parent.messageId,
          timestamp: parent.timestamp + 1,
          plainText: kind === "edit" ? "LATEST_PARENT" : "",
          segments: kind === "edit" ? [{ type: "text", text: "LATEST_PARENT" }] : [],
        })
        release()
        await pending
        expect(send).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(send.mock.calls)).not.toContain("OUTDATED_REPLY_SECRET")
        expect(send).toHaveBeenCalledWith(
          expect.stringContaining(kind === "edit" ? "LATEST_PARENT" : "[deleted]")
        )
      } finally {
        release()
        await pending
      }
    }
  )

  it("refuses a same-clock media edit accepted during the final canonical read", async () => {
    const image = (dataBase64: string) => ({
      type: "image" as const,
      url: `data:image/png;base64,${dataBase64}`,
      dataBase64,
      mimeType: "image/png",
    })
    const event = makeEvent({
      platform: "onebot",
      conversationKey: "onebot:adapter_1:g:42",
      messageId: "same-clock-media",
      timestamp: 20,
      plainText: "[image]",
      segments: [image("AAAA")],
    })
    const job = await enqueueConnectorInboundJob(event, "queue")
    await recordConnectorInboundEdit({
      ...event,
      kind: "edit",
      messageId: "first-edit",
      replacesMessageId: event.messageId,
    })
    await callHandler(event, "manual-store")
    const source = (await getDb().messages.toArray())[0]!
    expect(source.metadata?.inboundMutationRevision).toEqual({ jobId: job.id, revision: 1 })
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = jest.fn()
    installRuntime(getBus(), {
      runAndCapture: async (_session, _prompt, _options, cap) => {
        const messages = getDb().messages
        const originalGet = messages.get.bind(messages)
        const read = jest.spyOn(messages, "get").mockImplementationOnce((async (key: string) => {
          const snapshot = await originalGet(key)
          entered()
          await blocked
          return snapshot
        }) as never)
        try {
          await cap?.beforeSend?.()
          send()
          return { text: "stale reply", messageId: "stale-reply" }
        } finally {
          read.mockRestore()
        }
      },
    })
    const pending = callHandler(event, "ai-run", RESOLVED, job.id)
    try {
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error("Dispatch finished before the final canonical read")
        }),
      ])
      await recordConnectorInboundEdit({
        ...event,
        kind: "edit",
        messageId: "second-edit",
        replacesMessageId: event.messageId,
        segments: [image("BBBB")],
      })
      release()
      await pending
      expect(send).not.toHaveBeenCalled()
      const currentJob = await getDb().connectorInboundJobs.get(job.id)
      expect(currentJob?.mutationRevision).toBe(2)
      expect(currentJob?.status).toBe("recovery_required")
      expect((await getDb().messages.get(source.id))?.metadata?.inboundMutationRevision).toEqual({
        jobId: job.id,
        revision: 1,
      })
      expect(await getDb().outboundQueue.count()).toBe(0)
    } finally {
      release()
      await pending
    }
  })

  it.each(["previous edit", "original"] as const)(
    "refuses a Matrix source while a journaled edit redaction rolls back to %s",
    async (fallback) => {
      const parse = (
        event_id: string,
        type: string,
        at: number,
        content: Record<string, unknown>
      ) =>
        parseMatrixEvent("matrix", "@bot:srv", "!room:srv", {
          type,
          event_id,
          sender: "@alice:srv",
          origin_server_ts: at,
          content,
          ...(type === "m.room.redaction" ? { redacts: "$latest" } : {}),
        })!
      const event = parse("$source", "m.room.message", 1, { msgtype: "m.text", body: "original" })
      const job = await enqueueConnectorInboundJob(event, "queue")
      if (fallback === "previous edit") {
        await recordConnectorInboundEdit(
          parse("$previous", "m.room.message", 2, {
            "m.relates_to": { rel_type: "m.replace", event_id: "$source" },
            "m.new_content": { msgtype: "m.text", body: "previous" },
          })
        )
      }
      await recordConnectorInboundEdit(
        parse("$latest", "m.room.message", 3, {
          "m.relates_to": { rel_type: "m.replace", event_id: "$source" },
          "m.new_content": { msgtype: "m.text", body: "latest" },
        })
      )
      await callHandler(event, "manual-store")
      const source = (await getDb().messages.toArray())[0]!
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const send = jest.fn()
      installRuntime(getBus(), {
        runAndCapture: async (_session, _prompt, _options, cap) => {
          const messages = getDb().messages
          const originalGet = messages.get.bind(messages)
          const read = jest.spyOn(messages, "get").mockImplementationOnce((async (key: string) => {
            const snapshot = await originalGet(key)
            entered()
            await blocked
            return snapshot
          }) as never)
          try {
            await cap?.beforeSend?.()
            send()
            return { text: "stale reply", messageId: "stale-reply" }
          } finally {
            read.mockRestore()
          }
        },
      })
      const pending = callHandler(event, "ai-run", RESOLVED, job.id)
      try {
        await Promise.race([
          ready,
          pending.then(() => {
            throw new Error("Dispatch finished before the final canonical read")
          }),
        ])
        await recordConnectorInboundRecall(parse("$redaction", "m.room.redaction", 4, {}), 4)
        release()
        await pending
        expect(send).not.toHaveBeenCalled()
        expect((await getDb().messages.get(source.id))?.parts).toEqual([
          { type: "text", text: "latest" },
        ])
        const currentJob = await getDb().connectorInboundJobs.get(job.id)
        expect(currentJob?.status).toBe("recovery_required")
        expect(currentJob?.recalledAt).toBeUndefined()
        expect(currentJob?.pendingEdit?.plainText).toBe(
          fallback === "previous edit" ? "previous" : undefined
        )
        expect(await getDb().outboundQueue.count()).toBe(0)
      } finally {
        release()
        await pending
      }
    }
  )

  it.each(
    (["dingtalk", "wecom", "onebot", "qq-official", "matrix"] as const).flatMap((platform) =>
      (["edit", "delete"] as const).map((kind) => [platform, kind] as const)
    )
  )("refuses a journaled %s %s during the final canonical read", async (platform, kind) => {
    const event = makeEvent({
      platform,
      conversationKey: `${platform}:adapter_1:journaled-source`,
      messageId: "journaled-source",
    })
    await callHandler(event, "manual-store")
    const source = (await getDb().messages.toArray())[0]!
    const job = await enqueueConnectorInboundJob(event, "queue")
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const send = jest.fn()
    installRuntime(getBus(), {
      runAndCapture: async (_session, _prompt, _options, cap) => {
        const messages = getDb().messages
        const originalGet = messages.get.bind(messages)
        const read = jest.spyOn(messages, "get").mockImplementationOnce((async (key: string) => {
          const snapshot = await originalGet(key)
          entered()
          await blocked
          return snapshot
        }) as never)
        try {
          await cap?.beforeSend?.()
          send()
          return { text: "stale reply", messageId: "stale-reply" }
        } finally {
          read.mockRestore()
        }
      },
    })
    const pending = callHandler(event, "ai-run", RESOLVED, job.id)
    try {
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error("Dispatch finished before the final canonical read")
        }),
      ])
      const mutation = {
        ...event,
        kind,
        messageId: "accepted-mutation",
        replacesMessageId: event.messageId,
        timestamp: event.timestamp + 1,
        segments: kind === "edit" ? [{ type: "text" as const, text: "latest" }] : [],
        plainText: kind === "edit" ? "latest" : "",
      }
      if (kind === "edit") await recordConnectorInboundEdit(mutation)
      else await recordConnectorInboundRecall(mutation, mutation.timestamp)
      release()
      await pending
      expect(send).not.toHaveBeenCalled()
      expect(await getDb().outboundQueue.count()).toBe(0)
      expect((await getDb().messages.get(source.id))?.parts).toEqual(source.parts)
      const currentJob = await getDb().connectorInboundJobs.get(job.id)
      if (kind === "edit") expect(currentJob?.status).toBe("recovery_required")
      else {
        expect(currentJob?.recalledAt).toBe(mutation.timestamp)
        expect(currentJob?.status).not.toBe("recovery_required")
      }
    } finally {
      release()
      await pending
    }
  })

  it.each([
    ["team", "edit"],
    ["team", "delete"],
    ["workflow", "edit"],
    ["workflow", "delete"],
  ] as const)("does not start %s after a %s during routing preparation", async (target, kind) => {
    mockStartTeamRunFromIM.mockClear()
    mockStartWorkflowFromIM.mockClear()
    const event = makeEvent({ messageId: `${target}-${kind}-preparing` })
    await callHandler(event, "manual-store")
    const source = await getDb().messages.where("platformMessageId").equals(event.messageId).first()
    await upsertByConversationKey({
      conversationKey: event.conversationKey,
      sessionId: source!.sessionId,
      ...(target === "team" ? { teamId: "team" } : { workflowId: "workflow" }),
    })
    const job = await enqueueConnectorInboundJob(event, "queue")
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    mockBeforePermissionCeiling.mockImplementationOnce(async () => {
      entered()
      await blocked
    })
    const pending = callHandler(event, "ai-run", RESOLVED, job.id)
    try {
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error("Dispatch finished before routing preparation")
        }),
      ])
      await getBus().dispatchInboundFull({
        ...event,
        kind,
        messageId: `${target}-${kind}-mutation`,
        replacesMessageId: event.messageId,
        timestamp: Date.now() + 1,
        segments: kind === "edit" ? [{ type: "text", text: "latest" }] : [],
        plainText: kind === "edit" ? "latest" : "",
      })
      release()
      await pending
      expect(mockStartTeamRunFromIM).not.toHaveBeenCalled()
      expect(mockStartWorkflowFromIM).not.toHaveBeenCalled()
      if (kind === "edit")
        expect((await getDb().connectorInboundJobs.get(job.id))?.status).toBe("recovery_required")
    } finally {
      release()
      await pending
    }
  })
  it.each(["edit", "delete"] as const)(
    "refuses a stale source after a %s inside capture preparation",
    async (kind) => {
      const event = makeEvent({ messageId: "late-preparing-source" })
      await callHandler(event, "manual-store")
      const job = await enqueueConnectorInboundJob(event, "queue")
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const send = jest.fn()
      installRuntime(getBus(), {
        runAndCapture: async (_session, _prompt, _options, cap) => {
          entered()
          await blocked
          await cap?.beforeSend?.()
          send()
          return { text: "stale reply", messageId: "stale-reply" }
        },
      })
      const pending = callHandler(event, "ai-run", RESOLVED, job.id)
      try {
        await ready
        await getBus().dispatchInboundFull({
          ...event,
          kind,
          messageId: "late-mutation",
          replacesMessageId: event.messageId,
          timestamp: Date.now() + 1,
          segments: kind === "edit" ? [{ type: "text", text: "latest" }] : [],
          plainText: kind === "edit" ? "latest" : "",
        })
        release()
        await pending
        expect(send).not.toHaveBeenCalled()
        expect(await getDb().outboundQueue.count()).toBe(0)
        if (kind === "edit")
          expect((await getDb().connectorInboundJobs.get(job.id))?.status).toBe("recovery_required")
      } finally {
        release()
        await pending
      }
    }
  )
  it.each(["edit", "delete"] as const)(
    "does not dispatch stale content after a %s during preparation",
    async (kind) => {
      const event = makeEvent({
        messageId: "preparing-source",
        plainText: "ORIGINAL_BODY",
        segments: [{ type: "text", text: "ORIGINAL_BODY" }],
      })
      await callHandler(event, "manual-store")
      const job = await enqueueConnectorInboundJob(event, "queue")
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      const resolveOptions = buildOptions.resolveSendOptions
      const spy = jest
        .spyOn(buildOptions, "resolveSendOptions")
        .mockImplementationOnce(async (...args) => {
          entered()
          await blocked
          return resolveOptions(...args)
        })
      const pending = callHandler(event, "ai-run", RESOLVED, job.id)
      try {
        await ready
        await getBus().dispatchInboundFull({
          ...event,
          kind,
          messageId: "mutation",
          replacesMessageId: event.messageId,
          timestamp: Date.now() + 1,
          segments: kind === "edit" ? [{ type: "text", text: "LATEST_BODY" }] : [],
          plainText: kind === "edit" ? "LATEST_BODY" : "",
        })
        release()
        await pending
        expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
        if (kind === "edit")
          expect((await getDb().connectorInboundJobs.get(job.id))?.status).toBe("recovery_required")
      } finally {
        release()
        await pending
        spy.mockRestore()
      }
    }
  )
  it("creates a ChatSession with platformBinding", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].platformBinding?.conversationKey).toBe("telegram:adapter_1:chat_ai")
    expect(sessions[0].platformBinding?.platform).toBe("telegram")
    expect(sessions[0].characterId).toBe("char_abc")
  })

  it("stamps the bot-default SLA deadline right after the first platform session is created (slice 1B)", async () => {
    await seedAdapter("adapter_sla", { defaultSlaResponseMinutes: 20 } as never)
    const event = makeEvent({
      adapterId: "adapter_sla",
      conversationKey: "telegram:adapter_sla:chat_first",
      timestamp: 1_000_000,
    })
    await callHandler(event, "ai-run")
    const row = await readForResolution("telegram:adapter_sla:chat_first")
    expect(row?.nextResponseDueAt).toBe(1_000_000 + 20 * 60_000)

    // Second inbound: the session exists, so the runtime does not re-stamp
    // (the bus owns the per-inbound refresh); the deadline is untouched.
    await callHandler(
      makeEvent({
        adapterId: "adapter_sla",
        conversationKey: "telegram:adapter_sla:chat_first",
        messageId: "msg_second",
        timestamp: 2_000_000,
      }),
      "ai-run"
    )
    expect((await readForResolution("telegram:adapter_sla:chat_first"))?.nextResponseDueAt).toBe(
      1_000_000 + 20 * 60_000
    )
  })

  it("does not create an SLA deadline when the adapter has no default SLA", async () => {
    await seedAdapter("adapter_nosla")
    await callHandler(
      makeEvent({ adapterId: "adapter_nosla", conversationKey: "telegram:adapter_nosla:c" }),
      "ai-run"
    )
    expect((await readForResolution("telegram:adapter_nosla:c"))?.nextResponseDueAt).toBeUndefined()
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

  it("reuses the same inbound StoredMessage when a failed live steer falls back to FIFO", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_ai",
      messageId: "msg_idempotent_steer",
    })
    const session = await getDb().sessions.add({
      id: "session-steer",
      title: "Steer",
      createdAt: 1,
      updatedAt: 1,
    } as never)

    await insertInboundMessage(event, String(session))
    await insertInboundMessage(event, String(session))

    expect(await getDb().messages.where("platformMessageId").equals(event.messageId).count()).toBe(
      1
    )
  })

  it("stores outgoing OneBot history as assistant without changing live inbound roles", async () => {
    await getDb().sessions.add({
      id: "snow-history-roles",
      title: "History",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const event = parseV11HistoryMessage(
      "adapter_1",
      {
        message_id: -100,
        time: 1,
        message_type: "private",
        user_id: 100000,
        sender: { user_id: 100000, nickname: "Self" },
        message: [{ type: "text", data: { text: "historical reply" } }],
      },
      { selfId: 100000, chatId: 200001, messageType: "private" }
    )!
    expect((await insertInboundMessage(event, "snow-history-roles", 10)).role).toBe("assistant")
    expect(
      (
        await insertInboundMessage(
          { ...event, messageId: "-101", channelData: undefined },
          "snow-history-roles",
          11
        )
      ).role
    ).toBe("user")
    expect(
      (
        await insertInboundMessage(
          { ...event, messageId: "-102", sender: { ...event.sender, remoteUserId: "200001" } },
          "snow-history-roles",
          12
        )
      ).role
    ).toBe("user")
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
  })

  it("keeps one OneBot history source in its original session across load-earlier and recall", async () => {
    const event = parseV11Event("adapter_1", {
      post_type: "message",
      message_type: "group",
      self_id: 1,
      user_id: 2,
      group_id: 42,
      message_id: 77,
      time: 1,
      message: [{ type: "text", data: { text: "original" } }],
    })!
    for (const id of ["onebot-original", "onebot-later"]) {
      await getDb().sessions.add({ id, title: id, createdAt: 1, updatedAt: 1 } as never)
    }
    const original = await insertInboundMessage(event, "onebot-original")
    const loaded = await insertInboundMessage(event, "onebot-later")
    await getBus().dispatchInboundFull(
      parseV11Event("adapter_1", {
        post_type: "notice",
        notice_type: "group_recall",
        self_id: 1,
        user_id: 2,
        group_id: 42,
        message_id: 77,
        time: 2,
      })!
    )
    const rows = await getDb().messages.where("platformMessageId").equals(event.messageId).toArray()
    expect(loaded.id).toBe(original.id)
    expect(loaded.sessionId).toBe("onebot-original")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.metadata?.deletedAt).toBeDefined()
    expect(rows[0]?.parts).toEqual([{ type: "text", text: "[deleted]" }])
  })

  it("deduplicates concurrent OneBot history inserts across different sessions", async () => {
    const event = makeEvent({
      platform: "onebot",
      conversationKey: "onebot:adapter_1:g:42",
      messageId: "onebot-concurrent-source",
    })
    for (const id of ["onebot-first", "onebot-second"]) {
      await getDb().sessions.add({ id, title: id, createdAt: 1, updatedAt: 1 } as never)
    }
    const [first, second] = await Promise.all([
      insertInboundMessage(event, "onebot-first"),
      insertInboundMessage(event, "onebot-second"),
    ])
    expect(first.id).toBe(second.id)
    expect(first.sessionId).toBe(second.sessionId)
    expect(await getDb().messages.where("platformMessageId").equals(event.messageId).count()).toBe(
      1
    )
    const states = await getDb().sessionState.toArray()
    expect(states.reduce((total, state) => total + state.unreadCount, 0)).toBe(1)
  })

  it.each(["adapter", "conversation", "legacy-other", "legacy-same"] as const)(
    "preserves %s scope when reusing a canonical history source",
    async (scope) => {
      const event = makeEvent({
        platform: "onebot",
        conversationKey: "onebot:adapter_1:g:42",
        messageId: "scoped-history-source",
      })
      await getDb().sessions.bulkAdd(
        ["scope-original", "scope-later"].map((id) => ({
          id,
          title: id,
          createdAt: 1,
          updatedAt: 1,
          platformConversationKey: event.conversationKey,
        })) as never
      )
      const original = await insertInboundMessage(event, "scope-original")
      if (scope.startsWith("legacy")) {
        const {
          adapterId: _adapter,
          conversationKey: _conversation,
          ...legacy
        } = original.metadata!.platformMessage!
        await getDb().messages.update(original.id, {
          metadata: { ...original.metadata, platformMessage: legacy },
        })
      }
      const replay = {
        ...event,
        ...(scope === "adapter"
          ? { adapterId: "adapter_2", conversationKey: "onebot:adapter_2:g:42" }
          : scope === "conversation" || scope === "legacy-other"
            ? { conversationKey: "onebot:adapter_1:g:43" }
            : {}),
      }
      const loaded = await insertInboundMessage(replay, "scope-later")
      const count = await getDb()
        .messages.where("platformMessageId")
        .equals(event.messageId)
        .count()
      if (scope === "legacy-same") {
        expect(loaded.id).toBe(original.id)
        expect(loaded.sessionId).toBe("scope-original")
        expect(count).toBe(1)
      } else {
        expect(loaded.id).not.toBe(original.id)
        expect(loaded.sessionId).toBe("scope-later")
        expect(count).toBe(2)
      }
    }
  )

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "uses the edited canonical source during retry after session switch=%s legacy=%s",
    async (switched, legacy) => {
      const create = parseMatrixEvent("adapter_1", "@bot:srv", "!room:srv", {
        type: "m.room.message",
        event_id: "$source",
        sender: "@alice:srv",
        origin_server_ts: 1,
        content: { msgtype: "m.text", body: "ORIGINAL_BODY" },
      })!
      await callHandler(create, "manual-store")
      const original = (await getDb().messages.toArray())[0]
      await getBus().dispatchInboundFull(
        parseMatrixEvent("adapter_1", "@bot:srv", "!room:srv", {
          type: "m.room.message",
          event_id: "$edit",
          sender: "@alice:srv",
          origin_server_ts: 2,
          content: {
            "m.relates_to": { rel_type: "m.replace", event_id: "$source" },
            "m.new_content": { msgtype: "m.text", body: "LATEST_BODY" },
          },
        })!
      )
      if (legacy) {
        const row = (await getDb().messages.get(original.id))!
        const {
          adapterId: _adapter,
          conversationKey: _key,
          ...platformMessage
        } = row.metadata!.platformMessage!
        await getDb().messages.update(row.id, { metadata: { ...row.metadata, platformMessage } })
      }
      if (switched) {
        const next = await createPlatformSession(create, undefined)
        await upsertByConversationKey({
          conversationKey: create.conversationKey,
          sessionId: original.sessionId,
          activeSessionId: next.id,
        })
      }
      await callHandler(create, "ai-run")
      expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledWith(
        original.sessionId,
        expect.stringContaining("LATEST_BODY"),
        expect.anything(),
        expect.anything()
      )
      expect(JSON.stringify((DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls)).not.toContain(
        "ORIGINAL_BODY"
      )
      expect(
        await getDb().messages.where("platformMessageId").equals(create.messageId).count()
      ).toBe(1)
    }
  )

  it("keeps display image bytes out of replayed message parts", async () => {
    await getDb().sessions.add({
      id: "display-media",
      title: "Media",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const event = makeEvent({
      platform: "lark",
      messageId: "display-image",
      raw: { event: { message: { message_type: "image" } } },
      segments: [{ type: "image", url: "key", dataBase64: "AAAA", mimeType: "image/png" }],
      plainText: "[image]",
    })
    const row = await insertInboundMessage(event, "display-media")
    expect(row.parts).toEqual([{ type: "text", text: "[image: key]" }])
    expect(JSON.stringify(row.parts)).not.toContain("base64")
    expect(row.metadata?.inboundA2UI).toMatchObject({
      body: [{ displayUrl: "data:image/png;base64,AAAA" }],
    })
  })

  it("retains the original Matrix reply when a valid early edit follows a foreign edit", async () => {
    await getDb().sessions.add({
      id: "matrix-reply",
      title: "Matrix",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const parse = (
      event_id: string,
      content: Record<string, unknown>,
      sender = "@alice:srv",
      origin_server_ts = 1
    ) =>
      parseMatrixEvent("matrix", "@bot:srv", "!room:srv", {
        type: "m.room.message",
        event_id,
        content,
        sender,
        origin_server_ts,
      })!
    const parent = await insertInboundMessage(
      parse("$parent", { msgtype: "m.text", body: "parent text" }),
      "matrix-reply"
    )
    const create = parse("$original", {
      msgtype: "m.text",
      body: "original",
      "m.relates_to": { "m.in_reply_to": { event_id: "$parent" } },
    })
    const content = {
      "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      "m.new_content": { msgtype: "m.text", body: "edited" },
    }
    await recordConnectorInboundEdit(parse("$forged", content, "@mallory:srv", 4))
    await recordConnectorInboundEdit(parse("$edited", content, "@alice:srv", 3))
    const stored = await insertInboundMessage(create, "matrix-reply")
    expect(stored.parts).toEqual([{ type: "text", text: "edited" }])
    expect(stored.metadata?.inboundEditBase).toMatchObject({
      parts: [{ type: "text", text: "original" }],
    })
    expect(stored.metadata?.replyTo).toMatchObject({ messageId: parent.id, preview: "parent text" })
    const mutation = (await getDb().connectorInboundJobs.toArray()).find(
      (job) => job.sourceMessageId === create.messageId
    )!
    expect(mutation.appliedMutationRevision).toBe(mutation.mutationRevision)
  })

  it.each([false, true])(
    "retains early Matrix revision history after create and job pruning with all-redacted=%s",
    async (allRedacted) => {
      const parse = (event_id: string, body: string, at: number, target?: string) =>
        parseMatrixEvent("matrix", "@bot:srv", "!room:srv", {
          type: "m.room.message",
          event_id,
          sender: "@alice:srv",
          origin_server_ts: at,
          content: target
            ? {
                "m.relates_to": { rel_type: "m.replace", event_id: target },
                "m.new_content": { msgtype: "m.text", body },
              }
            : { msgtype: "m.text", body },
        })!
      const recall = (target: string) =>
        parseMatrixEvent("matrix", "@bot:srv", "!room:srv", {
          type: "m.room.redaction",
          event_id: `$redact-${target}`,
          sender: "@alice:srv",
          origin_server_ts: 4,
          redacts: target,
          content: {},
        })!
      const original = parse("$early-original", "original", 1)
      const first = parse("$early-first", "first", 2, "$early-original")
      const latest = parse("$early-latest", "latest", 3, "$early-original")
      await recordConnectorInboundEdit(first)
      await recordConnectorInboundEdit(latest)
      if (allRedacted) {
        await recordConnectorInboundRecall(recall("$early-first"), 4)
        await recordConnectorInboundRecall(recall("$early-latest"), 4)
      }
      await getDb().sessions.add({
        id: "early-history",
        title: "history",
        createdAt: 1,
        updatedAt: 1,
      } as never)
      const stored = await insertInboundMessage(original, "early-history")
      const history = stored.metadata?.inboundMatrixRevisions as {
        edits: Record<string, { parts: unknown; inboundA2UI?: { raw?: unknown } }>
        redactedEditIds: string[]
      }
      expect(Object.keys(history.edits).sort()).toEqual([first.messageId, latest.messageId].sort())
      expect(history.edits[first.messageId]?.parts).toEqual([{ type: "text", text: "first" }])
      expect(history.edits[latest.messageId]?.inboundA2UI?.raw).toBeUndefined()
      expect(history.redactedEditIds).toEqual(
        allRedacted ? [first.messageId, latest.messageId] : []
      )
      expect(stored.metadata?.inboundEditBase).toMatchObject({
        parts: [{ type: "text", text: "original" }],
      })
      await getDb().connectorInboundJobs.clear()
      await getBus().dispatchInboundFull(recall("$early-latest"))
      expect((await getDb().messages.get(stored.id))?.parts).toEqual([
        { type: "text", text: allRedacted ? "original" : "first" },
      ])
    }
  )

  it("persists each QQ reply body and attachment once through the actual parser", async () => {
    await getDb().sessions.add({
      id: "qq-history",
      title: "QQ",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const event = parseQQDispatch("qq", "bot", {
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "message",
        author: { user_openid: "user" },
        content: "hello",
        message_reference: { message_id: "parent" },
        attachments: [{ url: "https://cdn/voice", content_type: "voice" }],
      },
    })!
    const row = await insertInboundMessage(event, "qq-history")
    const texts = row.parts.map((part) => (part.type === "text" ? part.text : ""))
    expect(texts).toEqual(["[reply:]", "hello", "[voice]"])
    expect(texts.join("\n").match(/hello/g)).toHaveLength(1)
    expect(row.metadata?.replyTo).toMatchObject({ platformMessageId: "parent" })
  })

  it("stores a terminal tombstone when recall beats the queued create", async () => {
    await getDb().sessions.add({
      id: "recall-before-create",
      title: "Recall",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const event = makeEvent({
      messageId: "late-create",
      plainText: "withdrawn secret",
      segments: [{ type: "text", text: "withdrawn secret" }],
    })
    await getBus().dispatchInboundFull({
      ...event,
      kind: "delete",
      replacesMessageId: event.messageId,
      segments: [],
      plainText: "",
    })
    const row = await insertInboundMessage(event, "recall-before-create")
    expect(row.parts).toEqual([{ type: "text", text: "[deleted]" }])
    expect(row.metadata?.deletedAt).toBeDefined()
    expect((await getDb().sessions.get("recall-before-create"))?.lastMessagePreview).toBe(
      "[deleted]"
    )
    const mutation = (await getDb().connectorInboundJobs.toArray()).find(
      (job) => job.sourceMessageId === event.messageId
    )!
    expect(mutation.appliedMutationRevision).toBe(mutation.mutationRevision)
    const duplicate = await insertInboundMessage(event, "recall-before-create")
    expect(duplicate.id).toBe(row.id)
    expect(duplicate.parts).toEqual(row.parts)
    expect(duplicate.metadata?.deletedAt).toBe(row.metadata?.deletedAt)
  })

  it("uses the latest edit for a create waiting to enter the transcript and prompt", async () => {
    const event = makeEvent({
      messageId: "queued-edit",
      plainText: "original secret",
      segments: [{ type: "text", text: "original secret" }],
    })
    await enqueueConnectorInboundJob(event, "queue")
    await getBus().dispatchInboundFull({
      ...event,
      kind: "edit",
      replacesMessageId: event.messageId,
      timestamp: event.timestamp + 1,
      plainText: "edited question",
      segments: [{ type: "text", text: "edited question" }],
    })
    await callHandler(event, "ai-run")
    const row = await getDb().messages.where("platformMessageId").equals(event.messageId).first()
    expect(row?.parts).toEqual([{ type: "text", text: "edited question" }])
    const mutation = (await getDb().connectorInboundJobs.toArray()).find(
      (job) => job.sourceMessageId === event.messageId
    )!
    expect(mutation.appliedMutationRevision).toBe(mutation.mutationRevision)
    expect(DEFAULT_RUN_AND_CAPTURE).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("edited question"),
      expect.anything(),
      expect.anything()
    )
    expect(JSON.stringify((DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls)).not.toContain(
      "original secret"
    )
  })

  it("persists plugin inbound labels onto the message row", async () => {
    const session = await getDb().sessions.add({
      id: "session-labels",
      title: "Labels",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const labels = [
      { key: "spam", score: 0.97, severity: "high" as const, label: "Spam", source: "laya", at: 1 },
    ]
    const row = await insertInboundMessage(
      { ...makeEvent({ messageId: "msg_labels" }), inboundLabels: labels },
      String(session)
    )
    expect(row.metadata?.inboundLabels).toEqual(labels)
    const plain = await insertInboundMessage(makeEvent({ messageId: "msg_plain" }), String(session))
    expect(plain.metadata).not.toHaveProperty("inboundLabels")
  })

  it("keeps an inbound reply as a replyTo reference, resolved to the stored parent", async () => {
    const session = await getDb().sessions.add({
      id: "session-reply",
      title: "Reply",
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const parent = makeEvent({
      conversationKey: "telegram:adapter_1:chat_reply",
      messageId: "msg_parent",
      segments: [{ type: "text", text: "should we ship?" }],
      plainText: "should we ship?",
    })
    await insertInboundMessage(parent, String(session))
    const stored = await getDb().messages.where("platformMessageId").equals("msg_parent").first()
    const reply = makeEvent({
      conversationKey: "telegram:adapter_1:chat_reply",
      messageId: "msg_reply",
      replyTo: { messageId: "msg_parent", snippet: "should we…" },
    })
    const row = await insertInboundMessage(reply, String(session))
    expect(row.metadata?.replyTo).toEqual({
      messageId: stored?.id,
      preview: "should we ship?",
      platformMessageId: "msg_parent",
    })
    // A parent that was never stored keeps the platform id and snippet.
    const orphan = makeEvent({
      conversationKey: "telegram:adapter_1:chat_reply",
      messageId: "msg_orphan",
      replyTo: { messageId: "msg_gone", snippet: "older text" },
    })
    expect((await insertInboundMessage(orphan, String(session))).metadata?.replyTo).toEqual({
      messageId: "msg_gone",
      preview: "older text",
      platformMessageId: "msg_gone",
    })
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

  it("replays a durable steer as one framed turn at the safe boundary", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    event.channelData = { dispatchIntent: "steer-replay" }
    await callHandler(event, "ai-run")

    const [, content] = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0]
    expect(content).toBe("By the way (steering): hello runtime")
  })

  it("wires a HITL onPermissionRequest responder + raised timeout into the capture options", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" })
    await callHandler(event, "ai-run")

    const cap = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][3] as {
      onPermissionRequest?: unknown
      timeoutMs?: number
      idleTimeoutMs?: number
      adapterId?: string
      conversationKey?: string
    }
    expect(typeof cap.onPermissionRequest).toBe("function")
    expect(cap.timeoutMs).toBeGreaterThan(5 * 60 * 1000)
    // Read watchdog must be wired: `idleTimeoutMs` defaults to 0 in the capture
    // (armIdle() no-ops), so omitting it left the 15-min wall clock as the only
    // backstop and a silent provider stream stalled the IM thread that long.
    // Well under the wall clock, since the watchdog stands down for permission
    // waits and in-flight tools.
    expect(cap.idleTimeoutMs).toBeGreaterThan(0)
    expect(cap.idleTimeoutMs).toBeLessThan(cap.timeoutMs!)
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

  it("enqueues textual A2UI as a surface when capture has no tool-created surfaces", async () => {
    jest.mocked(DEFAULT_RUN_AND_CAPTURE).mockResolvedValueOnce({
      text: `Summary\n\`\`\`a2ui\n${JSON.stringify({
        surface: { id: "reply-card", type: "inline" },
        components: [{ id: "root", component: "Text", text: "Project overview" }],
      })}\n\`\`\``,
      messageId: "a2ui-text-reply",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_ai" }), "ai-run")
    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].request.segments).toEqual([
      { type: "markdown", md: "Summary\n" },
      expect.objectContaining({
        type: "a2ui",
        surfaceId: "reply-card",
        plainTextMirror: "Project overview",
      }),
    ])
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
  it("keeps the durable journal but omits the IM binding when liveActivity is false", async () => {
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
    expect(typeof receivedCap?.onEvent).toBe("function")
    expect(
      await getDb()
        .executionRunBindings.where("conversationKey")
        .equals("telegram:adapter_1:chat_liveoff")
        .count()
    ).toBe(0)
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.filter((a) => a.kind === "activity.card_dispatched")).toHaveLength(0)
  })

  it("journals progress for the generic projection runner when the adapter has no edit()", async () => {
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
    mockWaitForExecutionRunPresentationFreeze.mockImplementationOnce(async () => {
      const authoritativeReplies = (await getDb().outboundQueue.toArray()).filter(
        (job) => job.source === "ai-run"
      )
      expect(authoritativeReplies).toHaveLength(0)
      return true
    })
    // No edit() on the adapter (none registered) → APPEND mode (workflow⇄IM
    // visibility parity): one compact progress line per boundary, NOT the
    // cumulative card.
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_append" })
    await callHandler(event, "ai-run")
    expect(typeof receivedCap?.onEvent).toBe("function")
    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    const events = await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()
    expect(events.map((item) => item.type)).toEqual(
      expect.arrayContaining(["run.started", "tool.started", "run.completed"])
    )
    expect(await getDb().executionRunBindings.where("runId").equals(run!.id).count()).toBe(1)
    expect(mockWaitForExecutionRunPresentationFreeze).toHaveBeenCalledWith(run!.id)
  })

  it("journals a versioned recovery anchor and persists the captured SDK session", async () => {
    const conversationKey = "telegram:adapter_1:chat_recovery_anchor"
    await callHandler(makeEvent({ conversationKey, messageId: "seed" }), "manual-store")
    const session = await getDb()
      .sessions.filter(
        (candidate) => candidate.platformBinding?.conversationKey === conversationKey
      )
      .first()
    expect(session).toBeDefined()
    await getDb().sessions.update(session!.id, { sdkSessionId: "sdk-before" })
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockImplementationOnce(
      async (_sessionId, _prompt, _sendOptions, cap) => {
        await cap?.onSdkSessionId?.("sdk-after")
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            cap?.onEvent?.({ type: "text-delta", delta: "partial" })
            cap?.onEvent?.({
              type: "tool-call",
              toolName: "Read",
              input: { path: "a.ts" },
              id: "call-1",
            })
            cap?.onEvent?.({
              type: "tool-result",
              toolName: "Read",
              id: "call-1",
              result: "ok",
            })
            resolve()
          }, 0)
        })
        return {
          text: "continued",
          messageId: "uuid-recovered",
          sdkSessionId: "sdk-after",
        }
      }
    )

    const event = makeEvent({ conversationKey, messageId: "recoverable" })
    await callHandler(event, "ai-run")
    expect(
      (await getDb().connectorAudit.toArray()).filter(
        (entry) => entry.reason === "ai_run_capture_failed"
      )
    ).toEqual([])

    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    const started = (
      await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()
    ).find((item) => item.type === "run.started")
    expect(started?.payload.recoveryAnchor).toEqual(
      expect.objectContaining({
        version: 1,
        inboundJobId: "test:recoverable",
        sessionId: session!.id,
        sdkSessionId: "sdk-before",
        executionFingerprint: expect.any(String),
      })
    )
    expect((await getDb().sessions.get(session!.id))?.sdkSessionId).toBe("sdk-after")
    expect(
      (await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()).find(
        (item) => item.type === "resource.changed"
      )?.payload.recoveryAnchor
    ).toEqual(expect.objectContaining({ sdkSessionId: "sdk-after" }))
    // This used to assert the send carried NO spec, which was only ever true
    // because the `agentExecutionResolverV2` gate kept it off the wire. That
    // gate is retired, so every send is stamped. What still has to hold —
    // and is what recovery actually depends on — is that the stamped spec's
    // identity is the identity the anchor journals, so a continuation can
    // re-mint the same execution instead of starting a stranger.
    expect(started?.payload.recoveryAnchor).toEqual(
      expect.objectContaining({ executionIdentityRunId: expect.any(String) })
    )
    const journalledIdentity = started?.payload.recoveryAnchor as {
      executionIdentityRunId: string
      attemptId: string
    }
    expect((DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][2].execution?.identity).toEqual({
      runId: journalledIdentity.executionIdentityRunId,
      attemptId: journalledIdentity.attemptId,
    })
    expect(
      mockAppendCanonicalEnvelopes.mock.calls.map(
        (call) => (call[1] as Array<{ event: { kind: string } }>)[0].event.kind
      )
    ).toEqual(["text-delta", "tool-call", "tool-result"])
  })

  it("keeps canonical persistence live after one failure and parks the job fail-closed", async () => {
    mockAppendCanonicalEnvelopes.mockRejectedValueOnce(new Error("canonical disk unavailable"))
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockImplementationOnce(
      async (_sessionId, _prompt, _sendOptions, cap) => {
        cap?.onEvent?.({
          type: "tool-call",
          toolName: "Write",
          input: { path: "a.ts" },
          id: "call-1",
        })
        cap?.onEvent?.({
          type: "tool-result",
          toolName: "Write",
          id: "call-1",
          result: "ok",
        })
        return { text: "must not deliver", messageId: "uuid-canonical-failed" }
      }
    )
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_canonical_failure",
      messageId: "canonical-failure",
    })
    const inboundJob = await enqueueConnectorInboundJob(event, "queue")

    await callHandler(event, "ai-run", RESOLVED, inboundJob.id)

    expect(
      mockAppendCanonicalEnvelopes.mock.calls.map(
        (call) => (call[1] as Array<{ event: { kind: string } }>)[0].event.kind
      )
    ).toEqual(["tool-call", "tool-result"])
    expect(await getDb().connectorInboundJobs.get(inboundJob.id)).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "canonical_log_write_failed",
      })
    )
    expect(await getDb().outboundQueue.toArray()).toHaveLength(0)
  })

  it("continues a terminal run in a linked immutable journal run", async () => {
    const conversationKey = "telegram:adapter_1:chat_resume_existing_run"
    const event = makeEvent({ conversationKey, messageId: "same-message" })
    await callHandler(makeEvent({ conversationKey, messageId: "seed" }), "manual-store")
    const session = await getDb()
      .sessions.filter(
        (candidate) => candidate.platformBinding?.conversationKey === conversationKey
      )
      .first()
    await getDb().sessions.update(session!.id, { sdkSessionId: "sdk-resume" })

    await callHandler(event, "ai-run")
    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    const firstEvents = await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()
    const firstAnchor = firstEvents.find((item) => item.type === "run.started")?.payload
      .recoveryAnchor as Record<string, unknown>
    const executionIdentityRunId = firstAnchor.executionIdentityRunId as string
    const firstRevision = (await getDb().executionRuns.get(run!.id))!.currentRevision

    const resumedEvent = makeEvent({
      ...event,
      channelData: {
        recoveryIntent: "continue_safely",
        dispatchIntent: "steer-replay",
        recoveryAnchor: {
          ...firstAnchor,
          attemptId: "recovery-test",
          partialOutput: "partial ",
          restoredPermissions: [{ requestId: "prior-deny", toolName: "Bash", state: "denied" }],
        },
      },
    })
    let restoredDecision: unknown
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockImplementationOnce(
      async (_sessionId, _prompt, _sendOptions, cap) => {
        await new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            void cap
              ?.onPermissionRequest?.({
                type: "permission_request",
                sessionId: session!.id,
                requestId: "prior-deny",
                toolUseID: "tool-use-1",
                toolName: "Bash",
                input: { command: "pwd" },
              })
              .then((decision: CapturePermissionDecision) => {
                restoredDecision = decision
                resolve()
              }, reject)
          }, 0)
        })
        return { text: "resumed", messageId: "uuid-resumed" }
      }
    )
    await callHandler(resumedEvent, "ai-run")

    const runs = await getDb().executionRuns.where("kind").equals("agent-turn").toArray()
    const resumedRun = runs.find((candidate) => candidate.id !== run!.id)
    const rows = await getDb().executionRunEvents.where("runId").equals(resumedRun!.id).toArray()
    const sequences = rows.map((row) => row.seq)
    expect(runs).toHaveLength(2)
    expect(resumedRun).toMatchObject({
      parentRunId: run!.id,
      sourceId: run!.sourceId,
      status: "completed",
    })
    expect((await getDb().executionRuns.get(run!.id))!.currentRevision).toBe(firstRevision)
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(rows.find((row) => row.type === "run.started")?.payload.recoveryAnchor).toEqual(
      expect.objectContaining({ executionJournalRunId: resumedRun!.id })
    )
    const resumedExecution = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[1][2].execution
    expect(resumedExecution.identity).toMatchObject({
      runId: executionIdentityRunId,
      attemptId: "recovery-test",
    })
    const { resolveAgentExecutionSpecForConfig } =
      await import("@/lib/ai/agent/execution/agent-execution-service")
    const resumedSendOptions = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[1][2]
    const expectedResolution = await resolveAgentExecutionSpecForConfig(
      {
        sessionId: session!.id,
        provider: resumedSendOptions.provider,
        model: resumedSendOptions.model,
        toolsEnabled: true,
      },
      { isTauri: false, isHeadlessHost: false },
      {
        surface: "connector",
        policy: { executionKind: "agent" },
        identity: { runId: executionIdentityRunId, attemptId: "recovery-test" },
      }
    )
    expect(resumedExecution.executionFingerprint).toBe(
      computeExecutionFingerprint(expectedResolution.spec)
    )
    expect(restoredDecision).toEqual({
      decision: "deny",
      message: "permission denied by recovered state",
    })
    expect((await getDb().outboundQueue.toArray()).at(-1)?.request.segments[0]).toMatchObject({
      type: "markdown",
      md: "partial resumed",
    })
    window.localStorage.removeItem("cognia-agent-execution-flags-v1")
  })

  it("audits a bounded freeze timeout before enqueueing the independent final reply", async () => {
    mockWaitForExecutionRunPresentationFreeze.mockResolvedValueOnce(false)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_freeze_timeout" })

    await callHandler(event, "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs.some((job) => job.source === "ai-run")).toBe(true)
    expect(await getDb().connectorAudit.toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "run_projection_freeze_timeout",
          conversationKey: event.conversationKey,
        }),
      ])
    )
  })

  it("uses the configured character name as the safe Agent run title", async () => {
    await getDb().characters.put({ id: "char_abc", name: "Support Agent" } as never)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_named" })

    await callHandler(event, "ai-run")

    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    expect(run?.title).toBe("Support Agent")
  })

  it("creates one durable native-preferred binding for an edit-capable adapter", async () => {
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
    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    expect(await getDb().executionRunBindings.where("runId").equals(run!.id).first()).toMatchObject(
      {
        status: "active",
        deliveryMode: "native",
        sourceMessageId: event.messageId,
      }
    )
  })
})

describe("installRuntime — ai-run (twin injection)", () => {
  it("builds twin deps when the bound character is twin-bound", async () => {
    await getDb().characters.put({ id: "char_abc", name: "Twinned", twinId: "twin_1" } as never)
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_twin" })
    await callHandler(event, "ai-run")
    expect(tryBuildTwinDepsImpl).toHaveBeenCalledTimes(1)
  })

  it("marks twin-generated outbound content visibly and structurally", async () => {
    await getDb().characters.put({ id: "char_abc", name: "Twinned", twinId: "twin_1" } as never)
    tryBuildTwinDepsImpl = jest.fn(async () => ({ embedding: {}, store: {} }))
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_twin_disclosure" })
    await callHandler(event, "ai-run")
    const [job] = await getDb().outboundQueue.toArray()
    expect(job.request.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ md: expect.stringContaining("AI-generated · Digital Twin") }),
      ])
    )
    expect(job.request.metadata.provenance).toEqual([
      { source: "digital-twin", sourceId: "twin_1", disclosure: "ai-generated" },
    ])
  })

  it("persists Twin provenance in draft outbound previews", async () => {
    await getDb().characters.put({ id: "char_abc", name: "Twinned", twinId: "twin_1" } as never)
    tryBuildTwinDepsImpl = jest.fn(async () => ({ embedding: {}, store: {} }))
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_twin_draft" })
    await callHandler(event, "draft-prepare")
    const [draft] = await getDb().connectorDrafts.toArray()
    expect(draft.outboundPreview?.metadata.provenance).toEqual([
      { source: "digital-twin", sourceId: "twin_1", disclosure: "ai-generated" },
    ])
    expect(draft.outboundPreview?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ md: expect.stringContaining("AI-generated · Digital Twin") }),
      ])
    )
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
            scope: "global",
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
    await getDb().settings.put({
      id: "singleton",
      memory: { enabled: true, useMemory: true },
    } as never)
    await getDb().characters.put({ id: "char_abc", name: "Plain" } as never)
    const clean = memoryDepsWithEmbedSpy()
    tryBuildMemoryDepsImpl = jest.fn(async () => clean.deps)
    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_mem_c" }), "ai-run")
    expect(clean.embed).toHaveBeenCalledWith("hello runtime", { signal: expect.any(AbortSignal) })

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

  it("parks the inbound job as recovery_required so recovery controls stay available", async () => {
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(new Error("sidecar died"))
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_capture_recovery",
      messageId: "capture-recovery",
    })
    const inboundJob = await enqueueConnectorInboundJob(event, "queue")

    await callHandler(event, "ai-run", RESOLVED, inboundJob.id)

    expect(await getDb().connectorInboundJobs.get(inboundJob.id)).toEqual(
      expect.objectContaining({
        status: "recovery_required",
        recoveryReason: "ai_run_capture_failed",
        lastError: "sidecar died",
      })
    )
  })

  it("rejects to the bus when the recovery state cannot be written", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inboundJobs = require("@/lib/db/connector-inbound-jobs")
    const markSpy = jest
      .spyOn(inboundJobs, "markConnectorInboundJobRecoveryRequired")
      .mockRejectedValueOnce(new Error("disk full"))
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(new Error("sidecar died"))
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_capture_mark_fails",
      messageId: "capture-mark-fails",
    })
    const inboundJob = await enqueueConnectorInboundJob(event, "queue")

    try {
      await expect(callHandler(event, "ai-run", RESOLVED, inboundJob.id)).rejects.toThrow(
        "sidecar died"
      )
    } finally {
      markSpy.mockRestore()
    }

    // The cleanup still ran: the run is closed as failed, not left dangling.
    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    const types = (await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()).map(
      (item) => item.type
    )
    expect(types).toContain("run.failed")
  })

  it("does not offer recovery for a PII block", async () => {
    const piiErr = new Error("PII gate blocked auto-mode send")
    piiErr.name = "PiiGateBlocked"
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockRejectedValueOnce(piiErr)
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_pii_no_recovery",
      messageId: "pii-no-recovery",
    })
    const inboundJob = await enqueueConnectorInboundJob(event, "queue")

    await callHandler(event, "ai-run", RESOLVED, inboundJob.id)

    expect((await getDb().connectorInboundJobs.get(inboundJob.id))?.status).not.toBe(
      "recovery_required"
    )
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
    mockStartTeamRunFromIM.mockResolvedValue({ started: true, runId: "run_team_bound" })
    mockStartWorkflowFromIM.mockClear()
    mockStartWorkflowFromIM.mockResolvedValue({ ok: true, runId: "run_x" })
  })

  it("dispatches a DRAFTED turn to the bound team instead of silently answering alone", async () => {
    // The headline defect of the old shape: `draft-prepare` was a route, and
    // that branch resolved no execution target — so a conversation bound to a
    // team produced a single-character draft and nothing recorded that the
    // team had been skipped.
    const key = "telegram:adapter_1:chat_team_draft"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_team_draft",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({
      conversationKey: key,
      sessionId: "s_team_draft",
      teamId: "team_r",
    })

    await callHandler(makeEvent({ conversationKey: key }), "draft-prepare")

    expect(mockStartTeamRunFromIM).toHaveBeenCalledTimes(1)
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    // Acceptance is honoured through the mechanism a team actually has: a
    // human signs off on the plan before it acts. Holding the finished output
    // would review work already done.
    expect(
      (mockStartTeamRunFromIM.mock.calls[0][0] as { requirePlanApprovalFloor?: boolean })
        .requirePlanApprovalFloor
    ).toBe(true)
    const audit = await getDb().connectorAudit.toArray()
    const dispatched = audit.find((row) => row.kind === "team.dispatched")
    expect(dispatched?.fields).toMatchObject({ acceptance: "plan-approval" })
    // No draft row: the single-agent product that used to be drafted here was
    // never what the operator asked for.
    expect(await getDb().connectorDrafts.count()).toBe(0)
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
    // The execution journal keys a team run as `execution:team:<sourceId>`;
    // binding the raw source id meant crash recovery could never reconnect the
    // inbound job to the run it belonged to.
    expect(mockBindExecutionRun).toHaveBeenCalledWith("execution:team:run_team_bound")

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

    await callHandler(makeEvent({ conversationKey: key }), "ai-run", {
      ...RESOLVED,
      characterId: undefined,
    })

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "adapter.error" && r.reason === "team_not_found")).toBe(
      true
    )
  })

  it("holds a DRAFTED workflow dispatch behind an Approve card instead of running it live", async () => {
    // The third shape of acceptance. A workflow has no plan gate and ships its
    // product through its own nodes, so the only moment "a human signs off
    // before it acts" is still true is before the run starts.
    const key = "telegram:adapter_1:chat_wf_draft"
    await seedAdapter("adapter_1")
    await getDb().sessions.add({
      id: "s_wf_draft",
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
    await upsertByConversationKey({
      conversationKey: key,
      sessionId: "s_wf_draft",
      workflowId: "wf_n",
    })

    await callHandler(makeEvent({ conversationKey: key }), "draft-prepare")

    expect(mockStartWorkflowFromIM).not.toHaveBeenCalled()
    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    // No draft row either: the single-character product the old branch drafted
    // here was never what the operator asked for.
    expect(await getDb().connectorDrafts.count()).toBe(0)

    const bindings = await getDb().connectorCallbackBindings.toArray()
    expect(bindings.map((row) => row.kind).sort()).toEqual(["wf_approve", "wf_cancel"])
    // One surface — the dispatcher deletes siblings by surfaceId.
    expect(new Set(bindings.map((row) => row.surfaceId)).size).toBe(1)
    expect(bindings[0].payload).toMatchObject({
      workflowId: "wf_n",
      runParams: { message: "hello runtime" },
      triggeredFrom: { source: "im", conversationKey: key },
    })
    // The card itself went out.
    expect(await getDb().outboundQueue.count()).toBe(1)

    const audit = await getDb().connectorAudit.toArray()
    expect(audit.find((row) => row.kind === "workflow.dispatch_held")?.fields).toMatchObject({
      workflowId: "wf_n",
      acceptance: "run-approval",
    })
    expect(audit.some((row) => row.kind === "workflow.dispatched")).toBe(false)
  })

  it.each([true, false])(
    "routes workflow with replyable message flag %s",
    async (canReplyToMessage) => {
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

      await callHandler(
        makeEvent({ conversationKey: key, canReplyToMessage, messageId: "workflow-trigger" }),
        "ai-run",
        {
          ...RESOLVED,
          characterId: undefined,
        }
      )

      expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
      expect(mockStartWorkflowFromIM).toHaveBeenCalledTimes(1)
      const arg = mockStartWorkflowFromIM.mock.calls[0][0] as unknown as {
        workflowId: string
        runParams: { message: string }
        triggeredFrom: { source: string; conversationKey: string; sourceMessageId?: string }
      }
      expect(arg.workflowId).toBe("wf_n")
      expect(arg.runParams.message).toBe("hello runtime")
      expect(arg.triggeredFrom.source).toBe("im")
      expect(arg.triggeredFrom.conversationKey).toBe(key)
      expect(arg.triggeredFrom.sourceMessageId).toBe(
        canReplyToMessage ? "workflow-trigger" : undefined
      )
      expect(mockBindExecutionRun).toHaveBeenCalledWith("run_x")

      const audit = await getDb().connectorAudit.toArray()
      expect(audit.some((r) => r.kind === "workflow.dispatched")).toBe(true)
      expect(await getDb().outboundQueue.count()).toBe(0)
    }
  )

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

    await callHandler(makeEvent({ conversationKey: key }), "ai-run", {
      ...RESOLVED,
      characterId: undefined,
    })

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

    await callHandler(makeEvent({ conversationKey: key }), "ai-run", {
      ...RESOLVED,
      characterId: undefined,
    })

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

  it("stale instance-default team fails closed without a direct-agent fallback", async () => {
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

    await callHandler(makeEvent({ conversationKey: key }), "ai-run", {
      ...RESOLVED,
      characterId: undefined,
    })

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    const audit = await getDb().connectorAudit.toArray()
    expect(audit.some((r) => r.kind === "adapter.error" && r.reason === "team_not_found")).toBe(
      true
    )
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

    await callHandler(makeEvent({ conversationKey: key }), "ai-run", {
      ...RESOLVED,
      characterId: undefined,
    })

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
    mockStartTeamRunFromIM.mockResolvedValue({ started: true, runId: "run_team_rule" })
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

    // The reason travels with the denial now: the sidecar (and the trace) can
    // tell "the operator has the bot drafting" from a plain refusal.
    await expect(Promise.resolve(seenPermission)).resolves.toEqual({
      decision: "deny",
      message: "ask-tier tools are denied while drafting",
    })
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
  it("withholds resolved data URLs from text prompts without a binary grant", () => {
    const event = makeEvent({
      segments: [
        { type: "image", url: "data:image/png;base64,DISPLAY_ONLY", rawUrl: "remote-key" },
      ],
      plainText: "[image]",
    })
    expect(inboundEventToSendContent(event)).toBe("[image: remote-key]")
  })
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

  describe("group speaker attribution", () => {
    // One ChatSession is shared by every participant of a group, so before
    // this the model read five people as one: the sender only ever reached
    // `metadata.platformMessage.sender`, which the prompt never sees.
    const group = { id: "ch_9", name: "Release war room", kind: "group" as const }

    it("names the sender in a group", () => {
      const event = makeEvent({
        channel: group,
        segments: [{ type: "text", text: "ship it" }],
        plainText: "ship it",
      })
      const out = inboundEventToSendContent(event) as string
      expect(out).toMatch(/^\[speaker: Alice · Person-[0-9A-Z]{6}\]\nship it$/)
    })

    it("leaves a private chat exactly as it was", () => {
      const event = makeEvent({
        segments: [{ type: "text", text: "ship it" }],
        plainText: "ship it",
      })
      expect(inboundEventToSendContent(event)).toBe("ship it")
    })

    it("names the sender even when the segment list produced nothing", () => {
      const event = makeEvent({ channel: group, segments: [], plainText: "fallback" })
      expect(inboundEventToSendContent(event)).toContain("Alice")
      expect(inboundEventToSendContent(event)).toContain("fallback")
    })

    it("keeps the header as the first block of a mixed-media turn", () => {
      const event = makeEvent({
        channel: group,
        mediaModelPolicy: "allow_cloud_binary",
        segments: [
          { type: "text", text: "look:" },
          { type: "image", url: "ignored", dataBase64: "AAA", mimeType: "image/jpeg" },
        ],
        plainText: "look:",
      })
      const out = inboundEventToSendContent(event)
      expect(Array.isArray(out)).toBe(true)
      expect((out as { type: string; text?: string }[])[0].text).toContain("[speaker:")
    })

    it("distinguishes two senders who share a display name", () => {
      const one = inboundEventToSendContent(
        makeEvent({
          channel: group,
          sender: {
            id: "u_1",
            platform: "telegram",
            adapterId: "adapter_1",
            remoteUserId: "u_1",
            displayName: "张伟",
          },
          segments: [{ type: "text", text: "hi" }],
          plainText: "hi",
        })
      )
      const two = inboundEventToSendContent(
        makeEvent({
          channel: group,
          sender: {
            id: "u_2",
            platform: "telegram",
            adapterId: "adapter_1",
            remoteUserId: "u_2",
            displayName: "张伟",
          },
          segments: [{ type: "text", text: "hi" }],
          plainText: "hi",
        })
      )
      expect(one).not.toBe(two)
    })

    it("falls back to a pseudonym rather than letting a nickname trip the PII gate", () => {
      // `safe-send-prompt.ts` runs `hasNoLeakingPii` over every block of this
      // very SendContent and aborts the turn when one fails. A member whose
      // nickname is their phone number must not be able to mute the bot.
      const event = makeEvent({
        channel: group,
        sender: {
          id: "u_phone",
          platform: "telegram",
          adapterId: "adapter_1",
          remoteUserId: "u_phone",
          displayName: "13800138000",
        },
        segments: [{ type: "text", text: "hi" }],
        plainText: "hi",
      })
      const out = inboundEventToSendContent(event) as string
      expect(out).not.toContain("13800138000")
      expect(hasNoLeakingPii(out)).toBe(true)
    })

    it("marks a sibling bot as an app rather than a person", () => {
      const event = makeEvent({
        channel: group,
        sender: {
          id: "u_bot",
          platform: "telegram",
          adapterId: "adapter_1",
          remoteUserId: "u_bot",
          displayName: "Ops Bot",
          kind: "bot",
        },
        segments: [{ type: "text", text: "deploy done" }],
        plainText: "deploy done",
      })
      expect(inboundEventToSendContent(event)).toContain("App-")
    })
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

  it("sends base64 image segments as image blocks ONLY under an explicit grant", () => {
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
    event.mediaModelPolicy = "allow_cloud_binary"
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

  it("withholds inline image bytes under the default policy", () => {
    // The default is what an unconfigured bot in a group chat runs with, so it
    // is the case that decides whether someone's photo reaches a third party.
    const event = makeEvent({
      segments: [
        { type: "text", text: "look:" },
        { type: "image", url: "", dataBase64: "AAA", mimeType: "image/jpeg" },
      ],
      plainText: "look:",
    })
    const out = inboundEventToSendContent(event)
    // No image block at all, and the model is told an attachment exists.
    expect(out).toBe(`look:\n${WITHHELD_MEDIA_MARKER}`)
    expect(JSON.stringify(out)).not.toContain("AAA")
  })

  it("treats an unstamped event as withholding, never as permission", () => {
    // A path that forgets to run the gate must fail safe.
    const event = makeEvent({
      segments: [{ type: "image", url: "", dataBase64: "SECRET", mimeType: "image/png" }],
      plainText: "",
    })
    expect(event.mediaModelPolicy).toBeUndefined()
    expect(JSON.stringify(inboundEventToSendContent(event))).not.toContain("SECRET")
  })

  it("still hands over locally-extracted text when the bytes are withheld", () => {
    // This is what makes local_extract_only usable rather than merely safe.
    const event = makeEvent({
      segments: [{ type: "image", url: "", dataBase64: "AAA", ocrText: "RECEIPT $9" }],
      plainText: "",
    })
    const out = inboundEventToSendContent(event)
    expect(out).toBe("RECEIPT $9")
    expect(JSON.stringify(out)).not.toContain("AAA")
  })

  it("tells the model when a voice note has no local transcript", () => {
    const event = makeEvent({
      segments: [{ type: "voice", url: "https://example.com/v.ogg" }],
      plainText: "",
    })
    expect(inboundEventToSendContent(event)).toBe(`[voice message] ${WITHHELD_MEDIA_MARKER}`)
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
    // Without a local transcript there is nothing the model may have — the
    // audio itself is binary — so the marker now says so explicitly.
    expect(
      inboundEventToSendContent(
        makeEvent({ segments: [{ type: "voice", url: "v_k" }], plainText: "" })
      )
    ).toBe(`[voice message] ${WITHHELD_MEDIA_MARKER}`)
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
    mediaModelPolicy: "local_extract_only",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as AdapterInstanceRow)
}

// NOTE: unit coverage for `resolveRespondViaTarget` lives in
// `runtime.respond-via.test.ts` — a light suite that doesn't stand up the
// full installRuntime harness. Only the end-to-end ai-run wiring is here.

describe("installRuntime — ai-run reply quoting (ADR-0009 §3A.3)", () => {
  const groupEvent = (over: Partial<NormalizedInboundEvent> = {}) =>
    makeEvent({
      conversationKey: "telegram:adapter_1:group_9",
      messageId: "msg_group_trigger",
      channel: { id: "ch_g9", name: "Ops group", kind: "group" },
      ...over,
    })

  it("quotes the triggering message in a group when the platform declares send.reply", async () => {
    await seedAdapter("adapter_1")
    await callHandler(groupEvent(), "ai-run")
    const [job] = await getDb().outboundQueue.toArray()
    expect(job.request.replyTo).toEqual({ messageId: "msg_group_trigger" })
  })

  it("does not quote an interaction id that is not a platform message", async () => {
    await seedAdapter("adapter_1")
    await callHandler(groupEvent({ canReplyToMessage: false }), "ai-run")
    const [job] = await getDb().outboundQueue.toArray()
    expect(job.request.replyTo).toBeUndefined()
    expect(job.request.deliveryTarget?.sourceMessageId).toBeUndefined()
    const [binding] = await getDb().executionRunBindings.toArray()
    expect(binding).toBeDefined()
    expect(binding.sourceMessageId).toBeUndefined()
    expect(binding.deliveryTarget?.sourceMessageId).toBeUndefined()
    expect(binding.deliveryTarget?.conversationRef).toEqual(groupEvent().conversationRef)
  })

  it("does not quote in a private chat", async () => {
    await seedAdapter("adapter_1")
    await callHandler(
      makeEvent({ conversationKey: "telegram:adapter_1:chat_priv", messageId: "msg_priv" }),
      "ai-run"
    )
    const [job] = await getDb().outboundQueue.toArray()
    expect(job.request.replyTo).toBeUndefined()
  })

  it("does not quote when the reply is rewired through a respond-via sibling", async () => {
    await seedAdapter("adapter_1", {
      dispatchRules: [{ id: "r_via", match: {}, action: { respondViaAdapterId: "adapter_2" } }],
    })
    await putInstance("adapter_2")
    await callHandler(
      groupEvent({
        conversationAddress: {
          conversationKey: "telegram:adapter_1:group_9",
          platform: "telegram",
          adapterId: "adapter_1",
          scopeKind: "group",
          containerId: "group_9",
        },
      }),
      "ai-run"
    )
    const [job] = await getDb().outboundQueue.toArray()
    expect(job.adapterId).toBe("adapter_2")
    expect(job.request.replyTo).toBeUndefined()
  })

  it("honours the override / bot-default opt-outs (override wins over the bot default)", async () => {
    await seedAdapter("adapter_1", { replyQuoting: false } as never)
    await callHandler(groupEvent(), "ai-run")
    let jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].request.replyTo).toBeUndefined()

    // Conversation override re-enables quoting for this group only.
    await upsertByConversationKey({
      conversationKey: "telegram:adapter_1:group_9",
      sessionId: "ses_placeholder",
      replyQuoting: true,
    })
    await getDb().outboundQueue.clear()
    await callHandler(groupEvent({ messageId: "msg_group_trigger_2" }), "ai-run")
    jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].request.replyTo).toEqual({ messageId: "msg_group_trigger_2" })

    // And an override `false` wins over an (implicit) bot default of ON.
    await getDb().outboundQueue.clear()
    await putInstance("adapter_off")
    await upsertByConversationKey({
      conversationKey: "telegram:adapter_off:group_x",
      sessionId: "ses_placeholder",
      replyQuoting: false,
    })
    await callHandler(
      groupEvent({
        adapterId: "adapter_off",
        conversationKey: "telegram:adapter_off:group_x",
        messageId: "msg_off",
      }),
      "ai-run"
    )
    const [offJob] = await getDb().outboundQueue.toArray()
    expect(offJob.request.replyTo).toBeUndefined()
  })

  it("does not quote on a platform whose adapter lacks send.reply", async () => {
    await getDb().adapterInstances.put({
      id: "adapter_wxoa",
      type: "wechat-oa",
      displayName: "WeChat OA",
      enabled: true,
      transportMode: "webhook",
      settings: {},
      credentialsRef: { keyringService: "test", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      createdAt: 0,
      updatedAt: 0,
    } as AdapterInstanceRow)
    await callHandler(
      groupEvent({
        platform: "wechat-oa",
        adapterId: "adapter_wxoa",
        conversationKey: "wechat-oa:adapter_wxoa:group_1",
        conversationRef: { platform: "wechat-oa", adapterId: "adapter_wxoa" },
        sender: {
          id: "u_alice",
          platform: "wechat-oa",
          adapterId: "adapter_wxoa",
          remoteUserId: "u_alice",
          displayName: "Alice",
        },
        messageId: "msg_wxoa",
      }),
      "ai-run"
    )
    const [job] = await getDb().outboundQueue.toArray()
    expect(job).toBeDefined()
    expect(job.request.replyTo).toBeUndefined()
  })
})

describe("installRuntime — ai-run Lark result card", () => {
  const larkEvent = (over: Partial<NormalizedInboundEvent> = {}) =>
    makeEvent({
      platform: "lark",
      adapterId: "adapter_lark",
      conversationKey: "lark:adapter_lark:oc_9",
      conversationRef: { platform: "lark", adapterId: "adapter_lark" },
      sender: {
        id: "u_alice",
        platform: "lark",
        adapterId: "adapter_lark",
        remoteUserId: "ou_alice",
        displayName: "Alice",
      },
      channel: { id: "oc_9", name: "Ops group", kind: "group" },
      messageId: "om_group_trigger",
      ...over,
    })

  const seedLark = (patch: Partial<AdapterInstanceRow> = {}) =>
    putInstance("adapter_lark", { type: "lark", ...patch })

  type CardPayload = {
    schema?: string
    config?: { update_multi?: boolean; summary?: { content?: string }; width_mode?: string }
    header?: unknown
    body?: { elements: Record<string, unknown>[] }
  }

  function cardPayloadOf(job: { request: { segments: MessageSegment[] } }): CardPayload {
    const seg = job.request.segments[0]
    expect(seg.type).toBe("card")
    if (seg.type !== "card") throw new Error("expected card segment")
    expect(seg.card.kind).toBe("lark")
    return seg.card.payload as CardPayload
  }

  it.each([true, false])(
    "persists the request locale and safe first-line title with live activity %s",
    async (liveActivity) => {
      await seedLark()
      await getDb().settings.put({ id: "singleton", language: "en" } as never)
      const event = larkEvent({
        plainText: "  帮我\t查看发布进度  \nInclude the full deployment log",
      })
      await upsertByConversationKey({
        conversationKey: event.conversationKey,
        sessionId: "ses_placeholder",
        liveActivity,
      })
      jest.mocked(DEFAULT_RUN_AND_CAPTURE).mockImplementationOnce(async () => {
        const [run] = await getDb().executionRuns.toArray()
        expect(run.latestSnapshot).toMatchObject({
          locale: "zh-CN",
          title: "帮我 查看发布进度",
        })
        // A later inbound-text change must not switch a running card's language.
        event.plainText = "Show the deployment log"
        return { text: "Released", messageId: "locale-stable-reply" }
      })

      await callHandler(event, "ai-run")

      const [run] = await getDb().executionRuns.toArray()
      expect(run.title).toBe("帮我 查看发布进度")
      expect(run.latestSnapshot).toMatchObject({
        locale: "zh-CN",
        title: "帮我 查看发布进度",
        status: "completed",
      })
      const started = (await getDb().executionRunEvents.toArray()).find(
        (item) => item.type === "run.started"
      )
      expect(started?.payload).toMatchObject({
        locale: "zh-CN",
        title: "帮我 查看发布进度",
        safeTitle: true,
      })
      const bindings = await getDb().executionRunBindings.toArray()
      expect(bindings).toHaveLength(liveActivity ? 1 : 0)
      if (liveActivity) expect(bindings[0].locale).toBe("zh-CN")
      const [job] = await getDb().outboundQueue.toArray()
      const footer = cardPayloadOf(job).body?.elements.find(
        (element) => element.element_id === "footer"
      )
      expect(footer?.content).toContain("用时")
    }
  )

  it.each([
    ["Review the deployment\n请保留这行作为正文", "Review the deployment", "zh-CN"],
    ["Check the release", "Check the release", "en"],
    ["Review " + "a".repeat(140), "Review " + "a".repeat(112) + "…", "en"],
    ["Run `curl https://example.com/private`", "Agent run", "en"],
    ["", "Agent run", "en"],
  ])("sanitizes the Lark run title for %j", async (plainText, title, locale) => {
    await seedLark()
    await getDb().characters.put({ id: "char_abc", name: "Support Agent" } as never)
    await getDb().settings.put({ id: "singleton", language: "en" } as never)
    await callHandler(larkEvent({ plainText }), "ai-run")

    const [run] = await getDb().executionRuns.toArray()
    expect(run.title).toBe(title)
    expect(run.latestSnapshot).toMatchObject({ title, locale })
  })

  it("uses the persisted card preferences when queueing a final reply", async () => {
    await seedLark({
      settings: {
        cardPresentation: { title: "Release", theme: "purple", width: "fill", showFooter: false },
      },
    })
    await callHandler(larkEvent(), "ai-run")
    const [job] = await getDb().outboundQueue.toArray()
    const payload = cardPayloadOf(job)
    expect(payload.header).toMatchObject({ title: { content: "Release" }, template: "purple" })
    expect(payload.config?.width_mode).toBe("fill")
    expect(payload.body?.elements.some((el) => el.element_id === "footer")).toBe(false)
  })

  it("ships the completed answer as a standalone Card 2.0 segment", async () => {
    await seedLark({ settings: { webEntryBaseUrl: "https://app.example.com" } })
    await callHandler(larkEvent({ plainText: "帮我看看发布进度" }), "ai-run")

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    const payload = cardPayloadOf(jobs[0])
    expect(payload.schema).toBe("2.0")
    expect(payload.config?.update_multi).toBe(true)
    expect(payload.config?.summary?.content).toBe("Hello back from Claude!")
    // A terminal card carries no state header.
    expect(payload.header).toBeUndefined()

    const elements = payload.body?.elements ?? []
    const md = elements.filter((el) => el.tag === "markdown").map((el) => String(el.content))
    expect(md).toContain("Hello back from Claude!")

    // Footer: initiator at-mention + run-details link + elapsed readout.
    const footer = String(elements.find((el) => el.element_id === "footer")?.content ?? "")
    expect(footer).toContain("<at id=ou_alice></at>")
    expect(footer).toContain("https://app.example.com/agent-runs?run=")
    expect(footer).toContain("用时")

    // Native reply quoting is on by default in a group → the request carries
    // replyTo and the card has no redundant blockquote.
    expect(jobs[0].request.replyTo).toEqual({ messageId: "om_group_trigger" })
    expect(elements.some((el) => el.element_id === "quote")).toBe(false)
  })

  it("renders the card's blockquote when reply quoting is opted out", async () => {
    await seedLark({ replyQuoting: false })
    await callHandler(larkEvent({ plainText: "deploy the build" }), "ai-run")

    const [job] = await getDb().outboundQueue.toArray()
    expect(job.request.replyTo).toBeUndefined()
    const payload = cardPayloadOf(job)
    const quote = (payload.body?.elements ?? []).find((el) => el.element_id === "quote")
    // The card answers in the language the asker wrote in.
    expect(quote?.content).toBe("> Re: deploy the build")
  })

  it("does not mention the reader to themselves in a private chat", async () => {
    await seedLark()
    await callHandler(
      larkEvent({
        conversationKey: "lark:adapter_lark:oc_priv",
        channel: { id: "oc_priv", name: "DM", kind: "private" },
        plainText: "17 乘 23 等于多少",
      }),
      "ai-run"
    )

    const [job] = await getDb().outboundQueue.toArray()
    const payload = cardPayloadOf(job)
    const footer = String(
      (payload.body?.elements ?? []).find((el) => el.element_id === "footer")?.content ?? ""
    )
    expect(footer).not.toContain("<at ")
    expect(footer).toContain("用时")
  })

  it("never renders a quote element in a private chat", async () => {
    await seedLark({ replyQuoting: false })
    await callHandler(
      larkEvent({
        conversationKey: "lark:adapter_lark:oc_priv",
        channel: { id: "oc_priv", name: "DM", kind: "private" },
        plainText: "hello there",
      }),
      "ai-run"
    )

    const [job] = await getDb().outboundQueue.toArray()
    expect(job.request.replyTo).toBeUndefined()
    const payload = cardPayloadOf(job)
    expect((payload.body?.elements ?? []).some((el) => el.element_id === "quote")).toBe(false)
  })

  it("enqueues each card as its own request when other segments surround it", async () => {
    jest.mocked(DEFAULT_RUN_AND_CAPTURE).mockResolvedValueOnce({
      text: `Summary\n\`\`\`a2ui\n${JSON.stringify({
        surface: { id: "reply-card", type: "inline" },
        components: [{ id: "root", component: "Text", text: "Project overview" }],
      })}\n\`\`\``,
      messageId: "a2ui-reply",
      a2uiSurfaces: {},
      a2uiSurfaceOrder: [],
    })
    await seedLark()
    await callHandler(larkEvent(), "ai-run")

    const jobs = await listPendingForConversation(larkEvent().conversationKey)
    expect(jobs).toHaveLength(2)
    // `[markdown, a2ui]` → `[card, a2ui]` → grouped `[[card], [a2ui]]` so the
    // card never reaches the multi-segment combiner (which degrades it).
    expect(jobs[0].request.segments[0].type).toBe("card")
    expect(jobs[0].request.segments).toHaveLength(1)
    expect(jobs[1].request.segments[0].type).toBe("a2ui")
    // Multi-part turns get distinct idempotency keys — the runner dedupes
    // delivered keys.
    expect(jobs[0].idempotencyKey).toBe("airun:a2ui-reply:part:0")
    expect(jobs[1].idempotencyKey).toBe("airun:a2ui-reply:part:1")
    // The reply anchor rides only on the first message of the turn.
    expect(jobs[0].request.replyTo).toEqual({ messageId: "om_group_trigger" })
    expect(jobs[1].request.replyTo).toBeUndefined()
  })

  it("keeps raw segments on the draft path — the card transform never applies", async () => {
    await seedLark()
    await callHandler(larkEvent(), "draft-prepare")

    const [draft] = await getDb().connectorDrafts.toArray()
    expect(draft.segments).toEqual([{ type: "markdown", md: "Hello back from Claude!" }])
    expect(draft.outboundPreview?.segments[0]?.type).toBe("markdown")
    expect(await getDb().outboundQueue.count()).toBe(0)
  })
})

describe("installRuntime — ai-run respond-via rule", () => {
  it("delivers the reply through the rule's respondViaAdapterId sibling", async () => {
    await seedAdapter("adapter_1", {
      dispatchRules: [{ id: "r_via", match: {}, action: { respondViaAdapterId: "adapter_2" } }],
    })
    await putInstance("adapter_2")
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:chat_42",
      conversationAddress: {
        conversationKey: "telegram:adapter_1:chat_42",
        platform: "telegram",
        adapterId: "adapter_1",
        scopeKind: "private",
        containerId: "chat_42",
      },
    })
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

  it("notifies when a stale instance-default team fails closed", async () => {
    const key = "telegram:adapter_1:chat_staleteam_notify"
    await seedAdapter("adapter_1", { defaultTeamId: "ghost" })
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)

    await callHandler(makeEvent({ conversationKey: key }), "ai-run", {
      ...RESOLVED,
      characterId: undefined,
    })
    await flushNotify()

    expect(DEFAULT_RUN_AND_CAPTURE).not.toHaveBeenCalled()
    expect(notifyMock).toHaveBeenCalledTimes(1)
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

  async function failureReplies(key: string) {
    return (await getDb().outboundQueue.toArray()).filter(
      (job) =>
        job.conversationKey === key &&
        job.request.metadata?.idempotencyKey?.startsWith("im-failure:")
    )
  }

  async function seedSession(key: string, id: string): Promise<void> {
    await getDb().sessions.add({
      id,
      title: "t",
      kind: "direct",
      platformConversationKey: key,
      platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: key },
      createdAt: 0,
      updatedAt: 0,
    } as never)
  }

  it("answers the user directly when a team fails to start, without a second IM push", async () => {
    const key = "telegram:adapter_1:chat_teamfail_reply"
    await seedAdapter("adapter_1")
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)
    await seedSession(key, "s_tfr")
    await upsertOverride({ conversationKey: key, sessionId: "s_tfr", teamId: "ghost" })
    const event = makeEvent({ conversationKey: key, messageId: "teamfail-msg" })

    await callHandler(event, "ai-run")
    await flushNotify()

    const replies = await failureReplies(key)
    expect(replies).toHaveLength(1)
    expect(replies[0].request.metadata?.idempotencyKey).toBe(
      `im-failure:${event.adapterId}:${key}:teamfail-msg`
    )
    expect(replies[0].request.segments[0]).toEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("Dispatch failed") })
    )
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ centerOnly: true }))
  })

  // Telegram message ids restart in every chat, so two chats can each fail on
  // message 42. Each must get its own notice.
  it("answers the same message id in two chats separately", async () => {
    const keys = ["telegram:adapter_1:chat_dup_a", "telegram:adapter_1:chat_dup_b"]
    await seedAdapter("adapter_1")
    for (const [index, key] of keys.entries()) {
      mockStartTeamRunFromIM.mockResolvedValueOnce({
        started: false,
        reason: "team_not_found",
      } as never)
      await seedSession(key, `s_dup_${index}`)
      await upsertOverride({ conversationKey: key, sessionId: `s_dup_${index}`, teamId: "ghost" })
      await callHandler(makeEvent({ conversationKey: key, messageId: "42" }), "ai-run")
    }

    for (const key of keys) {
      const replies = await failureReplies(key)
      expect(replies).toHaveLength(1)
    }
    const ids = (await getDb().outboundQueue.toArray())
      .filter((job) => job.request.metadata?.idempotencyKey?.startsWith("im-failure:"))
      .map((job) => job.request.metadata?.idempotencyKey)
    expect(new Set(ids).size).toBe(2)
  })

  it("answers the user when the workflow launch throws, and still rethrows for the bus", async () => {
    const key = "telegram:adapter_1:chat_wfthrow_reply"
    await seedAdapter("adapter_1")
    mockStartWorkflowFromIM.mockRejectedValueOnce(new Error("admission refused"))
    await seedSession(key, "s_wft")
    await upsertOverride({ conversationKey: key, sessionId: "s_wft", workflowId: "wf_1" })

    await expect(callHandler(makeEvent({ conversationKey: key }), "ai-run")).rejects.toThrow(
      "admission refused"
    )

    expect(await failureReplies(key)).toHaveLength(1)
  })

  it("answers a failed direct run only when no live card speaks for it", async () => {
    const offKey = "telegram:adapter_1:chat_capture_liveoff"
    const onKey = "telegram:adapter_1:chat_capture_liveon"
    await upsertOverride({
      conversationKey: offKey,
      sessionId: "ses_placeholder",
      liveActivity: false,
    })
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock)
      .mockRejectedValueOnce(new Error("sidecar died"))
      .mockRejectedValueOnce(new Error("sidecar died"))

    await callHandler(makeEvent({ conversationKey: offKey }), "ai-run")
    await callHandler(makeEvent({ conversationKey: onKey }), "ai-run")
    await flushNotify()

    expect(await failureReplies(offKey)).toHaveLength(1)
    expect(await failureReplies(onKey)).toHaveLength(0)
  })

  it("keeps a drafting conversation's failures off the end user's chat", async () => {
    const key = "telegram:adapter_1:chat_draft_teamfail"
    await seedAdapter("adapter_1")
    mockStartTeamRunFromIM.mockResolvedValueOnce({
      started: false,
      reason: "team_not_found",
    } as never)
    await seedSession(key, "s_dtf")
    await upsertOverride({ conversationKey: key, sessionId: "s_dtf", teamId: "ghost" })

    await callHandler(makeEvent({ conversationKey: key }), "draft-prepare")
    await flushNotify()

    expect(await failureReplies(key)).toHaveLength(0)
    expect(notifyMock).toHaveBeenCalledWith(expect.not.objectContaining({ centerOnly: true }))
  })
})

describe("installRuntime — ai-run (stopped at a limit)", () => {
  it("maps SDK result subtypes to a stop report", () => {
    expect(incompleteRunStop(undefined)).toBeNull()
    expect(incompleteRunStop("success")).toBeNull()
    expect(incompleteRunStop("degraded")).toBeNull()
    expect(incompleteRunStop("error_max_turns")?.reason).toBe("max_turns")
    expect(incompleteRunStop("error_max_budget_usd")?.reason).toBe("max_budget")
    expect(incompleteRunStop("error_during_execution")?.reason).toBe("incomplete")
  })

  it("finishes the run failed and marks the delivered partial reply as incomplete", async () => {
    const captured: Awaited<ReturnType<RunAndCaptureFn>> = {
      text: "partial answer",
      messageId: "uuid-max-turns",
      resultSubtype: "error_max_turns",
    }
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockResolvedValueOnce(captured)
    const key = "telegram:adapter_1:chat_max_turns"

    await callHandler(makeEvent({ conversationKey: key }), "ai-run")

    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    const types = (await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()).map(
      (item) => item.type
    )
    expect(types).toContain("run.failed")
    expect(types).not.toContain("run.completed")
    const reply = (await getDb().outboundQueue.toArray()).find(
      (job) => job.request.metadata?.idempotencyKey === "airun:uuid-max-turns"
    )
    const text = reply!.request.segments
      .map((segment) => ("text" in segment ? segment.text : "md" in segment ? segment.md : ""))
      .join("")
    expect(text).toContain("partial answer")
    expect(text).toContain("Stopped at the turn limit")
    const audits = await getDb().connectorAudit.toArray()
    expect(audits.find((a) => a.reason === "ai_run_stopped_incomplete")?.fields).toEqual(
      expect.objectContaining({ stop: "max_turns", resultSubtype: "error_max_turns" })
    )
  })

  it("leaves a normal finish completed with no note", async () => {
    ;(DEFAULT_RUN_AND_CAPTURE as jest.Mock).mockResolvedValueOnce({
      text: "full answer",
      messageId: "uuid-success",
      resultSubtype: "success",
    })

    await callHandler(makeEvent({ conversationKey: "telegram:adapter_1:chat_success" }), "ai-run")

    const run = await getDb().executionRuns.where("kind").equals("agent-turn").first()
    const types = (await getDb().executionRunEvents.where("runId").equals(run!.id).toArray()).map(
      (item) => item.type
    )
    expect(types).toContain("run.completed")
    expect(
      (await getDb().connectorAudit.toArray()).some((a) => a.reason === "ai_run_stopped_incomplete")
    ).toBe(false)
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

  it("combines the running adapter abort signal with the per-run control signal", async () => {
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
    expect(cap.signal).toBeDefined()
    expect(cap.signal?.aborted).toBe(false)
    adapterAc.abort()
    expect(cap.signal?.aborted).toBe(true)
  })

  it("provides a per-run control signal when the adapter has no lifecycle entry", async () => {
    const event = makeEvent({ conversationKey: "telegram:adapter_1:chat_nosignal" })
    await callHandler(event, "ai-run")
    const cap = (DEFAULT_RUN_AND_CAPTURE as jest.Mock).mock.calls[0][3] as {
      signal?: AbortSignal
    }
    expect(cap.signal).toBeDefined()
    expect(cap.signal?.aborted).toBe(false)
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
          cap!.signal!.addEventListener("abort", () => reject(new Error("aborted by signal")), {
            once: true,
          })
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
      jobs.filter((j) => String(j.request.metadata?.idempotencyKey ?? "").startsWith("airun:"))
    ).toHaveLength(0)
  })

  it("threads the adapter signal into drafted captures too", async () => {
    // A drafted turn now runs the ai-run path, so its capture signal is the
    // COMPOSED one (adapter teardown OR run-control stop) rather than the raw
    // adapter signal the old separate branch passed. Assert propagation, not
    // identity: identity would pin the weaker of the two behaviours.
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
    expect(cap.signal).toBeDefined()
    expect(cap.signal!.aborted).toBe(false)
    adapterAc.abort("teardown")
    expect(cap.signal!.aborted).toBe(true)
  })
})

describe("insertInboundMessage — existing chat projection", () => {
  beforeEach(() => useChatStore.getState().clear())
  afterEach(() => useChatStore.getState().clear())

  it("projects the committed inbound row before a later assistant in its own existing slice", async () => {
    await getDb().sessions.put({ id: "projected", title: "IM", createdAt: 1, updatedAt: 1 })
    const chat = useChatStore.getState()
    chat.setActiveSession("projected")
    const assistant = {
      id: "live-answer",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "partial" }],
      metadata: { createdAt: 300 },
    }
    chat.replaceSessionMessages("projected", [assistant])
    chat.replaceSessionMessages("other", [assistant])
    const other = useChatStore.getState().sessions.other.messages

    const stored = await insertInboundMessage(
      makeEvent({ messageId: "projected-inbound" }),
      "projected",
      200
    )

    const state = useChatStore.getState()
    expect(state.sessions.projected.messages.map((message) => message.id)).toEqual([
      stored.id,
      "live-answer",
    ])
    expect(state.sessions.projected.messages[0]).toMatchObject({
      role: "user",
      metadata: {
        createdAt: 200,
        sessionId: "projected",
        platformMessage: { messageId: "projected-inbound" },
      },
    })
    expect(state.sessions.projected.messages[1]).toBe(assistant)
    expect(state.sessions.other.messages).toBe(other)
    expect(state.messages).toBe(state.sessions.projected.messages)
  })

  it("keeps unopened conversations out of the chat store and projects canonical redelivery later", async () => {
    await getDb().sessions.put({ id: "unopened", title: "IM", createdAt: 1, updatedAt: 1 })
    const event = makeEvent({ messageId: "unopened-inbound" })
    const stored = await insertInboundMessage(event, "unopened", 100)
    expect(useChatStore.getState().sessions.unopened).toBeUndefined()
    expect(useChatStore.getState().activeSessionId).toBeNull()

    await getDb().messages.update(stored.id, {
      parts: [{ type: "text", text: "[deleted]" }],
      metadata: { ...stored.metadata, deletedAt: 200 },
    })
    useChatStore.getState().replaceSessionMessages("unopened", [])
    const replay = await insertInboundMessage(event, "unopened", 300)
    expect(replay.id).toBe(stored.id)
    expect(useChatStore.getState().sessions.unopened.messages).toEqual([
      expect.objectContaining({
        id: stored.id,
        parts: [{ type: "text", text: "[deleted]" }],
        metadata: expect.objectContaining({ createdAt: 100, deletedAt: 200 }),
      }),
    ])
    expect(await getDb().messages.where("sessionId").equals("unopened").count()).toBe(1)
    expect(useChatStore.getState().activeSessionId).toBeNull()
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

describe("insertInboundMessage — session preview stamp", () => {
  it("stamps the inserted message as the session's last-message preview", async () => {
    const conversationKey = "telegram:adapter_1:chat_preview"
    await callHandler(makeEvent({ conversationKey }), "manual-store")
    const session = (await getDb().sessions.toArray())[0]
    expect(session).toBeDefined()

    // The Inbox row reads this denormalized pair; inbound writes bypass
    // `persistMessages`, so the runtime has to stamp it itself.
    await insertInboundMessage(
      makeEvent({
        conversationKey,
        segments: [{ type: "text", text: "  fresh   platform\ntext " }],
        plainText: "fresh platform text",
      }),
      session.id,
      8_000_000_000_000
    )
    const stamped = await getDb().sessions.get(session.id)
    expect(stamped?.lastMessagePreview).toBe("fresh platform text")
    expect(stamped?.lastMessageAt).toBe(8_000_000_000_000)

    // A late-arriving older message lands in the transcript but must not
    // pull the preview backwards.
    await insertInboundMessage(
      makeEvent({
        conversationKey,
        segments: [{ type: "text", text: "late straggler" }],
        plainText: "late straggler",
      }),
      session.id,
      7_000_000_000_000
    )
    const after = await getDb().sessions.get(session.id)
    expect(after?.lastMessagePreview).toBe("fresh platform text")
    expect(after?.lastMessageAt).toBe(8_000_000_000_000)
  })
})

describe("inbound shared unread state", () => {
  it("increments the canonical session unread counter once across concurrent redelivery", async () => {
    const event = makeEvent({
      conversationKey: "telegram:adapter_1:unread-unified",
      messageId: "first",
    })
    await callHandler(event, "manual-store")
    const session = (await getDb().sessions.toArray())[0]!
    const previous = (await getDb().sessionState.get(session.id))?.unreadCount ?? 0
    const next = makeEvent({ conversationKey: event.conversationKey, messageId: "second" })
    const [a, b] = await Promise.all([
      insertInboundMessage(next, session.id),
      insertInboundMessage(next, session.id),
    ])
    expect(a.id).toBe(b.id)
    expect((await getDb().sessionState.get(session.id))?.unreadCount).toBe(previous + 1)
  })
})

// ── group conversation context ────────────────────────────────────────────────

const GROUP_KEY = "telegram:adapter_1:group_ctx"

function groupEvent(overrides: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return makeEvent({
    conversationKey: GROUP_KEY,
    channel: { id: "g_ctx", kind: "group" },
    ...overrides,
  })
}

async function seedGroupSession(id: string): Promise<void> {
  await getDb().sessions.add({
    id,
    title: "g",
    kind: "direct",
    platformConversationKey: GROUP_KEY,
    platformBinding: { platform: "telegram", adapterId: "adapter_1", conversationKey: GROUP_KEY },
    createdAt: 0,
    updatedAt: 0,
  } as never)
}

function storedMsgRow(
  id: string,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
  createdAt: number,
  senderName = "Ada"
) {
  return {
    id,
    sessionId,
    role,
    parts: [{ type: "text", text }],
    createdAt,
    updatedAt: createdAt,
    metadata:
      role === "user"
        ? {
            platformMessage: {
              messageId: `pm_${id}`,
              platform: "telegram",
              adapterId: "adapter_1",
              conversationKey: GROUP_KEY,
              sender: {
                id: `pid_${id}`,
                platform: "telegram",
                adapterId: "adapter_1",
                remoteUserId: `u_${id}`,
                displayName: senderName,
                kind: "human",
              },
            },
          }
        : undefined,
  } as never
}

describe("recentGroupContextBlock", () => {
  it("scrubs legacy inline image markers before projecting group context", async () => {
    await seedGroupSession("s_ctx")
    const now = Date.now()
    await getDb().messages.bulkAdd([
      storedMsgRow(
        "m_legacy",
        "s_ctx",
        "user",
        "caption [image: data:image/png;base64,DISPLAY_HISTORY_SENTINEL] done",
        now - 1_000
      ),
    ])
    const block = await recentGroupContextBlock({
      event: groupEvent(),
      excludeMessageId: "m_now",
      now,
    })
    expect(block).toContain("caption [image] done")
    expect(block).not.toContain("DISPLAY_HISTORY_SENTINEL")
  })

  it("returns undefined for a private conversation", async () => {
    await expect(
      recentGroupContextBlock({ event: makeEvent({}), excludeMessageId: "x" })
    ).resolves.toBeUndefined()
  })

  it("collects group user messages newer than the last assistant reply", async () => {
    await seedGroupSession("s_ctx")
    const now = Date.now()
    await getDb().messages.bulkAdd([
      storedMsgRow("m_old", "s_ctx", "user", "already handled", now - 3_000),
      storedMsgRow("a_1", "s_ctx", "assistant", "bot reply", now - 2_000),
      storedMsgRow("m_new", "s_ctx", "user", "unseen ambient", now - 1_000),
      storedMsgRow("m_now", "s_ctx", "user", "current turn", now),
    ])

    const block = await recentGroupContextBlock({
      event: groupEvent(),
      excludeMessageId: "m_now",
      now,
    })

    expect(block).toContain("unseen ambient")
    expect(block).toContain("Ada")
    // `m_old` predates the assistant watermark — the model already saw it.
    expect(block).not.toContain("already handled")
    expect(block).not.toContain("current turn")
  })

  it("reaches into an earlier bound session when the active one is new", async () => {
    await seedGroupSession("s_old")
    await seedGroupSession("s_new")
    const now = Date.now()
    await getDb().messages.bulkAdd([
      storedMsgRow("m_prev", "s_old", "user", "from before the /new", now - 1_000),
    ])

    const block = await recentGroupContextBlock({
      event: groupEvent(),
      excludeMessageId: "m_now",
      now,
    })

    expect(block).toContain("from before the /new")
  })

  it("drops messages older than the context window", async () => {
    await seedGroupSession("s_ctx")
    const now = Date.now()
    await getDb().messages.bulkAdd([
      storedMsgRow("m_stale", "s_ctx", "user", "two days ago", now - 48 * 60 * 60 * 1000),
    ])

    await expect(
      recentGroupContextBlock({ event: groupEvent(), excludeMessageId: "x", now })
    ).resolves.toBeUndefined()
  })
})

describe("withConversationContext", () => {
  it("scrubs complete and truncated inline image markers from stored reply previews", async () => {
    const stored = {
      id: "m_now",
      metadata: {
        replyTo: { messageId: "m_1", preview: "caption [image: blob:DISPLAY_REPLY_SENTINEL" },
      },
    } as never
    const out = await withConversationContext("body", { event: makeEvent({}), stored })
    expect(out).toBe("[replying-to: caption [image]]\nbody")
  })
  it("prepends the replied-to preview as a bracketed header", async () => {
    const stored = {
      id: "m_now",
      metadata: { replyTo: { messageId: "m_1", preview: "the earlier words" } },
    } as never
    const out = await withConversationContext("body text", {
      event: makeEvent({}),
      stored,
    })
    expect(out).toBe("[replying-to: the earlier words]\nbody text")
  })

  it("prepends context as a leading text block on structured prompts", async () => {
    const stored = {
      id: "m_now",
      metadata: { replyTo: { messageId: "m_1", preview: "quoted" } },
    } as never
    const out = await withConversationContext([{ type: "text", text: "body" }], {
      event: makeEvent({}),
      stored,
    })
    expect(out).toEqual([
      { type: "text", text: "[replying-to: quoted]" },
      { type: "text", text: "body" },
    ])
  })

  it("returns the prompt untouched when there is nothing to add", async () => {
    const stored = { id: "m_now" } as never
    await expect(withConversationContext("body", { event: makeEvent({}), stored })).resolves.toBe(
      "body"
    )
  })
})
