/**
 * Plugin SDK - `cli-tool` capability surface.
 *
 * Re-exports the declarative CLI tool authoring helper and host executor. The
 * executor lazy-loads Tauri/Dexie dependencies only when invoked.
 */

export { defineCliTool } from "../define/define-cli-tool"

export { CliToolExecutionError, executeCliTool } from "@/lib/plugin/cli-tools/execute-cli-tool"

export type {
  CliToolDeps,
  CliToolExecutionResult,
  ExecuteCliToolContext,
} from "@/lib/plugin/cli-tools/execute-cli-tool"

export type {
  PluginCliArgvToken,
  PluginCliBinaryRef,
  PluginCliCwdPolicy,
  PluginCliOutputParse,
  PluginCliToolDef,
} from "@/types/plugin/plugin-cli-tool"
