/**
 * Plugin SDK — `terminal-completion` capability surface.
 *
 * Re-exports the authoring helper, manifest bridge, plugin adapter, and
 * namespaced host completion registry aliases for terminal suggestions.
 */

export { defineTerminalCompletionProvider } from "../define/define-terminal-completion"

export {
  adaptPluginCompletionProvider,
  registerPluginCompletionProvider,
  registerTerminalCompletionProvidersForPlugin,
  unregisterTerminalCompletionProvidersForPlugin,
} from "@/lib/plugin/bridge/terminal-completion-bridge"

export type {
  TerminalCompletionBridgeError,
  TerminalCompletionBridgeOptions,
  TerminalCompletionBridgeResult,
} from "@/lib/plugin/bridge/terminal-completion-bridge"

export {
  getCompletions as getTerminalCompletions,
  listProviders as listTerminalCompletionProviders,
  rankSuggestions as rankTerminalCompletionSuggestions,
  registerCompletionProvider as registerTerminalCompletionProvider,
} from "@/lib/terminal/completion/registry"

export type {
  AcceptEdit,
  TerminalCompletionContext,
  TerminalCompletionProvider,
  TerminalCompletionSuggestion,
} from "@/lib/terminal/completion/types"

export { SOURCE_PRIORITY as TERMINAL_COMPLETION_SOURCE_PRIORITY } from "@/lib/terminal/completion/types"

export type {
  PluginTerminalCompletionContext,
  PluginTerminalCompletionFactory,
  PluginTerminalCompletionItem,
  PluginTerminalCompletionProvider,
  PluginTerminalCompletionProviderDef,
} from "@/types/plugin/plugin-terminal-completion"
