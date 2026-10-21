/**
 * The plugin contract's share of `lib/plugin/contracts/plugin-points.ts`, which re-exports these.
 */
import type { CANONICAL_EXTENSION_POINTS } from "@/lib/plugin/contracts/plugin-points"

export type PluginPointGovernanceMode = "warn" | "block"

export type CanonicalExtensionPoint = (typeof CANONICAL_EXTENSION_POINTS)[number]

export type ActivationEventDeclaration =
  | "startup"
  | "onStartup"
  | "onCommand:*"
  | `onCommand:${string}`
  | "onTool:*"
  | `onTool:${string}`
  | "onAgentTool:*"
  | `onAgentTool:${string}`
  | "onChat:*"
  | `onChat:${string}`
  | "onAgent:start"
  | "onA2UI:surface"
  | `onLanguage:${string}`
  | `onFile:${string}`
  // VS Code-flavoured activation events. Patterns ending in `:*` may
  // appear without suffix (e.g. literal `onView:*`) or with one (`onView:foo`).
  | "onView:*"
  | `onView:${string}`
  | "onWebviewPanel:*"
  | `onWebviewPanel:${string}`
  | "onCustomEditor:*"
  | `onCustomEditor:${string}`
  | "onAuthenticationRequest"
  | `onAuthenticationRequest:${string}`
  | "onTaskType:*"
  | `onTaskType:${string}`
  | "onFileSystem:*"
  | `onFileSystem:${string}`
  | "onDebugResolve:*"
  | `onDebugResolve:${string}`
  | "onStartupFinished"
  | "onUri"
  | "onTerminal"
  | "onTerminalProfile:*"
  | `onTerminalProfile:${string}`
  | "onNotebook:*"
  | `onNotebook:${string}`
  | "onWalkthrough:*"
  | `onWalkthrough:${string}`
  | "onChatParticipant:*"
  | `onChatParticipant:${string}`
  | "onLanguageModelTool:*"
  | `onLanguageModelTool:${string}`
  | `workspaceContains:${string}`
