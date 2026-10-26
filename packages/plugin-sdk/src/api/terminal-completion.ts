/**
 * Plugin SDK — `terminal-completion` capability surface.
 *
 * Exports the authoring helper, provider registration, and namespaced host
 * completion registry aliases for terminal suggestions. The host adapts and
 * registers manifest-declared providers itself.
 */

export { defineTerminalCompletionProvider } from "../define/define-terminal-completion"

export { registerPluginCompletionProvider } from "@cognia/plugin-contract/lib/plugin/bridge/terminal-completion-bridge"

export type {
  TerminalCompletionBridgeError,
  TerminalCompletionBridgeOptions,
  TerminalCompletionBridgeResult,
} from "@cognia/plugin-contract/lib/plugin/bridge/terminal-completion-bridge"

export {
  getCompletions as getTerminalCompletions,
  listProviders as listTerminalCompletionProviders,
  rankSuggestions as rankTerminalCompletionSuggestions,
  registerCompletionProvider as registerTerminalCompletionProvider,
} from "@cognia/plugin-contract/lib/terminal/completion/registry"

export type {
  AcceptEdit,
  TerminalCompletionContext,
  TerminalCompletionProvider,
  TerminalCompletionSuggestion,
} from "@cognia/plugin-contract/lib/terminal/completion/types"

export { SOURCE_PRIORITY as TERMINAL_COMPLETION_SOURCE_PRIORITY } from "@cognia/plugin-contract/lib/terminal/completion/types"

export type {
  PluginTerminalCompletionContext,
  PluginTerminalCompletionFactory,
  PluginTerminalCompletionItem,
  PluginTerminalCompletionProvider,
  PluginTerminalCompletionProviderDef,
} from "@cognia/plugin-contract/types/plugin/plugin-terminal-completion"
