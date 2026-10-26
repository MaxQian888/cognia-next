/**
 * The plugin contract's share of `lib/plugin/api/agent-config-api.ts`, which re-exports these.
 */
import type {
  AgentConfigApplyResult,
  AgentConfigEdit,
  AgentConfigFacts,
  AgentConfigLineProvenance,
  AgentConfigReferenceCheck,
  AgentConfigReferenceInput,
  AgentConfigSurfaceDocument,
  AgentConfigSurfaceListing,
} from "../../agent-config/types"

export interface PluginAgentConfigScope {
  /** The workspace to read; omit for the active one, `null` for account-only. */
  workspaceId?: string | null
}

export interface PluginAgentConfigAPI {
  /** Every surface an agent loads, in the Prompt Center's order, with load order for files. */
  listSurfaces(options?: PluginAgentConfigScope): Promise<AgentConfigSurfaceListing>
  /** One surface's text and the version a later edit is checked against; `null` when it is gone. */
  readSurface(
    key: string,
    options?: PluginAgentConfigScope
  ): Promise<AgentConfigSurfaceDocument | null>
  /** Structural facts about hooks, permission rules, MCP servers, Skills and the default model. */
  readFacts(options?: PluginAgentConfigScope): Promise<AgentConfigFacts>
  /** Whether paths and package scripts an instruction names still exist in the workspace. */
  checkReferences(input: AgentConfigReferenceInput): Promise<AgentConfigReferenceCheck>
  /** Commit and time per line of a file-backed surface; `null` outside a repository. */
  readProvenance(key: string): Promise<AgentConfigLineProvenance[] | null>
  /** `text` made safe for a model, line count unchanged; `null` when it cannot be. */
  redactForModel(text: string): string | null
  /** Write a change through the surface's owner after the user confirms it. */
  applyEdit(edit: AgentConfigEdit): Promise<AgentConfigApplyResult>
}
