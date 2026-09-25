/**
 * @jest-environment jsdom
 *
 * Coverage focus: the deterministic action surface of `useClaudeChat`.
 * The hook also wires a long-lived sidecar event handler through `onClaudeMessage`
 * — that handler is exercised indirectly via `send` / `respondToApproval`.
 */
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { act, renderHook } from "@testing-library/react"
import type { SendContentBlock, SendOptions } from "@cognia/agent-config-types"

import { useAgentRuntimeStore, useExternalAgentStore } from "@/stores/agent"
import type {
  StartSquadRunInput,
  StartSquadRunResult,
} from "@/lib/ai/agent/team/squad/start-squad-run"
import type { WatchSquadRunInput } from "@/lib/ai/agent/team/squad/watch-squad-run"
import type {
  ArmVerificationInput,
  ArmVerificationResult,
} from "@/lib/agent/composition/verified-fresh-agent"

const recordExternalAgentUsageMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/session-usage", () => ({
  ...jest.requireActual("@/lib/db/session-usage"),
  recordExternalAgentUsage: (...args: unknown[]) => recordExternalAgentUsageMock(...args),
}))

jest.mock("@/lib/task-workspace/client", () => {
  const actual = jest.requireActual("@/lib/task-workspace/client")
  return {
    ...actual,
    acquireWorkspaceBundle: jest.fn(actual.acquireWorkspaceBundle),
    settleTaskWorkspaceTurn: jest.fn(actual.settleTaskWorkspaceTurn),
  }
})
jest.mock("@/lib/code-adoption/client", () => {
  const actual = jest.requireActual("@/lib/code-adoption/client")
  return {
    ...actual,
    endCodeAdoptionTurn: jest.fn(actual.endCodeAdoptionTurn),
    consumeCodeAdoptionTrackingAttempt: jest.fn(actual.consumeCodeAdoptionTrackingAttempt),
  }
})

const persistSessionAssetsMock = jest.fn(
  async (_sessionId: string, message: import("ai").UIMessage) => message
)
jest.mock("@/lib/db/session-assets", () => ({
  ...jest.requireActual("@/lib/db/session-assets"),
  persistMessageSessionAssets: (...args: Parameters<typeof persistSessionAssetsMock>) =>
    persistSessionAssetsMock(...args),
}))

const backgroundDrainMock = jest.fn()
const peerDrainMock = jest.fn(async () => undefined)
jest.mock("./background-result-runtime", () => ({
  ...jest.requireActual("./background-result-runtime"),
  maybeDrainBackgroundResults: (sessionId: string) => backgroundDrainMock(sessionId),
}))
// Call-through spy: the real sink stays in charge of the journal, the test only
// observes what the approval paths record into it.
jest.mock("@/lib/chat/canonical-sink", () => {
  const actual = jest.requireActual("@/lib/chat/canonical-sink")
  return { ...actual, recordChatCanonicalEvents: jest.fn(actual.recordChatCanonicalEvents) }
})
jest.mock("@/lib/chat/session-peer-messaging", () => ({
  ...jest.requireActual("@/lib/chat/session-peer-messaging"),
  drainSessionPeerMessages: (sessionId: string) => (peerDrainMock as jest.Mock)(sessionId),
}))

const mockTrackEvent = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}))

const releaseSkillLoadContextMock = jest.fn()
jest.mock("@/lib/skills/runtime-loader", () => ({
  releaseSkillLoadContext: (sessionId: string) => releaseSkillLoadContextMock(sessionId),
}))

jest.mock("@/lib/perf/chat-turn-performance", () => ({
  chatTurnPerformance: {
    begin: jest.fn(),
    markDispatched: jest.fn(),
    markFirstResponse: jest.fn(),
    markCommandDeduped: jest.fn(),
    beginFinalPersistence: jest.fn(),
    endFinalPersistence: jest.fn(),
    finish: jest.fn(),
  },
}))
const chatTurnPerformanceMock = (
  jest.requireMock("@/lib/perf/chat-turn-performance") as {
    chatTurnPerformance: {
      begin: jest.Mock
      markDispatched: jest.Mock
      markFirstResponse: jest.Mock
      markCommandDeduped: jest.Mock
      beginFinalPersistence: jest.Mock
      endFinalPersistence: jest.Mock
      finish: jest.Mock
    }
  }
).chatTurnPerformance

// `stores/index.ts` calls `isTauri()` at module top-level; declaring the
// jest.fn inside the factory dodges the TDZ that closures over an outer
// const would otherwise hit during ES import hoisting.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(true),
}))
const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

const onClaudeUnsub = jest.fn()
let _messageCallback: ((evt: unknown) => void) | null = null
const onClaudeMessageMock = jest.fn(async (cb: (evt: unknown) => void) => {
  _messageCallback = cb
  return onClaudeUnsub
})
const sendPromptMock = jest.fn().mockResolvedValue(undefined)
const enqueueHostStateIntentMock = jest.fn().mockResolvedValue(null)
const interruptSessionMock = jest.fn().mockResolvedValue(undefined)
// Live mid-turn steer into the Anthropic sidecar's streaming input. Rejecting
// is the realistic default for most tests: an idle/closed query refuses, and
// `send` must then fall back to the durable queue.
const steerSessionMock = jest.fn().mockRejectedValue(new Error("input_closed"))
const closeSessionIpcMock = jest.fn().mockResolvedValue(undefined)
const approveToolMock = jest.fn().mockResolvedValue(undefined)
// Real module otherwise — only the epoch bump is asserted, and a stubbed
// `judgeCommandSafety` returning null keeps the auto-mode tier a safe no-op.
const invalidateJudgeContextMock = jest.fn()
jest.mock("@/lib/claude/permissions/command-judge", () => ({
  invalidateJudgeContext: (...a: unknown[]) => invalidateJudgeContextMock(...a),
  judgeCommandSafety: jest.fn(async () => null),
  __resetJudgeCache: jest.fn(),
}))

jest.mock("@/lib/claude/ipc", () => ({
  approveTool: (...a: unknown[]) => approveToolMock(...a),
  closeSession: (id: string) => closeSessionIpcMock(id),
  interruptSession: (id: string) => interruptSessionMock(id),
  onClaudeMessage: (cb: (evt: unknown) => void) => onClaudeMessageMock(cb),
  sendPrompt: (...a: unknown[]) => sendPromptMock(...a),
  steerSession: (...a: unknown[]) => steerSessionMock(...a),
}))

const acceptChatTurnMock = jest.fn().mockResolvedValue(null)
const bindChatTurnContextMock = jest.fn().mockResolvedValue(false)
const claimChatTurnForDispatchMock = jest.fn().mockResolvedValue("disabled")
const markChatTurnStartedMock = jest.fn().mockResolvedValue(false)
const settleChatTurnForSessionMock = jest.fn().mockResolvedValue(false)
jest.mock("@/lib/work-submission/chat-adapter", () => ({
  acceptChatTurn: (...args: unknown[]) => acceptChatTurnMock(...args),
  bindChatTurnContext: (...args: unknown[]) => bindChatTurnContextMock(...args),
  chatSubmissionId: (runId: string) => `work:${runId}`,
  claimChatTurnForDispatch: (...args: unknown[]) => claimChatTurnForDispatchMock(...args),
  markChatTurnStarted: (...args: unknown[]) => markChatTurnStartedMock(...args),
  settleChatTurnForSession: (...args: unknown[]) => settleChatTurnForSessionMock(...args),
}))

const unregisterInteractiveWorkSubmissionEventsMock = jest.fn()
const registerInteractiveWorkSubmissionEventsMock = jest.fn(
  () => unregisterInteractiveWorkSubmissionEventsMock
)
jest.mock("@/lib/work-submission/terminal-events", () => ({
  registerInteractiveWorkSubmissionEvents: () => registerInteractiveWorkSubmissionEventsMock(),
}))

const stopLeaseHeartbeatMock = jest.fn()
const startLeaseHeartbeatMock = jest.fn(
  (_submissionId: string, _leaseOwner: string) => stopLeaseHeartbeatMock
)
jest.mock("@/lib/work-submission/lease-heartbeat", () => ({
  startWorkSubmissionLeaseHeartbeat: (submissionId: string, leaseOwner: string) =>
    startLeaseHeartbeatMock(submissionId, leaseOwner),
}))

jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: (...args: unknown[]) => enqueueHostStateIntentMock(...args),
}))

// Standalone (BYOK) chat — off by default so the sidecar-path suite is
// unaffected; individual tests flip the flag.
const standaloneFlag = { value: false }
const runStandaloneTurnMock = jest.fn(async (_args?: unknown): Promise<void> => undefined)
const gateWorkbenchProviderPayloadMock = jest.fn((payload: unknown) => payload)
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => standaloneFlag.value,
}))
jest.mock("@/lib/ai/chat/standalone-engine", () => ({
  runStandaloneTurn: (args: { emit: (e: unknown) => void; signal: AbortSignal }) =>
    runStandaloneTurnMock(args),
}))
jest.mock("@/lib/context-workbench/provider-payload", () => ({
  gateWorkbenchProviderPayload: (
    payload: { content: unknown; sendOptions: unknown; messages: unknown[] },
    resourceContext: string
  ) =>
    gateWorkbenchProviderPayloadMock({
      ...payload,
      content: resourceContext
        ? `[Current resource context]\n${resourceContext}\n\n[User instruction]\n${String(payload.content)}`
        : payload.content,
    }),
}))

jest.mock("@/lib/claude/adapter", () => ({
  applySdkEvent: jest.fn(() => ({ messages: [], turnComplete: false })),
  contentPreview: (c: unknown) => (typeof c === "string" ? c : "preview"),
  makeUserMessage: jest.fn((c: unknown) => ({
    id: "u1",
    role: "user",
    parts: [{ type: "text", text: c }],
  })),
  extractUsage: jest.fn(() => null),
  mergeTwinSourcesIntoLastAssistant: (msgs: unknown) => msgs,
  mergeWebSearchSourcesIntoLastAssistant: jest.fn((msgs: unknown) => msgs),
}))

const runTurnMemoryMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/memory/run-turn-memory", () => ({
  runTurnMemory: (...args: unknown[]) => runTurnMemoryMock(...args),
}))

const applySdkSubagentBridgeMock = jest.fn()
jest.mock("@/lib/claude/sdk-subagent-bridge", () => ({
  applySdkSubagentBridge: (...args: unknown[]) => applySdkSubagentBridgeMock(...args),
  __resetSdkSubagentBridge: () => {},
}))

jest.mock("@/lib/plugin/messaging/message-bus", () => {
  const actual = jest.requireActual("@/lib/plugin/messaging/message-bus")
  return { ...actual, emitSystemBusEvent: jest.fn() }
})
const busEmitMock = (
  jest.requireMock("@/lib/plugin/messaging/message-bus") as {
    emitSystemBusEvent: jest.Mock
  }
).emitSystemBusEvent
const { SystemEvents: BusEvents } = jest.requireActual(
  "@/lib/plugin/messaging/message-bus"
) as typeof import("@/lib/plugin/messaging/message-bus")

// ADR-0019 goal wiring — mock the runtime/turn-driver/judge-client so `send`
// and the turn-complete handler don't reach real Dexie. Defaults make the
// no-goal path a no-op (getActiveGoalForSession → undefined).
const goalRuntimeMock = {
  getActiveGoalForSession: jest.fn().mockResolvedValue(undefined),
  pauseGoal: jest.fn().mockResolvedValue(null),
  registerAbortController: jest.fn(() => () => {}),
  onManualContinue: jest.fn(() => () => {}),
  requestManualContinue: jest.fn(),
  recordPacingDecision: jest.fn().mockResolvedValue(undefined),
}
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => goalRuntimeMock,
}))
// Same posture for the /loop runtime — defaults make the no-loop path a
// no-op (getActiveLoopForSession → undefined) so send()/turn-complete
// never reach real Dexie.
const loopRuntimeMock = {
  getActiveLoopForSession: jest.fn().mockResolvedValue(undefined),
  pauseLoop: jest.fn().mockResolvedValue(null),
  registerAbortController: jest.fn(() => () => {}),
  // NB: typed param so tests can mockImplementation((cb) => …) — a bare
  // jest.fn(() => …) infers a zero-arg signature (TS2345).
  onKickoff: jest.fn((_cb: (loop: unknown) => void) => () => {}),
}
jest.mock("@/lib/loop/runtime", () => ({
  getLoopRuntime: () => loopRuntimeMock,
}))
const handleLoopTurnCompleteMock = jest.fn()
jest.mock("@/lib/loop/turn-driver", () => ({
  handleLoopTurnComplete: (...a: unknown[]) => handleLoopTurnCompleteMock(...a),
}))
const handleTurnCompleteMock = jest.fn()
jest.mock("@/lib/goal/turn-driver", () => ({
  handleTurnComplete: (...a: unknown[]) => handleTurnCompleteMock(...a),
}))
const buildGoalJudgeClientMock = jest.fn()
jest.mock("@/lib/goal/judge-client", () => ({
  buildGoalJudgeClient: (...a: unknown[]) => buildGoalJudgeClientMock(...a),
}))

const persistMessagesMock = jest.fn().mockResolvedValue(undefined)
const truncateAfterMock = jest.fn().mockResolvedValue(undefined)
const listMessagesMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (id: string) => listMessagesMock(id),
  persistMessages: (...a: unknown[]) => persistMessagesMock(...a),
  persistStreamingMessages: (...a: unknown[]) => persistMessagesMock(...a),
  truncateAfter: (...a: unknown[]) => truncateAfterMock(...a),
}))

const getSessionMock = jest.fn()
const setSdkSessionIdMock = jest.fn().mockResolvedValue(undefined)
const touchSessionMock = jest.fn().mockResolvedValue(undefined)
const updateSessionMock = jest.fn().mockResolvedValue(undefined)
const clearBranchSeedMock = jest.fn().mockResolvedValue(undefined)
const mockHandoffClient = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/ai/generation/agent-backed-client", () => ({
  buildAgentBackedLlmClient: (...args: unknown[]) => mockHandoffClient(...args),
}))
const freezeImportedSessionMock = jest.fn().mockResolvedValue(undefined)
// The send-time Workspace Trust gate (`resolveWorkspaceTrustForSend`) reads
// persisted grants from Dexie for every project root. This suite has no
// IndexedDB: an unmocked read opens the shared database, fails, and leaves it
// closed for every later test in the file. Every root is trusted here; the gate
// has its own suite (lib/workspace/trust-gate.test.ts).
jest.mock("@/lib/db/trusted-workspaces", () => ({
  isWorkspaceTrusted: jest.fn(async () => true),
}))
jest.mock("@/lib/db/sessions", () => ({
  clearBranchSeed: (...a: unknown[]) => clearBranchSeedMock(...a),
  freezeImportedSession: (...a: unknown[]) => freezeImportedSessionMock(...a),
  getSession: (id: string) => getSessionMock(id),
  setSdkSessionId: (...a: unknown[]) => setSdkSessionIdMock(...a),
  touchSession: (id: string) => touchSessionMock(id),
  updateSession: (...a: unknown[]) => updateSessionMock(...a),
}))

jest.mock("@/lib/db/session-state", () => ({
  bumpUnread: jest.fn().mockResolvedValue(undefined),
}))

const flushProjectEditorEdits = jest.fn<Promise<string[]>, []>()
const toastWarning = jest.fn()
jest.mock("@/lib/files/project-editor-bridge", () => ({
  flushProjectEditorEdits: () => flushProjectEditorEdits(),
}))
const toastInfo = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    warning: (msg: string) => toastWarning(msg),
    info: (msg: string) => toastInfo(msg),
  },
}))
const resolveSendOptionsMock = jest.fn<Promise<SendOptions>, []>(async () => ({
  model: "sonnet",
  systemPrompt: "sys",
}))
jest.mock("@/lib/claude/build-options", () => ({
  resolveSendOptions: (...args: unknown[]) => resolveSendOptionsMock(...(args as [])),
}))

const openWorkspaceBundleTurnLeaseMock = jest.fn()
jest.mock("@/lib/task-workspace/run-lease", () => ({
  openWorkspaceBundleTurnLease: (...args: unknown[]) => openWorkspaceBundleTurnLeaseMock(...args),
}))

const ensureSessionExecutionBundleMock = jest.fn()
jest.mock("@/lib/task-workspace/session-bundle", () => ({
  ensureSessionExecutionBundle: (input: unknown) => ensureSessionExecutionBundleMock(input),
}))

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [
        {
          id: "project-1",
          roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
        },
      ],
    }),
  },
}))

const getProjectEnvironmentMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  getProjectEnvironment: (id: string) => getProjectEnvironmentMock(id),
}))
const executeProjectEnvironmentMock = jest.fn()
jest.mock("@/lib/project-environment/executor", () => ({
  executeProjectEnvironment: (input: unknown) => executeProjectEnvironmentMock(input),
}))

const dispatchUserPromptSubmitMock = jest.fn(async () => ({ action: "proceed" as const }))
const dispatchChatErrorMock = jest.fn()
const dispatchTokenUsageMock = jest.fn()
const dispatchPostChatReceiveMock = jest.fn(async () => ({}))
jest.mock("@/lib/claude/adapter-hooks", () => ({
  dispatchUserPromptSubmit: (...a: unknown[]) => dispatchUserPromptSubmitMock(...(a as [])),
  dispatchChatError: (...a: unknown[]) => dispatchChatErrorMock(...(a as [])),
  dispatchTokenUsage: (...a: unknown[]) => dispatchTokenUsageMock(...(a as [])),
  dispatchPostChatReceive: (...a: unknown[]) => dispatchPostChatReceiveMock(...(a as [])),
  // W3.1 tool hooks — inert in this unit suite (integration coverage lives in
  // chat-main-flow.integration.test.tsx).
  dispatchPreToolUse: jest.fn(async () => ({ action: "allow" as const })),
  dispatchPostToolUse: jest.fn(async () => ({})),
  dispatchOnMessageSend: jest.fn(async (m: unknown) => m),
  dispatchOnAssistantMessage: jest.fn(async (m: unknown) => m),
  hasPostToolUseListeners: jest.fn(() => false),
}))

// External-agent branch (D1): dynamically imported by `send` when the agent
// runtime is "external". Mock both so the branch is drivable from a test.
const executeOnExternalAgentMock = jest.fn()
const executeOnRemoteHostAgentMock = jest.fn()
jest.mock("@/lib/ai/agent/external/runtimes/remote/remote-execute", () => ({
  ...jest.requireActual("@/lib/ai/agent/external/runtimes/remote/remote-execute"),
  executeOnRemoteHostAgent: (...args: unknown[]) => executeOnRemoteHostAgentMock(...args),
}))
const rendererToolHostStartMock = jest.fn(async (..._args: unknown[]) => ({
  mcpServers: [] as import("@/types/agent/external-agent").AcpMcpServerConfig[],
  catalogFingerprint: "catalog-1",
}))
const rendererToolHostPauseMock = jest.fn(async () => {})
const rendererToolHostCloseMock = jest.fn(async () => {})
const createRendererToolHostMock = jest.fn((..._args: unknown[]) => ({
  start: rendererToolHostStartMock,
  pause: rendererToolHostPauseMock,
  close: rendererToolHostCloseMock,
}))
const closeExternalSessionMock = jest.fn(async (..._args: unknown[]) => {})
const setSessionHostFactsMock = jest.fn()
const respondExternalPermissionMock = jest.fn(async (..._args: unknown[]) => {})
const externalProtocolMock = { value: "acp" }
const externalPresetMock = { value: "" }
const externalMcpLevelMock = { value: "native" }
jest.mock("@/lib/ai/agent/external/session/renderer-tool-host", () => ({
  RENDERER_TOOL_HOST_APPROVAL_PREFIX: "external-tool-host:",
  createRendererToolHost: (...args: unknown[]) => createRendererToolHostMock(...args),
}))
const getConnectedAgentsMock = jest.fn<unknown[], []>(() => [])
const checkDelegationMock = jest.fn(
  (): {
    shouldDelegate: boolean
    targetAgentId?: string
    matchedRule?: { id: string; name: string }
    reasonCode?: string
  } => ({ shouldDelegate: false })
)
const setDelegationRulesMock = jest.fn()
/**
 * The send readies its own lane before dispatching, so a restored session that
 * never touched the runtime picker does not die on the manager's internal
 * "Agent not found". These tests point at `ext-1` without ever registering it
 * with a manager, so without this every external-lane case is refused with
 * `external_agent_unavailable` before `executeOnExternalAgent` is reached.
 */
const ensureExternalAgentReadyMock = jest.fn(async (..._args: unknown[]) => ({
  ok: true,
  alreadyConnected: true,
}))
jest.mock("@/lib/agent/ensure-external-agent-ready", () => ({
  ensureExternalAgentReady: (...args: unknown[]) => ensureExternalAgentReadyMock(...args),
}))

jest.mock("@/lib/ai/agent/external/manager", () => ({
  executeOnExternalAgent: (...a: unknown[]) => executeOnExternalAgentMock(...(a as [])),
  getExternalAgentManager: () => ({
    getConnectedAgents: () => getConnectedAgentsMock(),
    getAgentCapabilityProfile: () => ({
      effective: {
        mcp: { level: externalMcpLevelMock.value },
        "tools.ordinary": { level: "native" },
        "tools.results": { level: "native" },
        "session.resume": {
          level: externalProtocolMock.value === "dsh-sdk" ? "unsupported" : "native",
        },
      },
    }),
    closeSession: (...args: unknown[]) => closeExternalSessionMock(...args),
    setSessionHostFacts: (...args: unknown[]) => setSessionHostFactsMock(...args),
    respondToPermission: (...args: unknown[]) => respondExternalPermissionMock(...args),
    getAgent: () => ({
      config: {
        protocol: externalProtocolMock.value,
        metadata: { preset: externalPresetMock.value },
      },
    }),
    checkDelegation: (...a: unknown[]) => checkDelegationMock(...(a as [])),
    setDelegationRules: (...a: unknown[]) => setDelegationRulesMock(...(a as [])),
  }),
}))
/**
 * A stand-in for the real mapper, kept faithful on the one axis the tests read:
 * events it does not route into parts return the SAME array, which is how the
 * caller detects "no change". Appending for every event made a turn that
 * produced nothing look like a turn that produced text, so a guard on "did
 * this turn show anything" could never be exercised here.
 */
const PARTS_EVENTS = new Set([
  "message_delta",
  "thinking",
  "commentary_delta",
  "tool_use_start",
  "tool_call_update",
  "tool_use_end",
  "tool_result",
  "hook_fire",
  // Not a real mapper case; the older tests emit it as a shorthand for a text
  // delta and assert one appended character per event.
  "text",
])
jest.mock("@/lib/ai/agent/external/session/event-to-parts", () => {
  const actual = jest.requireActual<
    typeof import("@/lib/ai/agent/external/session/event-to-parts")
  >("@/lib/ai/agent/external/session/event-to-parts")
  return {
    applyExternalAgentEventToParts: (parts: unknown, event: unknown, options?: unknown) => {
      const type = (event as { type?: string } | undefined)?.type
      // Delegate to the real projection so the inlineQuestions gate and the
      // card part's session stamping are exercised end-to-end.
      if (type === "async_questions") {
        return actual.applyExternalAgentEventToParts(
          parts as never,
          event as never,
          options as never
        )
      }
      if (type && !PARTS_EVENTS.has(type)) return parts as unknown[]
      return [...((parts as unknown[]) ?? []), { type: "text", text: "x", state: "streaming" }]
    },
  }
})

const startSquadRunMock = jest.fn<Promise<StartSquadRunResult>, [StartSquadRunInput]>()
const stopSquadWatchMock = jest.fn()
const watchSquadRunSettlementMock = jest.fn<() => void, [WatchSquadRunInput]>(
  () => stopSquadWatchMock
)
jest.mock("@/lib/ai/agent/team/squad/start-squad-run", () => ({
  startSquadRun: (input: StartSquadRunInput) => startSquadRunMock(input),
}))
jest.mock("@/lib/ai/agent/team/squad/watch-squad-run", () => ({
  watchSquadRunSettlement: (input: WatchSquadRunInput) => watchSquadRunSettlementMock(input),
}))
const armVerifiedFreshAgentFollowupMock = jest.fn<
  Promise<ArmVerificationResult>,
  [ArmVerificationInput]
>(async () => ({ armed: true, settled: Promise.resolve() }))
jest.mock("@/lib/agent/composition/verified-fresh-agent", () => ({
  armVerifiedFreshAgentFollowup: (input: ArmVerificationInput) =>
    armVerifiedFreshAgentFollowupMock(input),
}))
jest.mock("@/lib/execution/agent-team-bridge", () => ({
  agentTeamExecutionRunId: (id: string) => `execution:team:${id}`,
}))

// `@agent` turn routing (`lib/chat/turn-route/`): the send path re-reads the
// route context at commit time. Stubbed so each test states the catalog, the
// Squads and the switch it runs against; the parser and the lane resolver stay
// real, so a test proves the send path's decision rather than a stub's.
const routeSnapshotMock = jest.fn<
  Promise<import("@/lib/chat/turn-route/snapshot").RouteContextSnapshot>,
  [string | null | undefined, unknown?]
>()
jest.mock("@/lib/chat/turn-route/snapshot", () => ({
  ...jest.requireActual("@/lib/chat/turn-route/snapshot"),
  snapshotRouteContext: (sessionId: string | null | undefined, options?: unknown) =>
    routeSnapshotMock(sessionId, options),
}))

interface SliceLike {
  messages: unknown[]
  status: string
  errorMessage: string | null
  errorDiagnostic: { message?: string } | null
  pendingApprovals: unknown[]
  activeBranchByGroup: Record<string, string>
  pendingCommandOverrides?: unknown
  citedRefs?: unknown[]
  ephemeralSkillIds?: string[]
  steerQueue?: unknown[]
}
const makeSlice = (): SliceLike => ({
  messages: [],
  status: "idle",
  errorMessage: null,
  errorDiagnostic: null,
  pendingApprovals: [],
  activeBranchByGroup: {},
})

interface ChatStateLike {
  activeSessionId: string | null
  openSessionIds: string[]
  paneIdsBySession: Record<string, string[]>
  splitSessionId: string | null
  /** Slices for *background* (non-focused) sessions; the active session's slice
   * is projected from the flat fields below by the `sessions` getter, so the
   * existing flat-field test seeds (`chatState.messages = …`) keep working. */
  otherSlices: Record<string, SliceLike>
  readonly sessions: Record<string, SliceLike>
  messages: unknown[]
  status: string
  errorMessage: string | null
  errorDiagnostic: { message?: string } | null
  pendingApprovals: unknown[]
  activeBranchByGroup: Record<string, string>
  pendingCommandOverrides: unknown
  referencedPaths: unknown[]
  citedRefs: unknown[]
  ephemeralSkillIds: string[]
  lastSendBySession: Record<
    string,
    { content: unknown; options: SendOptions; attemptIndex: number }
  >
  setActiveSession: jest.Mock
  setMessages: jest.Mock
  replaceMessages: jest.Mock
  appendMessage: jest.Mock
  setStatus: jest.Mock
  setError: jest.Mock
  replaceSessionMessages: jest.Mock
  replaceMessagesForSession: jest.Mock
  setSessionStatus: jest.Mock
  setSessionError: jest.Mock
  setSessionDiagnostic: jest.Mock
  setSessionActiveBranch: jest.Mock
  hydrateSessionActiveBranches: jest.Mock
  pushApproval: jest.Mock
  clearApproval: jest.Mock
  markApprovalInterrupted: jest.Mock
  closeSession: jest.Mock
  setPendingCommandOverrides: jest.Mock
  clearEphemeralSkillIds: jest.Mock
  setLastSend: jest.Mock
  clearLastSend: jest.Mock
  enqueueSteer: jest.Mock
  clearSteerQueue: jest.Mock
}

const sliceWrite = (id: string, patch: Partial<SliceLike>) => {
  if (id === chatState.activeSessionId) {
    if (patch.messages !== undefined) chatState.messages = patch.messages
    if (patch.status !== undefined) chatState.status = patch.status
    if (patch.errorMessage !== undefined) chatState.errorMessage = patch.errorMessage
    if (patch.pendingApprovals !== undefined) chatState.pendingApprovals = patch.pendingApprovals
    if (patch.activeBranchByGroup !== undefined)
      chatState.activeBranchByGroup = patch.activeBranchByGroup
    return
  }
  chatState.otherSlices[id] = { ...(chatState.otherSlices[id] ?? makeSlice()), ...patch }
}

const chatState: ChatStateLike = {
  activeSessionId: "sess-1",
  openSessionIds: ["sess-1"],
  paneIdsBySession: {},
  splitSessionId: null,
  otherSlices: {},
  get sessions() {
    const map: Record<string, SliceLike> = { ...chatState.otherSlices }
    if (chatState.activeSessionId) {
      map[chatState.activeSessionId] = {
        messages: chatState.messages,
        status: chatState.status,
        errorMessage: chatState.errorMessage,
        errorDiagnostic: chatState.errorDiagnostic,
        pendingApprovals: chatState.pendingApprovals,
        activeBranchByGroup: chatState.activeBranchByGroup,
      }
    }
    return map
  },
  messages: [],
  status: "idle",
  errorMessage: null,
  errorDiagnostic: null,
  pendingApprovals: [],
  activeBranchByGroup: {},
  pendingCommandOverrides: null,
  referencedPaths: [],
  citedRefs: [],
  ephemeralSkillIds: [],
  lastSendBySession: {},
  setActiveSession: jest.fn(),
  setMessages: jest.fn(),
  replaceMessages: jest.fn((m: unknown[]) => {
    chatState.messages = m
  }),
  appendMessage: jest.fn((msg: unknown) => {
    chatState.messages = [...chatState.messages, msg]
  }),
  setStatus: jest.fn((s: string) => {
    chatState.status = s
  }),
  setError: jest.fn((e: string | null) => {
    chatState.errorMessage = e
    chatState.status = e ? "error" : "idle"
  }),
  replaceSessionMessages: jest.fn((id: string, m: unknown[]) => sliceWrite(id, { messages: m })),
  setSessionStatus: jest.fn((id: string, s: string) => sliceWrite(id, { status: s })),
  setSessionError: jest.fn((id: string, e: string | null) =>
    sliceWrite(id, { errorMessage: e, errorDiagnostic: null, status: e ? "error" : "idle" })
  ),
  // Mirrors the real store: the structured write also lands the raw technical
  // text on the legacy field.
  setSessionDiagnostic: jest.fn((id: string, d: { message?: string } | null) =>
    sliceWrite(id, {
      errorDiagnostic: d,
      errorMessage: d?.message ?? null,
      status: d ? "error" : "idle",
    })
  ),
  setSessionActiveBranch: jest.fn((id: string, g: string, mid: string) => {
    const cur = chatState.sessions[id]?.activeBranchByGroup ?? {}
    sliceWrite(id, { activeBranchByGroup: { ...cur, [g]: mid } })
  }),
  hydrateSessionActiveBranches: jest.fn((id: string, map: Record<string, string>) =>
    sliceWrite(id, { activeBranchByGroup: { ...map } })
  ),
  pushApproval: jest.fn((a: { sessionId: string }) => {
    const cur = chatState.sessions[a.sessionId]?.pendingApprovals ?? []
    sliceWrite(a.sessionId, { pendingApprovals: [...cur, a], status: "awaiting_approval" })
  }),
  replaceMessagesForSession: jest.fn((id: string, messages: unknown[]) =>
    sliceWrite(id, { messages })
  ),
  clearApproval: jest.fn(),
  markApprovalInterrupted: jest.fn(),
  closeSession: jest.fn(),
  setPendingCommandOverrides: jest.fn((o: unknown) => {
    chatState.pendingCommandOverrides = o
  }),
  clearEphemeralSkillIds: jest.fn(() => {
    chatState.ephemeralSkillIds = []
  }),
  setLastSend: jest.fn(
    (id: string, e: { content: unknown; options: SendOptions; attemptIndex: number }) => {
      chatState.lastSendBySession[id] = e
    }
  ),
  clearLastSend: jest.fn((id: string) => {
    delete chatState.lastSendBySession[id]
  }),
  enqueueSteer: jest.fn(),
  clearSteerQueue: jest.fn(),
}

const subscribers: Array<(s: ChatStateLike) => void> = []
const selectIsAtStreamCapMock = jest.fn((_s: unknown, _id: string) => false)

jest.mock("@/stores/chat/chat-store", () => jest.requireMock("@/stores/chat"))

jest.mock("@/stores/chat", () => {
  // Loaded with the mock rather than on first use: pulling the real store's
  // module graph in mid-send stalls the turn long enough for unrelated
  // IndexedDB-backed effects to surface as test failures.
  const actualChatStore = jest.requireActual<typeof import("@/stores/chat/chat-store")>(
    "@/stores/chat/chat-store"
  )
  return {
    useChatStore: Object.assign(<T>(selector: (s: ChatStateLike) => T): T => selector(chatState), {
      getState: () => chatState,
      subscribe: (fn: (s: ChatStateLike) => void) => {
        subscribers.push(fn)
        return () => {
          const i = subscribers.indexOf(fn)
          if (i >= 0) subscribers.splice(i, 1)
        }
      },
    }),
    selectIsAtStreamCap: (s: unknown, id: string) => selectIsAtStreamCapMock(s, id),
    // Same per-conversation resolution the real store exports: the send path
    // reads THIS session's draft, not the focused projection.
    selectComposerEphemeralSkillIds: (s: ChatStateLike, id?: string | null) =>
      (id
        ? (s as ChatStateLike & Record<string, never>).sessions?.[id]?.ephemeralSkillIds
        : null) ??
      s.ephemeralSkillIds ??
      [],
    selectComposerPendingCommandOverrides: (s: ChatStateLike, id?: string | null) =>
      (id
        ? (s as ChatStateLike & Record<string, never>).sessions?.[id]?.pendingCommandOverrides
        : null) ??
      s.pendingCommandOverrides ??
      null,
    // Chip-style citations (a staged document / memory / issue / plan / chat /
    // artifact). They leave no token in the text, so the send path merges this
    // list with the ones `resolve-mentions.ts` parses out of it — same
    // per-conversation resolution as the two above.
    selectComposerCitedRefs: (s: ChatStateLike, id?: string | null) =>
      (id ? (s as ChatStateLike & Record<string, never>).sessions?.[id]?.citedRefs : null) ??
      s.citedRefs ??
      [],
    // The real branch-visibility rule: the send path hands a lane the turns it
    // has not seen from the VISIBLE thread (`lib/chat/turn-route/history.ts`).
    // Pure, so the actual implementation is used rather than a lookalike.
    selectVisibleMessages: actualChatStore.selectVisibleMessages,
  }
})

// The unified execution broker governs the concurrency cap; stub it so a test
// can flip the session at/over capacity without standing up the real broker.
const isAtCapacityMock = jest.fn((_resource: string, _id?: string) => false)
jest.mock("@/lib/execution/broker", () => ({
  getExecutionBroker: () => ({
    isAtCapacity: (resource: string, id?: string) => isAtCapacityMock(resource, id),
  }),
}))
// Chat admission is exercised in lib/execution/chat-lease.test.ts; here it is a
// no-op so the hook's send path stays isolated from the real broker.
const acquireChatLeaseMock = jest.fn().mockResolvedValue(undefined)
// The in-session plan edges both runtimes share (`plan-turn-settle.ts` has its
// own suite); here only WHICH edge the external lane takes is asserted.
const driveInSessionPlanAfterTurnMock = jest.fn(async (_input: unknown) => false)
const haltInSessionPlanOnTurnFailureMock = jest.fn(async (_input: unknown) => undefined)
jest.mock("./plan-turn-settle", () => ({
  driveInSessionPlanAfterTurn: (input: unknown) => driveInSessionPlanAfterTurnMock(input),
  haltInSessionPlanOnTurnFailure: (input: unknown) => haltInSessionPlanOnTurnFailureMock(input),
}))

const isChatTurnQueuedMock = jest.fn((_sessionId: string) => false)
jest.mock("@/lib/execution/chat-lease", () => ({
  acquireChatLease: (...args: unknown[]) => acquireChatLeaseMock(...args),
  isChatTurnQueued: (sessionId: string) => isChatTurnQueuedMock(sessionId),
  isQueuedChatTurnCancellation: (error: unknown) =>
    error instanceof Error && error.name === "AbortError",
}))

// Direct-chat journal persistence is covered by lib/execution/direct-chat-run.test.ts.
// Keep this hook suite focused on routing and UI state without requiring IndexedDB.
jest.mock("@/lib/execution/direct-chat-run", () => ({
  finishDirectChatExecutionRun: jest.fn().mockResolvedValue(undefined),
  projectDirectChatCaptureEvent: jest.fn().mockResolvedValue(undefined),
  projectDirectChatSdkMessage: jest.fn().mockResolvedValue(undefined),
  startDirectChatExecutionRun: jest.fn().mockResolvedValue(undefined),
}))

const settingsState = {
  settings: {
    alwaysAllowTools: [] as string[],
    artifacts: { autoCreate: false },
    agentPermissions: undefined as { toolRules?: Record<string, unknown> } | undefined,
    inlineQuestions: undefined as { enabled?: boolean } | undefined,
  },
  toggleAlwaysAllow: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockResolvedValue(undefined),
}
const settingsSubscribers: Array<(s: typeof settingsState) => void> = []

// The background utility client is irrelevant to these tests (Auto-mode uses
// the deterministic rules tier without it); stub it to null so no real
// provider resolution runs.
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: () => null,
}))
// Wrap the real Auto-mode runner so most tests keep its deterministic rules
// tier, while one test can override it to a never-resolving promise (a wedged
// model judge) and assert the renderer's timeout still surfaces the dialog.
jest.mock("@/lib/claude/permissions/auto-mode-runner", () => {
  const actual = jest.requireActual("@/lib/claude/permissions/auto-mode-runner")
  return { ...actual, runAutoModeForTool: jest.fn(actual.runAutoModeForTool) }
})
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    <T>(selector: (s: typeof settingsState) => T): T => selector(settingsState),
    {
      getState: () => settingsState,
      subscribe: (fn: (s: typeof settingsState) => void) => {
        settingsSubscribers.push(fn)
        return () => {
          const i = settingsSubscribers.indexOf(fn)
          if (i >= 0) settingsSubscribers.splice(i, 1)
        }
      },
    }
  ),
}))

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: { getState: () => ({ autoCreateFromContent: jest.fn() }) },
}))

const mockGetTwinRuntimeSettings = jest.fn()
jest.mock("@/lib/db/twin-runtime-settings", () => ({
  getTwinRuntimeSettings: () => mockGetTwinRuntimeSettings(),
}))

const mockCreateVectorStore = jest.fn()
jest.mock("@cognia/vector/store", () => ({
  createVectorStore: (...args: unknown[]) => mockCreateVectorStore(...args),
}))

// Router + Fusion (ADR-0188) entry seams. The defaults are the off path: every
// send passes through untouched, nothing is cancelled.
const prepareRouterFusionSendMock = jest.fn(async (input: { options: SendOptions }) => ({
  kind: "send" as const,
  options: input.options,
}))
const abortRouterFusionSendMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/router-fusion/gate/chat-send", () => ({
  prepareRouterFusionSend: (input: { options: SendOptions }) => prepareRouterFusionSendMock(input),
  abortRouterFusionSend: (...args: unknown[]) => abortRouterFusionSendMock(...args),
}))
const cancelRouterFusionTurnMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/router-fusion/gate/chat-events", () => ({
  ...jest.requireActual("@/lib/router-fusion/gate/chat-events"),
  cancelRouterFusionTurn: (...args: unknown[]) => cancelRouterFusionTurnMock(...args),
}))
// A cascade or panel turn (ADR-0188 B3). The default is no fusion turn in flight.
const fusionChatTurnActiveMock = jest.fn((_sessionId: string) => false)
const runFusionChatTurnMock = jest.fn(
  async (..._args: unknown[]): Promise<"completed" | "failed" | "cancelled"> => "completed"
)
const stopFusionChatTurnMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./router-fusion-chat-turn", () => ({
  ...jest.requireActual("./router-fusion-chat-turn"),
  fusionChatTurnActive: (sessionId: string) => fusionChatTurnActiveMock(sessionId),
  runFusionChatTurn: (...args: unknown[]) => runFusionChatTurnMock(...args),
  stopFusionChatTurn: (...args: unknown[]) => stopFusionChatTurnMock(...args),
}))
// A private session is the default: `beginSharedSessionRun` only reaches its
// lease handlers for a collaboration-bound session.
const beginSharedSessionRunMock = jest.fn(
  async (..._args: unknown[]) => ({ kind: "private" }) as unknown
)
const sendSharedSessionMessageMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  ...jest.requireActual("@/lib/collab/shared-run-coordinator"),
  beginSharedSessionRun: (...args: unknown[]) => beginSharedSessionRunMock(...args),
  sendSharedSessionMessage: (...args: unknown[]) => sendSharedSessionMessageMock(...args),
}))
const isCostBudgetConfiguredMock = jest.fn(() => false)
const enforceCostBudgetMock = jest.fn(async (..._args: unknown[]) => ({
  allowed: true,
  blockedBy: [] as Array<{ scopeKey: string }>,
}))
jest.mock("@/lib/usage/cost-budget-gate", () => ({
  ...jest.requireActual("@/lib/usage/cost-budget-gate"),
  isCostBudgetConfigured: () => isCostBudgetConfiguredMock(),
  enforceCostBudget: (...args: unknown[]) => enforceCostBudgetMock(...args),
}))

import {
  __resetRemoteAttachForTests,
  DEFAULT_APPROVAL_BACKSTOP_MS,
} from "@/lib/companion/remote-attach-registry"
import { registerCaptureResponder } from "@/lib/connectors/hitl/approval-registry"
import {
  RouterFusionInfrastructureError,
  RouterFusionRefusalError,
  RouterFusionUnavailableError,
} from "@/lib/router-fusion/gate/faults"
import { createElement, useState, type ReactNode } from "react"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import { buildRouteTargets } from "@/lib/agent-team/runtime-targets"
import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"
import type { RouteContextSnapshot } from "@/lib/chat/turn-route/snapshot"
import type { TurnRoute } from "@/lib/chat/turn-route/types"
import { subscribeDiagnostic } from "@/lib/diagnostics/bus"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import { useClaudeChat } from "./use-claude-chat-controller"
import { recordChatCanonicalEvents } from "@/lib/chat/canonical-sink"
import { answerChatApproval, stopChatTurn } from "./chat-control-bridge"
import {
  AgentExecutionHandleProvider,
  useAgentExecutionHandleDirectory,
} from "@/components/providers/agent-execution-handle-provider"
import { ClaudeChatRuntimeProvider, useClaudeChat as useSharedClaudeChat } from "./use-claude-chat"
import {
  hasSessionGrant,
  recordSessionGrant,
  __resetForTesting as resetComputerUseSessionGrants,
} from "@/lib/claude/computer-use-session-grants"

// The FIRST `renderHook(() => useClaudeChat())` pays for cold-loading the real
// hook's module graph — ~4.5s, against a 5s default, while every test after it
// runs in single-digit milliseconds. That margin is thinner than parallel-worker
// contention, so the cold test tipped over intermittently and reported as a
// broken send guard when it was only slow.
jest.setTimeout(30_000)

beforeEach(() => {
  persistSessionAssetsMock.mockReset().mockImplementation(async (_sessionId, message) => message)
  chatState.paneIdsBySession = {}
  useSubagentRuntimeStore.setState({ subAgents: {} })
  resetComputerUseSessionGrants()
  isTauriMock.mockReset().mockReturnValue(true)
  flushProjectEditorEdits.mockReset().mockResolvedValue([])
  toastWarning.mockReset()
  _messageCallback = null
  busEmitMock.mockClear()
  onClaudeMessageMock.mockClear()
  onClaudeUnsub.mockClear()
  sendPromptMock.mockReset().mockResolvedValue(undefined)
  prepareRouterFusionSendMock
    .mockReset()
    .mockImplementation(async (input) => ({ kind: "send", options: input.options }))
  abortRouterFusionSendMock.mockReset().mockResolvedValue(undefined)
  cancelRouterFusionTurnMock.mockReset().mockResolvedValue(undefined)
  fusionChatTurnActiveMock.mockReset().mockReturnValue(false)
  runFusionChatTurnMock.mockReset().mockResolvedValue("completed")
  stopFusionChatTurnMock.mockReset().mockResolvedValue(undefined)
  isCostBudgetConfiguredMock.mockReset().mockReturnValue(false)
  enforceCostBudgetMock.mockReset().mockResolvedValue({ allowed: true, blockedBy: [] })
  acceptChatTurnMock.mockReset().mockResolvedValue(null)
  bindChatTurnContextMock.mockReset().mockResolvedValue(false)
  claimChatTurnForDispatchMock.mockReset().mockResolvedValue("disabled")
  markChatTurnStartedMock.mockReset().mockResolvedValue(false)
  settleChatTurnForSessionMock.mockReset().mockResolvedValue(false)
  registerInteractiveWorkSubmissionEventsMock.mockClear()
  unregisterInteractiveWorkSubmissionEventsMock.mockClear()
  startLeaseHeartbeatMock.mockClear()
  stopLeaseHeartbeatMock.mockClear()
  enqueueHostStateIntentMock.mockReset().mockResolvedValue(null)
  interruptSessionMock.mockReset().mockResolvedValue(undefined)
  beginSharedSessionRunMock.mockReset().mockResolvedValue({ kind: "private" })
  standaloneFlag.value = false
  runStandaloneTurnMock.mockReset().mockResolvedValue(undefined)
  gateWorkbenchProviderPayloadMock.mockClear()
  runTurnMemoryMock.mockReset().mockResolvedValue(undefined)
  releaseSkillLoadContextMock.mockClear()
  closeSessionIpcMock.mockReset().mockResolvedValue(undefined)
  approveToolMock.mockReset().mockResolvedValue(undefined)
  persistMessagesMock.mockReset().mockResolvedValue(undefined)
  truncateAfterMock.mockReset().mockResolvedValue(undefined)
  listMessagesMock.mockReset().mockResolvedValue([])
  getSessionMock.mockReset().mockResolvedValue({
    id: "sess-1",
    title: "New chat",
    model: "sonnet",
  })
  setSdkSessionIdMock.mockClear()
  touchSessionMock.mockClear()
  updateSessionMock.mockReset().mockResolvedValue(undefined)
  clearBranchSeedMock.mockReset().mockResolvedValue(undefined)
  freezeImportedSessionMock.mockReset().mockResolvedValue(undefined)
  resolveSendOptionsMock.mockReset().mockResolvedValue({ model: "sonnet", systemPrompt: "sys" })
  openWorkspaceBundleTurnLeaseMock.mockReset().mockResolvedValue(null)
  ensureSessionExecutionBundleMock
    .mockReset()
    .mockImplementation(async ({ context }: { context: Record<string, unknown> }) => ({
      context: {
        ...context,
        execution: {
          mode: "managed",
          bundleId: "bundle-1",
          base: { kind: "workingState" },
          roots: [
            {
              logicalRootId: "root-1",
              role: "primary",
              aliasPath: "/managed/sess-1",
              workspaceId: "workspace-1",
            },
          ],
        },
      },
      bundle: {
        bundleId: "bundle-1",
        leases: [
          {
            bundleId: "bundle-1",
            workspaceId: "workspace-1",
            logicalRootId: "root-1",
            role: "primary",
            aliasPath: "/managed/sess-1",
          },
        ],
      },
      primaryAlias: "/managed/sess-1",
      additionalAliases: [],
      primaryLogicalRootId: "root-1",
      aliasesBySource: new Map([["/repo", "/managed/sess-1"]]),
    }))
  getProjectEnvironmentMock.mockReset().mockResolvedValue(undefined)
  executeProjectEnvironmentMock.mockReset().mockResolvedValue({ success: true, bypassed: false })
  chatState.activeSessionId = "sess-1"
  chatState.openSessionIds = ["sess-1"]
  chatState.splitSessionId = null
  chatState.otherSlices = {}
  chatState.messages = []
  chatState.status = "idle"
  chatState.errorMessage = null
  chatState.pendingApprovals = []
  chatState.activeBranchByGroup = {}
  chatState.pendingCommandOverrides = null
  chatState.referencedPaths = []
  chatState.ephemeralSkillIds = []
  chatState.lastSendBySession = {}
  chatState.setActiveSession.mockClear()
  chatState.setMessages.mockClear()
  chatState.replaceMessages.mockClear()
  chatState.appendMessage.mockClear()
  chatState.setStatus.mockClear()
  chatState.setError.mockClear()
  chatState.replaceSessionMessages.mockClear()
  steerSessionMock.mockClear().mockRejectedValue(new Error("input_closed"))
  chatState.setSessionStatus.mockClear()
  chatState.setSessionError.mockClear()
  chatState.setSessionDiagnostic.mockClear()
  chatState.setSessionActiveBranch.mockClear()
  chatState.hydrateSessionActiveBranches.mockClear()
  chatState.pushApproval.mockClear()
  chatState.clearApproval.mockClear()
  chatState.markApprovalInterrupted.mockClear()
  invalidateJudgeContextMock.mockClear()
  approveToolMock.mockClear().mockResolvedValue(undefined)
  chatState.closeSession.mockClear()
  chatState.setPendingCommandOverrides.mockClear()
  chatState.clearEphemeralSkillIds.mockClear()
  selectIsAtStreamCapMock.mockReset().mockReturnValue(false)
  isAtCapacityMock.mockReset().mockReturnValue(false)
  acquireChatLeaseMock.mockReset().mockResolvedValue(undefined)
  isChatTurnQueuedMock.mockReset().mockReturnValue(false)
  driveInSessionPlanAfterTurnMock.mockReset().mockResolvedValue(false)
  haltInSessionPlanOnTurnFailureMock.mockReset().mockResolvedValue(undefined)
  subscribers.length = 0
  settingsSubscribers.length = 0
  mockGetTwinRuntimeSettings.mockReset()
  mockCreateVectorStore.mockReset()
  goalRuntimeMock.getActiveGoalForSession.mockReset().mockResolvedValue(undefined)
  goalRuntimeMock.pauseGoal.mockReset().mockResolvedValue(null)
  goalRuntimeMock.registerAbortController.mockReset().mockReturnValue(() => {})
  goalRuntimeMock.onManualContinue.mockReset().mockReturnValue(() => {})
  goalRuntimeMock.requestManualContinue.mockReset()
  goalRuntimeMock.recordPacingDecision.mockReset().mockResolvedValue(undefined)
  loopRuntimeMock.getActiveLoopForSession.mockReset().mockResolvedValue(undefined)
  loopRuntimeMock.pauseLoop.mockReset().mockResolvedValue(null)
  loopRuntimeMock.registerAbortController.mockReset().mockReturnValue(() => {})
  loopRuntimeMock.onKickoff.mockReset().mockReturnValue(() => {})
  handleLoopTurnCompleteMock.mockReset()
  handleTurnCompleteMock.mockReset()
  buildGoalJudgeClientMock.mockReset().mockReturnValue(null)
  executeOnExternalAgentMock.mockReset()
  executeOnRemoteHostAgentMock
    .mockReset()
    .mockResolvedValue({ success: true, finalResponse: "host done" })
  rendererToolHostStartMock
    .mockReset()
    .mockResolvedValue({ mcpServers: [], catalogFingerprint: "catalog-1" })
  rendererToolHostPauseMock.mockClear()
  rendererToolHostCloseMock.mockClear()
  createRendererToolHostMock.mockClear()
  closeExternalSessionMock.mockClear()
  setSessionHostFactsMock.mockClear()
  externalProtocolMock.value = "acp"
  externalPresetMock.value = ""
  externalMcpLevelMock.value = "native"
  respondExternalPermissionMock.mockClear()
  getConnectedAgentsMock.mockReset().mockReturnValue([])
  checkDelegationMock.mockReset().mockReturnValue({ shouldDelegate: false })
  setDelegationRulesMock.mockReset()
  mockTrackEvent.mockClear()
  for (const method of Object.values(chatTurnPerformanceMock)) method.mockClear()
  startSquadRunMock.mockReset().mockResolvedValue({ started: true, runId: "run_team_abc123def456" })
  stopSquadWatchMock.mockClear()
  watchSquadRunSettlementMock.mockClear()
})

async function flush() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0))
  })
}

afterEach(() => {
  __resetRemoteAttachForTests()
  // The external-branch test flips the (real) agent-runtime store; reset it so
  // subsequent tests keep taking the default claude-sdk path.
  useAgentRuntimeStore.setState({
    runtimeRef: { kind: "builtin" },
    runtime: "claude-sdk",
    externalAgentId: null,
    sessionCompositions: {},
  })
  useExternalAgentStore.setState({ delegationRules: [], chatFailurePolicy: "fallback" })
})

describe("useClaudeChat — actions", () => {
  it("send() guards against empty string content", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("   ")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("records message submission before the provider settles", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
    })

    expect(mockTrackEvent).toHaveBeenCalledWith("chat.message.sent", {
      sessionId: "sess-1",
      provider: "anthropic",
      surface: "chat",
    })
  })

  it("send() guards against empty array content", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send([] as never)
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("send() with text rolls through persist + sendPrompt", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(persistMessagesMock).toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
    expect(touchSessionMock).toHaveBeenCalledWith("sess-1")
    expect(chatTurnPerformanceMock.begin).toHaveBeenCalledWith("sess-1")
    expect(chatTurnPerformanceMock.markDispatched).toHaveBeenCalledWith("sess-1")
    expect(resolveSendOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ skillRenderMode: "hybrid" })
    )
    // Plugin bus: the committed send announces MESSAGE_SENT + AGENT_STARTED.
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.MESSAGE_SENT, { sessionId: "sess-1" })
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.AGENT_STARTED, { sessionId: "sess-1" })
  })

  it("freezes and claims durable work before handing it to the canonical send command", async () => {
    acceptChatTurnMock.mockResolvedValueOnce({ submissionId: "work:run-1" })
    bindChatTurnContextMock.mockResolvedValueOnce(true)
    claimChatTurnForDispatchMock.mockResolvedValueOnce("claimed")
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("durable")
    })

    expect(acceptChatTurnMock).toHaveBeenCalled()
    expect(bindChatTurnContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ sendOptions: expect.any(Object) }),
      })
    )
    expect(claimChatTurnForDispatchMock).toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "durable", expect.any(Object), {
      commandId: expect.stringMatching(/^work:/),
    })
    expect(updateSessionMock).toHaveBeenCalledWith("sess-1", {
      sdkSessionStorage: { backend: "filesystem" },
    })
    const storageCall = updateSessionMock.mock.calls.findIndex((call) => call[1]?.sdkSessionStorage)
    expect(updateSessionMock.mock.invocationCallOrder[storageCall]).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder[0]
    )
    expect(markChatTurnStartedMock).toHaveBeenCalled()
    expect(startLeaseHeartbeatMock).toHaveBeenCalledWith(
      expect.stringMatching(/^work:/),
      "live-chat"
    )
    expect(stopLeaseHeartbeatMock).not.toHaveBeenCalled()
    expect(bindChatTurnContextMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder[0]
    )
    expect(chatState.setLastSend.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder[0]
    )
    expect(sendPromptMock.mock.invocationCallOrder[0]).toBeLessThan(
      markChatTurnStartedMock.mock.invocationCallOrder[0]
    )
  })

  it("does not send when another outbox runner already owns the durable claim", async () => {
    acceptChatTurnMock.mockResolvedValueOnce({ submissionId: "work:run-1" })
    bindChatTurnContextMock.mockResolvedValueOnce(true)
    claimChatTurnForDispatchMock.mockResolvedValueOnce("owned_elsewhere")
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("durable")
    })

    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(markChatTurnStartedMock).not.toHaveBeenCalled()
  })

  // "External lane with nothing selected" used to be a representable state: the
  // lane and the target were separate persisted fields. It settled a claimed
  // turn with `external_agent_not_selected`, which is now a fail-closed backstop
  // rather than a reachable path. What replaces that test is the invariant: a
  // rule that names no agent does not delegate, and the built-in path runs.
  it("runs the built-in path when a delegation rule names no agent", async () => {
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("durable")
    })

    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
    expect(settleChatTurnForSessionMock).not.toHaveBeenCalledWith("sess-1", {
      outcome: "failed",
      errorCode: "external_agent_not_selected",
    })
  })

  // The host lane answered `null` to "which agent is this turn on", because that
  // read the LOCAL agent field and a host selection leaves it empty. The turn
  // was therefore recorded as an in-app turn under the agent id "built-in", and
  // it registered the durable chat receipt that an external turn must not have.
  it("treats a host-owned agent turn as external, not as a built-in turn", async () => {
    useAgentRuntimeStore.setState({
      runtimeRef: {
        kind: "host",
        configId: "eac_1",
        revision: "eacr_1",
        lifecycleGeneration: 2,
        name: "Pi",
      },
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("host turn", {
        systemPrompt: "Selected skill",
        appendSystemPrompt: "Workspace guidance",
        allowedTools: ["read"],
      })
    })

    expect(executeOnRemoteHostAgentMock).toHaveBeenCalledWith(
      "host turn",
      expect.objectContaining({
        systemPrompt: "Selected skill\n\nWorkspace guidance",
        allowedTools: ["read"],
        mcpServers: [],
        chatSessionId: "sess-1",
      })
    )
    expect(acceptChatTurnMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  // The paired-host executor takes the same single prompt string as the local
  // one (a phone driving its desktop's agent goes through here), so it gets the
  // question behind the attached file's text, not the file's text alone.
  it("sends a host-owned agent the typed question behind an attachment's OCR text", async () => {
    useAgentRuntimeStore.setState({
      runtimeRef: {
        kind: "host",
        configId: "eac_1",
        revision: "eacr_1",
        lifecycleGeneration: 2,
        name: "Pi",
      },
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send(
        [
          { type: "text", text: "WHITEBOARD OCR: ship v2 by Friday" },
          { type: "text", text: "turn this into a task list" },
        ],
        undefined,
        {
          attachmentManifest: [
            { filename: "board.png", mediaType: "image/png", kind: "image" as const },
          ],
        }
      )
    })

    expect(executeOnRemoteHostAgentMock).toHaveBeenCalledWith(
      "WHITEBOARD OCR: ship v2 by Friday\n\nturn this into a task list",
      expect.objectContaining({ chatSessionId: "sess-1" })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("keeps the legacy send path available when durable acceptance fails", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    acceptChatTurnMock.mockRejectedValueOnce(new Error("ledger unavailable"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("legacy")
    })

    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "legacy", expect.any(Object))
    expect(consoleError).toHaveBeenCalledWith("acceptChatTurn failed", expect.any(Error))
    consoleError.mockRestore()
  })

  it("persists an attached HostState action before rendering optimism and skips direct RPC", async () => {
    enqueueHostStateIntentMock.mockResolvedValueOnce({ id: "action-1", status: "pending" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("host-owned")
    })

    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      action: {
        kind: "message.enqueue",
        messageId: "u1",
        text: "host-owned",
        attachments: [],
      },
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(persistMessagesMock).not.toHaveBeenCalled()
    expect(chatState.sessions["sess-1"]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "u1" })])
    )
  })

  it("reuses the persisted managed-worktree binding and redirects the turn", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Managed",
      model: "sonnet",
      executionContext: {
        location: "managedWorktree",
        projectId: "project-1",
        projectRoot: "/repo",
        taskWorkspace: { taskId: "task-workspace:sess-1", workspaceKey: "sess-1" },
        lifecycle: { state: "ready", createdAt: 1, updatedAt: 2, pinned: false },
      },
    })
    openWorkspaceBundleTurnLeaseMock.mockResolvedValue({
      bundleTurnId: "bundle-turn-1",
      run: {
        runId: "run:sess-1:1",
        executionRoot: "/physical/workspace-1",
        isolationRef: "codex/sess-1",
      },
      primaryAlias: "/managed/sess-1",
      additionalAliases: ["/managed/docs"],
      settle: jest.fn(),
    })

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(openWorkspaceBundleTurnLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "bundle-1" }),
      "root-1",
      expect.objectContaining({
        taskId: "task-workspace:sess-1",
        workspaceKey: "sess-1",
        workspaceRoot: "/managed/sess-1",
      })
    )
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      expect.anything(),
      expect.objectContaining({
        cwd: "/managed/sess-1",
        additionalDirectories: ["/managed/docs"],
      })
    )
    expect(updateSessionMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        executionContext: expect.objectContaining({
          taskWorkspace: expect.objectContaining({
            runId: "run:sess-1:1",
            bundleTurnId: "bundle-turn-1",
          }),
          lifecycle: expect.objectContaining({ state: "active" }),
        }),
      })
    )
    const persistedContext = updateSessionMock.mock.calls.findLast(
      (call) => call[1]?.executionContext
    )?.[1]?.executionContext
    expect(persistedContext).not.toHaveProperty("worktreePath")
    expect(persistedContext).not.toHaveProperty("branch")
  })

  it("carries the Workspace Trust proof onto the managed-worktree alias the turn runs in", async () => {
    // `resolveSendOptions` stamps the trusted SOURCE root; the sidecar honours
    // only a trusted root that is also cwd or an additional directory.
    resolveSendOptionsMock.mockResolvedValue({
      model: "sonnet",
      systemPrompt: "sys",
      cwd: "/repo",
      trustedWorkspaceRoots: ["/repo"],
    })
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Managed",
      model: "sonnet",
      executionContext: {
        location: "managedWorktree",
        projectId: "project-1",
        projectRoot: "/repo",
        taskWorkspace: { taskId: "task-workspace:sess-1", workspaceKey: "sess-1" },
        lifecycle: { state: "ready", createdAt: 1, updatedAt: 2, pinned: false },
      },
    })
    openWorkspaceBundleTurnLeaseMock.mockResolvedValue({
      bundleTurnId: "bundle-turn-1",
      run: { runId: "run:sess-1:1", executionRoot: "/physical/workspace-1" },
      primaryAlias: "/managed/sess-1",
      additionalAliases: [],
      settle: jest.fn(),
    })

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("use the repo skill")
    })

    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      expect.anything(),
      expect.objectContaining({
        cwd: "/managed/sess-1",
        trustedWorkspaceRoots: ["/managed/sess-1"],
      })
    )
  })

  it("carries the Workspace Trust proof onto a legacy working-copy alias", async () => {
    const workspace = await import("@/lib/task-workspace/client")
    ;(workspace.acquireWorkspaceBundle as jest.Mock).mockResolvedValueOnce({
      bundleId: "legacy-bundle",
      leases: [],
    })
    resolveSendOptionsMock.mockResolvedValue({
      model: "sonnet",
      systemPrompt: "sys",
      cwd: "/repo",
      trustedWorkspaceRoots: ["/repo"],
    })
    openWorkspaceBundleTurnLeaseMock.mockResolvedValue({
      bundleTurnId: "legacy-turn",
      run: { runId: "legacy-run", executionRoot: "/physical/legacy" },
      primaryAlias: "/isolated/legacy",
      additionalAliases: [],
      settle: jest.fn(),
    })

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("use the repo skill")
    })

    expect(openWorkspaceBundleTurnLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ bundleId: "legacy-bundle" }),
      "primary",
      expect.objectContaining({ workspaceRoot: "/repo" })
    )
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      expect.anything(),
      expect.objectContaining({
        cwd: "/isolated/legacy",
        trustedWorkspaceRoots: ["/isolated/legacy"],
      })
    )
  })

  it("fails closed instead of falling back to Local when managed isolation is unavailable", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Managed",
      model: "sonnet",
      executionContext: {
        location: "managedWorktree",
        projectId: "project-1",
        projectRoot: "/repo",
        taskWorkspace: { taskId: "task-workspace:sess-1", workspaceKey: "sess-1" },
        lifecycle: { state: "requested", createdAt: 1, updatedAt: 1, pinned: false },
      },
    })

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
  })

  it("runs an explicit zero-tool turn without a managed workspace", async () => {
    standaloneFlag.value = true
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    resolveSendOptionsMock.mockResolvedValue({
      model: "sonnet",
      systemPrompt: "sys",
      toolSurface: "none",
    })
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Cognia Support",
      model: "sonnet",
      executionContext: {
        location: "managedWorktree",
        projectId: "project-1",
        projectRoot: "/repo",
        taskWorkspace: { taskId: "task-workspace:sess-1", workspaceKey: "sess-1" },
        lifecycle: { state: "requested", createdAt: 1, updatedAt: 1, pinned: false },
      },
    })

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("help")
    })

    expect(runStandaloneTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        sendOptions: expect.objectContaining({ toolSurface: "none" }),
      })
    )
    expect(chatState.setSessionError).not.toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("managed")
    )
  })

  describe("a standalone (BYOK) engine turn has no working copy to acquire", () => {
    // The context `startNewSession` persists for a rootless chat on a shell
    // that cannot materialize a managed workspace: a web tab with no host, or
    // a phone in standalone mode.
    const unmaterializedManagedContext = {
      location: "managedWorktree",
      projectId: "project-1",
      projectRoot: "",
      workspaceBinding: { kind: "managed", workspaceId: "managed-workspace:sess-1" },
      managedWorkspace: { availability: "missing-on-device" },
      taskWorkspace: { taskId: "task-workspace:sess-1", workspaceKey: "sess-1" },
      lifecycle: { state: "requested", createdAt: 1, updatedAt: 1, pinned: false },
    }

    beforeEach(() => {
      useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" } })
      // What the real bundle seam does for that context on such a shell.
      ensureSessionExecutionBundleMock.mockRejectedValue(
        new Error("managed workspace is not available on this device")
      )
    })

    it("runs the first turn of a rootless chat instead of refusing it", async () => {
      standaloneFlag.value = true
      getSessionMock.mockResolvedValue({
        id: "sess-1",
        title: "New chat",
        model: "sonnet",
        projectId: "project-1",
        executionContext: unmaterializedManagedContext,
      })

      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("hello")
      })

      expect(ensureSessionExecutionBundleMock).not.toHaveBeenCalled()
      expect(openWorkspaceBundleTurnLeaseMock).not.toHaveBeenCalled()
      expect(runStandaloneTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1" })
      )
      // No cwd: the engine has no file tool, and no directory was ever bound.
      const dispatched = runStandaloneTurnMock.mock.calls[0]![0] as { sendOptions: SendOptions }
      expect(dispatched.sendOptions.cwd).toBeUndefined()
      expect(dispatched.sendOptions.taskWorkspace).toBeUndefined()
      expect(settleChatTurnForSessionMock).not.toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({ outcome: "failed" })
      )
      const codes = chatState.setSessionDiagnostic.mock.calls.map(
        (call) => (call[1] as { code?: string } | null)?.code
      )
      expect(codes).not.toContain("workspaceBundleFailed")
      expect(codes).not.toContain("workspaceUnavailable")
      expect(sendPromptMock).not.toHaveBeenCalled()
    })

    it("does not run a project environment the engine could never execute in", async () => {
      standaloneFlag.value = true
      getSessionMock.mockResolvedValue({
        id: "sess-1",
        title: "New chat",
        model: "sonnet",
        projectId: "project-1",
        executionContext: { ...unmaterializedManagedContext, environmentId: "env-1" },
      })

      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("hello")
      })

      expect(getProjectEnvironmentMock).not.toHaveBeenCalled()
      expect(executeProjectEnvironmentMock).not.toHaveBeenCalled()
      expect(runStandaloneTurnMock).toHaveBeenCalled()
    })

    it("still refuses the same context on a shell whose turns run on a host", async () => {
      // Desktop and paired shells are unchanged: their executor opens files,
      // so a managed workspace this device cannot provide stays a refusal.
      getSessionMock.mockResolvedValue({
        id: "sess-1",
        title: "New chat",
        model: "sonnet",
        projectId: "project-1",
        executionContext: unmaterializedManagedContext,
      })

      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("hello")
      })

      expect(ensureSessionExecutionBundleMock).toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(runStandaloneTurnMock).not.toHaveBeenCalled()
      expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({ code: "workspaceBundleFailed" })
      )
      expect(settleChatTurnForSessionMock).toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({ outcome: "failed", errorCode: "workspace_bundle_unavailable" })
      )
    })

    it("keeps the gate for an external lane, which the standalone engine does not run", async () => {
      // The gate follows the executor, not the shell: a turn routed to an
      // external agent never reaches the in-webview engine.
      standaloneFlag.value = true
      useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
      getSessionMock.mockResolvedValue({
        id: "sess-1",
        title: "New chat",
        model: "sonnet",
        projectId: "project-1",
        executionContext: unmaterializedManagedContext,
      })

      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("hello")
      })

      expect(ensureSessionExecutionBundleMock).toHaveBeenCalled()
      expect(runStandaloneTurnMock).not.toHaveBeenCalled()
      expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    })
  })

  it("initializes the selected environment inside the managed execution root", async () => {
    const environment = {
      id: "env-1",
      projectId: "project-1",
      name: "Development",
      isEnabled: true,
      setupScript: { default: "pnpm install" },
      actions: [],
      variables: {},
      keyringReferences: [],
      createdAt: 1,
      updatedAt: 1,
    }
    getProjectEnvironmentMock.mockResolvedValue(environment)
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Managed",
      model: "sonnet",
      executionContext: {
        location: "managedWorktree",
        projectId: "project-1",
        projectRoot: "/repo",
        environmentId: "env-1",
        taskWorkspace: { taskId: "task-workspace:sess-1", workspaceKey: "sess-1" },
        lifecycle: { state: "ready", createdAt: 1, updatedAt: 2, pinned: false },
      },
    })
    openWorkspaceBundleTurnLeaseMock.mockResolvedValue({
      bundleTurnId: "bundle-turn-1",
      run: { runId: "run-1", executionRoot: "/managed/sess-1", isolationRef: "branch" },
      primaryAlias: "/managed/sess-1",
      additionalAliases: [],
      settle: jest.fn(),
    })

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(executeProjectEnvironmentMock).toHaveBeenCalledWith({
      environment,
      executionRoot: "/managed/sess-1",
      scope: "managedWorktree",
      surface: "interactive",
      bypassOnFailure: undefined,
    })
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("preserves attachment provenance on the optimistic user message", async () => {
    const { makeUserMessage } = jest.requireMock("@/lib/claude/adapter") as {
      makeUserMessage: jest.Mock
    }
    const manifest = [{ filename: "notes.txt", mediaType: "text/plain", kind: "document" as const }]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", undefined, { attachmentManifest: manifest })
    })
    expect(makeUserMessage).toHaveBeenCalledWith("hello", expect.any(String), manifest)
  })

  it("derives routing attachment kinds from the outgoing content blocks", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send([
        { type: "text", text: "transcribe this" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "SU1H" },
        },
        {
          type: "document",
          source: { type: "base64", media_type: "audio/mpeg", data: "QVVESU8=" },
        },
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "UERG" },
        },
      ] as never)
    })
    expect(resolveSendOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routingContextHint: expect.objectContaining({
          promptText: "transcribe this",
          attachmentKinds: ["image", "audio", "document"],
        }),
      })
    )
  })

  describe("native video route guard", () => {
    const info = {
      groupId: "v1",
      filename: "demo.mp4",
      sourceMediaType: "video/mp4",
      kind: "video" as const,
      durationSec: 12,
      width: 1280,
      height: 720,
      delivery: "native" as const,
      strategy: "uniform" as const,
      range: null,
      frameTimes: [],
      engine: "browser" as const,
    }
    const fallback = {
      blocks: [
        { type: "text" as const, text: "storyboard of demo.mp4" },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/jpeg", data: "Qk9BUkQ=" },
        },
      ],
      tokens: 3,
      info: { ...info, delivery: "storyboard" as const, frameTimes: [2, 6, 10] },
    }
    const nativeEntry = {
      filename: "demo.mp4",
      mediaType: "video/mp4",
      kind: "video" as const,
      video: {
        info,
        poster: { mediaType: "image/jpeg", base64: "UE9TVEVS", width: 512, height: 288 },
        fallback,
      },
    }
    const nativeContent = [
      { type: "text" as const, text: "Sent as the original video file." },
      {
        type: "document" as const,
        source: { type: "base64" as const, media_type: "video/mp4", data: "VklERU8=" },
      },
      { type: "text" as const, text: "what happens?" },
    ]

    it("swaps a native video for its storyboard when the resolved route cannot take video", async () => {
      const { makeUserMessage } = jest.requireMock("@/lib/claude/adapter") as {
        makeUserMessage: jest.Mock
      }
      // The suite's default route: no provider, i.e. the Claude Agent SDK.
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send(nativeContent, undefined, {
          attachmentManifest: [nativeEntry, nativeEntry],
        })
      })
      const expected = [...fallback.blocks, { type: "text", text: "what happens?" }]
      expect(sendPromptMock.mock.calls[0]![1]).toEqual(expected)
      const fallbackEntry = {
        filename: "demo.mp4",
        mediaType: "video/mp4",
        kind: "video",
        video: { info: fallback.info },
      }
      expect(makeUserMessage).toHaveBeenCalledWith(expected, expect.any(String), [
        fallbackEntry,
        fallbackEntry,
      ])
      expect(toastInfo).toHaveBeenCalledTimes(1)
    })

    it("sends the original file on a Gemini route that declares video", async () => {
      resolveSendOptionsMock.mockResolvedValue({
        provider: "google",
        model: "gemini-3.6-flash",
        systemPrompt: "sys",
      })
      toastInfo.mockClear()
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send(nativeContent, undefined, {
          attachmentManifest: [nativeEntry, nativeEntry],
        })
      })
      expect(sendPromptMock.mock.calls[0]![1]).toEqual(nativeContent)
      expect(toastInfo).not.toHaveBeenCalled()
    })
  })

  it("send() routes through the standalone engine (not the sidecar) in BYOK mode", async () => {
    standaloneFlag.value = true
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(runStandaloneTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", emit: expect.any(Function) })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("gates the fully assembled payload for embedded resource sessions", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Embedded",
      kind: "resource-workbench",
      visibility: "embedded",
      model: "sonnet",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("sensitive context")
    })

    expect(gateWorkbenchProviderPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "sensitive context",
        sendOptions: expect.any(Object),
        messages: expect.any(Array),
      })
    )
  })

  it("keeps private resource context out of plugin hooks and persisted user messages", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Embedded",
      kind: "resource-workbench",
      visibility: "embedded",
      model: "sonnet",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("fix this", undefined, {
        sessionId: "sess-1",
        resourceContext: "private@example.com",
      })
    })

    expect(dispatchUserPromptSubmitMock).toHaveBeenCalledWith(
      "fix this",
      "sess-1",
      expect.any(Object)
    )
    expect(gateWorkbenchProviderPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("private@example.com") })
    )
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("private@example.com"),
      expect.any(Object)
    )
    const persistedMessages = persistMessagesMock.mock.calls.at(-1)?.[1]
    expect(JSON.stringify(persistedMessages)).toContain("fix this")
    expect(JSON.stringify(persistedMessages)).not.toContain("private@example.com")
  })

  it("stop() aborts the standalone turn instead of interrupting the sidecar", async () => {
    standaloneFlag.value = true
    let captured: { signal: AbortSignal } | null = null
    runStandaloneTurnMock.mockImplementation(async (args?: unknown) => {
      captured = args as { signal: AbortSignal }
      await new Promise(() => {}) // never resolves — stays "in flight"
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      void result.current.send("hello")
    })
    await act(async () => {
      await result.current.stop("sess-1")
    })
    expect(captured).not.toBeNull()
    expect(captured!.signal.aborted).toBe(true)
    expect(interruptSessionMock).not.toHaveBeenCalled()
  })

  it("persists external usage in the same chat session as the assistant turn", async () => {
    recordExternalAgentUsageMock.mockClear()
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    const usage = { promptTokens: 267000, completionTokens: 11, totalTokens: 267011 }
    executeOnExternalAgentMock.mockResolvedValue({
      success: true,
      finalResponse: "done",
      tokenUsage: usage,
      duration: 1200,
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(recordExternalAgentUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        messageId: expect.stringMatching(/^assistant-/),
        usage,
        durationMs: 1200,
      })
    )
    const finalMessages = persistMessagesMock.mock.calls.at(-1)?.[1]
    expect(finalMessages.at(-1)).toMatchObject({
      id: recordExternalAgentUsageMock.mock.calls[0][0].messageId,
      metadata: { usage: { inputTokens: 267000, outputTokens: 11 } },
    })
  })

  it("releases an acquired workspace after a pre-stream Pi handshake failure and accepts the next send", async () => {
    const workspace = await import("@/lib/task-workspace/client")
    const adoption = await import("@/lib/code-adoption/client")
    const { startCodeAdoptionTracker } = await import("@/lib/code-adoption/turn-tracker")
    let leased = false
    const acquire = (workspace.acquireWorkspaceBundle as jest.Mock).mockResolvedValue({
      bundleId: "pi-bundle",
      leases: [],
    } as never)
    const settle = (workspace.settleTaskWorkspaceTurn as jest.Mock).mockImplementation(async () => {
      leased = false
      return null
    })
    const end = (adoption.endCodeAdoptionTurn as jest.Mock).mockResolvedValue(null)
    const consume = (adoption.consumeCodeAdoptionTrackingAttempt as jest.Mock).mockReturnValue(
      undefined
    )
    resolveSendOptionsMock.mockResolvedValue({ model: "sonnet", cwd: "/repo" })
    openWorkspaceBundleTurnLeaseMock.mockImplementation(async () => {
      if (leased) throw new Error("working copy in use")
      leased = true
      return {
        bundleTurnId: "pi-turn",
        run: { runId: "pi-run", executionRoot: "/repo" },
        primaryAlias: "/repo",
        additionalAliases: [],
      }
    })
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock
      .mockImplementationOnce(async () => {
        expect(leased).toBe(true)
        expect(chatState.status).toBe("streaming")
        throw new Error("Pi extension handshake timed out")
      })
      .mockResolvedValueOnce({ success: true, finalResponse: "recovered" })
    const oldSetStatus = chatState.setSessionStatus.getMockImplementation()
    const oldSetDiagnostic = chatState.setSessionDiagnostic.getMockImplementation()
    chatState.setSessionDiagnostic.mockImplementation((id: string, diagnostic: unknown) => {
      const before = { sessions: { [id]: { ...chatState.sessions[id] } } }
      oldSetDiagnostic!(id, diagnostic)
      for (const sub of [...subscribers]) {
        ;(sub as (state: unknown, previous: unknown) => void)(chatState, before)
      }
    })
    chatState.setSessionStatus.mockImplementation((id: string, status: string) => {
      const before = { sessions: { [id]: { ...chatState.sessions[id] } } }
      sliceWrite(id, { status })
      for (const sub of [...subscribers]) {
        ;(sub as (state: unknown, previous: unknown) => void)(chatState, before)
      }
    })
    const stop = startCodeAdoptionTracker()
    try {
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("first")
      })
      await flush()
      expect(openWorkspaceBundleTurnLeaseMock).toHaveBeenCalledTimes(1)
      expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
      expect(settle).toHaveBeenCalledWith("sess-1", undefined, "failed")
      expect(leased).toBe(false)
      await act(async () => {
        await result.current.send("second")
      })
      expect(openWorkspaceBundleTurnLeaseMock).toHaveBeenCalledTimes(2)
      expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(2)
      expect(chatState.status).toBe("idle")
    } finally {
      stop()
      chatState.setSessionStatus.mockImplementation(oldSetStatus!)
      chatState.setSessionDiagnostic.mockImplementation(oldSetDiagnostic!)
      const realWorkspace = jest.requireActual("@/lib/task-workspace/client")
      const realAdoption = jest.requireActual("@/lib/code-adoption/client")
      acquire.mockReset().mockImplementation(realWorkspace.acquireWorkspaceBundle)
      settle.mockReset().mockImplementation(realWorkspace.settleTaskWorkspaceTurn)
      end.mockReset().mockImplementation(realAdoption.endCodeAdoptionTurn)
      consume.mockReset().mockImplementation(realAdoption.consumeCodeAdoptionTrackingAttempt)
    }
  })

  it("external-agent writes stream into the sender's own slice across a mid-run focus switch (D1)", async () => {
    // Concurrent-chat behavior: a focus switch mid-run must NOT redirect or
    // drop the in-flight external turn — every write targets the *sender's*
    // session slice (sess-1) regardless of which session is now focused.
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    executeOnExternalAgentMock.mockImplementation(
      async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({ type: "text", text: "a" })
        // User switches focus away mid-run.
        chatState.activeSessionId = "sess-other"
        subscribers.forEach((sub) => sub(chatState))
        opts.onEvent({ type: "text", text: "b" })
        return { success: true, finalResponse: "done" }
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("hi")
    })
    // Every assistant write is session-scoped to sess-1 (never the now-focused
    // sess-other), so the background pane keeps streaming.
    const targets = chatState.replaceSessionMessages.mock.calls.map((c) => c[0])
    expect(targets.length).toBeGreaterThanOrEqual(2)
    expect(targets.every((id) => id === "sess-1")).toBe(true)
    // Persist targets THIS session id.
    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", expect.any(Array))
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.completed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "external",
        surface: "chat",
      })
    )
  })

  /**
   * Pi reports a refused turn on the assistant message it could not produce,
   * and the adapter maps that to an `error` event. `applyExternalAgentEventToParts`
   * has no `error` case, so the reason was dropped and the turn settled as an
   * ordinary completion with an empty bubble: a provider saying "402
   * Insufficient Balance" reached the user as nothing at all.
   */
  it("shows the provider's own words when the agent errored and produced nothing", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockImplementation(
      async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({
          type: "error",
          error: '402: {"message":"Insufficient Balance"}',
          recoverable: true,
        })
        // Pi still settles the turn as an ordinary end, which is what made
        // this look like a success.
        return { success: true, finalResponse: "" }
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    // The failure path routes through the diagnostic surface, which is the
    // same red card a refused turn already uses.
    const reported = chatState.setSessionDiagnostic.mock.calls.map((call) =>
      JSON.stringify(call[1])
    )
    expect(reported.join("\n")).toContain("Insufficient Balance")
  })

  it("keeps a turn that died during start-up on screen, marked failed with a typed reason", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    const { PiProcessExitedError } = jest.requireActual<
      typeof import("@/lib/ai/agent/external/runtimes/pi/pi-rpc-client")
    >("@/lib/ai/agent/external/runtimes/pi/pi-rpc-client")
    executeOnExternalAgentMock.mockRejectedValue(new PiProcessExitedError(1))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    // Classified from the error's type, not its English sentence.
    const diagnostic = chatState.setSessionDiagnostic.mock.calls.at(-1)?.[1] as {
      code: string
      detail?: string
    }
    expect(diagnostic.code).toBe("initializationFailed")
    expect(diagnostic.detail).toContain("Pi process exited (code 1)")
    // The user's message stays, carrying the failure — in the store AND in
    // the transcript written to disk, so a reload still shows it.
    const lastWrite = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      role: string
      metadata?: { turnAdmission?: { state: string; code: string } }
    }>
    const userRow = lastWrite.filter((message) => message.role === "user").at(-1)
    expect(userRow?.metadata?.turnAdmission).toMatchObject({
      state: "failed",
      code: "initializationFailed",
    })
    const persisted = persistMessagesMock.mock.calls.at(-1)?.[1] as typeof lastWrite
    expect(persisted.filter((message) => message.role === "user").at(-1)?.metadata).toMatchObject({
      turnAdmission: { state: "failed" },
    })
  })

  it("completes an in-session plan step that ran on an external agent", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "step done" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("Step 1: do it", undefined, { skipUserAppend: true })
    })
    expect(driveInSessionPlanAfterTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", lastResponse: "step done" })
    )
    expect(haltInSessionPlanOnTurnFailureMock).not.toHaveBeenCalled()
  })

  it("halts the plan on a step whose external turn never started, with the typed cause", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    const { LeaseConflictError } = jest.requireActual<
      typeof import("@/lib/execution/lease-conflict")
    >("@/lib/execution/lease-conflict")
    executeOnExternalAgentMock.mockRejectedValue(
      new LeaseConflictError("agent-process", "Agent pi:s1 is already running")
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("Step 1: do it", undefined, { skipUserAppend: true })
    })
    expect(haltInSessionPlanOnTurnFailureMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      cause: "not_started",
      detail: "agentProcessBusy: Agent pi:s1 is already running",
    })
    expect(driveInSessionPlanAfterTurnMock).not.toHaveBeenCalled()
  })

  it("never halts a plan because a manual message failed", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(haltInSessionPlanOnTurnFailureMock).not.toHaveBeenCalled()
  })

  it("names an agent process held by another process as a lease conflict", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    const { LeaseConflictError } = jest.requireActual<
      typeof import("@/lib/execution/lease-conflict")
    >("@/lib/execution/lease-conflict")
    executeOnExternalAgentMock.mockRejectedValue(
      new LeaseConflictError("agent-process", "Agent pi:s1 is already running", {
        holder: "pi:s1",
      })
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    const diagnostic = chatState.setSessionDiagnostic.mock.calls.at(-1)?.[1] as { code: string }
    expect(diagnostic.code).toBe("agentProcessBusy")
  })

  it("shows a send that has to wait for its working copy as queued, then runs it", async () => {
    let admit: () => void = () => {}
    acquireChatLeaseMock.mockImplementationOnce(
      (params: { onQueued?: (blocker: unknown) => void }) => {
        params.onQueued?.({
          reason: "slot",
          slotKey: "dir:/repo",
          ahead: 0,
          holder: { kind: "workflow-step", label: "Ship the refactor" },
        })
        return new Promise<void>((resolve) => (admit = resolve))
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    let sending: Promise<void> = Promise.resolve()
    await act(async () => {
      sending = result.current.send("hi")
      await flush()
    })
    const queuedWrite = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      role: string
      metadata?: { turnAdmission?: { state: string; waitingFor?: { holderLabel?: string } } }
    }>
    const queuedRow = queuedWrite.filter((message) => message.role === "user").at(-1)
    expect(queuedRow?.metadata?.turnAdmission).toMatchObject({
      state: "queued",
      waitingFor: { reason: "slot", holderKind: "workflow-step", holderLabel: "Ship the refactor" },
    })
    // Written through immediately: a switch or reload rehydrates from disk.
    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", queuedWrite)
    expect(sendPromptMock).not.toHaveBeenCalled()
    await act(async () => {
      admit()
      await sending
    })
    expect(sendPromptMock).toHaveBeenCalled()
    const admittedRows = chatState.replaceSessionMessages.mock.calls
      .map((call) => call[1] as typeof queuedWrite)
      .filter((messages) => messages.some((message) => message.role === "user"))
    const afterAdmission = admittedRows
      .at(-1)!
      .filter((message) => message.role === "user")
      .at(-1)
    expect(afterAdmission?.metadata?.turnAdmission).toBeUndefined()
  })

  it("withdraws a queued send the user cancels without running it", async () => {
    acquireChatLeaseMock.mockImplementationOnce(
      async (params: { onQueued?: (blocker: unknown) => void }) => {
        params.onQueued?.({ reason: "capacity", limit: 1, ahead: 0 })
        const cancelled = new Error("lease cancelled while queued")
        cancelled.name = "AbortError"
        throw cancelled
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("never mind")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    const finalWrite = persistMessagesMock.mock.calls.at(-1)?.[1] as Array<{
      parts: Array<{ text?: string }>
    }>
    expect(JSON.stringify(finalWrite)).not.toContain("never mind")
  })

  it("keeps a turn that recovered and answered a success", async () => {
    // An `error` mid-turn is not a refusal when the agent went on to produce
    // text, so the promotion above must not fire on one.
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockImplementation(
      async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({ type: "error", error: "a retryable hiccup", recoverable: true })
        opts.onEvent({ type: "message_delta", delta: { type: "text", text: "recovered" } })
        return { success: true, finalResponse: "recovered" }
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    const reported = chatState.setSessionDiagnostic.mock.calls.map((call) =>
      JSON.stringify(call[1])
    )
    expect(reported.join("\n")).not.toContain("hiccup")
  })

  it("renders an inline answer card for async questions when the setting is on", async () => {
    // Codex `delivery: "async"` agentMessage → `async_questions` event →
    // interactive card part, stamped with the CHAT session id so an answer
    // from a background pane still lands in the right conversation.
    settingsState.settings.inlineQuestions = { enabled: true }
    try {
      useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
      chatState.activeSessionId = "sess-1"
      executeOnExternalAgentMock.mockImplementation(
        async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
          opts.onEvent({
            type: "async_questions",
            sessionId: "native-1",
            messageId: "q1",
            questions: [{ title: "Which file?", options: ["a.ts", "b.ts"] }],
          })
          return { success: true, finalResponse: "done" }
        }
      )
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      subscribers.forEach((sub) => sub(chatState))
      await act(async () => {
        await result.current.send("hi")
      })
      const written = chatState.replaceSessionMessages.mock.calls.flatMap(
        (call) => call[1] as Array<{ parts: Array<Record<string, unknown>> }>
      )
      const card = written
        .flatMap((m) => m.parts)
        .find((p) => p?.type === "data-async-questions") as
        { data: Record<string, unknown> } | undefined
      expect(card?.data).toMatchObject({
        itemId: "q1",
        sessionId: "sess-1",
        questions: [{ title: "Which file?", options: ["a.ts", "b.ts"] }],
      })
    } finally {
      settingsState.settings.inlineQuestions = undefined
    }
  })

  it("registers an RPC-backed question and stamps the card with the chat-side key", async () => {
    // requestUserInput isBlocking:false — the event carries the wire requestId.
    // The card must get the namespaced registry key (requestId) plus the raw
    // wire id (responseRequestId) so resolveExternalQuestion / a later
    // permission_response can find it.
    settingsState.settings.inlineQuestions = { enabled: true }
    try {
      useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
      chatState.activeSessionId = "sess-1"
      executeOnExternalAgentMock.mockImplementation(
        async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
          opts.onEvent({
            type: "async_questions",
            sessionId: "native-1",
            messageId: "q-item",
            requestId: "q-item",
            questions: [{ id: "q1", title: "Region?", options: ["us-east"] }],
          })
          return { success: true, finalResponse: "done" }
        }
      )
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      subscribers.forEach((sub) => sub(chatState))
      await act(async () => {
        await result.current.send("hi")
      })
      const written = chatState.replaceSessionMessages.mock.calls.flatMap(
        (call) => call[1] as Array<{ parts: Array<Record<string, unknown>> }>
      )
      const card = written
        .flatMap((m) => m.parts)
        .find((p) => p?.type === "data-async-questions") as
        { data: Record<string, unknown> } | undefined
      expect(card?.data?.responseRequestId).toBe("q-item")
      expect(typeof card?.data?.requestId).toBe("string")
      expect((card?.data?.requestId as string).startsWith("external-agent:")).toBe(true)
    } finally {
      settingsState.settings.inlineQuestions = undefined
    }
  })

  it("degrades async questions to plain text when the setting is off", async () => {
    settingsState.settings.inlineQuestions = { enabled: false }
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    executeOnExternalAgentMock.mockImplementation(
      async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({
          type: "async_questions",
          sessionId: "native-1",
          messageId: "q1",
          questions: [{ title: "Which file?" }],
        })
        return { success: true, finalResponse: "done" }
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("hi")
    })
    const written = chatState.replaceSessionMessages.mock.calls.flatMap(
      (call) => call[1] as Array<{ role: string; parts: Array<Record<string, unknown>> }>
    )
    const parts = written.filter((m) => m.role === "assistant").flatMap((m) => m.parts)
    expect(parts.some((p) => p?.type === "data-async-questions")).toBe(false)
    const text = parts.find((p) => p?.type === "text") as { text: string } | undefined
    expect(text?.text).toContain("Which file?")
  })

  it("reuses a verified imported native session on the external lane", async () => {
    externalPresetMock.value = "codex"
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "ext-1" },
      sessionCompositions: {
        // The marker, not the id. The native session id lives on the session
        // row, which is where the resume reads it from.
        "import:codex:thread-1": {
          presetId: "standard",
          verifiedNativeResume: true,
          verifiedNativeResumeAgentId: "ext-1",
        },
      },
    })
    getSessionMock.mockResolvedValue({
      id: "import:codex:thread-1",
      title: "Imported Codex",
      importOwnership: "native-bound",
      branchSeed: { kind: "transcript", content: "Imported context" },
      importRuntimeBinding: { nativeSessionId: "thread-1", presetId: "codex" },
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "continued" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("continue", undefined, { sessionId: "import:codex:thread-1" })
    })
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "continue",
      expect.objectContaining({
        agentId: "ext-1",
        sessionId: "thread-1",
        context: expect.objectContaining({
          custom: expect.objectContaining({ chatSessionId: "import:codex:thread-1" }),
        }),
      })
    )
    expect(clearBranchSeedMock).toHaveBeenCalledWith("import:codex:thread-1")
    expect(freezeImportedSessionMock).not.toHaveBeenCalled()
  })

  it.each([
    ["different instance", "ext-2", "codex"],
    ["different preset", "ext-1", "claude-code"],
  ])("does not reuse imported native context for a %s", async (_case, agentId, preset) => {
    externalPresetMock.value = preset
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId },
      sessionCompositions: {
        "import:codex:thread-1": {
          presetId: "standard",
          verifiedNativeResume: true,
          verifiedNativeResumeAgentId: "ext-1",
        },
      },
    })
    getSessionMock.mockResolvedValue({
      id: "import:codex:thread-1",
      title: "Imported",
      importOwnership: "native-bound",
      importRuntimeBinding: { nativeSessionId: "thread-1", presetId: "codex" },
    })
    listMessagesMock.mockResolvedValue([
      {
        id: "old-goal",
        role: "user",
        parts: [{ type: "text", text: "Preserve the original requirements" }],
      },
    ])
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "continued" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("continue", undefined, { sessionId: "import:codex:thread-1" })
      expect(
        useAgentRuntimeStore.getState().sessionCompositions["import:codex:thread-1"]
          .verifiedNativeResume
      ).toBeUndefined()
    })
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      expect.stringContaining("Preserve the original requirements"),
      expect.not.objectContaining({ sessionId: "thread-1" })
    )
  })

  it("hands native-bound history to builtin without reusing the external SDK session", async () => {
    const id = "import:codex:thread-1"
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "builtin" },
      sessionCompositions: {
        [id]: {
          presetId: "standard",
          verifiedNativeResume: true,
          verifiedNativeResumeAgentId: "ext-1",
        },
      },
    })
    getSessionMock.mockResolvedValue({
      id,
      title: "Imported",
      importOwnership: "native-bound",
      sdkSessionId: "external-native",
      importRuntimeBinding: { nativeSessionId: "external-native", presetId: "codex" },
      externalAgentSession: { agentId: "ext-1", sessionId: "external-native" },
    })
    listMessagesMock.mockResolvedValue([
      {
        id: "prior",
        role: "user",
        parts: [{ type: "text", text: "Keep the full task requirements" }],
      },
    ])
    resolveSendOptionsMock.mockResolvedValue({
      model: "sonnet",
      systemPrompt: "sys",
      resumeSessionId: "external-native",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("continue", undefined, { sessionId: id })
    })
    expect(sendPromptMock).toHaveBeenCalledWith(
      id,
      "continue",
      expect.objectContaining({
        appendSystemPrompt: expect.stringContaining("Keep the full task requirements"),
      })
    )
    expect(sendPromptMock.mock.calls[0][2]).not.toHaveProperty("resumeSessionId")
    expect(updateSessionMock).toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        sdkSessionId: undefined,
        importOwnership: "cognia-owned",
        externalAgentSession: undefined,
      })
    )
    expect(
      useAgentRuntimeStore.getState().sessionCompositions[id].verifiedNativeResume
    ).toBeUndefined()
  })

  it.each(["cli", "thread-handoff"])(
    "prepares complete %s import history before the first builtin send",
    async (handoffSource) => {
      const id = "received-task"
      useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" } })
      getSessionMock.mockResolvedValue({
        id,
        title: "Imported",
        handoffSource,
        branchSeed: { kind: "transcript", content: "Old truncated seed" },
        importCanonicalState: { goals: [{ goalId: "g", description: "Never deploy" }] },
      })
      listMessagesMock.mockResolvedValue([
        {
          id: "prior",
          role: "user",
          parts: [{ type: "text", text: "Full original requirements" }],
        },
      ])
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("continue", undefined, { sessionId: id })
      })
      expect(sendPromptMock).toHaveBeenCalledWith(
        id,
        "continue",
        expect.objectContaining({
          appendSystemPrompt: expect.stringContaining("Full original requirements"),
        })
      )
      expect(sendPromptMock.mock.calls[0][2].appendSystemPrompt).toContain("Never deploy")
      expect(clearBranchSeedMock).toHaveBeenCalledWith(id)
      getSessionMock.mockResolvedValue({ id, handoffSource, importOwnership: "cognia-owned" })
      await act(async () => {
        _messageCallback?.({ type: "session_ended", sessionId: id })
      })
      listMessagesMock.mockClear()
      sendPromptMock.mockClear()
      await act(async () => {
        await result.current.send("next", undefined, { sessionId: id })
      })
      expect(sendPromptMock).toHaveBeenCalled()
      expect(sendPromptMock.mock.calls[0][2].appendSystemPrompt ?? "").not.toContain(
        "Full original requirements"
      )
      expect(listMessagesMock).not.toHaveBeenCalled()
    }
  )

  it("refuses oversized imported builtin continuation without a summary client", async () => {
    const id = "oversized-import"
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" } })
    getSessionMock.mockResolvedValue({
      id,
      handoffSource: "cli",
      branchSeed: { kind: "transcript", content: "Truncated" },
    })
    listMessagesMock.mockResolvedValue([
      { id: "prior", role: "user", parts: [{ type: "text", text: "constraint ".repeat(4000) }] },
    ])
    mockHandoffClient.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await expect(result.current.send("continue", undefined, { sessionId: id })).rejects.toThrow(
        "handoff_context_summary_unavailable"
      )
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(clearBranchSeedMock).not.toHaveBeenCalled()
  })

  it("summarizes full imported state before builtin continuation and blocks locked imports first", async () => {
    const id = "import:source:large"
    const imported = {
      id,
      branchSeed: { kind: "transcript", content: "Old seed" },
      importCanonicalState: { goals: [{ goalId: "goal", description: "Never change production" }] },
      handoffLock: { ticketId: "ticket", state: "frozen" },
    }
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "builtin" } })
    getSessionMock.mockResolvedValue(imported)
    listMessagesMock.mockResolvedValue([
      { id: "prior", role: "user", parts: [{ type: "text", text: "history ".repeat(4000) }] },
    ])
    const complete = jest.fn().mockResolvedValue("Original constraint: Never change production.")
    mockHandoffClient.mockReset().mockResolvedValue({ complete })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await expect(
        result.current.send("continue", undefined, { sessionId: id })
      ).rejects.toMatchObject({ code: "session_handoff_locked" })
    })
    expect(mockHandoffClient).not.toHaveBeenCalled()
    expect(freezeImportedSessionMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
    getSessionMock.mockResolvedValue({ ...imported, handoffLock: undefined })
    await act(async () => {
      await result.current.send("continue", undefined, { sessionId: id })
    })
    expect(complete).toHaveBeenCalled()
    expect(JSON.stringify(complete.mock.calls)).toContain("Never change production")
    expect(sendPromptMock.mock.calls[0][2].appendSystemPrompt).toContain(
      "Original constraint: Never change production."
    )
    mockHandoffClient.mockReset().mockResolvedValue(null)
  })

  // Verification is what unlocks the resume. Without it the turn must start a
  // fresh session rather than reattach to one nobody confirmed is still there.
  it("starts a fresh session for an imported conversation that was never verified", async () => {
    useAgentRuntimeStore.setState({
      runtimeRef: { kind: "external", agentId: "ext-1" },
      sessionCompositions: { "import:codex:thread-1": { presetId: "standard" } },
    })
    getSessionMock.mockResolvedValue({
      id: "import:codex:thread-1",
      title: "Imported Codex",
      importOwnership: "native-bound",
      importRuntimeBinding: { nativeSessionId: "thread-1", presetId: "codex" },
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "continued" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("continue", undefined, { sessionId: "import:codex:thread-1" })
    })
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "continue",
      expect.not.objectContaining({ sessionId: "thread-1" })
    )
  })

  // The model picker persists its pick on the conversation row and relies on
  // the turn replaying it (`applyModelToSession`). Nothing read the row back,
  // so a model chosen before the first turn — the only way to pick one on an
  // agent with no session open yet — never reached the agent at all.
  it("replays the model this conversation persisted for its own agent", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "External",
      model: "anthropic/claude-opus-4-1",
      providerOverride: `cognia:external-agent:${encodeURIComponent("ext-1")}`,
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", undefined, { sessionId: "sess-1" })
    })

    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ agentId: "ext-1", model: "anthropic/claude-opus-4-1" })
    )
  })

  // ADR-0182. A project run is readied where its runtime environment puts it,
  // so the readiness check is told the session's project, its environment
  // definition and the root it runs in. A session with no project is told
  // nothing (the plain-lane tests above), which is the Q39 off path.
  it.each([undefined, { agentId: "previous-agent", sessionId: "previous-native" }])(
    "hands earlier constraints and tool evidence to a fresh external agent (%j)",
    async (externalAgentSession) => {
      useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
      chatState.activeSessionId = "sess-1"
      getSessionMock.mockResolvedValue({ id: "sess-1", title: "Handoff", externalAgentSession })
      listMessagesMock.mockResolvedValue([
        {
          id: "goal",
          role: "user",
          parts: [{ type: "text", text: "Only analyze; never edit production" }],
        },
        {
          id: "evidence",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "test",
              toolCallId: "test-1",
              state: "output-available",
              input: {},
              output: "Parser test failed at line 42",
            },
          ],
        },
      ])
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "continued" })
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("continue")
      })
      const [prompt] = executeOnExternalAgentMock.mock.calls[0]
      expect(prompt).toContain("Only analyze; never edit production")
      expect(prompt).toContain("Parser test failed at line 42")
      expect(prompt).toContain("Current user request:\ncontinue")
    }
  )

  it("does not dispatch imported continuation if claiming history ownership fails", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "import:codex:ownership"
    getSessionMock.mockResolvedValue({
      id: "import:codex:ownership",
      title: "Imported",
      importOwnership: "source-mirror",
    })
    freezeImportedSessionMock.mockRejectedValueOnce(new Error("ownership-write-failed"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await expect(result.current.send("continue")).rejects.toThrow("ownership-write-failed")
    })
    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("readies an external agent for the session's project and environment", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    getProjectEnvironmentMock.mockResolvedValue({
      id: "env-1",
      projectId: "project-1",
      name: "Development",
      isEnabled: true,
      actions: [],
      variables: {},
      keyringReferences: [],
      createdAt: 1,
      updatedAt: 1,
    })
    // The project rides on the execution context, as the other project-run
    // tests here do: a top-level `projectId` also sends the turn through the
    // Workspace Trust read, which this suite does not stand up.
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Project run",
      executionContext: {
        location: "local",
        projectId: "project-1",
        projectRoot: "/repo",
        environmentId: "env-1",
        taskWorkspace: { taskId: "task-1" },
      },
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", undefined, { sessionId: "sess-1" })
    })

    expect(ensureExternalAgentReadyMock).toHaveBeenCalledWith(
      "ext-1",
      expect.objectContaining({
        environment: expect.objectContaining({
          projectId: "project-1",
          environmentId: "env-1",
          executionRoot: "/repo",
          surface: "interactive",
          project: expect.objectContaining({ id: "project-1" }),
        }),
      })
    )
  })

  it("stops the turn when readiness refuses the run's environment", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Project run",
      executionContext: { location: "local", projectId: "project-1", projectRoot: "/repo" },
    })
    ensureExternalAgentReadyMock.mockResolvedValueOnce({
      ok: false,
      reason: "blocked",
      detail: "Runtime environments are not enabled on this deployment",
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", undefined, { sessionId: "sess-1" })
    })

    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
  })

  it("routes an internal model and account through the external task gateway", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Gateway task",
      model: "kimi-for-coding",
      providerOverride: "plugin:kimi:subscription",
      accountId: "account-a",
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", undefined, { sessionId: "sess-1" })
    })
    expect(ensureExternalAgentReadyMock).toHaveBeenCalledWith("ext-1", { deferConnect: true })
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({
        cogniaModel: {
          providerId: "plugin:kimi:subscription",
          modelId: "kimi-for-coding",
          accountId: "account-a",
        },
        context: expect.objectContaining({
          custom: expect.objectContaining({ chatSessionId: "sess-1" }),
        }),
      })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("resumes and persists the durable gateway session link after manager recreation", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    const nativeId = "cognia-gateway:task-1:native-1"
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Resumed task",
      model: "auto",
      externalAgentSession: { agentId: "ext-1", sessionId: nativeId },
    })
    executeOnExternalAgentMock.mockResolvedValue({
      success: true,
      finalResponse: "ok",
      sessionId: nativeId,
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("continue", undefined, { sessionId: "sess-1" })
    })
    expect(ensureExternalAgentReadyMock).toHaveBeenCalledWith("ext-1", { deferConnect: true })
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "continue",
      expect.objectContaining({ sessionId: nativeId })
    )
  })

  it("aborts the isolated external task when Stop is pressed without interrupting the built-in agent", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Task",
      model: "coder",
      providerOverride: "gateway",
    })
    let taskSignal: AbortSignal | undefined
    executeOnExternalAgentMock.mockImplementation(
      (_prompt: string, options: { signal: AbortSignal }) => {
        taskSignal = options.signal
        return new Promise((resolve) =>
          options.signal.addEventListener(
            "abort",
            () => resolve({ success: false, error: "aborted" }),
            { once: true }
          )
        )
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    let sending: Promise<unknown>
    await act(async () => {
      sending = result.current.send("hi", undefined, { sessionId: "sess-1" })
      await flush()
    })
    expect(taskSignal).toBeDefined()
    await act(async () => {
      await result.current.stop("sess-1")
      await sending
    })
    expect(taskSignal!.aborted).toBe(true)
    expect(interruptSessionMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("stores the first gateway session link for later app reloads", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    const nativeId = "cognia-gateway:task-2:native-2"
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "New task",
      model: "coder",
      providerOverride: "gateway",
    })
    executeOnExternalAgentMock.mockResolvedValue({
      success: true,
      finalResponse: "ok",
      sessionId: nativeId,
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", undefined, { sessionId: "sess-1" })
    })
    expect(updateSessionMock).toHaveBeenCalledWith("sess-1", {
      externalAgentSession: { agentId: "ext-1", sessionId: nativeId },
    })
  })

  it("does not replay a model the row attributes to a different agent", async () => {
    // The marker is scoped per agent precisely so a pick made on one agent is
    // not asked for on another, which would be a model that agent never listed.
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "External",
      model: "anthropic/claude-opus-4-1",
      providerOverride: `cognia:external-agent:${encodeURIComponent("ext-2")}`,
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", undefined, { sessionId: "sess-1" })
    })

    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "hi",
      expect.not.objectContaining({ model: expect.anything() })
    )
  })

  it("does not replay a provider model as if the agent had offered it", async () => {
    // An unmarked row holds the built-in lane's model. Replaying it would ask
    // the agent for a model id no agent published, and the legacy unscoped
    // marker cannot be attributed to an agent either.
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "External",
      model: "claude-opus-5",
      providerOverride: "cognia:external-agent",
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", undefined, { sessionId: "sess-1" })
    })

    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "hi",
      expect.not.objectContaining({ model: expect.anything() })
    )
  })

  // ADR-0127 §1: the external rail rides the per-session coalescer — a burst
  // of deltas inside one frame must not fan out into one store commit each.
  it("external-agent deltas are rAF-coalesced: a 50-delta burst yields ≤2 store commits", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    chatState.activeSessionId = "sess-1"
    executeOnExternalAgentMock.mockImplementation(
      async (_text: string, opts: { onEvent: (e: unknown) => void }) => {
        for (let i = 0; i < 50; i++) opts.onEvent({ type: "text", text: `t${i}` })
        return { success: true, finalResponse: "done" }
      }
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    chatState.replaceSessionMessages.mockClear()
    await act(async () => {
      await result.current.send("hi")
    })
    const assistantWrites = chatState.replaceSessionMessages.mock.calls.filter(
      (c) =>
        c[0] === "sess-1" && (c[1] as Array<{ role: string }>).some((m) => m.role === "assistant")
    )
    // One flushed frame + the final canonical replace — never one per delta.
    expect(assistantWrites.length).toBeGreaterThan(0)
    expect(assistantWrites.length).toBeLessThanOrEqual(2)
    // The last visible frame carries the whole burst (the mocked
    // event-to-parts appends one char per delta).
    const last = assistantWrites.at(-1)![1] as Array<{
      role: string
      parts: Array<{ text?: string }>
    }>
    const text = last
      .find((m) => m.role === "assistant")!
      .parts.map((p) => p.text ?? "")
      .join("")
    expect(text.length).toBeGreaterThanOrEqual(50)
    // Final persist happened for this session.
    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", expect.any(Array))
  })

  it("does not reuse a previous agent's hosted native id when the new agent cannot host MCP", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockResolvedValue({
      success: true,
      finalResponse: "done",
      sessionId: "native-first",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("first")
    })
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-2" } })
    externalMcpLevelMock.value = "unsupported"
    listMessagesMock.mockResolvedValue([
      {
        id: "old-goal",
        role: "user",
        parts: [{ type: "text", text: "Keep the prior constraints" }],
      },
    ])
    await act(async () => {
      await result.current.send("continue")
    })
    expect(executeOnExternalAgentMock.mock.calls[1][0]).toContain("Keep the prior constraints")
    expect(executeOnExternalAgentMock.mock.calls[1][1]).toMatchObject({ agentId: "ext-2" })
    expect(executeOnExternalAgentMock.mock.calls[1][1]).not.toHaveProperty(
      "sessionId",
      "native-first"
    )
    expect(closeExternalSessionMock).toHaveBeenCalledWith("ext-1", "native-first")
  })

  it("retains one Cognia tool host across external turns and closes its native session on chat disposal", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockResolvedValue({
      success: true,
      finalResponse: "done",
      sessionId: "native-1",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("first")
    })
    await act(async () => {
      await result.current.send("follow-up")
    })
    expect(createRendererToolHostMock).toHaveBeenCalledTimes(1)
    expect(rendererToolHostStartMock).toHaveBeenCalledTimes(2)
    expect(rendererToolHostPauseMock).toHaveBeenCalledTimes(2)
    expect(rendererToolHostCloseMock).not.toHaveBeenCalled()
    expect(executeOnExternalAgentMock.mock.calls[1][1]).toMatchObject({ sessionId: "native-1" })
    expect(setSessionHostFactsMock).toHaveBeenCalledWith(
      "ext-1",
      "sess-1",
      expect.objectContaining({ toolHostRunning: true })
    )
    await act(async () => {
      await result.current.close("sess-1")
    })
    expect(closeExternalSessionMock).toHaveBeenCalledWith("ext-1", "native-1")
    expect(rendererToolHostCloseMock).toHaveBeenCalledTimes(1)
  })

  it.each(["pi-rpc", "codex-app-server", "opencode-v2", "acp"])(
    "projects tools for %s without duplicate host events or native approvals",
    async (protocol) => {
      externalProtocolMock.value = protocol
      useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
      rendererToolHostStartMock.mockResolvedValueOnce({
        mcpServers: [
          { type: "http", name: "cognia-tools", url: "http://127.0.0.1:4444/mcp", headers: [] },
        ],
        catalogFingerprint: "catalog",
      })
      executeOnExternalAgentMock.mockImplementation(async (_prompt, options) => {
        options.onEvent({
          type: "permission_request",
          sessionId: "native-tools",
          request: {
            id: "native-ask",
            toolInfo: { name: "mcp__cognia-tools__read" },
            options: [{ optionId: "once", kind: "allow_once", name: "Allow" }],
          },
        })
        return { success: true, finalResponse: "done", sessionId: "native-tools" }
      })
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("read workspace")
      })
      expect(rendererToolHostStartMock.mock.calls[0][0]).toMatchObject({ onToolEvent: undefined })
      expect(executeOnExternalAgentMock.mock.calls[0][1].context.custom.mcpServers).toEqual([
        expect.objectContaining({ name: "cognia-tools" }),
      ])
      expect(respondExternalPermissionMock).toHaveBeenCalledWith(
        "ext-1",
        "native-tools",
        expect.objectContaining({ requestId: "native-ask", granted: true, optionId: "once" })
      )
      expect(chatState.pushApproval).not.toHaveBeenCalledWith(
        expect.objectContaining({ requestId: expect.stringContaining("native-ask") })
      )
    }
  )

  it("recreates SDK native state when the projected catalog changes and carries the Cognia transcript", async () => {
    externalProtocolMock.value = "dsh-sdk"
    listMessagesMock.mockResolvedValue([
      {
        id: "old",
        role: "assistant",
        parts: [{ type: "text", text: "Retained plan from previous turn" }],
      },
      { id: "u1", role: "user", parts: [{ type: "text", text: "new tools" }] },
    ])
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockResolvedValue({
      success: true,
      finalResponse: "done",
      sessionId: "native-1",
    })
    rendererToolHostStartMock
      .mockResolvedValueOnce({ mcpServers: [], catalogFingerprint: "catalog-1" })
      .mockResolvedValueOnce({ mcpServers: [], catalogFingerprint: "catalog-2" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("first")
    })
    await act(async () => {
      await result.current.send("new tools")
    })
    expect(closeExternalSessionMock).toHaveBeenCalledWith("ext-1", "native-1")
    expect(executeOnExternalAgentMock.mock.calls[1][1].sessionId).toBeUndefined()
    expect(rendererToolHostStartMock.mock.calls[0][0]).toMatchObject({ onToolEvent: undefined })
    expect(
      executeOnExternalAgentMock.mock.calls[1][1].context.custom.conversationHistory
    ).toContain("Retained plan from previous turn")
    expect(
      executeOnExternalAgentMock.mock.calls[1][1].context.custom.conversationHistory
    ).not.toContain("new tools")
  })

  it("delegates a matching turn to the external agent (Thread B)", async () => {
    chatState.activeSessionId = "sess-1"
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({
      shouldDelegate: true,
      targetAgentId: "ext-1",
      matchedRule: { id: "r1", name: "Code → CC" },
      reasonCode: "ok",
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "delegated done" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("refactor this module", {
        additionalDirectories: ["/shared"],
        effort: "xhigh",
        systemPrompt: "Use the selected skill catalog.",
        appendSystemPrompt: "Workspace context and skill guidance.",
        allowedTools: ["mcp__docs__search"],
        mcpServers: {
          docs: {
            type: "http",
            url: "https://docs.example/mcp",
            headers: { Authorization: "Bearer scoped-token" },
          },
        },
      })
    })
    expect(setDelegationRulesMock).toHaveBeenCalled()
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "refactor this module",
      expect.objectContaining({
        agentId: "ext-1",
        reasoningEffort: "xhigh",
        systemPrompt: "Use the selected skill catalog.\n\nWorkspace context and skill guidance.",
        allowedTools: ["mcp__docs__search"],
        context: {
          custom: {
            additionalDirectories: ["/shared"],
            chatSessionId: "sess-1",
            mcpServers: [
              {
                type: "http",
                name: "docs",
                url: "https://docs.example/mcp",
                headers: [{ name: "Authorization", value: "Bearer scoped-token" }],
              },
            ],
          },
        },
      })
    )
    // Built-in SDK path did NOT run for the delegated turn.
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("routes a delegated turn on the typed question and hands the agent the attached file with it", async () => {
    chatState.activeSessionId = "sess-1"
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({
      shouldDelegate: true,
      targetAgentId: "ext-1",
      matchedRule: { id: "r1", name: "Code → CC" },
      reasonCode: "ok",
    })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "delegated done" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send(
        [
          { type: "text", text: "export function legacyParse() {}" },
          { type: "text", text: "refactor this module" },
        ],
        undefined,
        {
          attachmentManifest: [
            { filename: "parse.ts", mediaType: "text/plain", kind: "document" as const },
          ],
        }
      )
    })
    // The rules read what the user asked, never the file's contents.
    expect(checkDelegationMock).toHaveBeenCalledWith("refactor this module", {
      sessionId: "sess-1",
    })
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "export function legacyParse() {}\n\nrefactor this module",
      expect.objectContaining({ agentId: "ext-1" })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("does not delegate when no external agents are connected", async () => {
    getConnectedAgentsMock.mockReturnValue([])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("refactor this module")
    })
    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled() // built-in path ran
  })

  it("falls back to the built-in path when a delegated turn fails (fallback policy)", async () => {
    useExternalAgentStore.setState({ chatFailurePolicy: "fallback" })
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    executeOnExternalAgentMock.mockResolvedValue({ success: false, error: "spawn failed" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("refactor this module")
    })
    // Fallback re-entry runs the SDK path.
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("surfaces the error without fallback under the strict policy", async () => {
    useExternalAgentStore.setState({ chatFailurePolicy: "strict" })
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    executeOnExternalAgentMock.mockResolvedValue({ success: false, error: "spawn failed" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("refactor this module")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      // Strict policy: the external-agent turn is NOT re-issued on the built-in
      // path, so the diagnostic is attributed to the agent that actually failed.
      expect.objectContaining({
        message: "spawn failed",
        source: "external-agent",
        meta: expect.objectContaining({ agentId: "ext-1" }),
      })
    )
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "external",
        surface: "chat",
        errorType: "ExternalAgentError",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("spawn failed")
  })

  it("send() updates the title for a new session and marks it machine-set", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("new prompt")
    })
    expect(updateSessionMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ title: expect.any(String), titleAuto: true })
    )
  })

  it("send() does not overwrite a manually-renamed (non-placeholder) title", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "My renamed chat",
      titleAuto: false,
      model: "sonnet",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("new prompt")
    })
    expect(updateSessionMock).not.toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ title: expect.any(String) })
    )
  })

  it("send() surfaces error when no active session", async () => {
    chatState.activeSessionId = null
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(chatState.setError).toHaveBeenCalledWith(
      "No conversation is open. Start a new one to send this."
    )
  })

  it("send() applies pending command overrides", async () => {
    chatState.pendingCommandOverrides = {
      model: "opus",
      allowedTools: ["read"],
      paths: ["/x"],
    }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    // Cleared against THIS conversation, matching where they were read from —
    // the bare call cleared whichever pane happened to have focus.
    expect(chatState.setPendingCommandOverrides).toHaveBeenCalledWith(null, "sess-1")
  })

  it("send() consults the plugin onUserPromptSubmit hook before sending", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({ action: "proceed" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(dispatchUserPromptSubmitMock).toHaveBeenCalledWith("hello", "sess-1", expect.any(Object))
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("send() bails when a plugin returns action:'block'", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({
      action: "block",
      reason: "policy violation",
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("nope")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ code: "promptBlockedByPlugin", message: "policy violation" })
    )
  })

  it("send() rewrites the prompt when a plugin returns action:'modify'", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({
      action: "modify",
      modifiedPrompt: "rewritten",
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("original")
    })
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "rewritten", expect.any(Object))
  })

  it("send() folds plugin additionalContext into appendSystemPrompt", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({
      action: "modify",
      additionalContext: "extra system note",
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      "hello",
      expect.objectContaining({ appendSystemPrompt: "extra system note" })
    )
  })

  it("send() calls dispatchChatError when sendPrompt throws", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("network down"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ message: "network down", source: "chat" })
    )
    expect(dispatchChatErrorMock).toHaveBeenCalledWith("sess-1", expect.any(Error))
  })

  it("stop() interrupts the active session", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.stop()
    })
    expect(interruptSessionMock).toHaveBeenCalledWith("sess-1")
    expect(chatTurnPerformanceMock.finish).toHaveBeenCalledWith("sess-1", "cancelled")
  })

  it("registers its stop and approval responder for surfaces outside the provider", async () => {
    const { unmount } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await expect(stopChatTurn("sess-bg")).resolves.toBe(true)
    })
    expect(interruptSessionMock).toHaveBeenCalledWith("sess-bg")
    await act(async () => {
      await expect(
        answerChatApproval(
          { sessionId: "sess-bg", requestId: "r-bg", toolName: "read" } as never,
          "deny"
        )
      ).resolves.toBe(true)
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-bg", "r-bg", "deny")
    unmount()
    // Unmounted runtime: nothing left to deliver through.
    await expect(stopChatTurn("sess-bg")).resolves.toBe(false)
  })

  it("stop() durably queues an attached HostState abort instead of direct interrupt", async () => {
    enqueueHostStateIntentMock.mockResolvedValueOnce({ id: "abort-action", status: "pending" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.stop()
    })

    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      action: { kind: "turn.abort" },
    })
    expect(interruptSessionMock).not.toHaveBeenCalled()
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
  })

  it("stop() releases the GUI before a slow interrupt acknowledgement returns", async () => {
    chatState.status = "streaming"
    let acknowledgeInterrupt: (() => void) | undefined
    interruptSessionMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledgeInterrupt = resolve
        })
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    let stopPromise: Promise<void> | undefined
    act(() => {
      stopPromise = result.current.stop()
    })

    // Capability probing is asynchronous. Let the legacy fallback reach the
    // direct interrupt call without resolving its deliberately slow receipt.
    await act(async () => {
      await Promise.resolve()
    })

    expect(interruptSessionMock).toHaveBeenCalledWith("sess-1")
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
    expect(chatState.status).toBe("idle")

    acknowledgeInterrupt?.()
    await act(async () => {
      await stopPromise
    })
  })

  it("stop() is a no-op without an active session", async () => {
    chatState.activeSessionId = null
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.stop()
    })
    expect(interruptSessionMock).not.toHaveBeenCalled()
  })

  it("close() forwards to closeSession", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.close("sess-1")
    })
    expect(closeSessionIpcMock).toHaveBeenCalledWith("sess-1")
    expect(chatTurnPerformanceMock.finish).toHaveBeenCalledWith("sess-1", "cancelled")
  })

  it("close() clears Computer Use session grants even when sidecar close fails", async () => {
    recordSessionGrant("sess-1", "click_text")
    closeSessionIpcMock.mockRejectedValueOnce(new Error("sidecar unavailable"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.close("sess-1")
    })

    expect(hasSessionGrant("sess-1", "click_text")).toBe(false)
    expect(releaseSkillLoadContextMock).toHaveBeenCalledWith("sess-1")
  })

  it("respondToApproval (allow): forwards to approveTool", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "read",
        } as never,
        "allow"
      )
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-1", "allow")
    expect(chatState.clearApproval).toHaveBeenCalledWith("r-1", "sess-1")
  })

  it("respondToApproval through an execution handle journals the resolution approveTool would have", async () => {
    const resolvePermission = jest.fn(async () => undefined)
    const { result } = renderHook(
      () => ({ chat: useClaudeChat(), directory: useAgentExecutionHandleDirectory() }),
      { wrapper: AgentExecutionHandleProvider }
    )
    await flush()
    act(() => {
      result.current.directory.register({ sessionId: "sess-h", resolvePermission } as never)
    })
    await act(async () => {
      await result.current.chat.respondToApproval(
        { sessionId: "sess-h", requestId: "r-h", toolName: "read" } as never,
        "allow_always"
      )
    })
    expect(resolvePermission).toHaveBeenCalledWith("r-h", "allow_always")
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(recordChatCanonicalEvents).toHaveBeenCalledWith("sess-h", [
      { kind: "permission-resolved", requestId: "r-h", behavior: "allow" },
    ])
    expect(chatState.clearApproval).toHaveBeenCalledWith("r-h", "sess-h")
    await act(async () => {
      await result.current.chat.respondToApproval(
        { sessionId: "sess-h", requestId: "r-h2", toolName: "read" } as never,
        "deny"
      )
    })
    expect(recordChatCanonicalEvents).toHaveBeenLastCalledWith("sess-h", [
      { kind: "permission-resolved", requestId: "r-h2", behavior: "deny" },
    ])
  })

  it("keeps a manual approval pending when permission dispatch fails", async () => {
    approveToolMock.mockRejectedValueOnce(new Error("sidecar unavailable"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await expect(
        result.current.respondToApproval(
          { sessionId: "sess-1", requestId: "r-retry", toolName: "read" } as never,
          "allow"
        )
      ).rejects.toThrow("sidecar unavailable")
    })

    expect(chatState.clearApproval).not.toHaveBeenCalledWith("r-retry", "sess-1")
  })

  it("respondToApproval queues the attached decision and skips direct approval RPC", async () => {
    enqueueHostStateIntentMock.mockResolvedValueOnce({ id: "approval-action", status: "pending" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.respondToApproval(
        { sessionId: "sess-1", requestId: "r-host", toolName: "read" } as never,
        "deny"
      )
    })

    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      action: { kind: "approval.respond", requestId: "r-host", decision: "deny" },
    })
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(chatState.clearApproval).toHaveBeenCalledWith("r-host", "sess-1")
  })

  it("respondToApproval records a session grant for OCR visual tools", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-ocr",
          toolName: "mcp__cognia-plugin-tools__click_text",
        } as never,
        "allow"
      )
    })

    expect(hasSessionGrant("sess-1", "mcp__cognia-plugin-tools__click_text")).toBe(true)
  })

  it("resolves external tool-host approval in the local registry without the agent or SDK permission RPC", async () => {
    const { awaitApproval, hasSessionBypass } =
      await import("@/lib/connectors/hitl/approval-registry")
    const pending = awaitApproval("sess-1", "external-tool-host:lease:tool-1")
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "external-tool-host:lease:tool-1",
          toolUseID: "tool-1",
          toolName: "write",
          input: {},
          status: "pending",
        },
        "allow_always"
      )
    })
    await expect(pending).resolves.toEqual({ decision: "allow_always" })
    expect(hasSessionBypass("sess-1", "write")).toBe(true)
    expect(hasSessionBypass("other-session", "write")).toBe(false)
    await act(async () => {
      await result.current.close("sess-1")
    })
    expect(hasSessionBypass("sess-1", "write")).toBe(false)
    expect(approveToolMock).not.toHaveBeenCalled()
  })

  it("respondToApproval resolves builtin-skill: approvals locally, never via approveTool", async () => {
    const { resolveApproval, awaitApproval } =
      await import("@/lib/connectors/hitl/approval-registry")
    void resolveApproval
    const pending = awaitApproval("sess-1", "builtin-skill:im.create_chat:x", { ttlMs: 0 })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "builtin-skill:im.create_chat:x",
          toolName: "im_create_chat",
        } as never,
        "allow"
      )
    })
    // Resolved in-renderer: the pending registry promise settles, the card is
    // cleared, and the sidecar approveTool IPC is never touched.
    await expect(pending).resolves.toEqual({ decision: "allow" })
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(chatState.clearApproval).toHaveBeenCalledWith("builtin-skill:im.create_chat:x", "sess-1")
  })

  it("respondToApproval resolves realtime approvals locally and persists always-allow rules", async () => {
    const { awaitApproval } = await import("@/lib/connectors/hitl/approval-registry")
    const requestId = "realtime-tool:call-1"
    const pending = awaitApproval("sess-1", requestId, { ttlMs: 0 })
    settingsState.save.mockClear()
    settingsState.toggleAlwaysAllow.mockClear()
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId,
          toolName: "search_notes",
        } as never,
        "allow_always"
      )
    })

    await expect(pending).resolves.toEqual({ decision: "allow" })
    expect(settingsState.save).toHaveBeenCalledWith({
      agentPermissions: { toolRules: { search_notes: { "*": "allow" } } },
    })
    expect(settingsState.toggleAlwaysAllow).not.toHaveBeenCalled()
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(chatState.clearApproval).toHaveBeenCalledWith(requestId, "sess-1")
  })

  it("SDK suppressed persistent approval never saves a rule from a stale always response", async () => {
    settingsState.save.mockClear()
    settingsState.toggleAlwaysAllow.mockClear()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-sdk",
          toolName: "read",
          input: {},
          suppressAlwaysAllowRule: true,
        } as never,
        "allow_always"
      )
    })
    expect(settingsState.save).not.toHaveBeenCalled()
    expect(settingsState.toggleAlwaysAllow).not.toHaveBeenCalled()
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-sdk", "allow")
  })

  it("respondToApproval (allow_always) toggles the always-allow list", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "read",
        } as never,
        "allow_always"
      )
    })
    expect(settingsState.toggleAlwaysAllow).toHaveBeenCalledWith("read", true)
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-1", "allow")
  })

  it("respondToApproval (allow_always) persists a TARGET-SCOPED rule when a target exists", async () => {
    settingsState.save.mockClear()
    settingsState.toggleAlwaysAllow.mockClear()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "Bash",
          input: { command: "git status" },
        } as never,
        "allow_always"
      )
    })
    // Scoped rule persisted; the coarse name-grant path is NOT taken.
    //
    // The pattern is the command the user actually read, not its family.
    // Deriving `git *` from the head is what `deriveAllowRuleFromApproval`
    // deliberately stopped doing: one click on a read-only `git status` also,
    // and permanently, granted `git push --force` / `git reset --hard`.
    // `approval-rule.test.ts` pins that directly (`not.toBe("git *")`); this
    // asserts the caller threads it through unwidened.
    expect(settingsState.save).toHaveBeenCalledWith({
      agentPermissions: { toolRules: { Bash: { "git status": "allow" } } },
    })
    expect(settingsState.toggleAlwaysAllow).not.toHaveBeenCalled()
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-1", "allow")
  })

  it("respondToApproval (deny) forwards deny to approveTool", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.respondToApproval(
        {
          sessionId: "sess-1",
          requestId: "r-1",
          toolName: "read",
        } as never,
        "deny"
      )
    })
    expect(approveToolMock).toHaveBeenCalledWith("sess-1", "r-1", "deny")
  })

  it("editAndResend keeps the original as a sibling instead of deleting its tail", async () => {
    // This used to `truncateAfter(..., { inclusive: true })`: rewording a
    // question halfway up a thread permanently destroyed everything after it,
    // with no undo. Regenerate had kept its alternatives as branches since it
    // was written; editing now behaves the same way.
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "original" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "reply" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.editAndResend("u-1", "edited")
    })

    expect(truncateAfterMock).not.toHaveBeenCalled()
    const persisted = persistMessagesMock.mock.calls.at(-1)?.[1] as Array<{
      id: string
      metadata?: Record<string, unknown>
    }>
    // The original joins a sibling group…
    expect(persisted.find((m) => m.id === "u-1")?.metadata).toMatchObject({
      branchGroupId: "edit::u-1",
      branchIndex: 0,
    })
    // …and the reply that followed it now hangs off it, so it hides while the
    // new variant is selected and comes back when you flip to the original.
    expect(persisted.find((m) => m.id === "a-1")?.metadata).toMatchObject({
      branchOwnerId: "u-1",
    })
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("editAndResend stamps the new turn's replies with the edited variant as branch owner", async () => {
    // The original keeps its own tail via `tagEditSibling`, but the reply the
    // RESEND produces must hang off the replacement too — otherwise flipping
    // the navigator back to the original shows the new answer under it.
    const adapterMock = jest.requireMock("@/lib/claude/adapter") as {
      applySdkEvent: jest.Mock
    }
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "original" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "reply" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.editAndResend("u-1", "edited")
    })

    // `makeUserMessage` is mocked to id "u1" — that is the replacement variant
    // the just-sent turn owns.
    const appended = [
      ...(chatState.messages as object[]),
      { id: "a-2", role: "assistant", parts: [{ type: "text", text: "new reply" }] },
    ]
    adapterMock.applySdkEvent.mockReturnValueOnce({ messages: appended, turnComplete: true })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
    })
    await flush()

    const written = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      id: string
      metadata?: Record<string, unknown>
    }>
    expect(written.find((m) => m.id === "a-2")?.metadata).toMatchObject({
      branchOwnerId: "u1",
    })
    // The pre-existing tail stays owned by the ORIGINAL sibling.
    expect(written.find((m) => m.id === "a-1")?.metadata).toMatchObject({
      branchOwnerId: "u-1",
    })
  })

  it("editAndResend is a no-op when the message is not in the thread", async () => {
    chatState.messages = []
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.editAndResend("gone", "edited")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("editAndResend is a no-op while the session is mid-turn", async () => {
    // Drafts can outlive the idle moment they were opened in: a send now
    // would land as a steer, and a steer never consumes `branchTag` — the
    // group `tagEditSibling` persists would have no replacement variant.
    chatState.status = "streaming"
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "original" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "reply" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    persistMessagesMock.mockClear()
    await act(async () => {
      await result.current.editAndResend("u-1", "edited")
    })
    expect(persistMessagesMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
    // Nothing was tagged into a sibling group either.
    expect(
      (chatState.messages as Array<{ metadata?: unknown }>).every((m) => m.metadata === undefined)
    ).toBe(true)
  })

  it("regenerate is a no-op when there is no user message", async () => {
    chatState.messages = []
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.regenerate()
    })
    expect(truncateAfterMock).not.toHaveBeenCalled()
  })

  it("regenerate is a no-op while the session is mid-turn", async () => {
    // `skipUserAppend` bypasses the steer gate, so a regenerate here would
    // re-enter the normal send path and restart the sidecar under the live
    // turn — silently dropping its context. Guard before any tagging.
    chatState.status = "awaiting_approval"
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    persistMessagesMock.mockClear()
    await act(async () => {
      await result.current.regenerate()
    })
    expect(persistMessagesMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("regenerate and editAndResend are no-ops while the turn waits for admission", async () => {
    // A queued turn leaves the status idle. Re-issuing it would park a second
    // copy of the same turn behind the same working tree.
    chatState.status = "idle"
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    isChatTurnQueuedMock.mockReturnValue(true)
    persistMessagesMock.mockClear()
    await act(async () => {
      await result.current.regenerate()
      await result.current.editAndResend("u-1", "edited")
    })
    expect(persistMessagesMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("regenerate tags the existing assistant siblings and re-sends without re-appending the user turn", async () => {
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
    ]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.regenerate()
    })

    // Branch-aware regenerate no longer truncates — siblings are preserved
    // and stamped with branchGroupId / branchIndex via persistMessages.
    expect(truncateAfterMock).not.toHaveBeenCalled()
    expect(persistMessagesMock).toHaveBeenCalled()
    // Find the persist call that wrote the branch-tagged snapshot. send()
    // and applySdkEvent may also persist, so we scan rather than peek
    // at the last call.
    const taggingCall = persistMessagesMock.mock.calls.find((args) => {
      const list = args[1] as Array<{ id: string; metadata?: { branchGroupId?: string } }>
      return Array.isArray(list) && list.some((m) => m.id === "a-1" && m.metadata?.branchGroupId)
    })
    expect(taggingCall).toBeTruthy()
    expect(taggingCall?.[0]).toBe("sess-1")
    const merged = taggingCall?.[1] as Array<{
      id: string
      metadata?: { branchGroupId?: string; branchIndex?: number }
    }>
    const tagged = merged.find((m) => m.id === "a-1")
    expect(tagged?.metadata?.branchGroupId).toBe("u-1")
    expect(tagged?.metadata?.branchIndex).toBe(0)

    // sendPrompt fires for the new assistant turn — sendPromptMock has been
    // called (via `send()`), which means we did re-issue the request.
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("non-Tauri: skips the message subscription", async () => {
    isTauriMock.mockReturnValue(false)
    renderHook(() => useClaudeChat())
    await flush()
    expect(onClaudeMessageMock).not.toHaveBeenCalled()
  })

  it("suppresses the global projector only after the interactive subscription succeeds", async () => {
    const { unmount } = renderHook(() => useClaudeChat())
    await flush()

    expect(registerInteractiveWorkSubmissionEventsMock).toHaveBeenCalledTimes(1)
    unmount()
    expect(unregisterInteractiveWorkSubmissionEventsMock).toHaveBeenCalledTimes(1)
  })

  it("leaves the global projector active and retries when the interactive subscription fails", async () => {
    const listenError = new Error("listener unavailable")
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    onClaudeMessageMock.mockRejectedValueOnce(listenError)

    renderHook(() => useClaudeChat())
    await flush()

    expect(registerInteractiveWorkSubmissionEventsMock).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith("listen claude events failed", listenError)
    await new Promise((resolve) => setTimeout(resolve, 1_050))
    await flush()
    expect(onClaudeMessageMock).toHaveBeenCalledTimes(2)
    expect(registerInteractiveWorkSubmissionEventsMock).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  // ── handleEvent paths (driven through the sidecar message subscription) ──

  it("incoming sdk_session_id event persists the SDK conversation id", async () => {
    renderHook(() => useClaudeChat())
    await flush()
    expect(_messageCallback).toBeTruthy()
    await act(async () => {
      _messageCallback?.({
        type: "sdk_session_id",
        sessionId: "sess-1",
        sdkSessionId: "sdk-abc",
      })
    })
    expect(setSdkSessionIdMock).toHaveBeenCalledWith("sess-1", "sdk-abc")
  })

  it("incoming session_ended (no error) completes a tool-only turn", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      _messageCallback?.({ type: "session_ended", sessionId: "sess-1" })
    })
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
    expect(chatTurnPerformanceMock.finish).toHaveBeenCalledWith("sess-1", "completed")
    expect(releaseSkillLoadContextMock).toHaveBeenCalledWith("sess-1")
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.completed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
      })
    )
    expect(settleChatTurnForSessionMock).toHaveBeenCalledWith("sess-1", {
      outcome: "completed",
      writeTranscript: expect.any(Function),
    })
  })

  it("records a permanent provider failure without exporting its message", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      _messageCallback?.({
        type: "session_ended",
        sessionId: "sess-1",
        error: "private upstream response",
        httpStatus: 429,
      })
    })
    await flush()

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
        errorType: "http_429",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("private upstream response")
    expect(chatTurnPerformanceMock.finish).toHaveBeenCalledWith("sess-1", "failed")
  })

  it("classifies a permanent provider failure without an HTTP status", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      _messageCallback?.({
        type: "session_ended",
        sessionId: "sess-1",
        error: "private upstream response",
      })
    })
    await flush()

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
        errorType: "provider_error",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("private upstream response")
  })

  // ADR-0127: `command_ack { duplicate: true }` used to fall through the event
  // switch unhandled. It now records the dedupe and touches nothing else.
  it("command_ack records a dedupe mark and leaves session state untouched", async () => {
    chatState.activeSessionId = "sess-1"
    chatState.openSessionIds = ["sess-1"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    chatState.replaceSessionMessages.mockClear()
    chatState.setSessionStatus.mockClear()
    await act(async () => {
      _messageCallback?.({
        type: "command_ack",
        sessionId: "sess-1",
        commandId: "cmd-7",
        duplicate: true,
      })
    })
    expect(chatTurnPerformanceMock.markCommandDeduped).toHaveBeenCalledWith("sess-1")
    expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
    expect(chatState.setSessionStatus).not.toHaveBeenCalled()
    expect(persistMessagesMock).not.toHaveBeenCalledWith("sess-1", expect.anything())
  })

  it("sidecar_exited settles a streaming session with a retryable error", async () => {
    chatState.status = "idle"
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
      chatState.status = "streaming"
      _messageCallback?.({ type: "sidecar_exited" })
    })
    // The sidecar crash now emits a code, not a sentinel string the view has
    // to compare back — that round-trip existed only because the store could
    // not carry structure.
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ code: "sidecarExited", source: "chat", retryable: true })
    )
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
        errorType: "sidecar_exited",
      })
    )
    expect(chatTurnPerformanceMock.finish).toHaveBeenCalledWith("sess-1", "failed")
    chatState.status = "idle"
  })

  it("sidecar_exited interrupts a pending approval and does not touch idle sessions", async () => {
    chatState.status = "awaiting_approval"
    chatState.pendingApprovals = [{ requestId: "req-9", sessionId: "sess-1" }]
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({ type: "sidecar_exited" })
    })
    expect(chatState.markApprovalInterrupted).toHaveBeenCalledWith(
      "req-9",
      "sess-1",
      expect.any(String)
    )
    // The sidecar crash now emits a code, not a sentinel string the view has
    // to compare back — that round-trip existed only because the store could
    // not carry structure.
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ code: "sidecarExited", source: "chat", retryable: true })
    )
    chatState.status = "idle"
    chatState.pendingApprovals = []
  })

  it("sidecar_exited leaves an idle session untouched", async () => {
    chatState.status = "idle"
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({ type: "sidecar_exited" })
    })
    expect(chatState.setSessionDiagnostic).not.toHaveBeenCalled()
  })

  it("incoming permission_request for an already-allowed tool auto-approves", async () => {
    settingsState.settings.alwaysAllowTools = ["read"]
    renderHook(() => useClaudeChat())
    await flush()
    // Mirror the subscriber-driven allow-list refresh that happens on mount.
    settingsSubscribers.forEach((sub) => sub(settingsState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-1",
        toolUseID: "tu-1",
        toolName: "read",
        input: {},
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith(
      "sess-1",
      "req-1",
      "allow",
      undefined,
      undefined,
      undefined,
      {
        authority: "policy-rule",
      }
    )
    settingsState.settings.alwaysAllowTools = []
  })

  it("Auto-mode auto-approves a safe shell command without prompting", async () => {
    ;(settingsState.settings as Record<string, unknown>).agentPermissions = {
      autoApprove: { enabled: true },
    }
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-auto-allow",
        toolUseID: "tu-a",
        toolName: "Bash",
        input: { command: "git status" },
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith(
      "sess-1",
      "req-auto-allow",
      "allow",
      undefined,
      undefined,
      undefined,
      {
        authority: "policy-rule",
      }
    )
    delete (settingsState.settings as Record<string, unknown>).agentPermissions
  })

  it("Auto-mode auto-denies a catastrophic shell command", async () => {
    ;(settingsState.settings as Record<string, unknown>).agentPermissions = {
      autoApprove: { enabled: true },
    }
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-auto-deny",
        toolUseID: "tu-d",
        toolName: "Bash",
        input: { command: "rm -rf /" },
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith(
      "sess-1",
      "req-auto-deny",
      "deny",
      expect.stringContaining("auto-denied"),
      undefined,
      undefined,
      { authority: "policy-deny" }
    )
    delete (settingsState.settings as Record<string, unknown>).agentPermissions
  })

  it.each([
    ["pwd", "allow"],
    ["rm -rf /", "deny"],
  ] as const)(
    "routes Auto-mode %s decisions to the renderer tool broker",
    async (command, expected) => {
      const { tryAutoModeDecision } = await import("./claude-chat-events")
      ;(settingsState.settings as Record<string, unknown>).agentPermissions = {
        autoApprove: { enabled: true },
      }
      const respond = jest.fn(async (_decision: "allow" | "deny", _message?: string) => {})
      try {
        await expect(
          tryAutoModeDecision(
            {
              sessionId: "sess-1",
              requestId: "external-tool-host:auto",
              toolName: "Bash",
              input: { command },
            },
            respond
          )
        ).resolves.toBe(true)
        expect(respond.mock.calls[0][0]).toBe(expected)
        expect(approveToolMock).not.toHaveBeenCalled()
      } finally {
        delete (settingsState.settings as Record<string, unknown>).agentPermissions
      }
    }
  )

  it("surfaces the manual approval dialog when the Auto-mode judge hangs (no-dialog hang guard)", async () => {
    const { runAutoModeForTool } = await import("@/lib/claude/permissions/auto-mode-runner")
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    chatState.pushApproval.mockClear()

    // A wedged utility-LLM judge: the Auto-mode decision never settles. Without
    // the renderer timeout this would freeze the turn with no dialog ever shown.
    ;(runAutoModeForTool as jest.Mock).mockReturnValueOnce(new Promise(() => {}))
    jest.useFakeTimers()
    try {
      act(() => {
        _messageCallback?.({
          type: "permission_request",
          sessionId: "sess-1",
          requestId: "req-hang",
          toolUseID: "tu-h",
          toolName: "Bash",
          input: { command: "echo hi" },
        })
      })
      // Let the handler reach the awaited Auto-mode race (still pending).
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(chatState.pushApproval).not.toHaveBeenCalled()

      // After the decision timeout the request falls through to the manual modal.
      act(() => {
        jest.advanceTimersByTime(12_000)
      })
      jest.useRealTimers()
      await flush()
      expect(chatState.pushApproval).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "sess-1", requestId: "req-hang" })
      )
    } finally {
      jest.useRealTimers()
      ;(runAutoModeForTool as jest.Mock).mockReset()
    }
  })

  it("incoming permission_request for a non-open session is auto-denied", async () => {
    chatState.activeSessionId = "sess-other"
    // sess-1 has no open pane → its approval is auto-denied (not surfaced).
    chatState.openSessionIds = ["sess-other"]
    renderHook(() => useClaudeChat())
    await flush()
    // Push the active-session change through the subscriber callback so
    // the hook's `activeRef` reflects it without re-rendering.
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-2",
        toolUseID: "tu-2",
        toolName: "write",
        input: {},
      })
    })
    expect(approveToolMock).toHaveBeenCalledWith(
      "sess-1",
      "req-2",
      "deny",
      expect.stringContaining("auto-denied")
    )
    chatState.activeSessionId = "sess-1"
  })

  it("permission_request for a non-open but remotely-attached session is not auto-denied", async () => {
    const registry = await import("@/lib/companion/remote-attach-registry")
    registry.__resetRemoteAttachForTests()
    registry.attachSession("sess-1", "dev-remote", {
      eventStreams: [
        {
          leaseId: "esl-ready",
          transport: "ws",
          state: "ready",
          openedAt: Date.now(),
        },
      ],
      grants: [registry.REMOTE_CONTROL_CAPABILITY],
    })

    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-remote",
        toolUseID: "tu-r",
        toolName: "write",
        input: {},
      })
    })
    // Routed to the remote device — no auto-deny, and a backstop is armed.
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(registry.hasArmedBackstop("sess-1")).toBe(true)

    registry.__resetRemoteAttachForTests()
    chatState.activeSessionId = "sess-1"
  })

  it("bounds a local approval even when its pane closes before the user answers", async () => {
    renderHook(useClaudeChat)
    await flush()
    jest.useFakeTimers()
    try {
      await act(async () => {
        _messageCallback?.({
          type: "permission_request",
          sessionId: "sess-1",
          requestId: "forgotten",
          toolName: "edit",
          input: {},
        })
      })
      expect(chatState.pushApproval).toHaveBeenCalled()
      chatState.activeSessionId = "sess-other"
      chatState.openSessionIds = ["sess-other"]
      delete chatState.otherSlices["sess-1"]
      await act(async () => jest.advanceTimersByTime(DEFAULT_APPROVAL_BACKSTOP_MS))
      expect(approveToolMock).toHaveBeenCalledWith(
        "sess-1",
        "forgotten",
        "deny",
        "auto-denied: approval timed out"
      )
      expect(chatState.markApprovalInterrupted).toHaveBeenCalledWith(
        "forgotten",
        "sess-1",
        "approval timed out"
      )
    } finally {
      __resetRemoteAttachForTests()
      jest.useRealTimers()
    }
  })

  it("incoming permission_request for the active session pushes an approval", async () => {
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        requestId: "req-3",
        toolUseID: "tu-3",
        toolName: "edit",
        input: { path: "x.ts" },
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
      })
    })
    expect(chatState.pushApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        requestId: "req-3",
        toolName: "edit",
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
      })
    )
  })
})

describe("useClaudeChat — native vector backend branch", () => {
  const mockNativeStore = { provider: "native" }

  beforeEach(() => {
    mockGetTwinRuntimeSettings.mockResolvedValue({
      workerEnabled: true,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        apiKey: "sk-test",
      },
      storage: {
        vectorBackend: "native",
      },
    })
    mockCreateVectorStore.mockReturnValue(mockNativeStore)
  })

  it("case 'native' builds a storeConfig with provider=native and calls createVectorStore", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello from native")
    })

    expect(mockCreateVectorStore).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "native",
        native: {},
        embeddingConfig: expect.objectContaining({ provider: "openai" }),
      })
    )
  })
})

describe("useClaudeChat — goal loop wiring (ADR-0019)", () => {
  const adapterMock = jest.requireMock("@/lib/claude/adapter") as {
    applySdkEvent: jest.Mock
    extractUsage: jest.Mock
  }

  beforeEach(() => {
    // `recordResultUsage` (real module) also calls the mocked extractUsage, so
    // reset it here to the no-usage default for deterministic per-test setup.
    adapterMock.extractUsage.mockReset().mockReturnValue(null)
  })

  function activeGoal(over: Record<string, unknown> = {}) {
    return { id: "g1", status: "active", generationId: "gen1", config: {}, ...over }
  }

  /** Drive a synthetic `event` whose applySdkEvent result seals the turn. */
  async function driveTurnComplete(
    result: unknown = { usage: { input_tokens: 1, output_tokens: 1 } }
  ) {
    adapterMock.applySdkEvent.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "draft" }] }],
      turnComplete: true,
      result,
    })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
    })
    await flush()
    await flush()
  }

  it("records one successful turn outcome at the SDK result boundary", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", { provider: "anthropic", model: "sonnet" })
    })
    await driveTurnComplete()

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.completed",
      expect.objectContaining({
        sessionId: "sess-1",
        provider: "anthropic",
        surface: "chat",
      })
    )
    expect(
      mockTrackEvent.mock.calls.filter(([name]) => name === "chat.turn.completed")
    ).toHaveLength(1)
    expect(chatTurnPerformanceMock.markFirstResponse).toHaveBeenCalledWith("sess-1")
    expect(chatTurnPerformanceMock.beginFinalPersistence).toHaveBeenCalledWith("sess-1")
    expect(chatTurnPerformanceMock.endFinalPersistence).toHaveBeenCalledWith("sess-1")
    expect(chatTurnPerformanceMock.finish).toHaveBeenCalledWith("sess-1", "completed")
    expect(releaseSkillLoadContextMock).toHaveBeenCalledWith("sess-1")
  })

  it("passes the sealed assistant message id to long-term memory extraction", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("remember this")
    })
    await driveTurnComplete()

    expect(runTurnMemoryMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ assistantMessageId: "a1" })
    )
  })

  it("send pauses an active goal on a fresh user message", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal())
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("steer this way")
    })
    expect(goalRuntimeMock.pauseGoal).toHaveBeenCalledWith("g1")
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("send does NOT pause on a silent continuation (skipUserAppend)", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal())
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("keep going", undefined, { skipUserAppend: true })
    })
    expect(goalRuntimeMock.pauseGoal).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("send does NOT pause when there is no active goal", async () => {
    // default getActiveGoalForSession → undefined
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi")
    })
    expect(goalRuntimeMock.pauseGoal).not.toHaveBeenCalled()
  })

  it("send while streaming enqueues a steer entry preserving attachments", async () => {
    chatState.status = "streaming"
    const image = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
    }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    const webSearchContext = {
      provider: "tavily",
      results: [{ title: "Source", url: "https://example.com", content: "Result", score: 0.9 }],
    }
    await act(async () => {
      await result.current.send([image, { type: "text", text: "and this" }], undefined, {
        webSearchContext,
      })
    })
    expect(chatState.enqueueSteer).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ text: "and this", blocks: [image], webSearchContext })
    )
    // Busy-gate returns before dispatch — nothing reaches the sidecar.
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("shows a steer in the transcript immediately, in the user's own words", async () => {
    chatState.status = "streaming"
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("switch to TypeScript")
    })
    const appended = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      role: string
      parts: Array<{ type: string; text?: string }>
      metadata?: { steer?: { entryId: string; state: string } }
    }>
    const last = appended.at(-1)
    expect(last?.role).toBe("user")
    // The model-facing "By the way (steering): " framing is added only on the
    // replay payload — never on what the user reads back.
    expect(last?.parts[0]?.text).toBe("switch to TypeScript")
    expect(last?.metadata?.steer?.state).toBe("queued")
    // The bubble's entry id is what ties it to the queue entry.
    expect(last?.metadata?.steer?.entryId).toBe(
      (chatState.enqueueSteer.mock.calls.at(-1)?.[1] as { id: string }).id
    )
  })

  it("delivers a steer live through the Anthropic sidecar and skips the queue", async () => {
    chatState.status = "streaming"
    chatState.lastSendBySession["sess-1"] = {
      content: "original",
      options: {},
      attemptIndex: 0,
    }
    steerSessionMock.mockResolvedValue({ accepted: true })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    const webSearchContext = {
      provider: "brave",
      results: [{ title: "Docs", url: "https://docs.example.com", content: "Result", score: 0.8 }],
    }
    await act(async () => {
      await result.current.send("actually use Vitest", undefined, { webSearchContext })
    })
    expect(steerSessionMock).toHaveBeenCalledWith("sess-1", "actually use Vitest")
    // Accepted into the running query — nothing to replay later.
    expect(chatState.enqueueSteer).not.toHaveBeenCalled()
    const appended = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      metadata?: { steer?: { state: string } }
    }>
    expect(appended.at(-1)?.metadata?.steer?.state).toBe("accepted")
    expect(chatState.lastSendBySession["sess-1"]?.options.webSearchContext).toEqual(
      webSearchContext
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  // A new instruction while a tool ask is up supersedes the ask (Codex 0.154
  // parity): the waiter is denied through its own channel, the card is marked
  // `superseded`, and the steer still reaches the running turn.
  it("supersedes a pending approval when the user steers mid-ask", async () => {
    chatState.status = "awaiting_approval"
    chatState.pendingApprovals = [
      {
        sessionId: "sess-1",
        requestId: "req-pending",
        toolUseID: "tu-1",
        toolName: "Bash",
        input: { command: "rm -rf ./dist" },
        status: "pending",
      },
    ]
    steerSessionMock.mockResolvedValue({ accepted: true })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("actually don't delete anything")
    })
    expect(approveToolMock).toHaveBeenCalledWith(
      "sess-1",
      "req-pending",
      "deny",
      expect.stringContaining("superseded")
    )
    expect(chatState.markApprovalInterrupted).toHaveBeenCalledWith(
      "req-pending",
      "sess-1",
      "superseded"
    )
    // The instruction still steers the now-unblocked turn.
    expect(steerSessionMock).toHaveBeenCalledWith("sess-1", "actually don't delete anything")
  })

  it("re-arms the session's judge context on a mid-turn instruction", async () => {
    // Behavioural proof lives in command-judge.test.ts (epoch bump forces a
    // fresh verdict); this asserts the send path actually calls it.
    chatState.status = "streaming"
    steerSessionMock.mockResolvedValue({ accepted: true })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("change of plan")
    })
    expect(invalidateJudgeContextMock).toHaveBeenCalledWith("sess-1")
  })

  it("persists an attached HostState steer before accepting its optimistic bubble", async () => {
    chatState.status = "streaming"
    enqueueHostStateIntentMock.mockResolvedValueOnce({ id: "steer-action", status: "pending" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()

    await act(async () => {
      await result.current.send("change direction")
    })

    expect(enqueueHostStateIntentMock).toHaveBeenCalledWith({
      sessionId: "sess-1",
      action: { kind: "turn.steer", text: "change direction" },
    })
    expect(steerSessionMock).not.toHaveBeenCalled()
    expect(chatState.enqueueSteer).not.toHaveBeenCalled()
    const appended = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      metadata?: { steer?: { state: string } }
    }>
    expect(appended.at(-1)?.metadata?.steer?.state).toBe("accepted")
  })

  it("falls back to the queue when the live steer is refused", async () => {
    chatState.status = "streaming"
    steerSessionMock.mockRejectedValue(new Error("input_closed"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("and add tests")
    })
    expect(steerSessionMock).toHaveBeenCalled()
    expect(chatState.enqueueSteer).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ text: "and add tests" })
    )
  })

  // A steer cites what its chips/tokens named too — the bubble keeps
  // `metadata.mentions` for the backlink index and the queue entry carries
  // `citations` so a remote drain can rebuild the row's references.
  it("stamps a steer's citations on the bubble and the queue entry", async () => {
    chatState.status = "streaming"
    steerSessionMock.mockRejectedValue(new Error("input_closed"))
    const citations = [{ kind: "entity" as const, id: "issue:i1", label: "Broker race" }]
    const promptPreamble: import("@/lib/chat/prompt-preamble").PromptPreambleSummary = {
      sections: ["references"],
      references: [{ kind: "entity", entityKind: "issue", title: "Broker race" }],
    }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("follow up on this", undefined, {
        citations,
        promptPreamble,
      })
    })
    const appended = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      metadata?: { mentions?: unknown[]; promptPreamble?: unknown }
    }>
    expect(appended.at(-1)?.metadata?.mentions).toEqual(citations)
    expect(appended.at(-1)?.metadata?.promptPreamble).toEqual(promptPreamble)
    expect(chatState.enqueueSteer).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ citations, promptPreamble })
    )
  })

  it("stamps citations on a live-delivered steer too", async () => {
    chatState.status = "streaming"
    steerSessionMock.mockResolvedValue({ accepted: true })
    const citations = [{ kind: "entity" as const, id: "session:s9", label: "Sprint planning" }]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("check that thread", undefined, { citations })
    })
    expect(steerSessionMock).toHaveBeenCalledWith("sess-1", "check that thread")
    const appended = chatState.replaceSessionMessages.mock.calls.at(-1)?.[1] as Array<{
      metadata?: { mentions?: unknown[] }
    }>
    expect(appended.at(-1)?.metadata?.mentions).toEqual(citations)
  })

  // The shared transcript's local row is written by the sync projection of
  // the `message.created` event — the citations must ride the event payload or
  // no member, sender included, ever gets a backlink.
  it("publishes a shared-session send with its reference metadata on the event", async () => {
    chatState.activeSessionId = "sess-shared"
    chatState.openSessionIds = ["sess-shared"]
    getSessionMock.mockResolvedValue({
      id: "sess-shared",
      title: "Shared",
      model: "sonnet",
      collaboration: {
        orgId: "org_1",
        workspaceId: "ws_1",
        sessionId: "shared_1",
        policyRevision: 1,
        syncCursor: 0,
      },
    })
    const citations = [{ kind: "entity" as const, id: "session:s9", label: "Sprint planning" }]
    const promptPreamble: import("@/lib/chat/prompt-preamble").PromptPreambleSummary = {
      sections: ["references"],
      references: [{ kind: "entity", entityKind: "session", title: "Sprint planning" }],
    }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("see this thread", undefined, { citations, promptPreamble })
    })
    expect(sendSharedSessionMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sess-shared" }),
      expect.objectContaining({ metadata: { mentions: citations, promptPreamble } })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
    // A transcript reference going out over a shared link gets the once-per-
    // session heads-up — the snapshot publishes to members who may not be able
    // to open the source.
    expect(toastInfo).toHaveBeenCalledWith(
      "This message embeds a snapshot of another conversation — everyone here can read it."
    )
  })

  it("sends no reference metadata on a plain shared-session message", async () => {
    chatState.activeSessionId = "sess-shared-plain"
    chatState.openSessionIds = ["sess-shared-plain"]
    getSessionMock.mockResolvedValue({
      id: "sess-shared-plain",
      title: "Shared",
      model: "sonnet",
      collaboration: {
        orgId: "org_1",
        workspaceId: "ws_1",
        sessionId: "shared_2",
        policyRevision: 1,
        syncCursor: 0,
      },
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("nothing cited")
    })
    expect(sendSharedSessionMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sess-shared-plain" }),
      expect.not.objectContaining({ metadata: expect.anything() })
    )
  })

  it("tries the live lane while awaiting approval, which is when redirecting matters most", async () => {
    // The composer stays writable during approval on purpose. `routeSteer`
    // (sidecar/agent-host.mjs) does not gate on the permission round-trip: it
    // pushes into the session's streaming input and answers `input_closed` if
    // that input has actually gone. So there is a lane worth trying, and the
    // refusal path below is what handles the case where there is not.
    chatState.status = "awaiting_approval"
    steerSessionMock.mockResolvedValue({ accepted: true })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("don't use that tool")
    })
    expect(steerSessionMock).toHaveBeenCalledWith("sess-1", "don't use that tool")
    expect(chatState.enqueueSteer).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("still queues an approval-time steer the sidecar refuses", async () => {
    chatState.status = "awaiting_approval"
    steerSessionMock.mockRejectedValue(new Error("input_closed"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("don't use that tool")
    })
    expect(chatState.enqueueSteer).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ text: "don't use that tool" })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("ignores an empty steer instead of appending a blank bubble", async () => {
    chatState.status = "streaming"
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    chatState.replaceSessionMessages.mockClear()
    await act(async () => {
      await result.current.send("   ")
    })
    expect(chatState.enqueueSteer).not.toHaveBeenCalled()
    expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
  })

  it("flushSteer is a no-op when the queue is empty", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      result.current.flushSteer("sess-1")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("turnComplete + continue dispatches a silent continuation", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal())
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({ kind: "continue", userMessage: "go on" })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleTurnCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ goalId: "g1", capturedGenerationId: "gen1" })
    )
    // The continuation routes back through send → sendPrompt with the text.
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "go on", expect.any(Object))
    // Plugin bus: the SDK turn sealed → MESSAGE_RECEIVED + AGENT_COMPLETED.
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.MESSAGE_RECEIVED, { sessionId: "sess-1" })
    expect(busEmitMock).toHaveBeenCalledWith(BusEvents.AGENT_COMPLETED, { sessionId: "sess-1" })
  })

  it("turnComplete computes tokensDelta from result usage", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-tok" }))
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({ kind: "stale", reason: "x" })
    // Persistent (not Once): `recordResultUsage` consumes one call before the
    // goal block reads it, so both calls must see the same usage.
    adapterMock.extractUsage.mockReturnValue({ inputTokens: 10, outputTokens: 5 })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleTurnCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokensDelta: 15 })
    )
  })

  it("turnComplete + exit appends a system card and does not continue", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-exit" }))
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "judge_done",
      resultingStatus: "completed",
      reason: "objective satisfied",
    })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(chatState.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        parts: [expect.objectContaining({ text: expect.stringContaining("Goal completed") })],
      })
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("turnComplete with no judge client warns once and pauses", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-nojudge" }))
    buildGoalJudgeClientMock.mockReturnValue(null)
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleTurnCompleteMock).not.toHaveBeenCalled()
    expect(goalRuntimeMock.pauseGoal).toHaveBeenCalledWith("g-nojudge")
    expect(chatState.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [expect.objectContaining({ text: expect.stringContaining("no judge model") })],
      })
    )
  })

  it("turnComplete + stale outcome is a no-op (no card, no continuation)", async () => {
    goalRuntimeMock.getActiveGoalForSession.mockResolvedValue(activeGoal({ id: "g-stale" }))
    buildGoalJudgeClientMock.mockReturnValue({ complete: jest.fn() })
    handleTurnCompleteMock.mockResolvedValue({ kind: "stale", reason: "rotated" })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(chatState.appendMessage).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  // ── /loop wiring (self-paced) ──────────────────────────────────────────────

  it("send pauses an active self-paced loop on a fresh user message", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop())
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("steer this way")
    })
    expect(loopRuntimeMock.pauseLoop).toHaveBeenCalledWith("lp1")
  })

  it("send does NOT pause an interval loop (scheduler-driven)", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop({ mode: "interval" }))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("just chatting")
    })
    expect(loopRuntimeMock.pauseLoop).not.toHaveBeenCalled()
  })

  it("turnComplete drives the self-paced loop and dispatches the continuation", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop())
    handleLoopTurnCompleteMock.mockResolvedValue({
      kind: "continue",
      userMessage: "loop iteration 2",
      delayMs: 0,
    })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(handleLoopTurnCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ loopId: "lp1", capturedGenerationId: "lgen1" })
    )
    // gateLoopContinuation has no baseline (lastIterationAt undefined) → send.
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "loop iteration 2", expect.any(Object))
  })

  it("turnComplete + loop exit appends the loop card and stops", async () => {
    loopRuntimeMock.getActiveLoopForSession.mockResolvedValue(activeLoop({ id: "lp-exit" }))
    handleLoopTurnCompleteMock.mockResolvedValue({
      kind: "exit",
      exit: "completed",
      resultingStatus: "completed",
      reason: "report delivered",
    })
    renderHook(() => useClaudeChat())
    await flush()
    await driveTurnComplete()
    expect(chatState.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        parts: [expect.objectContaining({ text: expect.stringContaining("Loop completed") })],
      })
    )
  })

  it("the kickoff listener dispatches iteration 1 silently for the active session", async () => {
    let kickoff: ((loop: unknown) => void) | null = null
    loopRuntimeMock.onKickoff.mockImplementation((cb: (loop: unknown) => void) => {
      kickoff = cb
      return () => {}
    })
    renderHook(() => useClaudeChat())
    await flush()
    expect(kickoff).not.toBeNull()
    await act(async () => {
      kickoff?.(activeLoop({ safePrompt: "do the thing" }))
    })
    await flush()
    expect(sendPromptMock).toHaveBeenCalledWith(
      "sess-1",
      expect.stringContaining("[Loop iteration 1 of 100]"),
      expect.any(Object)
    )
  })

  it("the kickoff listener ignores loops for other sessions", async () => {
    let kickoff: ((loop: unknown) => void) | null = null
    loopRuntimeMock.onKickoff.mockImplementation((cb: (loop: unknown) => void) => {
      kickoff = cb
      return () => {}
    })
    renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      kickoff?.(activeLoop({ sessionId: "sess-other", safePrompt: "x" }))
    })
    await flush()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })
})

describe("useClaudeChat — agent-trace wiring (Phase B4)", () => {
  it("send() injects traceId + spanId into the SendOptions echoed to the sidecar", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(sendPromptMock).toHaveBeenCalled()
    const call = sendPromptMock.mock.calls.at(-1) as [string, unknown, Record<string, unknown>]
    const options = call[2]
    expect(typeof options.traceId).toBe("string")
    expect(typeof options.spanId).toBe("string")
    expect(String(options.traceId)).toMatch(/^[0-9a-f]{32}$/)
    expect(String(options.spanId)).toMatch(/^[0-9a-f]{16}$/)
    expect(options.traceparent).toBe(`00-${options.traceId}-${options.spanId}-01`)
  })

  it("setLastSend caches the trace identifiers so session_ended can finalise the span", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(chatState.setLastSend).toHaveBeenCalled()
    const lastCall = chatState.setLastSend.mock.calls.at(-1) as [
      string,
      { options: Record<string, unknown> },
    ]
    expect(typeof lastCall[1].options.spanId).toBe("string")
    expect(typeof lastCall[1].options.traceId).toBe("string")
  })

  it("caches composer web sources in finalized send options before dispatch", async () => {
    const webSearchContext = {
      provider: "tavily",
      results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
    }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", {
        provider: "anthropic",
        model: "sonnet",
        webSearchContext,
      })
    })

    const cached = chatState.setLastSend.mock.calls.at(-1)?.[1] as {
      options: { webSearchContext?: unknown }
    }
    expect(cached.options.webSearchContext).toEqual(webSearchContext)
    expect(chatState.setLastSend.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder.at(-1)!
    )
  })

  it("preserves a caller-provided spanId instead of generating a new one", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hi", {
        spanId: "1111222233334444",
        traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
      } as never)
    })
    const call = sendPromptMock.mock.calls.at(-1) as [string, unknown, Record<string, unknown>]
    expect(call[2].spanId).toBe("1111222233334444")
    expect(call[2].traceId).toBe("deadbeefdeadbeefdeadbeefdeadbeef")
    expect(call[2].traceparent).toBe("00-deadbeefdeadbeefdeadbeefdeadbeef-1111222233334444-01")
  })

  it("ends the span with errorType when send() throws before the sidecar gets the call", async () => {
    const { setAgentTraceWriter, __resetAgentTraceEmitterForTesting } =
      await import("@cognia/agent-trace/emitter")
    const captured: Array<Record<string, unknown>> = []
    __resetAgentTraceEmitterForTesting()
    setAgentTraceWriter((s) => {
      captured.push(s as unknown as Record<string, unknown>)
    })
    sendPromptMock.mockRejectedValueOnce(new Error("network down"))

    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("ping")
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].errorType).toBe("send_failed")
    expect(captured[0].errorMessage).toBe("network down")
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "chat.turn.failed",
      expect.objectContaining({
        sessionId: "sess-1",
        surface: "chat",
        errorType: "send_failed",
      })
    )
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("network down")
    setAgentTraceWriter(null)
  })
})

describe("useClaudeChat — concurrent sessions", () => {
  const adapterMock = jest.requireMock("@/lib/claude/adapter") as { applySdkEvent: jest.Mock }

  it("does not expose an idle turn until the unchanged final snapshot is durable", async () => {
    chatState.activeSessionId = "sess-1"
    chatState.openSessionIds = ["sess-1"]
    let releasePersist: (() => void) | undefined
    persistMessagesMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePersist = resolve
        })
    )
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    adapterMock.applySdkEvent.mockReturnValueOnce({
      messages: [],
      turnComplete: true,
    })

    act(() => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
    })
    await flush()

    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", [])
    expect(chatState.setSessionStatus).not.toHaveBeenCalledWith("sess-1", "idle")

    releasePersist?.()
    await flush()
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
  })

  it("routes streaming events to a background OPEN session's own slice, not the focused one", async () => {
    // Focus sess-other; sess-1 is open in another pane and mid-stream.
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other", "sess-1"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    adapterMock.applySdkEvent.mockReturnValueOnce({
      // turnComplete commits synchronously (mid-stream deltas are rAF-coalesced
      // and not deterministic under the macrotask-only test flush); the routing
      // code path (isOpen → replaceSessionMessages by id) is identical.
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "bg" }] }],
      turnComplete: true,
    })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
    })
    await flush()
    // The background session streams into its own slice; the focused session's
    // flat projection is never touched.
    expect(chatState.replaceSessionMessages).toHaveBeenCalledWith("sess-1", expect.any(Array))
    expect(chatState.otherSlices["sess-1"]?.messages).toHaveLength(1)
    expect(chatState.messages).toEqual([])
    // Its slice sealed to idle without disturbing the focused session.
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
  })

  it.each(["result", "session_ended"])(
    "settles a hidden retained session on %s without switching focus",
    async (terminal) => {
      chatState.activeSessionId = "sess-other"
      chatState.openSessionIds = ["sess-other"]
      chatState.otherSlices["sess-1"] = { ...makeSlice(), status: "streaming" }
      renderHook(useClaudeChat)
      await flush()
      const finalMessages = [
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
      ]
      if (terminal === "result")
        adapterMock.applySdkEvent.mockReturnValueOnce({
          messages: finalMessages,
          turnComplete: true,
        })
      else chatState.otherSlices["sess-1"].messages = finalMessages
      await act(async () =>
        _messageCallback?.(
          terminal === "result"
            ? { type: "event", sessionId: "sess-1", event: { type: "result" } }
            : { type: "session_ended", sessionId: "sess-1" }
        )
      )
      await flush()
      expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
      expect(chatState.activeSessionId).toBe("sess-other")
      expect(chatState.openSessionIds).toEqual(["sess-other"])
      expect(sendPromptMock).not.toHaveBeenCalled()
    }
  )

  it("does NOT touch the store for a closed (no-pane) session — only Dexie", async () => {
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other"] // sess-1 has no pane
    listMessagesMock.mockResolvedValue([])
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    adapterMock.applySdkEvent.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "bg" }] }],
      turnComplete: false,
    })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "delta" } })
    })
    await flush()
    expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
    expect(persistMessagesMock).toHaveBeenCalledWith("sess-1", expect.any(Array))
  })

  // ADR-0127 §1: a closed pane keeps an in-flight mirror like an open one, so
  // it reads Dexie once per turn (not per event) and its mid-stream writes go
  // through the debounced streaming writer; the turn seal writes canonically.
  it("closed-pane sessions read Dexie once per turn and seal with a canonical persist", async () => {
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other"]
    listMessagesMock.mockReset().mockResolvedValue([])
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    const first = [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "b" }] }]
    const second = [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "bg" }] }]
    adapterMock.applySdkEvent
      .mockReturnValueOnce({ messages: first, turnComplete: false })
      .mockReturnValueOnce({ messages: second, turnComplete: false })
      .mockReturnValueOnce({ messages: second, turnComplete: true })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "delta" } })
    })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "delta" } })
    })
    // Base for the second event came from the mirror, not another Dexie read.
    expect(listMessagesMock).toHaveBeenCalledTimes(1)
    expect(adapterMock.applySdkEvent.mock.calls[1]?.[0]).toBe(first)
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
    })
    await flush()
    expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
    // Turn seal: canonical persist for this session (last call carries the final list).
    const sealWrites = persistMessagesMock.mock.calls.filter((c) => c[0] === "sess-1")
    expect(sealWrites.length).toBeGreaterThan(0)
    // (run metadata such as `completedAt` is stamped on the seal.)
    expect(sealWrites.at(-1)![1]).toMatchObject(second)
    // Next turn starts from Dexie again (mirror dropped at the seal).
    adapterMock.applySdkEvent.mockReturnValueOnce({ messages: second, turnComplete: false })
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "delta" } })
    })
    expect(listMessagesMock).toHaveBeenCalledTimes(2)
  })

  it("feeds every SDK event to the SDK-native subagent bridge", async () => {
    chatState.activeSessionId = "sess-1"
    chatState.openSessionIds = ["sess-1"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    applySdkSubagentBridgeMock.mockClear()
    const event = {
      type: "system",
      subtype: "task_started",
      task_id: "T1",
      subagent_type: "researcher",
      description: "d",
      uuid: "u",
      session_id: "sdk",
    }
    await act(async () => {
      _messageCallback?.({ type: "event", sessionId: "sess-1", event })
    })
    await flush()
    expect(applySdkSubagentBridgeMock).toHaveBeenCalledWith(event, "sess-1")
  })

  it("skips the bridge block (incl. its getSession read) for stream_event token deltas", async () => {
    chatState.activeSessionId = "sess-1"
    chatState.openSessionIds = ["sess-1"]
    renderHook(() => useClaudeChat())
    await flush()
    subscribers.forEach((sub) => sub(chatState))
    applySdkSubagentBridgeMock.mockClear()
    getSessionMock.mockClear()
    adapterMock.applySdkEvent.mockReturnValueOnce({
      messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", text: "t" }] }],
      turnComplete: false,
    })
    await act(async () => {
      _messageCallback?.({
        type: "event",
        sessionId: "sess-1",
        event: {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "t" } },
        },
      })
    })
    await flush()
    // The per-token hot path must not pay a Dexie session read or feed the
    // (no-op for deltas) plan / subagent bridges.
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(applySdkSubagentBridgeMock).not.toHaveBeenCalled()
  })

  it("send() is blocked (no sidecar call) when the concurrency cap is reached", async () => {
    isAtCapacityMock.mockReturnValue(true)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("blocked")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(chatState.setSessionStatus).not.toHaveBeenCalledWith("sess-1", "streaming")
  })

  it("stop(sessionId) interrupts the given session, not just the focused one", async () => {
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other", "sess-1"]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.stop("sess-1")
    })
    expect(interruptSessionMock).toHaveBeenCalledWith("sess-1")
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
  })

  it("send(sessionId) targets the given session's slice", async () => {
    chatState.activeSessionId = "sess-other"
    chatState.openSessionIds = ["sess-other", "sess-1"]
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("to-bg", undefined, { sessionId: "sess-1" })
    })
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", expect.anything(), expect.anything())
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "streaming")
  })

  it("close() tears down the session's pane state in the store", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.close("sess-1")
    })
    expect(closeSessionIpcMock).toHaveBeenCalledWith("sess-1")
    expect(chatState.closeSession).toHaveBeenCalledWith("sess-1")
  })
})

describe("useClaudeChat — pre-turn editor flush", () => {
  it("flushes unsaved editor buffers before the turn reaches the sidecar", async () => {
    // The agent's file tools read the filesystem, so an editor buffer the user
    // edited but never saved is invisible to them: the turn would reason about
    // stale content and its write would clobber that work.
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(flushProjectEditorEdits).toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
    expect(flushProjectEditorEdits.mock.invocationCallOrder[0]).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder[0]
    )
  })

  it("stays quiet when everything flushed cleanly", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(toastWarning).not.toHaveBeenCalled()
  })

  it("warns about files it could not flush but still runs the turn", async () => {
    // The turn may not touch those files at all, so blocking would be wrong —
    // but for them disk is not what the user is looking at, and that must be said.
    flushProjectEditorEdits.mockResolvedValue(["/repo/a.ts", "/repo/b.ts"])
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(toastWarning).toHaveBeenCalledTimes(1)
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("does not flush for a send the guards reject", async () => {
    // Empty content never becomes a turn, so nothing should be saved for it.
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("   ")
    })

    expect(flushProjectEditorEdits).not.toHaveBeenCalled()
  })
})

describe("useClaudeChat — Squad dispatch", () => {
  function squadSession(extra: Record<string, unknown> = {}) {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "On a squad",
      model: "sonnet",
      squadId: "squad-1",
      ...extra,
    })
  }

  it("hands the turn to the Squad instead of running a model turn", async () => {
    squadSession()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("ship the thing")
    })

    expect(startSquadRunMock).toHaveBeenCalledTimes(1)
    expect(startSquadRunMock.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        squadId: "squad-1",
        goal: "ship the thing",
        origin: "chat",
        triggeredFrom: { source: "chat", sessionId: "sess-1" },
      })
    )
    // The whole point: no second, thinner executor runs alongside it.
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("keeps holding the session until the run settles", async () => {
    // Holding is what makes a follow-up queue as steering instead of starting
    // a second Squad over the top of the first.
    squadSession()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("go")
    })

    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "streaming")
    expect(chatState.setSessionStatus).not.toHaveBeenCalledWith("sess-1", "idle")
    expect(watchSquadRunSettlementMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionRunId: "execution:team:run_team_abc123def456" })
    )
  })

  it("releases the hold when the watcher reports the run is over", async () => {
    squadSession()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("go")
    })

    const onSettled = watchSquadRunSettlementMock.mock.calls[0]![0] as unknown as {
      onSettled: (status: string) => void
    }
    act(() => onSettled.onSettled("completed"))
    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
    expect(chatTurnPerformanceMock.finish).toHaveBeenCalledWith("sess-1", "completed")
  })

  it("leaves a record of the handoff in the conversation right away", async () => {
    // A Squad run takes minutes. A conversation that shows nothing until it
    // finishes reads as broken.
    squadSession()
    startSquadRunMock.mockResolvedValueOnce({
      started: true,
      runId: "run_team_abc123def456",
      squadName: "Research Squad",
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    chatState.replaceSessionMessages.mockClear()
    await act(async () => {
      await result.current.send("ship it")
    })

    const writes = chatState.replaceSessionMessages.mock.calls.filter(
      (c) =>
        c[0] === "sess-1" &&
        (c[1] as Array<{ parts?: Array<{ type?: string }> }>).some((m) =>
          m.parts?.some((part) => part.type === "squad-run")
        )
    )
    expect(writes.length).toBeGreaterThan(0)
    const messages = writes.at(-1)![1] as Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }>
    const part = messages.at(-1)!.parts[0]!
    expect(part).toEqual(
      expect.objectContaining({
        type: "squad-run",
        // The EXECUTION run id, which is what the journal and every control
        // verb are keyed by — not the raw lifecycle id.
        runId: "execution:team:run_team_abc123def456",
        squadId: "squad-1",
        squadName: "Research Squad",
        objective: "ship it",
      })
    )
  })

  it("falls back to the Squad id when the run could not name it", async () => {
    squadSession()
    startSquadRunMock.mockResolvedValueOnce({ started: true, runId: "run_team_abc123def456" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("go")
    })
    const write = chatState.replaceSessionMessages.mock.calls
      .map((c) => c[1] as Array<{ parts?: Array<Record<string, unknown>> }>)
      .reverse()
      .find((list) => list.some((m) => m.parts?.some((p) => p.type === "squad-run")))
    const part = write!.at(-1)!.parts!.find((p) => p.type === "squad-run")!
    expect(part.squadName).toBe("squad-1")
  })

  it("reports a failed dispatch instead of leaving the session held", async () => {
    squadSession()
    startSquadRunMock.mockResolvedValueOnce({ started: false, reason: "squad_not_found" })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("go")
    })

    expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "idle")
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ code: "squadNotFound" })
    )
    expect(watchSquadRunSettlementMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("runs an ordinary turn when the conversation has no Squad", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })

    expect(startSquadRunMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("lets one turn opt out of a bound Squad", async () => {
    // The override has to point down as well as up, or a Squad-bound
    // conversation could never send a single plain turn.
    squadSession()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", undefined, {
        compositionOverride: { presetId: "p1", orchestration: "direct" },
      })
    })

    expect(startSquadRunMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalled()
  })

  it("lets one turn point at a different Squad than the conversation", async () => {
    squadSession()
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello", undefined, {
        compositionOverride: {
          presetId: "p1",
          orchestration: "team",
          orchestrationRef: "squad-2",
        },
      })
    })

    expect(startSquadRunMock.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ squadId: "squad-2" })
    )
  })
})

describe("strict chat continuation dispatch", () => {
  it("rejects a failed sidecar dispatch after preserving the diagnostic", async () => {
    sendPromptMock.mockRejectedValueOnce(new Error("host offline"))
    const { result } = renderHook(useClaudeChat)
    await flush()
    await act(async () => {
      await expect(
        result.current.send("approved plan", undefined, {
          sessionId: "sess-1",
          skipUserAppend: true,
          throwOnError: true,
        })
      ).rejects.toThrow("host offline")
    })
    expect(chatState.setSessionDiagnostic).toHaveBeenCalled()
  })

  it.each(["", []])("rejects empty continuation content %j", async (content) => {
    const { result } = renderHook(useClaudeChat)
    await expect(result.current.send(content, undefined, { throwOnError: true })).rejects.toThrow(
      "empty_chat_turn"
    )
    expect(sendPromptMock).not.toHaveBeenCalled()
  })

  it("propagates the plugin refusal without dispatching", async () => {
    dispatchUserPromptSubmitMock.mockResolvedValueOnce({
      action: "block",
      reason: "blocked",
    } as never)
    const { result } = renderHook(useClaudeChat)
    await flush()
    await act(async () => {
      await expect(result.current.send("plan", undefined, { throwOnError: true })).rejects.toThrow(
        "blocked"
      )
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
  })
})

function activeLoop(over: Record<string, unknown> = {}) {
  return {
    id: "lp1",
    sessionId: "sess-1",
    mode: "self_paced",
    status: "active",
    generationId: "lgen1",
    config: {
      maxIterations: 100,
      maxTokens: 1_000_000,
      minDelayMs: 60_000,
      maxDelayMs: 3_600_000,
      maxParseFailures: 3,
    },
    iterations: 0,
    tokensUsed: 0,
    parseFailureCount: 0,
    ...over,
  }
}

describe("useClaudeChat — Router + Fusion dispatch (ADR-0188)", () => {
  const stamp = { runId: "rf-run-1", providerId: "openai", modelId: "gpt-5" } as NonNullable<
    SendOptions["routerFusion"]
  >
  const stamped: SendOptions = {
    provider: "openai",
    model: "gpt-5",
    routerFusion: stamp,
    ledger: {
      runId: "rf-run-1",
      mode: "per_call",
      transportAttempts: 2,
      deploymentId: "openai::gpt-5",
    },
  }

  it("[ACC:OFF-02] leaves an unstamped send on the original path, cost ceiling included", async () => {
    isCostBudgetConfiguredMock.mockReturnValue(true)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(prepareRouterFusionSendMock).not.toHaveBeenCalled()
    expect(enforceCostBudgetMock).toHaveBeenCalledTimes(1)
    expect(sendPromptMock).toHaveBeenCalled()
    expect(sendPromptMock.mock.calls.at(-1)?.[2]).not.toHaveProperty("routerFusion")
    expect(resolveSendOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ routerFusionSurface: "chat" })
    )
  })

  it("marks a turn a person typed as interactive", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(resolveSendOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ interactiveChat: true })
    )
  })

  it("does not mark a continuation re-send interactive: nobody typed it", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("next iteration", undefined, { skipUserAppend: true })
    })
    expect(resolveSendOptionsMock).toHaveBeenCalled()
    expect(resolveSendOptionsMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ interactiveChat: true })
    )
  })

  it("creates the run of a stamped turn after the early returns and before dispatch", async () => {
    isCostBudgetConfiguredMock.mockReturnValue(true)
    resolveSendOptionsMock.mockResolvedValue(stamped)
    const started = { ...stamped, routerFusion: { ...stamp, runId: "rf-run-2" } } as SendOptions
    prepareRouterFusionSendMock.mockResolvedValue({ kind: "send", options: started })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    // D35: the run holds the budget remainder, so the legacy ceiling is skipped.
    expect(enforceCostBudgetMock).not.toHaveBeenCalled()
    expect(prepareRouterFusionSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-1", reused: false })
    )
    const sent = sendPromptMock.mock.calls.at(-1)?.[2] as SendOptions
    expect(sent.routerFusion?.runId).toBe("rf-run-2")
    expect(prepareRouterFusionSendMock.mock.invocationCallOrder[0]).toBeLessThan(
      bindChatTurnContextMock.mock.invocationCallOrder.at(-1)!
    )
    expect(bindChatTurnContextMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sendPromptMock.mock.invocationCallOrder.at(-1)!
    )
    expect(abortRouterFusionSendMock).not.toHaveBeenCalled()
  })

  it("routes cached options again as a new run", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("retry", stamped)
    })
    expect(prepareRouterFusionSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reused: true,
        options: expect.objectContaining({ routerFusion: stamp }),
      })
    )
  })

  it("[ACC:ISO-04] does not dispatch a refused turn and shows the refusal", async () => {
    resolveSendOptionsMock.mockResolvedValue(stamped)
    prepareRouterFusionSendMock.mockResolvedValue({
      kind: "refused",
      code: "TENANT_BUDGET_EXHAUSTED",
      reasons: ["tenant"],
    } as never)
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(bindChatTurnContextMock).not.toHaveBeenCalled()
    expect(abortRouterFusionSendMock).not.toHaveBeenCalled()
    const diagnostic = chatState.setSessionDiagnostic.mock.calls.at(-1)?.[1] as {
      code: string
      detail?: string
    }
    expect(diagnostic.code).toBe("routerFusionRefused")
    expect(diagnostic.detail).toBe("TENANT_BUDGET_EXHAUSTED\ntenant")
    expect(settleChatTurnForSessionMock).toHaveBeenCalledWith("sess-1", {
      outcome: "failed",
      errorCode: "router_fusion_refused",
    })
  })

  it("[ACC:ISO-01] applies the cost ceiling when a faulted run sends the turn on the original path", async () => {
    isCostBudgetConfiguredMock.mockReturnValue(true)
    enforceCostBudgetMock.mockResolvedValue({ allowed: false, blockedBy: [{ scopeKey: "global" }] })
    resolveSendOptionsMock.mockResolvedValue(stamped)
    prepareRouterFusionSendMock.mockResolvedValue({
      kind: "send",
      options: {
        provider: "openai",
        model: "gpt-5",
        routerFusionBypass: { code: "db_unavailable", justTripped: false },
      },
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(enforceCostBudgetMock).toHaveBeenCalledTimes(1)
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(settleChatTurnForSessionMock).toHaveBeenCalledWith("sess-1", {
      outcome: "failed",
      errorCode: "cost_budget_exceeded",
    })
    expect(abortRouterFusionSendMock).not.toHaveBeenCalled()
  })

  it("sends a faulted turn unledgered when the ceiling allows it", async () => {
    resolveSendOptionsMock.mockResolvedValue(stamped)
    const bypassed: SendOptions = {
      provider: "openai",
      model: "gpt-5",
      routerFusionBypass: { code: "db_unavailable", justTripped: true },
    }
    prepareRouterFusionSendMock.mockResolvedValue({ kind: "send", options: bypassed })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    const sent = sendPromptMock.mock.calls.at(-1)?.[2] as SendOptions
    expect(sent.routerFusion).toBeUndefined()
    expect(sent.ledger).toBeUndefined()
    expect(sent.routerFusionBypass).toEqual({ code: "db_unavailable", justTripped: true })
  })

  it("releases the run when the dispatch itself fails", async () => {
    resolveSendOptionsMock.mockResolvedValue(stamped)
    sendPromptMock.mockRejectedValueOnce(new Error("ipc closed"))
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(abortRouterFusionSendMock).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({ routerFusion: stamp }),
      "ipc closed"
    )
    expect(settleChatTurnForSessionMock).toHaveBeenCalledWith("sess-1", {
      outcome: "failed",
      errorCode: "send_failed",
    })
  })

  it("stops granting model calls when the user stops the turn", async () => {
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.stop("sess-1")
    })
    expect(cancelRouterFusionTurnMock).toHaveBeenCalledWith("sess-1")
  })

  it("shows a build-time refusal as the refusal diagnostic, not a generic error", async () => {
    resolveSendOptionsMock.mockRejectedValue(
      new RouterFusionRefusalError("ROUTE_NO_SOLUTION", "no route satisfies the hard filters", {
        reasons: ["NO_CANDIDATES:alias:powerful"],
      })
    )
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await expect(result.current.send("hello")).rejects.toThrow(
        "no route satisfies the hard filters"
      )
    })
    expect(sendPromptMock).not.toHaveBeenCalled()
    const diagnostic = chatState.setSessionDiagnostic.mock.calls.at(-1)?.[1] as {
      code: string
      detail?: string
    }
    expect(diagnostic.code).toBe("routerFusionRefused")
    expect(diagnostic.detail).toBe("ROUTE_NO_SOLUTION\nNO_CANDIDATES:alias:powerful")
  })

  describe("a cascade or panel turn (B3)", () => {
    const runStamp = {
      runId: "rf-panel-1",
      decisionId: "d1",
      actionId: "panel_review",
      mode: "panel",
      ruleId: "R1_explicit_mode",
      requested: "panel",
      roles: { judge: "openai::gpt-5" },
      budgetMode: "tracked",
      capMicrousd: 2_000_000,
      acceptanceProfile: "evidence_review",
    } as NonNullable<SendOptions["routerFusionRun"]>
    const fusionOptions: SendOptions = {
      provider: "openai",
      model: "gpt-5",
      routerFusionRun: runStamp,
    }

    it("hands a stamped turn to the run instead of the sidecar", async () => {
      isCostBudgetConfiguredMock.mockReturnValue(true)
      resolveSendOptionsMock.mockResolvedValue(fusionOptions)
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("compare the two designs")
      })
      expect(runFusionChatTurnMock).toHaveBeenCalledTimes(1)
      const input = runFusionChatTurnMock.mock.calls[0]?.[0] as {
        sessionId: string
        stamp: unknown
        messages: Array<{ role: string }>
        userMessage: { role: string; parts: Array<{ text?: string }> } | null
      }
      expect(input.sessionId).toBe("sess-1")
      expect(input.stamp).toBe(runStamp)
      expect(input.userMessage?.parts[0]?.text).toBe("compare the two designs")
      expect(input.messages.at(-1)).toBe(input.userMessage)
      expect(chatState.setSessionStatus).toHaveBeenCalledWith("sess-1", "streaming")
      // None of the single-model-turn machinery runs for it.
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(prepareRouterFusionSendMock).not.toHaveBeenCalled()
      expect(enforceCostBudgetMock).not.toHaveBeenCalled()
      expect(acceptChatTurnMock).not.toHaveBeenCalled()
      expect(enqueueHostStateIntentMock).not.toHaveBeenCalled()
    })

    it("does not save the message again on a regenerate", async () => {
      resolveSendOptionsMock.mockResolvedValue(fusionOptions)
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("again", undefined, { skipUserAppend: true })
      })
      expect(
        (runFusionChatTurnMock.mock.calls[0]?.[0] as { userMessage: unknown }).userMessage
      ).toBeNull()
    })

    it("drains the steer queue when the run completes and keeps it when the run fails", async () => {
      resolveSendOptionsMock.mockResolvedValue(fusionOptions)
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("compare")
      })
      const { onSettled } = runFusionChatTurnMock.mock.calls[0]?.[0] as {
        onSettled: (result: string) => void
      }
      // The queue lives on the session's own slice; read it as a background one.
      chatState.activeSessionId = "elsewhere"
      try {
        const queuedBubble = {
          id: "steer-1",
          role: "user",
          parts: [{ type: "text", text: "next" }],
          metadata: { steer: { entryId: "q1", state: "queued" } },
        }
        chatState.otherSlices["sess-1"] = {
          ...makeSlice(),
          messages: [queuedBubble],
          steerQueue: [{ id: "q1", text: "next" }],
        }
        await act(async () => {
          onSettled("failed")
          await flush()
        })
        // A failed run keeps the queue and says the follow-up was not delivered.
        expect(chatState.clearSteerQueue).not.toHaveBeenCalled()
        const marked = chatState.otherSlices["sess-1"]?.messages as Array<{
          metadata?: { steer?: { state: string } }
        }>
        expect(marked[0]?.metadata?.steer?.state).toBe("failed")
        expect(mockTrackEvent).toHaveBeenCalledWith(
          "chat.turn.failed",
          expect.objectContaining({ sessionId: "sess-1", errorType: "router_fusion_run_failed" })
        )
        await act(async () => {
          onSettled("cancelled")
          await flush()
        })
        expect(chatState.clearSteerQueue).not.toHaveBeenCalled()
        await act(async () => {
          onSettled("completed")
          await flush()
        })
        expect(chatState.clearSteerQueue).toHaveBeenCalledWith("sess-1")
        // One turn, one outcome event: the first settle took the turn's start time.
        expect(
          mockTrackEvent.mock.calls.filter(([name]) => String(name).startsWith("chat.turn."))
        ).toHaveLength(1)
      } finally {
        chatState.activeSessionId = "sess-1"
      }
    })

    it("replays the queue when an interrupt-and-steer stop settles the run", async () => {
      resolveSendOptionsMock.mockResolvedValue(fusionOptions)
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("compare")
      })
      const { onSettled } = runFusionChatTurnMock.mock.calls[0]?.[0] as {
        onSettled: (result: string) => void
      }
      chatState.activeSessionId = "elsewhere"
      try {
        chatState.otherSlices["sess-1"] = {
          ...makeSlice(),
          steerQueue: [{ id: "q1", text: "next" }],
        }
        fusionChatTurnActiveMock.mockReturnValue(true)
        await act(async () => {
          await result.current.interruptAndSteer("sess-1")
        })
        expect(stopFusionChatTurnMock).toHaveBeenCalledWith("sess-1", expect.anything(), {
          settled: false,
        })
        // The stopped run settles as cancelled; the armed interrupt drains the queue.
        await act(async () => {
          onSettled("cancelled")
          await flush()
        })
        expect(chatState.clearSteerQueue).toHaveBeenCalledWith("sess-1")
        expect(mockTrackEvent).not.toHaveBeenCalledWith("chat.turn.failed", expect.anything())
      } finally {
        chatState.activeSessionId = "sess-1"
      }
    })

    it("queues a follow-up typed while the run works instead of steering it", async () => {
      chatState.status = "streaming"
      fusionChatTurnActiveMock.mockReturnValue(true)
      steerSessionMock.mockResolvedValue({ accepted: true })
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.send("also check the costs")
      })
      expect(steerSessionMock).not.toHaveBeenCalled()
      expect(enqueueHostStateIntentMock).not.toHaveBeenCalled()
      expect(chatState.enqueueSteer).toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({ text: "also check the costs" })
      )
      expect(runFusionChatTurnMock).not.toHaveBeenCalled()
    })

    it("stops the run on Stop, the session already settled", async () => {
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.stop("sess-1")
      })
      expect(stopFusionChatTurnMock).toHaveBeenCalledWith("sess-1", expect.anything(), {
        settled: true,
      })
    })

    it("stops the run for an interrupt-and-steer and lets its settle replay the queue", async () => {
      chatState.otherSlices["steer-sess"] = { ...makeSlice(), steerQueue: [{ id: "q1" }] }
      fusionChatTurnActiveMock.mockReturnValue(true)
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await result.current.interruptAndSteer("steer-sess")
      })
      expect(stopFusionChatTurnMock).toHaveBeenCalledWith("steer-sess", expect.anything(), {
        settled: false,
      })
      expect(interruptSessionMock).not.toHaveBeenCalled()
    })

    it("[ACC:ISO-03] explains an unavailable Router + Fusion for an explicit cascade or panel", async () => {
      resolveSendOptionsMock.mockRejectedValue(
        new RouterFusionUnavailableError(
          new RouterFusionInfrastructureError("breaker_tripped", "paused")
        )
      )
      const { result } = renderHook(() => useClaudeChat())
      await flush()
      await act(async () => {
        await expect(result.current.send("hello")).rejects.toThrow()
      })
      const diagnostic = chatState.setSessionDiagnostic.mock.calls.at(-1)?.[1] as {
        code: string
        detail?: string
      }
      expect(diagnostic.code).toBe("routerFusionRunFailed")
      expect(diagnostic.detail).toBe("ROUTER_FUSION_UNAVAILABLE\nbreaker_tripped")
      expect(runFusionChatTurnMock).not.toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
    })
  })

  it("stops granting model calls when a steer interrupts the running turn", async () => {
    chatState.otherSlices["steer-sess"] = { ...makeSlice(), steerQueue: [{ id: "q1" }] }
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.interruptAndSteer("steer-sess")
    })
    expect(interruptSessionMock).toHaveBeenCalledWith("steer-sess")
    expect(cancelRouterFusionTurnMock).toHaveBeenCalledWith("steer-sess")
  })

  it("stops granting model calls when the durable lease is lost", async () => {
    let leaseLost: (() => void) | undefined
    beginSharedSessionRunMock.mockResolvedValue({
      kind: "acquired",
      setApprovalDecisionHandler: jest.fn(),
      setLeaseLostHandler: (handler: () => void) => {
        leaseLost = handler
      },
    })
    const { result } = renderHook(() => useClaudeChat())
    await flush()
    await act(async () => {
      await result.current.send("hello")
    })
    expect(leaseLost).toBeDefined()
    await act(async () => {
      leaseLost?.()
      await flush()
    })
    expect(cancelRouterFusionTurnMock).toHaveBeenCalledWith("sess-1")
  })
})

describe("embedded runtime reachability", () => {
  it("projects existing subagents when a pane appears without a new runtime event", async () => {
    useSubagentRuntimeStore.setState({
      subAgents: {
        child: {
          id: "child",
          name: "Worker",
          parentAgentId: "aside",
          status: "completed",
          context: { sessionId: "aside" },
          result: { finalResponse: "done" },
          createdAt: new Date(),
        },
      },
    } as never)
    chatState.otherSlices.aside = {
      ...makeSlice(),
      messages: [{ id: "a", role: "assistant", parts: [] }],
    }
    renderHook(useClaudeChat)
    await flush()
    expect(chatState.replaceMessagesForSession).not.toHaveBeenCalledWith("aside", expect.anything())
    const previous = { ...chatState }
    chatState.paneIdsBySession = { aside: ["pane"] }
    act(() =>
      subscribers.forEach((subscriber) =>
        (subscriber as (state: ChatStateLike, previous: ChatStateLike) => void)(chatState, previous)
      )
    )
    expect(chatState.replaceMessagesForSession).toHaveBeenCalledWith(
      "aside",
      expect.arrayContaining([
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({ type: "subagent", subagentId: "child" }),
          ]),
        }),
      ])
    )
  })

  it("drains queued deliveries when an embedded pane becomes reachable", async () => {
    const { rerender } = renderHook(useClaudeChat)
    await flush()
    backgroundDrainMock.mockClear()
    peerDrainMock.mockClear()
    chatState.paneIdsBySession = { aside: ["pane"] }
    rerender()
    expect(backgroundDrainMock).toHaveBeenCalledWith("aside")
    expect(peerDrainMock).toHaveBeenCalledWith("aside")
  })

  it("starts an embedded loop on its bound session rather than the focused session", async () => {
    let kickoff: ((loop: unknown) => void) | null = null
    loopRuntimeMock.onKickoff.mockImplementationOnce((callback: (loop: unknown) => void) => {
      kickoff = callback
      return () => {}
    })
    chatState.paneIdsBySession = { aside: ["pane"] }
    chatState.otherSlices.aside = makeSlice()
    renderHook(useClaudeChat)
    await flush()
    await act(async () =>
      kickoff?.(activeLoop({ sessionId: "aside", safePrompt: "continue aside" }))
    )
    expect(sendPromptMock).toHaveBeenCalledWith(
      "aside",
      expect.stringContaining("continue aside"),
      expect.any(Object)
    )
    expect(chatState.activeSessionId).toBe("sess-1")
  })
})

describe("shared chat runtime", () => {
  it("does not race an IM responder even when capture releases before the event queue drains", async () => {
    renderHook(useSharedClaudeChat, { wrapper: ClaudeChatRuntimeProvider })
    await flush()
    const release = registerCaptureResponder("sess-1", "im-turn", true)
    act(() => {
      _messageCallback?.({
        type: "permission_request",
        sessionId: "sess-1",
        turnId: "im-turn",
        requestId: "im-ask",
        toolName: "Bash",
        input: { command: "pwd" },
      })
      release()
    })
    await flush()
    expect(approveToolMock).not.toHaveBeenCalled()
    expect(chatState.pushApproval).not.toHaveBeenCalled()
  })

  it("keeps the controller alive when a consumer unmounts", async () => {
    let hide: () => void = () => {}
    function Consumer() {
      useSharedClaudeChat()
      return null
    }
    function Wrapper({ children }: { children: ReactNode }) {
      const [visible, setVisible] = useState(true)
      hide = () => setVisible(false)
      return createElement(
        ClaudeChatRuntimeProvider,
        null,
        children,
        visible ? createElement(Consumer) : null
      )
    }
    const { unmount, result } = renderHook(useSharedClaudeChat, { wrapper: Wrapper })
    await flush()
    act(hide)
    expect(typeof result.current.send).toBe("function")
    expect(onClaudeMessageMock).toHaveBeenCalledTimes(1)
    expect(onClaudeUnsub).not.toHaveBeenCalled()
    unmount()
    expect(onClaudeUnsub).toHaveBeenCalledTimes(1)
  })

  it("rejects missing or nested runtime owners", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => renderHook(useSharedClaudeChat)).toThrow("requires ClaudeChatRuntimeProvider")
      expect(() =>
        renderHook(useSharedClaudeChat, {
          wrapper: ({ children }: { children: ReactNode }) =>
            createElement(
              ClaudeChatRuntimeProvider,
              null,
              createElement(ClaudeChatRuntimeProvider, null, children)
            ),
        })
      ).toThrow("must be mounted once")
    } finally {
      error.mockRestore()
    }
  })

  it("shares commands and one sidecar subscription across simultaneous surfaces", async () => {
    const { result } = renderHook(() => [useSharedClaudeChat(), useSharedClaudeChat()], {
      wrapper: ClaudeChatRuntimeProvider,
    })
    await flush()
    expect(onClaudeMessageMock).toHaveBeenCalledTimes(1)
    expect(result.current[0]).toBe(result.current[1])
  })
})

describe("attachment source persistence before dispatch", () => {
  it.each(["idle", "streaming"])(
    "rejects source persistence errors before sending in %s state",
    async (status) => {
      chatState.status = status as typeof chatState.status
      persistSessionAssetsMock.mockRejectedValueOnce(new Error("session_asset_quota_exceeded"))
      const { result } = renderHook(useClaudeChat)
      await flush()
      await act(async () => {
        await expect(
          result.current.send("attached source", undefined, { throwOnError: true })
        ).rejects.toThrow("session_asset_quota_exceeded")
      })
      expect(chatState.setSessionDiagnostic).toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(steerSessionMock).not.toHaveBeenCalled()
      expect(chatState.enqueueSteer).not.toHaveBeenCalled()
      expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    }
  )

  it("persists originals before publishing a shared document and sends only sanitized parts", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Shared",
      collaboration: {
        orgId: "o",
        workspaceId: "w",
        sessionId: "shared",
        policyRevision: 1,
        syncCursor: 0,
      },
    })
    const realMakeUserMessage = jest.requireActual("@/lib/claude/adapter").makeUserMessage
    const adapter = jest.requireMock("@/lib/claude/adapter") as { makeUserMessage: jest.Mock }
    adapter.makeUserMessage
      .mockImplementationOnce(realMakeUserMessage)
      .mockImplementationOnce(realMakeUserMessage)
    const original = new Blob(["document bytes"], { type: "application/pdf" })
    persistSessionAssetsMock.mockImplementationOnce(async (_sessionId, message) => ({
      ...message,
      parts: message.parts.map((part) => {
        const { attachmentOriginal: _original, ...safe } = part as unknown as Record<
          string,
          unknown
        >
        return safe as unknown as typeof part
      }),
    }))
    const { result } = renderHook(useClaudeChat)
    await flush()
    await act(async () => {
      await result.current.send(
        [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "ZG9j" },
          },
        ],
        undefined,
        {
          attachmentManifest: [
            { kind: "document", filename: "report.pdf", mediaType: "application/pdf", original },
          ],
        }
      )
    })
    expect(persistSessionAssetsMock.mock.calls[0]?.[1].parts[0]).toHaveProperty(
      "attachmentOriginal",
      original
    )
    const published = sendSharedSessionMessageMock.mock.calls.at(-1)?.[1] as { parts: unknown[] }
    expect(published.parts[0]).not.toHaveProperty("attachmentOriginal")
    expect(published.parts[0]).toHaveProperty("filename", "report.pdf")
    expect(persistSessionAssetsMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendSharedSessionMessageMock.mock.invocationCallOrder.at(-1)!
    )
  })

  it("refuses shared publishing when original persistence fails", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Shared",
      collaboration: {
        orgId: "o",
        workspaceId: "w",
        sessionId: "shared",
        policyRevision: 1,
        syncCursor: 0,
      },
    })
    persistSessionAssetsMock.mockRejectedValueOnce(new Error("source-disk-failed"))
    const { result } = renderHook(useClaudeChat)
    await flush()
    const before = sendSharedSessionMessageMock.mock.calls.length
    await act(async () => {
      await expect(
        result.current.send("source", undefined, { throwOnError: true })
      ).rejects.toThrow("source-disk-failed")
    })
    expect(sendSharedSessionMessageMock.mock.calls.length).toBe(before)
  })
})

it("queues attachment text as an attachment and preserves only the user request as steer prose", async () => {
  chatState.status = "streaming"
  steerSessionMock.mockRejectedValue(new Error("input_closed"))
  const original = new Blob(["report"])
  const descriptor = {
    filename: "report.txt",
    mediaType: "text/plain",
    kind: "document" as const,
    original,
  }
  const attachment = { type: "text" as const, text: "[Attachment source] extracted report" }
  const { result } = renderHook(useClaudeChat)
  await flush()
  await act(async () => {
    await result.current.send(
      [attachment, { type: "text", text: "compare this report" }],
      undefined,
      { attachmentManifest: [descriptor] }
    )
  })
  expect(chatState.enqueueSteer).toHaveBeenCalledWith(
    "sess-1",
    expect.objectContaining({
      text: "compare this report",
      blocks: [attachment],
      attachmentManifest: [{ filename: "report.txt", mediaType: "text/plain", kind: "document" }],
    })
  )
})

describe("useClaudeChat — @agent turn routing", () => {
  const CLAUDE: TurnRoute = {
    target: { kind: "runtime", runtime: "claude" },
    handle: "claude",
    label: "claude",
  }
  const CODEX: TurnRoute = {
    target: { kind: "runtime", runtime: "codex" },
    handle: "codex",
    label: "codex",
  }
  const CRITIC: TurnRoute = {
    target: { kind: "squadMember", squadId: "squad-r", teammateId: "tm-critic" },
    handle: "critic",
    label: "Critic",
  }
  const BUILTIN_ROW: AgentRuntimeDescriptor = {
    ref: { kind: "builtin" },
    key: "builtin",
    group: "builtin",
  }
  const CODEX_ROW: AgentRuntimeDescriptor = {
    ref: { kind: "external", agentId: "codex-1" },
    key: "external:codex-1",
    group: "external",
    name: "My Codex",
    presetId: "codex",
    brandId: "codex",
  }
  const reviewSquad = {
    id: "squad-r",
    name: "Review",
    config: {},
    teammateIds: ["tm-critic"],
  } as unknown as AgentTeam
  const critic: AgentTeammate = {
    id: "tm-critic",
    teamId: "squad-r",
    name: "Critic",
    description: "",
    role: "teammate",
    status: "idle",
    config: { systemPrompt: "You are the critic.", model: "critic-model" },
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(0),
  }

  /** A Codex configured and runnable, and one Squad with one member. */
  function routeContext(overrides: Partial<RouteContextSnapshot> = {}): RouteContextSnapshot {
    return {
      targets: buildRouteTargets({ squads: [{ team: reviewSquad, teammates: [critic] }] }),
      runtimes: [BUILTIN_ROW, CODEX_ROW],
      currentRef: { kind: "builtin" },
      teams: { [reviewSquad.id]: reviewSquad },
      teammates: { [critic.id]: critic },
      externalEnabled: true,
      configuredPresetIds: ["codex"],
      ...overrides,
    }
  }

  let busDiagnostics: CogniaDiagnostic[] = []
  let unsubscribeBus: () => void = () => {}
  beforeEach(() => {
    routeSnapshotMock.mockReset().mockImplementation(async () => routeContext())
    busDiagnostics = []
    unsubscribeBus = subscribeDiagnostic(({ diagnostic }) => busDiagnostics.push(diagnostic))
  })
  afterEach(() => {
    unsubscribeBus()
  })

  type Row = {
    id: string
    role: string
    parts: Array<{ type: string; text?: string }>
    metadata?: Record<string, unknown>
  }
  /** Every user row the send path put in the transcript. */
  function writtenUserRows(): Row[] {
    return chatState.replaceSessionMessages.mock.calls.flatMap(([, list]) =>
      (list as Row[]).filter((message) => message.role === "user")
    )
  }
  function routeRefusal(): { extra?: Record<string, unknown>; message?: string } | undefined {
    const call = chatState.setSessionDiagnostic.mock.calls.find(
      ([, diagnostic]) => (diagnostic as { code?: string } | null)?.code === "turnRouteUnavailable"
    )
    if (!call) return undefined
    const diagnostic = call[1] as { message?: string; meta?: { extra?: Record<string, unknown> } }
    return { extra: diagnostic.meta?.extra, message: diagnostic.message }
  }
  async function mount() {
    const hook = renderHook(() => useClaudeChat())
    await flush()
    // Only what the send itself writes counts below.
    chatState.replaceSessionMessages.mockClear()
    persistMessagesMock.mockClear()
    return hook
  }

  describe("refusal leaves no user row", () => {
    it.each([
      ["a team room", { kind: "team" }],
      ["an IM-bound conversation", { platformBinding: { platform: "lark", chatId: "c-1" } }],
      [
        "a shared transcript",
        {
          collaboration: {
            orgId: "o",
            workspaceId: "w",
            sessionId: "shared",
            policyRevision: 1,
            syncCursor: 0,
          },
        },
      ],
    ])("refuses an addressed turn in %s instead of running it unrouted", async (_label, extra) => {
      getSessionMock.mockResolvedValue({ id: "sess-1", title: "Not direct", ...extra })
      const { result } = await mount()
      await act(async () => {
        await expect(
          result.current.send("@claude hi", undefined, { turnRoute: CLAUDE, throwOnError: true })
        ).rejects.toThrow("turn_route_unavailable:unroutable-session")
      })
      expect(routeRefusal()?.extra).toEqual({ handle: "claude", reason: "unroutable-session" })
      expect(persistSessionAssetsMock).not.toHaveBeenCalled()
      expect(writtenUserRows()).toEqual([])
      expect(sendSharedSessionMessageMock).not.toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(startSquadRunMock).not.toHaveBeenCalled()
    })

    it.each([
      [
        "no Codex is configured",
        routeContext({ runtimes: [BUILTIN_ROW], configuredPresetIds: [] }),
        { reason: "not-configured", detail: "" },
      ],
      [
        "the only Codex is blocked",
        routeContext({ runtimes: [BUILTIN_ROW, { ...CODEX_ROW, blockedReason: "codex missing" }] }),
        { reason: "blocked", detail: "codex missing" },
      ],
    ])(
      "refuses @codex when %s, and never answers it on the builtin lane",
      async (_l, ctx, want) => {
        routeSnapshotMock.mockResolvedValue(ctx)
        const { result } = await mount()
        await act(async () => {
          await expect(
            result.current.send("@codex fix it", undefined, {
              turnRoute: CODEX,
              throwOnError: true,
            })
          ).rejects.toThrow(`turn_route_unavailable:${want.reason}`)
        })
        expect(routeRefusal()).toEqual({
          extra: { handle: "codex", reason: want.reason },
          message: want.detail,
        })
        // Re-resolved against THIS conversation at commit time.
        expect(routeSnapshotMock).toHaveBeenCalledWith("sess-1", expect.anything())
        expect(writtenUserRows()).toEqual([])
        expect(persistSessionAssetsMock).not.toHaveBeenCalled()
        expect(resolveSendOptionsMock).not.toHaveBeenCalled()
        expect(sendPromptMock).not.toHaveBeenCalled()
        expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
      }
    )

    it("refuses @codex when the turn's tool surface is none, rather than answering on builtin", async () => {
      // A deny-all tool surface quietly keeps an UNADDRESSED turn builtin; an
      // addressed one asked for Codex and is refused instead.
      resolveSendOptionsMock.mockResolvedValue({ model: "sonnet", toolSurface: "none" })
      const { result } = await mount()
      await act(async () => {
        await result.current.send("@codex fix it", undefined, { turnRoute: CODEX })
      })
      expect(routeRefusal()?.extra).toEqual({ handle: "codex", reason: "no-tool-surface" })
      expect(writtenUserRows()).toEqual([])
      expect(persistSessionAssetsMock).not.toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(ensureExternalAgentReadyMock).not.toHaveBeenCalled()
      expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    })
  })

  it.each([
    ["streaming", "streaming", false],
    ["waiting on an approval", "awaiting_approval", false],
    ["holding a queued turn", "idle", true],
  ])(
    "refuses an addressed turn while the session is %s, never demoting it to a steer",
    async (_label, status, queued) => {
      chatState.status = status
      isChatTurnQueuedMock.mockReturnValue(queued)
      const { result } = await mount()
      await act(async () => {
        await expect(
          result.current.send("@codex also this", undefined, {
            turnRoute: CODEX,
            throwOnError: true,
          })
        ).rejects.toThrow("turn_route_while_busy")
      })
      expect(busDiagnostics).toEqual([
        expect.objectContaining({
          code: "turnRouteWhileBusy",
          meta: expect.objectContaining({ sessionId: "sess-1", extra: { handle: "codex" } }),
        }),
      ])
      // On the bus, not the session: the running turn keeps its status.
      expect(chatState.setSessionDiagnostic).not.toHaveBeenCalled()
      expect(persistSessionAssetsMock).not.toHaveBeenCalled()
      expect(writtenUserRows()).toEqual([])
      expect(steerSessionMock).not.toHaveBeenCalled()
      expect(chatState.enqueueSteer).not.toHaveBeenCalled()
      expect(enqueueHostStateIntentMock).not.toHaveBeenCalled()
      expect(routeSnapshotMock).not.toHaveBeenCalled()
    }
  )

  it("runs @claude from an external-lane conversation on the builtin lane, and leaves the lane alone", async () => {
    useAgentRuntimeStore.setState({ runtimeRef: { kind: "external", agentId: "ext-1" } })
    executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "external" })
    const { result } = await mount()
    await act(async () => {
      await result.current.send("@claude explain", undefined, { turnRoute: CLAUDE })
    })
    // The options were built for the ROUTED lane, not the session's...
    const ctx = (resolveSendOptionsMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(ctx).not.toHaveProperty("externalRuntimeId")
    // ...and the dispatch took that same lane.
    expect(ensureExternalAgentReadyMock).not.toHaveBeenCalled()
    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "explain", expect.any(Object))
    // The reply is sealed as the builtin engine's answer to `@claude`.
    expect((chatState.lastSendBySession["sess-1"] as { routeStamp?: unknown }).routeStamp).toEqual({
      handle: "claude",
      label: "Claude",
      runtimeKind: "builtin",
      brandId: "anthropic",
    })
    // One turn: the conversation is still on its own lane.
    expect(useAgentRuntimeStore.getState().runtimeRef).toEqual({
      kind: "external",
      agentId: "ext-1",
    })
  })

  it("strips the handle from what the runtime reads, keeps it in the transcript, and stamps the route", async () => {
    const { result } = await mount()
    await act(async () => {
      await result.current.send("@claude explain this", undefined, { turnRoute: CLAUDE })
    })
    expect(sendPromptMock.mock.calls[0]![1]).toBe("explain this")
    expect(resolveSendOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        routingContextHint: expect.objectContaining({ promptText: "explain this" }),
      })
    )
    const row = writtenUserRows().at(-1)!
    expect(row.parts[0]!.text).toBe("@claude explain this")
    expect(row.metadata?.turnRoute).toEqual(CLAUDE)
  })

  it("strips the handle from the typed text, not from an attachment ahead of it", async () => {
    // An extracted document is a text block too; a route may not edit it.
    const attachment = { type: "text" as const, text: "@claude appears in this file" }
    const { result } = await mount()
    await act(async () => {
      await result.current.send(
        [attachment, { type: "text", text: "@claude summarize" }],
        undefined,
        {
          turnRoute: CLAUDE,
          attachmentManifest: [
            { filename: "notes.txt", mediaType: "text/plain", kind: "document" as const },
          ],
        }
      )
    })
    expect(sendPromptMock.mock.calls[0]![1]).toEqual([
      attachment,
      { type: "text", text: "summarize" },
    ])
  })

  describe("the external lane's prompt with an attached file", () => {
    const REPORT = "Q3 revenue grew 12% on the back of the new pricing tier."
    const manifest = [
      { filename: "report.pdf", mediaType: "application/pdf", kind: "document" as const },
    ]

    it("sends @codex the question the user typed, behind the extracted document, not the document alone", async () => {
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
      const { result } = await mount()
      await act(async () => {
        await result.current.send(
          [
            { type: "text", text: REPORT },
            { type: "text", text: "@codex what drove the growth?" },
          ],
          undefined,
          { turnRoute: CODEX, attachmentManifest: manifest }
        )
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
      const [prompt, options] = executeOnExternalAgentMock.mock.calls[0] as [string, object]
      // The typed question is what the agent is asked; the file is its material.
      expect(prompt).toBe(`${REPORT}\n\nwhat drove the growth?`)
      expect(options).toMatchObject({ agentId: "codex-1" })
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(writtenUserRows().at(-1)!.metadata?.turnRoute).toEqual(CODEX)
    })

    it("sends @codex exactly the typed text when nothing is attached", async () => {
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
      const { result } = await mount()
      await act(async () => {
        await result.current.send("@codex what drove the growth?", undefined, {
          turnRoute: CODEX,
        })
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
        "what drove the growth?",
        expect.objectContaining({ agentId: "codex-1" })
      )
    })
  })

  describe("an attached file's text is never read as the question", () => {
    // `buildSendContent` puts an extracted document (or an image's OCR) ahead
    // of the typed text as a text block of its own; the manifest counts them.
    const REPORT = "Q3 revenue grew 12% on the back of the new pricing tier."
    const QUESTION = "what drove the growth?"
    const manifest = [
      { filename: "report.pdf", mediaType: "application/pdf", kind: "document" as const },
    ]
    const withReport = (typed: string) => [
      { type: "text" as const, text: REPORT },
      { type: "text" as const, text: typed },
    ]
    function routingPromptText(): unknown {
      const ctx = (resolveSendOptionsMock.mock.calls[0] as unknown[])[0] as {
        routingContextHint?: { promptText?: unknown }
      }
      return ctx.routingContextHint?.promptText
    }

    it("keys routing and recall off the typed question", async () => {
      const { result } = await mount()
      await act(async () => {
        await result.current.send(withReport(QUESTION), undefined, {
          attachmentManifest: manifest,
        })
      })
      expect(routingPromptText()).toBe(QUESTION)
    })

    it("strips an addressed turn's handle from the question, not from the file", async () => {
      const { result } = await mount()
      await act(async () => {
        await result.current.send(withReport(`@claude ${QUESTION}`), undefined, {
          turnRoute: CLAUDE,
          attachmentManifest: manifest,
        })
      })
      expect(routingPromptText()).toBe(QUESTION)
    })

    it("gives a turn with nothing typed no question rather than the file", async () => {
      const { result } = await mount()
      await act(async () => {
        await result.current.send([{ type: "text", text: REPORT }], undefined, {
          attachmentManifest: manifest,
        })
      })
      expect(resolveSendOptionsMock).toHaveBeenCalledTimes(1)
      expect(routingPromptText()).toBeUndefined()
    })

    it("re-reads an edit's handle past the files it resends, and resends them as files", async () => {
      chatState.messages = [
        {
          id: "u-1",
          role: "user",
          parts: [
            { type: "file", filename: "report.pdf", mediaType: "application/pdf", text: REPORT },
            { type: "text", text: "summarize it" },
          ],
        },
        {
          id: "a-1",
          role: "assistant",
          parts: [{ type: "text", text: "summary" }],
          metadata: { run: { providerId: "anthropic" } },
        },
      ]
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
      const { result } = await mount()
      await act(async () => {
        await result.current.editAndResend(
          "u-1",
          withReport(`@codex ${QUESTION}`),
          "sess-1",
          undefined,
          manifest
        )
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
        `${REPORT}\n\n${QUESTION}`,
        expect.objectContaining({ agentId: "codex-1" })
      )
      expect(sendPromptMock).not.toHaveBeenCalled()
      const replacement = writtenUserRows()
        .filter((row) => row.id !== "u-1")
        .at(-1)
      expect(replacement?.metadata?.turnRoute).toEqual(
        expect.objectContaining({ target: { kind: "runtime", runtime: "codex" }, handle: "codex" })
      )
      // The manifest reaches the row builder, which makes the file a card again
      // rather than showing its text as what the user typed.
      const { makeUserMessage } = jest.requireMock("@/lib/claude/adapter") as {
        makeUserMessage: jest.Mock
      }
      expect(makeUserMessage).toHaveBeenCalledWith(
        withReport(`@codex ${QUESTION}`),
        expect.any(String),
        manifest
      )
    })

    it("hands a Squad the whole turn and names the question on its card", async () => {
      getSessionMock.mockResolvedValue({
        id: "sess-1",
        title: "On a squad",
        model: "sonnet",
        squadId: "squad-1",
      })
      const { result } = await mount()
      await act(async () => {
        await result.current.send(withReport(QUESTION), undefined, {
          attachmentManifest: manifest,
        })
      })
      // The goal is all the Squad gets: without the file it has nothing to
      // work from, without the question nothing to do.
      expect(startSquadRunMock.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ squadId: "squad-1", goal: `${REPORT}\n\n${QUESTION}` })
      )
      const card = chatState.replaceSessionMessages.mock.calls
        .flatMap(([, list]) => list as Array<{ parts?: Array<Record<string, unknown>> }>)
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === "squad-run")
      expect(card?.objective).toBe(QUESTION)
    })

    it("briefs the independent verifier with the question, without the file", async () => {
      const { result } = await mount()
      await act(async () => {
        await result.current.send(withReport(QUESTION), undefined, {
          attachmentManifest: manifest,
          compositionOverride: { presetId: "p1", orchestration: "verified-fresh-agent" },
        })
      })
      await flush()
      expect(armVerifiedFreshAgentFollowupMock).toHaveBeenCalledTimes(1)
      expect(armVerifiedFreshAgentFollowupMock.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ sessionId: "sess-1", request: QUESTION })
      )
    })

    it("records the question as the run's user input and the trace's input preview", async () => {
      const directChatRun = jest.requireMock("@/lib/execution/direct-chat-run") as {
        startDirectChatExecutionRun: jest.Mock
      }
      const { setAgentTraceWriter, __resetAgentTraceEmitterForTesting } =
        await import("@cognia/agent-trace/emitter")
      const spans: Array<Record<string, unknown>> = []
      __resetAgentTraceEmitterForTesting()
      setAgentTraceWriter((span) => {
        spans.push(span as unknown as Record<string, unknown>)
      })
      try {
        // A failed dispatch ends the turn's span, which is when the writer sees it.
        sendPromptMock.mockRejectedValueOnce(new Error("offline"))
        const { result } = await mount()
        await act(async () => {
          await result.current.send(withReport(QUESTION), undefined, {
            attachmentManifest: manifest,
          })
        })
        expect(directChatRun.startDirectChatExecutionRun).toHaveBeenCalledWith(
          expect.objectContaining({ prompt: QUESTION })
        )
        expect(spans).toHaveLength(1)
        expect(spans[0]!.inputPreview).toBe(QUESTION)
      } finally {
        setAgentTraceWriter(null)
      }
    })

    /** The row `makeUserMessage` leaves for an extracted document. */
    const reportPart = {
      type: "file",
      filename: "report.pdf",
      mediaType: "application/pdf",
      text: REPORT,
    }
    const reply = {
      id: "a-1",
      role: "assistant",
      parts: [{ type: "text", text: "summary" }],
      metadata: { run: { providerId: "anthropic" } },
    }

    it("resends an edited message's files with the edited text", async () => {
      chatState.messages = [
        { id: "u-1", role: "user", parts: [reportPart, { type: "text", text: "summarize it" }] },
        reply,
      ]
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
      const { result } = await mount()
      await act(async () => {
        // Every edit surface hands over the typed text alone.
        await result.current.editAndResend("u-1", `@codex ${QUESTION}`, "sess-1")
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
        `${REPORT}\n\n${QUESTION}`,
        expect.objectContaining({ agentId: "codex-1" })
      )
      const { makeUserMessage } = jest.requireMock("@/lib/claude/adapter") as {
        makeUserMessage: jest.Mock
      }
      expect(makeUserMessage).toHaveBeenCalledWith(
        withReport(`@codex ${QUESTION}`),
        expect.any(String),
        [expect.objectContaining({ filename: "report.pdf", kind: "document" })]
      )
      expect(toastWarning).not.toHaveBeenCalled()
    })

    it("names a file an edit cannot resend instead of dropping it silently", async () => {
      const native = {
        videoAttachment: {
          groupId: "g-1",
          filename: "clip.mp4",
          sourceMediaType: "video/mp4",
          kind: "video",
          durationSec: 4,
          width: 640,
          height: 360,
          delivery: "native",
          strategy: "uniform",
          range: null,
          frameTimes: [],
          engine: "browser",
        },
      }
      chatState.messages = [
        {
          id: "u-1",
          role: "user",
          parts: [
            { type: "file", mediaType: "text/plain", text: "A cat jumps.", ...native },
            { type: "text", text: "what happens?" },
          ],
        },
        reply,
      ]
      const { result } = await mount()
      await act(async () => {
        await result.current.editAndResend("u-1", "what happens next?", "sess-1")
      })
      expect(toastWarning).toHaveBeenCalledWith(
        "clip.mp4 couldn't be sent again and was left out. Attach it again to include it."
      )
      expect(sendPromptMock).toHaveBeenCalledWith(
        "sess-1",
        "what happens next?",
        expect.any(Object)
      )
    })

    it("regenerates a turn sent before a reload with its files, from its row", async () => {
      chatState.messages = [
        {
          id: "u-1",
          role: "user",
          parts: [reportPart, { type: "text", text: `@codex ${QUESTION}` }],
          metadata: { turnRoute: CODEX },
        },
        { ...reply, metadata: { run: { providerId: "external" } } },
      ]
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "again" })
      const { result } = await mount()
      await act(async () => {
        await result.current.regenerate("sess-1")
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
        `${REPORT}\n\n${QUESTION}`,
        expect.objectContaining({ agentId: "codex-1" })
      )
    })

    it("regenerates the turn it just sent with that turn's manifest", async () => {
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
      const { result } = await mount()
      await act(async () => {
        await result.current.send(withReport(`@codex ${QUESTION}`), undefined, {
          turnRoute: CODEX,
          attachmentManifest: manifest,
        })
      })
      await act(async () => {
        await result.current.regenerate("sess-1")
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(2)
      expect(executeOnExternalAgentMock.mock.calls[1]![0]).toBe(`${REPORT}\n\n${QUESTION}`)
    })

    it("tells the user what an external agent's text-only prompt left out", async () => {
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
      const shot = { filename: "shot.png", mediaType: "image/png", kind: "image" as const }
      const { result } = await mount()
      await act(async () => {
        await result.current.send(
          [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
            { type: "text", text: "OCR words" },
            { type: "text", text: `@codex ${QUESTION}` },
            { type: "text", text: "[Link] https://example.com: page text" },
          ],
          undefined,
          { turnRoute: CODEX, attachmentManifest: [shot, shot] }
        )
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
        `OCR words\n\n${QUESTION}`,
        expect.objectContaining({ agentId: "codex-1" })
      )
      expect(toastWarning).toHaveBeenCalledWith(
        "External agents receive text only, so the images or video in shot.png weren't sent. " +
          "Any text extracted from it was. A fetched page wasn't sent: external agents " +
          "receive only your message and the text of attached files."
      )
    })

    describe("a Squad's text-only goal", () => {
      const shot = { filename: "shot.png", mediaType: "image/png", kind: "image" as const }
      const turn: SendContentBlock[] = [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
        { type: "text", text: "OCR words" },
        { type: "text", text: QUESTION },
        { type: "text", text: "[Link] https://example.com: page text" },
      ]
      beforeEach(() => {
        getSessionMock.mockResolvedValue({
          id: "sess-1",
          title: "On a squad",
          model: "sonnet",
          squadId: "squad-1",
        })
      })

      it("tells the user what the goal left out once the Squad takes the run", async () => {
        const { result } = await mount()
        await act(async () => {
          await result.current.send(turn, undefined, { attachmentManifest: [shot, shot] })
        })
        expect(startSquadRunMock.mock.calls[0]![0]).toEqual(
          expect.objectContaining({ goal: `OCR words\n\n${QUESTION}` })
        )
        expect(toastWarning).toHaveBeenCalledWith(
          "A Squad's goal is text only, so the images or video in shot.png weren't handed to it. " +
            "Any text extracted from it was. A fetched page wasn't handed to the Squad: its goal " +
            "holds only your message and the text of attached files."
        )
      })

      it("says nothing for a run that already existed, whose goal the turn did not set", async () => {
        startSquadRunMock.mockResolvedValueOnce({
          started: true,
          runId: "run_team_abc123def456",
          duplicate: true,
        })
        const { result } = await mount()
        await act(async () => {
          await result.current.send(turn, undefined, { attachmentManifest: [shot, shot] })
        })
        expect(startSquadRunMock).toHaveBeenCalledTimes(1)
        expect(toastWarning).not.toHaveBeenCalled()
      })

      it("says nothing when the goal carried the whole turn", async () => {
        const { result } = await mount()
        await act(async () => {
          await result.current.send(withReport(QUESTION), undefined, {
            attachmentManifest: manifest,
          })
        })
        expect(startSquadRunMock).toHaveBeenCalledTimes(1)
        expect(toastWarning).not.toHaveBeenCalled()
      })
    })

    it("says nothing when an external agent's prompt carried the whole turn", async () => {
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "ok" })
      const { result } = await mount()
      await act(async () => {
        await result.current.send(withReport(`@codex ${QUESTION}`), undefined, {
          turnRoute: CODEX,
          attachmentManifest: manifest,
        })
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
      expect(toastWarning).not.toHaveBeenCalled()
    })

    it("hands the builtin lane Codex's replies in front of the files, not inside one", async () => {
      chatState.messages = [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "first question" }] },
        { ...reply, parts: [{ type: "text", text: "builtin reply" }] },
        {
          id: "u-2",
          role: "user",
          parts: [{ type: "text", text: "@codex second question" }],
          metadata: { turnRoute: CODEX },
        },
        {
          id: "a-2",
          role: "assistant",
          parts: [{ type: "text", text: "codex reply" }],
          metadata: { run: { providerId: "external" } },
        },
      ]
      const { result } = await mount()
      await act(async () => {
        await result.current.send(withReport(QUESTION), undefined, {
          attachmentManifest: manifest,
        })
      })
      const sent = sendPromptMock.mock.calls[0]![1] as Array<{ type: string; text: string }>
      expect(sent).toHaveLength(3)
      expect(sent[0]!.text).toContain("codex reply")
      expect(sent[0]!.text.endsWith("Current user request:")).toBe(true)
      expect(sent.slice(1)).toEqual(withReport(QUESTION))
    })
  })

  it("keeps an addressed turn off the host queue, which would record it without its handle", async () => {
    // The host writes the intent's text as the user row: the `@claude` chip and
    // `metadata.turnRoute` would be gone, and a regenerate would forget the route.
    enqueueHostStateIntentMock.mockResolvedValue(true)
    const { result } = await mount()
    await act(async () => {
      await result.current.send("@claude hi", undefined, { turnRoute: CLAUDE })
    })
    expect(enqueueHostStateIntentMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "hi", expect.any(Object))
    expect(writtenUserRows().at(-1)!.metadata?.turnRoute).toEqual(CLAUDE)
  })

  it("hands the builtin lane what Codex answered since it last spoke, without recording it as typed", async () => {
    chatState.messages = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "first question" }] },
      {
        id: "a-1",
        role: "assistant",
        parts: [{ type: "text", text: "builtin reply" }],
        metadata: { run: { providerId: "anthropic" } },
      },
      {
        id: "u-2",
        role: "user",
        parts: [{ type: "text", text: "@codex second question" }],
        metadata: { turnRoute: CODEX },
      },
      {
        id: "a-2",
        role: "assistant",
        parts: [{ type: "text", text: "codex reply" }],
        metadata: { run: { providerId: "external" } },
      },
    ]
    // Available, and still not taken: the host would persist the handoff as
    // the user's own message.
    enqueueHostStateIntentMock.mockResolvedValue(true)
    const { result } = await mount()
    await act(async () => {
      await result.current.send("third question")
    })
    expect(enqueueHostStateIntentMock).not.toHaveBeenCalled()
    const sent = sendPromptMock.mock.calls[0]![1] as string
    expect(sent).toContain("codex reply")
    expect(sent).not.toContain("builtin reply")
    expect(sent.endsWith("Current user request:\nthird question")).toBe(true)
    expect(writtenUserRows().at(-1)!.parts[0]!.text).toBe("third question")
  })

  it("never re-runs a failed @codex turn on the builtin lane", async () => {
    // Every fallback the send path has is armed: a matching delegation rule
    // and the "fallback" failure policy. None of them may touch this turn.
    useExternalAgentStore.setState({ chatFailurePolicy: "fallback" })
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    executeOnExternalAgentMock.mockResolvedValue({ success: false, error: "codex crashed" })
    const { result } = await mount()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("@codex fix it", undefined, { turnRoute: CODEX })
    })
    expect(ensureExternalAgentReadyMock).toHaveBeenCalledWith("codex-1", expect.anything())
    expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
    expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
      "fix it",
      expect.objectContaining({ agentId: "codex-1" })
    )
    expect(checkDelegationMock).not.toHaveBeenCalled()
    expect(sendPromptMock).not.toHaveBeenCalled()
    expect(busDiagnostics.map((d) => d.code)).not.toContain("fallbackToBuiltin")
    expect(chatState.setSessionDiagnostic).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        source: "external-agent",
        meta: expect.objectContaining({ agentId: "codex-1" }),
      })
    )
    const sealed = (chatState.lastSendBySession["sess-1"] ?? {}) as { routeStamp?: unknown }
    expect(sealed.routeStamp).toBeUndefined()
  })

  it("runs an addressed turn in a Squad-bound conversation as one direct turn, undelegated", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "On a squad",
      model: "sonnet",
      squadId: "squad-1",
    })
    getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
    checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
    const { result } = await mount()
    subscribers.forEach((sub) => sub(chatState))
    await act(async () => {
      await result.current.send("@claude quick question", undefined, { turnRoute: CLAUDE })
    })
    expect(startSquadRunMock).not.toHaveBeenCalled()
    expect(checkDelegationMock).not.toHaveBeenCalled()
    expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "quick question", expect.any(Object))
  })

  it("answers a member route as that member, with the member's model for the turn", async () => {
    getSessionMock.mockResolvedValue({
      id: "sess-1",
      title: "Direct",
      model: "sonnet",
      providerOverride: "anthropic",
      systemPrompt: "The conversation's own prompt.",
    })
    const { result } = await mount()
    await act(async () => {
      await result.current.send("@critic review this", undefined, { turnRoute: CRITIC })
    })
    const ctx = (resolveSendOptionsMock.mock.calls[0] as unknown[])[0] as {
      character: Record<string, unknown>
      session: Record<string, unknown>
      memberOverride?: unknown
    }
    expect(ctx.character).toEqual(
      expect.objectContaining({
        id: "__teammate__:tm-critic",
        name: "Critic",
        systemPrompt: "You are the critic.",
        model: "critic-model",
      })
    )
    // The persona replaces the conversation's prompt, and its model wins.
    expect(ctx.session.systemPrompt).toBeUndefined()
    expect(ctx.session.model).toBeUndefined()
    expect(ctx.session.providerOverride).toBeUndefined()
    expect(ctx.memberOverride).toEqual({
      characterId: "__teammate__:tm-critic",
      modelOverride: "critic-model",
    })
    expect(sendPromptMock).toHaveBeenCalledWith("sess-1", "review this", expect.any(Object))
    expect((chatState.lastSendBySession["sess-1"] as { routeStamp?: unknown }).routeStamp).toEqual(
      expect.objectContaining({
        handle: "critic",
        label: "Critic",
        runtimeKind: "builtin",
        teammateId: "tm-critic",
        squadId: "squad-r",
      })
    )
  })

  describe("regenerate", () => {
    const routedThread = () => [
      {
        id: "u-1",
        role: "user",
        parts: [{ type: "text", text: "@codex fix it" }],
        metadata: { turnRoute: CODEX },
      },
      {
        id: "a-1",
        role: "assistant",
        parts: [{ type: "text", text: "old answer" }],
        metadata: { run: { providerId: "external" } },
      },
    ]

    it("re-runs an addressed turn where it was addressed, not on the conversation's lane", async () => {
      chatState.messages = routedThread()
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "new answer" })
      const { result } = await mount()
      await act(async () => {
        await result.current.regenerate("sess-1")
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
        "fix it",
        expect.objectContaining({ agentId: "codex-1" })
      )
      expect(sendPromptMock).not.toHaveBeenCalled()
    })

    it("refuses a route that can no longer run before touching the thread", async () => {
      chatState.messages = routedThread()
      routeSnapshotMock.mockResolvedValue(
        routeContext({ runtimes: [BUILTIN_ROW], configuredPresetIds: [] })
      )
      const { result } = await mount()
      await act(async () => {
        await result.current.regenerate("sess-1")
      })
      expect(routeRefusal()?.extra).toEqual({ handle: "codex", reason: "not-configured" })
      // The reply is not re-parented into a branch group nobody fills.
      expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
      expect(persistMessagesMock).not.toHaveBeenCalled()
      expect(chatState.messages).toEqual(routedThread())
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    })

    // A branch tag armed for a turn that never runs is consumed by whichever
    // assistant message lands next — the NEXT turn's reply, filed as a
    // sibling of the old answer and hiding it.
    describe("any refusal leaves no branch bookkeeping behind", () => {
      const plainThread = () => [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      ]
      /** Lands one SDK frame that appends assistant `id` to the session. */
      async function landReply(id: string): Promise<Row | undefined> {
        const adapterMock = jest.requireMock("@/lib/claude/adapter") as {
          applySdkEvent: jest.Mock
        }
        adapterMock.applySdkEvent.mockReturnValueOnce({
          messages: [
            ...(chatState.messages as Row[]),
            { id, role: "assistant", parts: [{ type: "text", text: id }] },
          ],
          turnComplete: true,
        })
        await act(async () => {
          _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
        })
        await flush()
        return chatState.replaceSessionMessages.mock.calls
          .map(([, list]) => (list as Row[]).find((message) => message.id === id))
          .findLast((message) => message !== undefined)
      }

      it("stamps the reply of a regenerate that runs into the anchor's group", async () => {
        // The control for the refusals below: the same frame, after a
        // regenerate that was not refused, IS filed as the next sibling.
        chatState.messages = plainThread()
        const { result } = await mount()
        await act(async () => {
          await result.current.regenerate("sess-1")
        })
        expect(sendPromptMock).toHaveBeenCalledTimes(1)
        const reply = await landReply("a-2")
        expect(reply?.metadata).toMatchObject({ branchGroupId: "u-1", branchIndex: 1 })
        expect(chatState.setSessionActiveBranch).toHaveBeenCalledWith("sess-1", "u-1", "a-2")
      })

      it.each([
        [
          "a plugin prompt guard blocks it",
          () => {
            dispatchUserPromptSubmitMock.mockResolvedValueOnce({
              action: "block",
              reason: "policy violation",
            } as never)
          },
        ],
        [
          "the concurrent-stream cap is reached",
          () => {
            isAtCapacityMock.mockReturnValue(true)
          },
        ],
      ])("a regenerate refused because %s", async (_label, refuse) => {
        chatState.messages = plainThread()
        const { result } = await mount()
        refuse()
        await act(async () => {
          await result.current.regenerate("sess-1")
        })
        expect(sendPromptMock).not.toHaveBeenCalled()
        // The thread is exactly as it was: the reply was never re-parented.
        expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
        expect(persistMessagesMock).not.toHaveBeenCalled()
        expect(chatState.messages).toEqual(plainThread())

        // Nothing is armed: a frame landing now is not filed into the group…
        const late = await landReply("a-late")
        expect(late).toBeDefined()
        expect(late?.metadata?.branchGroupId).toBeUndefined()

        // …and neither is the reply of the next ordinary turn.
        isAtCapacityMock.mockReturnValue(false)
        await act(async () => {
          await result.current.send("next question", undefined, { sessionId: "sess-1" })
        })
        expect(sendPromptMock).toHaveBeenCalledTimes(1)
        const reply = await landReply("a-next")
        expect(reply).toBeDefined()
        expect(reply?.metadata?.branchGroupId).toBeUndefined()
        expect(reply?.metadata?.branchIndex).toBeUndefined()
        expect(chatState.setSessionActiveBranch).not.toHaveBeenCalled()
        expect(chatState.activeBranchByGroup).toEqual({})
      })

      it("refuses a regenerate whose turn stopped being the last one while its gates ran", async () => {
        chatState.messages = plainThread()
        const follow = { id: "u-2", role: "user", parts: [{ type: "text", text: "and another" }] }
        dispatchUserPromptSubmitMock.mockImplementationOnce(async () => {
          // Another surface lands a turn before the regenerate would tag.
          chatState.messages = [...plainThread(), follow]
          return { action: "proceed" as const }
        })
        const { result } = await mount()
        await act(async () => {
          await result.current.regenerate("sess-1")
        })
        expect(sendPromptMock).not.toHaveBeenCalled()
        // Tagging now would have dropped the new turn and answered the old one.
        expect(persistMessagesMock).not.toHaveBeenCalled()
        expect(chatState.messages).toEqual([...plainThread(), follow])
        const late = await landReply("a-late")
        expect(late).toBeDefined()
        expect(late?.metadata?.branchGroupId).toBeUndefined()
      })

      it("disarms the tag of a regenerate refused after it started", async () => {
        chatState.messages = plainThread()
        sendPromptMock.mockRejectedValueOnce(new Error("sidecar unavailable"))
        const { result } = await mount()
        await act(async () => {
          await result.current.regenerate("sess-1")
        })
        expect(sendPromptMock).toHaveBeenCalledTimes(1)
        // No `session_ended` follows a dispatch that never reached the host,
        // so nothing else would ever drop the tag.
        const late = await landReply("a-late")
        expect(late).toBeDefined()
        expect(late?.metadata?.branchGroupId).toBeUndefined()
        expect(chatState.setSessionActiveBranch).not.toHaveBeenCalled()
      })

      it("returns the navigator to the original when a refused edit never lands", async () => {
        chatState.messages = plainThread()
        persistSessionAssetsMock.mockRejectedValueOnce(new Error("disk full"))
        const { result } = await mount()
        await act(async () => {
          await result.current.editAndResend("u-1", "hello again", "sess-1")
        })
        expect(sendPromptMock).not.toHaveBeenCalled()
        // The pick made for the replacement is undone: it names a row that is
        // not in the transcript.
        expect(chatState.setSessionActiveBranch).toHaveBeenCalledWith("sess-1", "edit::u-1", "u1")
        expect(chatState.activeBranchByGroup).toEqual({})
        expect((chatState.messages as Row[]).some((message) => message.id === "u1")).toBe(false)
      })

      it("keeps a failed edit selected but drops its owner stamp", async () => {
        chatState.messages = plainThread()
        sendPromptMock.mockRejectedValueOnce(new Error("sidecar unavailable"))
        const { result } = await mount()
        await act(async () => {
          await result.current.editAndResend("u-1", "hello again", "sess-1")
        })
        // The edited question stays in the transcript and on screen, so the
        // failure it carries — and its retry — is what the user sees.
        expect((chatState.messages as Row[]).some((message) => message.id === "u1")).toBe(true)
        expect(chatState.activeBranchByGroup).toEqual({ "edit::u-1": "u1" })
        // A frame landing later is not filed under a turn that never ran.
        const late = await landReply("a-late")
        expect(late).toBeDefined()
        expect(late?.metadata?.branchOwnerId).toBeUndefined()
      })
    })

    // The external lane and a Squad handoff write their reply themselves, so
    // no `handleEvent` frame is there to consume what the send armed. Left
    // armed, the old reply sat alone in its group — both answers on screen and
    // no navigator — and the slot waited for whatever landed next.
    describe("a reply the send writes itself takes the armed slot", () => {
      /** Lands one SDK frame that appends assistant `id` to the session. */
      async function landReply(id: string): Promise<Row | undefined> {
        const adapterMock = jest.requireMock("@/lib/claude/adapter") as {
          applySdkEvent: jest.Mock
        }
        adapterMock.applySdkEvent.mockReturnValueOnce({
          messages: [
            ...(chatState.messages as Row[]),
            { id, role: "assistant", parts: [{ type: "text", text: id }] },
          ],
          turnComplete: true,
        })
        await act(async () => {
          _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
        })
        await flush()
        return (chatState.messages as Row[]).find((message) => message.id === id)
      }
      const replies = (): Row[] =>
        (chatState.messages as Row[]).filter((message) => message.role === "assistant")

      it("files an external regenerate's reply as the anchor's next sibling, and selects it", async () => {
        chatState.messages = routedThread()
        executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "new answer" })
        const { result } = await mount()
        await act(async () => {
          await result.current.regenerate("sess-1")
        })
        expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
        expect(sendPromptMock).not.toHaveBeenCalled()
        const [old, reply] = replies()
        expect(old?.metadata).toMatchObject({ branchGroupId: "u-1", branchIndex: 0 })
        expect(reply?.parts).toEqual([expect.objectContaining({ text: "new answer" })])
        expect(reply?.metadata).toMatchObject({
          branchGroupId: "u-1",
          branchIndex: 1,
          run: expect.objectContaining({ providerId: "external" }),
        })
        expect(chatState.setSessionActiveBranch).toHaveBeenCalledWith("sess-1", "u-1", reply?.id)
        expect(chatState.activeBranchByGroup).toEqual({ "u-1": reply?.id })
        // Dexie holds the same thread: the stamp survives a reload.
        const persisted = persistMessagesMock.mock.calls.at(-1)?.[1] as Row[]
        expect(persisted.find((message) => message.id === reply?.id)?.metadata).toMatchObject({
          branchGroupId: "u-1",
          branchIndex: 1,
        })

        // The slot is spent: a frame landing now is not filed into the group…
        const late = await landReply("a-late")
        expect(late).toBeDefined()
        expect(late?.metadata?.branchGroupId).toBeUndefined()

        // …and neither is the reply of the next ordinary turn.
        await act(async () => {
          await result.current.send("next question", undefined, { sessionId: "sess-1" })
        })
        expect(sendPromptMock).toHaveBeenCalledTimes(1)
        const next = await landReply("a-next")
        expect(next).toBeDefined()
        expect(next?.metadata?.branchGroupId).toBeUndefined()
        expect(next?.metadata?.branchIndex).toBeUndefined()
        expect(chatState.setSessionActiveBranch).toHaveBeenCalledTimes(1)
        expect(chatState.activeBranchByGroup).toEqual({ "u-1": reply?.id })
      })

      it("drops the slot of an external regenerate that ends without a reply", async () => {
        chatState.messages = routedThread()
        executeOnExternalAgentMock.mockResolvedValue({ success: false, error: "codex crashed" })
        const { result } = await mount()
        await act(async () => {
          await result.current.regenerate("sess-1")
        })
        expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
        expect(replies().map((message) => message.id)).toEqual(["a-1"])
        expect(chatState.setSessionActiveBranch).not.toHaveBeenCalled()
        // This lane produces no `session_ended`, so nothing else would drop it.
        const late = await landReply("a-late")
        expect(late).toBeDefined()
        expect(late?.metadata?.branchGroupId).toBeUndefined()
        expect(chatState.setSessionActiveBranch).not.toHaveBeenCalled()
      })

      it("files an external edit's reply under the replacement question", async () => {
        chatState.messages = routedThread()
        executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "edited" })
        const { result } = await mount()
        await act(async () => {
          await result.current.editAndResend("u-1", "@codex fix it properly", "sess-1")
        })
        expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
        // `makeUserMessage` is mocked to id "u1": the replacement variant.
        const reply = replies().find((message) => message.id !== "a-1")
        expect(reply?.parts).toEqual([expect.objectContaining({ text: "edited" })])
        expect(reply?.metadata).toMatchObject({ branchOwnerId: "u1" })
        expect(reply?.metadata?.branchGroupId).toBeUndefined()
        // The owner entry is spent with the turn.
        const late = await landReply("a-late")
        expect(late).toBeDefined()
        expect(late?.metadata?.branchOwnerId).toBeUndefined()
      })

      it("files a Squad regenerate's handoff card as the anchor's next sibling, and selects it", async () => {
        getSessionMock.mockResolvedValue({
          id: "sess-1",
          title: "On a squad",
          model: "sonnet",
          squadId: "squad-1",
        })
        chatState.messages = [
          { id: "u-1", role: "user", parts: [{ type: "text", text: "ship it" }] },
          {
            id: "a-1",
            role: "assistant",
            parts: [{ type: "squad-run", runId: "execution:team:run_old", squadId: "squad-1" }],
          },
        ]
        const { result } = await mount()
        await act(async () => {
          await result.current.regenerate("sess-1")
        })
        expect(startSquadRunMock).toHaveBeenCalledTimes(1)
        expect(sendPromptMock).not.toHaveBeenCalled()
        const [old, card] = replies()
        expect(old?.metadata).toMatchObject({ branchGroupId: "u-1", branchIndex: 0 })
        expect(card?.parts[0]?.type).toBe("squad-run")
        expect(card?.metadata).toMatchObject({ branchGroupId: "u-1", branchIndex: 1 })
        expect(chatState.activeBranchByGroup).toEqual({ "u-1": card?.id })

        // The run settles; the next ordinary Squad turn's card is its own.
        const { onSettled } = watchSquadRunSettlementMock.mock.calls[0]![0] as unknown as {
          onSettled: (status: string) => void
        }
        act(() => onSettled("completed"))
        await act(async () => {
          await result.current.send("ship the next thing", undefined, { sessionId: "sess-1" })
        })
        expect(startSquadRunMock).toHaveBeenCalledTimes(2)
        const nextCard = replies().at(-1)
        expect(nextCard?.id).not.toBe(card?.id)
        expect(nextCard?.metadata).toBeUndefined()
        expect(chatState.activeBranchByGroup).toEqual({ "u-1": card?.id })
      })

      // A Router + Fusion run (ADR-0188 B3) writes its verified answer itself
      // too: `runFusionChatTurn` claims the slot through the send's
      // `claimReplyBranch` and settles through `onSettled`.
      describe("a cascade or panel run", () => {
        const runId = "rf-panel-1"
        const answerId = `rf-${runId}-answer`
        const fusionOptions: SendOptions = {
          provider: "openai",
          model: "gpt-5",
          routerFusionRun: {
            runId,
            decisionId: "d1",
            actionId: "panel_review",
            mode: "panel",
            ruleId: "R1_explicit_mode",
            requested: "panel",
            roles: { judge: "openai::gpt-5" },
            budgetMode: "tracked",
            capMicrousd: 2_000_000,
            acceptanceProfile: "evidence_review",
          } as NonNullable<SendOptions["routerFusionRun"]>,
        }
        const plainThread = () => [
          { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
          { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
        ]
        type FusionInput = {
          sessionId: string
          claimReplyBranch?: (replyId: string) => Record<string, unknown>
          onSettled?: (result: string) => void
        }
        /** Plays the run's side of the contract, after the send has returned. */
        function runSettles(outcome: "answer" | "failed") {
          runFusionChatTurnMock.mockImplementationOnce(async (arg: unknown) => {
            const input = arg as FusionInput
            await new Promise((resolve) => setTimeout(resolve, 0))
            if (outcome === "answer") {
              const branch = input.claimReplyBranch?.(answerId) ?? {}
              chatState.replaceSessionMessages(input.sessionId, [
                ...(chatState.sessions[input.sessionId]?.messages ?? []),
                {
                  id: answerId,
                  role: "assistant",
                  parts: [{ type: "text", text: "verified" }],
                  metadata: { routerFusion: { runId, mode: "panel", origin: "chat" }, ...branch },
                },
              ])
            }
            chatState.setSessionStatus(input.sessionId, "idle")
            input.onSettled?.(outcome === "answer" ? "completed" : "failed")
            return outcome === "answer" ? "completed" : "failed"
          })
        }

        beforeEach(() => {
          resolveSendOptionsMock.mockResolvedValue(fusionOptions)
        })

        it("files a regenerate's verified answer as the anchor's next sibling, and selects it", async () => {
          chatState.messages = plainThread()
          runSettles("answer")
          const { result } = await mount()
          await act(async () => {
            await result.current.regenerate("sess-1")
          })
          await flush()
          expect(runFusionChatTurnMock).toHaveBeenCalledTimes(1)
          expect(sendPromptMock).not.toHaveBeenCalled()
          const [old, reply] = replies()
          expect(old?.metadata).toMatchObject({ branchGroupId: "u-1", branchIndex: 0 })
          expect(reply?.id).toBe(answerId)
          expect(reply?.metadata).toMatchObject({
            branchGroupId: "u-1",
            branchIndex: 1,
            routerFusion: expect.objectContaining({ runId }),
          })
          expect(chatState.setSessionActiveBranch).toHaveBeenCalledWith("sess-1", "u-1", answerId)
          expect(chatState.activeBranchByGroup).toEqual({ "u-1": answerId })

          // The slot is spent: a frame landing now is not filed into the group.
          const late = await landReply("a-late")
          expect(late).toBeDefined()
          expect(late?.metadata?.branchGroupId).toBeUndefined()
          expect(chatState.setSessionActiveBranch).toHaveBeenCalledTimes(1)
        })

        it("drops the slot of a regenerate whose run ends without an answer", async () => {
          chatState.messages = plainThread()
          runSettles("failed")
          const { result } = await mount()
          await act(async () => {
            await result.current.regenerate("sess-1")
          })
          await flush()
          expect(runFusionChatTurnMock).toHaveBeenCalledTimes(1)
          expect(replies().map((message) => message.id)).toEqual(["a-1"])
          expect(chatState.setSessionActiveBranch).not.toHaveBeenCalled()
          // This lane produces no `session_ended`, so nothing else would drop it.
          const late = await landReply("a-late")
          expect(late).toBeDefined()
          expect(late?.metadata?.branchGroupId).toBeUndefined()
          expect(chatState.setSessionActiveBranch).not.toHaveBeenCalled()
        })

        it("files an edit's verified answer under the replacement question", async () => {
          chatState.messages = plainThread()
          runSettles("answer")
          const { result } = await mount()
          await act(async () => {
            await result.current.editAndResend("u-1", "hello again", "sess-1")
          })
          await flush()
          expect(runFusionChatTurnMock).toHaveBeenCalledTimes(1)
          // `makeUserMessage` is mocked to id "u1": the replacement variant.
          const reply = replies().find((message) => message.id === answerId)
          expect(reply?.metadata).toMatchObject({ branchOwnerId: "u1" })
          expect(reply?.metadata?.branchGroupId).toBeUndefined()
          // The edit stays selected, and its owner entry is spent with the turn.
          expect(chatState.activeBranchByGroup).toEqual({ "edit::u-1": "u1" })
          const late = await landReply("a-late")
          expect(late).toBeDefined()
          expect(late?.metadata?.branchOwnerId).toBeUndefined()
        })

        it("drops an edit's owner when its run ends without an answer, keeping the edit selected", async () => {
          chatState.messages = plainThread()
          runSettles("failed")
          const { result } = await mount()
          await act(async () => {
            await result.current.editAndResend("u-1", "hello again", "sess-1")
          })
          await flush()
          expect(runFusionChatTurnMock).toHaveBeenCalledTimes(1)
          expect(chatState.activeBranchByGroup).toEqual({ "edit::u-1": "u1" })
          const late = await landReply("a-late")
          expect(late).toBeDefined()
          expect(late?.metadata?.branchOwnerId).toBeUndefined()
        })
      })
    })
  })

  describe("mixed-runtime handoff through the PII gate", () => {
    // Over the handoff budget (24k), so the unseen turns must be summarized —
    // and the summary request is refused: the material carries an address.
    const piiReply = `${"codex output line\n".repeat(1_800)}reach me at someone@example.com`
    const cleanReply = "codex output line\n".repeat(1_800)
    const thread = (reply: string, lane: "external" | "anthropic") => [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "first" }] },
      {
        id: "a-1",
        role: "assistant",
        parts: [{ type: "text", text: "short" }],
        metadata: { run: { providerId: lane === "external" ? "anthropic" : "external" } },
      },
      { id: "u-2", role: "user", parts: [{ type: "text", text: "second" }] },
      {
        id: "a-2",
        role: "assistant",
        parts: [{ type: "text", text: reply }],
        metadata: { run: { providerId: lane } },
      },
    ]

    it("fails a builtin turn whose handoff summary is PII-refused, instead of sending the excerpt", async () => {
      chatState.messages = thread(piiReply, "external")
      const { result } = await mount()
      await act(async () => {
        await expect(
          result.current.send("@claude continue", undefined, {
            turnRoute: CLAUDE,
            throwOnError: true,
          })
        ).rejects.toThrow("handoff_context_summary_unavailable:pii")
      })
      expect(JSON.stringify(chatState.setSessionDiagnostic.mock.calls)).toContain(
        "handoff_context_summary_unavailable:pii"
      )
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(enqueueHostStateIntentMock).not.toHaveBeenCalled()
      expect(writtenUserRows()).toEqual([])
    })

    it("still hands the builtin lane the marked excerpt when only no model can summarize", async () => {
      chatState.messages = thread(cleanReply, "external")
      const { result } = await mount()
      await act(async () => {
        await result.current.send("@claude continue", undefined, { turnRoute: CLAUDE })
      })
      const sent = sendPromptMock.mock.calls[0]![1] as string
      // The head/tail projection, with its explicit notice of what it left out.
      expect(sent).toContain("History omitted to fit context")
      expect(sent).toContain("second")
      expect(sent.endsWith("Current user request:\ncontinue")).toBe(true)
    })

    it("fails an @codex turn whose handoff summary is PII-refused, and never runs it anywhere", async () => {
      getSessionMock.mockResolvedValue({
        id: "sess-1",
        title: "Direct",
        model: "sonnet",
        // Codex has its own session here, so only the unseen turns are handed over.
        externalAgentSession: { agentId: "codex-1", sessionId: "native-1" },
      })
      listMessagesMock.mockResolvedValue(thread(piiReply, "anthropic"))
      useExternalAgentStore.setState({ chatFailurePolicy: "fallback" })
      const { result } = await mount()
      subscribers.forEach((sub) => sub(chatState))
      await act(async () => {
        await result.current.send("@codex continue", undefined, { turnRoute: CODEX })
      })
      expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
      const failure = chatState.setSessionDiagnostic.mock.calls.find(
        ([, diagnostic]) => (diagnostic as { source?: string } | null)?.source === "external-agent"
      )
      expect(failure?.[1]).toEqual(
        expect.objectContaining({ meta: expect.objectContaining({ agentId: "codex-1" }) })
      )
      expect(JSON.stringify(failure?.[1])).toContain("handoff_context_summary_unavailable:pii")
    })
  })

  describe("editAndResend", () => {
    it("re-reads the leading handle of the edited text", async () => {
      chatState.messages = [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        {
          id: "a-1",
          role: "assistant",
          parts: [{ type: "text", text: "hi" }],
          metadata: { run: { providerId: "anthropic" } },
        },
      ]
      executeOnExternalAgentMock.mockResolvedValue({ success: true, finalResponse: "done" })
      const { result } = await mount()
      await act(async () => {
        await result.current.editAndResend("u-1", "@codex hello again", "sess-1")
      })
      expect(executeOnExternalAgentMock).toHaveBeenCalledWith(
        "hello again",
        expect.objectContaining({ agentId: "codex-1" })
      )
      expect(sendPromptMock).not.toHaveBeenCalled()
      const replacement = writtenUserRows().find(
        (row) => row.parts[0]?.text === "@codex hello again"
      )
      expect(replacement?.metadata?.turnRoute).toEqual(
        expect.objectContaining({ target: { kind: "runtime", runtime: "codex" }, handle: "codex" })
      )
    })

    it("drops the route when the edit no longer leads with a handle", async () => {
      chatState.messages = [
        {
          id: "u-1",
          role: "user",
          parts: [{ type: "text", text: "@codex fix it" }],
          metadata: { turnRoute: CODEX },
        },
        {
          id: "a-1",
          role: "assistant",
          parts: [{ type: "text", text: "patched" }],
          metadata: { run: { providerId: "external" } },
        },
      ]
      const { result } = await mount()
      await act(async () => {
        await result.current.editAndResend("u-1", "just explain it", "sess-1")
      })
      expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
      expect(sendPromptMock).toHaveBeenCalled()
      const replacement = writtenUserRows().find((row) => row.parts[0]?.text === "just explain it")
      expect(replacement).toBeDefined()
      expect(replacement?.metadata?.turnRoute).toBeUndefined()
    })

    it("refuses an edit addressed to a runtime that cannot run, leaving the thread as it was", async () => {
      chatState.messages = [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      ]
      routeSnapshotMock.mockResolvedValue(
        routeContext({ runtimes: [BUILTIN_ROW], configuredPresetIds: [] })
      )
      const { result } = await mount()
      await act(async () => {
        await result.current.editAndResend("u-1", "@codex hello again", "sess-1")
      })
      expect(routeRefusal()?.extra).toEqual({ handle: "codex", reason: "not-configured" })
      expect(chatState.replaceSessionMessages).not.toHaveBeenCalled()
      expect(persistMessagesMock).not.toHaveBeenCalled()
      expect(sendPromptMock).not.toHaveBeenCalled()
      expect(executeOnExternalAgentMock).not.toHaveBeenCalled()
    })

    it("files a failed delegated edit's fallback reply under the row the edit appended", async () => {
      // The delegation fallback re-issues the turn with `skipUserAppend`. It
      // used to carry `branchTag` along, so it re-ran the edit bookkeeping on
      // a second user message it built and never appended: the navigator
      // picked a row that does not exist, and the reply was not owned by the
      // edit, so flipping back to the original still showed it.
      chatState.messages = [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "a-1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      ]
      useExternalAgentStore.setState({ chatFailurePolicy: "fallback" })
      getConnectedAgentsMock.mockReturnValue([{ config: { id: "ext-1" } }])
      checkDelegationMock.mockReturnValue({ shouldDelegate: true, targetAgentId: "ext-1" })
      executeOnExternalAgentMock.mockResolvedValue({ success: false, error: "spawn failed" })
      // Every user message the send path builds gets its own id here, so the
      // row the edit appended and anything a re-issue builds are told apart.
      const adapter = jest.requireMock("@/lib/claude/adapter") as {
        makeUserMessage: jest.Mock
        applySdkEvent: jest.Mock
      }
      const baseMakeUserMessage = adapter.makeUserMessage.getMockImplementation()
      let built = 0
      adapter.makeUserMessage.mockImplementation((c: unknown) => ({
        id: `u-built-${++built}`,
        role: "user",
        parts: [{ type: "text", text: c }],
      }))
      try {
        const { result } = await mount()
        subscribers.forEach((sub) => sub(chatState))
        await act(async () => {
          await result.current.editAndResend("u-1", "hello again", "sess-1")
        })
        expect(executeOnExternalAgentMock).toHaveBeenCalledTimes(1)
        expect(sendPromptMock).toHaveBeenCalledTimes(1)
        expect(busDiagnostics.map((d) => d.code)).toContain("fallbackToBuiltin")

        const rows = (): Row[] => chatState.messages as Row[]
        const edits = rows().filter((message) => message.role === "user" && message.id !== "u-1")
        expect(edits).toHaveLength(1)
        const editedId = edits[0]!.id
        expect(edits[0]!.metadata).toMatchObject({ branchGroupId: "edit::u-1", branchIndex: 1 })
        // The appended edit stays selected, and no pick ever named a row that
        // is not in the transcript.
        expect(chatState.activeBranchByGroup).toEqual({ "edit::u-1": editedId })
        const inTranscript = new Set(rows().map((message) => message.id))
        const picked = chatState.setSessionActiveBranch.mock.calls.map(([, , id]) => id)
        expect(picked).toEqual([editedId])
        expect(picked.every((id) => inTranscript.has(id as string))).toBe(true)

        // The sidecar's reply lands owned by the appended edit…
        adapter.applySdkEvent.mockReturnValueOnce({
          messages: [
            ...rows(),
            { id: "a-2", role: "assistant", parts: [{ type: "text", text: "fallback answer" }] },
          ],
          turnComplete: true,
        })
        await act(async () => {
          _messageCallback?.({ type: "event", sessionId: "sess-1", event: { type: "result" } })
        })
        await flush()
        expect(rows().find((message) => message.id === "a-2")?.metadata).toMatchObject({
          branchOwnerId: editedId,
        })
        // …while the original keeps its own tail.
        expect(rows().find((message) => message.id === "a-1")?.metadata).toMatchObject({
          branchOwnerId: "u-1",
        })
      } finally {
        adapter.makeUserMessage.mockImplementation(baseMakeUserMessage)
      }
    })
  })
})
