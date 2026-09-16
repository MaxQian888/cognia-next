/**
 * Router + Fusion host surface for the app (ADR-0188).
 *
 * Loaded only through `gate/load-engine.ts`, after the feature gate said "on".
 * Nothing on a shared send, gateway or sidecar path may import this module (or
 * anything under `lib/router-fusion/` outside `gate/`) statically; the gate
 * script enforces it.
 */

export {
  abortChatRunBeforeDispatch,
  answerCallReserve,
  beginChatRun,
  cancelChatRun,
  finalizeChatRun,
  observeEnvelopeMessage,
  preparedChatRoute,
  recordCallAttemptResult,
  recoverStaleFusionRuns,
  rememberChatRoute,
  type BeginChatRunOutcome,
  type ChatRunDeps,
  type ChatRunSeal,
  type PreparedChatRoute,
  type ReserveAnswer,
} from "./chat/chat-runs"
export { beginLedgeredUtilityCall, utilityRouteHost } from "./calls/ledgered-llm-client"
export { routeUtilityCall, utilityFeatures, UTILITY_ACTION_ID } from "./calls/utility-route"
export {
  beginUtilityCall,
  AI_SDK_USAGE_SEMANTICS,
  UTILITY_RUN_LEASE_MS,
  type UtilityCallBinding,
  type UtilityCallHandle,
  type UtilityRunDeps,
} from "./calls/utility-run"
export {
  acceptRun,
  cancelRunFromApi,
  contractEventOf,
  createRunFromApi,
  EXECUTABLE_MODES,
  getArtifactFromApi,
  getRunFromApi,
  getSessionFromApi,
  isRunApiScope,
  listRunEventsFromApi,
  readArtifactFromApi,
  readRunResult,
  resumeRunFromApi,
  RUN_API_SCOPES,
  snapshotOf,
  submitFeedbackFromApi,
  type AcceptRunInput,
  type ArtifactContentResponse,
  type RunApiActor,
  type RunApiDeps,
  type RunApiError,
  type RunApiResult,
  type RunApiScope,
  type RunCreated,
  type RunEventsPage,
  type RunSnapshotRead,
} from "./api/run-api"
export { createRoutedRun, runApiDeps, runRequestPolicyOf, sessionPort } from "./api/run-api-host"
export {
  chatResultFromApi,
  createChatRunFromApi,
  runTokenTotals,
  type ChatRunRead,
} from "./api/chat-compat"
export { driveRun, orchestratedRunResumer } from "./runtime/run-driver"
export { routeRunRequest, type RunRoute, type RunRouteInput } from "./routing/run-route"
export {
  createHostToolRuntime,
  createRunEvidenceResolver,
  PANEL_READ_POLICY,
  PANEL_VERIFY_POLICY,
} from "./tools/tool-runtime"
export { createRoleCallExecutor } from "./calls/role-call-executor"
export {
  passthroughRunId,
  reservePassthroughCall,
  settlePassthroughCall,
  PASSTHROUGH_RUN_LEASE_MS,
  PASSTHROUGH_SURFACE,
  type PassthroughReservation,
  type PassthroughReserveInput,
  type PassthroughSettleInput,
} from "./calls/gateway-ledger-source"
export {
  executeFusionRun,
  FUSION_RUN_LEASE_MS,
  reserveForAction,
  type ExecuteFusionRunInput,
  type FusionRunOutcome,
  type OrchestratorDeps,
} from "./runtime/orchestrator-host"
export { createChatRouteHost } from "./chat/chat-route-host"
export {
  cancelChatFusionTurn,
  chatAutoConsidersFusion,
  selectChatFusionRun,
  startChatFusionTurn,
  type ChatFusionSelection,
  type ChatFusionTurnOutcome,
} from "./chat/chat-fusion-turn"
export {
  sealChatRoute,
  selectChatDeployment,
  type ChatRouteHost,
  type ChatRouteRefusal,
  type ChatSeal,
  type ChatSelection,
  type ChatSelectionInput,
} from "./chat/route-chat-turn"
export { tenantLimitFor, type TenantLimit } from "./chat/tenant-budget"
export { currentFusionStore, drainAccountOutbox } from "./chat/store-provider"
export { pruneFusionDatabase, type FusionRetentionReport } from "./db/retention"
export { chatRunDeps, windowLeaseOwner } from "./chat/chat-run-deps"
export {
  abortRouterFusionChatTurn,
  cancelRouterFusionChatTurn,
  finishRouterFusionChatTurn,
  handleRouterFusionSidecarEvent,
  MAX_LEDGERED_REROUTES,
  observeRouterFusionSdkMessage,
  rerouteRouterFusionTurn,
  resealRouterFusionOptions,
  requestRouterFusionGrant,
  startRouterFusionChatTurn,
  type RerouteOutcome,
  type ResealOutcome,
  type RouterFusionSidecarEvent,
  type RouterFusionTurnSummary,
  type StartTurnOutcome,
} from "./chat/chat-turn-bridge"
