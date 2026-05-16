/**
 * Plugin SDK — `native-anthropic-tool` capability surface.
 *
 * Wraps the in-tree helpers (`lib/plugin/sdk/define-native-anthropic-tool.ts`,
 * `lib/plugin/registries/native-anthropic-tool-registry.ts`) under the
 * `plugin-sdk/typescript/src/api/native-anthropic-tool.ts` path the
 * `native-anthropic-tool` capability contract advertises in
 * `lib/plugin/contracts/plugin-capabilities.ts`. Existing plugins
 * (e.g. `plugins/computer-use/src/index.ts`) import directly from the
 * `@/lib/plugin/*` paths today; this module is the published entry point
 * the contract proof points at, so the rename stays trivial when the
 * `plugin-sdk/typescript/` package is spun out as a separate npm package.
 */

export { defineNativeAnthropicTool } from "@/lib/plugin/sdk/define-native-anthropic-tool"
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
