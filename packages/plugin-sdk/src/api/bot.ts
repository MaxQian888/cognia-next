/**
 * Plugin SDK, `bot` capability surface.
 *
 * A Bot is declared in the manifest and, for the `handler` executor, backed by
 * a module this plugin ships. Nothing here registers anything: the host
 * resolves `manifest.bots[]` itself, which is what lets a Python plugin
 * contribute a Bot on equal terms (a registration callback could not cross the
 * stdio boundary).
 */

export { defineBot, defineBotHandler } from "../define/define-bot"
export type {
  PluginBotsAPI,
  BotCredentialSlotSnapshot,
  BotDeliveryStatus,
  BotDeliverySummary,
  BotEnqueueInput,
  BotInstallationSnapshot,
  BotInstallationStatus,
  BotMonitorState,
  BotScopeKind,
  BotStepBeginResult,
  BotTriggerSnapshot,
  BotWaitOutcome,
} from "@/types/bot/api"

export type {
  BotMatchScalar,
  PluginBotDef,
  PluginBotExecutor,
  PluginBotRetryPolicy,
  PluginBotTriggerDef,
  PluginBotTriggerConditions,
  PluginBotTriggerKind,
  PluginBotEventSource,
  PluginBotLifecycleDef,
  PluginBotLifecycleHookName,
  PluginBotInteractionTrigger,
  PluginBotEventTrigger,
  PluginBotScheduleTrigger,
  PluginBotPollTrigger,
  PluginBotDerivedStateTrigger,
  PluginBotManualTrigger,
  PluginBotCredentialSlot,
  PluginBotRequirementsV1,
  PluginBotCompositionRequestV1,
  PluginBotPolicyV1,
  PluginWorkflowBotDef,
  PluginSquadBotDef,
  PluginAgentTurnBotDef,
  PluginHandlerBotDef,
} from "@/types/plugin/plugin-bot"

export {
  BOT_TIMED_TRIGGER_MIN_EVERY_MS,
  PLUGIN_BOT_EXECUTORS,
  PLUGIN_BOT_LIFECYCLE_HOOKS,
  PLUGIN_BOT_TRIGGER_KINDS,
} from "@/types/plugin/plugin-bot"

export type {
  BotEventEnvelopeV1,
  BotEventActor,
  BotEventResource,
  BotEventProvenanceV1,
  BotEventSource,
} from "@/types/bot/event"

export type {
  BotHandlerV1,
  BotHandlerResultV1,
  BotLifecycleContextV1,
  BotLifecycleHookV1,
  BotRunContextV1,
  BotRunSnapshotV1,
  BotStepApiV1,
  BotApprovalRequestV1,
  BotApprovalDecisionV1,
  BotWaitForEventInput,
  BotProgressUpdateV1,
  BotLogLevel,
} from "@/types/bot/run"
