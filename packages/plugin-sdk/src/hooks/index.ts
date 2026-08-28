/**
 * Plugin SDK — `hooks` subpath.
 *
 * Re-exports the hook schema plugin authors use when declaring lifecycle
 * and event hooks in their manifest's `hooks` block. The host-side
 * dispatchers (`HookDispatcher`, `PluginLifecycleHooks`, `PluginEventHooks`)
 * are intentionally NOT re-exported — those are runtime internals.
 *
 * Sources:
 *  - `types/plugin/plugin.ts` (base `PluginHooks` interface)
 *  - `types/plugin/plugin-hooks.ts` (additional hook event shapes,
 *    `HookPriority` type alias, sandbox execution result)
 */

export type { PluginCommandContext, PluginCommandResult, PluginHooks } from "@/types/plugin/plugin"

export type {
  // Domain-specific hook event shapes
  ProjectHookEvents,
  GoalHookPayload,
  GoalHookEvents,
  ShareLinkHookPayload,
  ShareHookEvents,
  CanvasHookEvents,
  ArtifactHookEvents,
  ExportHookEvents,
  ThemeHookEvents,
  AIHookEvents,
  VectorHookEvents,
  WorkflowHookEvents,
  PluginTerminalSpawnRequest,
  PluginTerminalSpawnDecision,
  PluginTerminalLifecycleEvent,
  TerminalHookEvents,
  ConnectorInboundHookPayload,
  ConnectorOutboundHookPayload,
  ConnectorHookDecision,
  ConnectorHookEvents,
  UIHookEvents,
  // Chat / prompt / tool hook payloads
  PromptAttachment,
  PromptSubmitContext,
  PromptSubmitResult,
  PreToolUseResult,
  PostToolUseResult,
  PreCompactContext,
  PreCompactResult,
  ChatResponseData,
  PostChatReceiveResult,
  BuildOptionsHookInput,
  BuildOptionsHookOutput,
  // Umbrella hook collections
  PluginHooksAll,
  // Registration options & sandbox result
  HookPriority,
  HookRegistrationOptions,
  HookSandboxExecutionResult,
} from "@/types/plugin/plugin-hooks"
