/**
 * Plugin SDK — `native-anthropic-tool` capability surface.
 *
 * Wraps the package-local helper
 * (`packages/plugin-sdk/src/define/define-native-anthropic-tool.ts`) and the
 * host runtime registry (`lib/plugin/registries/native-anthropic-tool-registry.ts`)
 * under the stable `@cognia/plugin-sdk/api/native-anthropic-tool` path the
 * `native-anthropic-tool` capability contract advertises.
 *
 * Full reference: `docs/content/docs/en/plugin-dev/native-anthropic-tools.mdx`.
 *
 * Quick example — register a fictional `spreadsheet_20260601` tool:
 *
 * ```ts
 * import { defineNativeAnthropicTool } from "@cognia/plugin-sdk/api/native-anthropic-tool"
 *
 * const SPREADSHEET_TOOL = defineNativeAnthropicTool({
 *   id: "spreadsheet",
 *   name: "spreadsheet",
 *   type: "spreadsheet_20260601",
 *   executeIpc: { invoke: "plugin_spreadsheet_execute" },
 *   permissionPolicy: "always-ask",
 * })
 *
 * export default {
 *   manifest: {
 *     id: "cognia-spreadsheet-tool",
 *     name: "Spreadsheet Tool",
 *     version: "0.1.0",
 *     type: "frontend",
 *     capabilities: ["native-anthropic-tool"],
 *     main: "src/index.ts",
 *     nativeAnthropicTools: [SPREADSHEET_TOOL],
 *     permissions: ["native:input"],
 *   } as never,
 *   activate: async () => {},
 * }
 * ```
 *
 * The Tauri command (`plugin_spreadsheet_execute`) lives in your plugin's
 * Rust workspace; the host's permission gate fires automatically when the
 * command body routes through `automation::commands::command_body!`.
 * `Character.computerUseSettings.allowedToolIds` filters by the `id`
 * field; `Character.computerUseSettings.requireConsent: true` forces every
 * dispatch through the floating consent overlay (`forceTier: "perCall"`).
 */

export { defineNativeAnthropicTool } from "../define/define-native-anthropic-tool"
export {
  registerNativeAnthropicTool,
  unregisterNativeAnthropicToolById,
  unregisterNativeAnthropicToolsByPlugin,
  getNativeAnthropicTool,
  getNativeAnthropicToolEntry,
  listNativeAnthropicToolIds,
  listNativeAnthropicToolEntries,
  computeAnthropicBetaHeaders,
} from "@/lib/plugin/registries/native-anthropic-tool-registry"
export type {
  AnthropicNativeToolType,
  NativeToolPermissionPolicy,
  PluginNativeAnthropicToolDef,
} from "@/types/plugin/plugin-native-tool"
