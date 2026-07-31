/**
 * Plugin SDK - `tool` capability surface.
 *
 * Re-exports the declarative tool authoring helper and tool runtime contracts.
 * The live tools bridge depends on renderer plugin stores, so this subpath
 * remains a lightweight authoring/type facade.
 */

export { defineTool } from "../define/define-tool"

export type { PluginTool, PluginToolContext, PluginToolDef } from "@/types/plugin"
