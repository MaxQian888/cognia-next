import type { VisualWorkflow } from "./visual"

export type DifyImportBlockerCode =
  | "invalid_yaml"
  | "invalid_envelope"
  | "unsupported_version"
  | "unsupported_node"
  | "invalid_node"
  | "invalid_graph"
  | "workflow_conflict"
  | "missing_plugin"
  | "missing_model"
  | "missing_tool"
  | "missing_knowledge"
  | "secret_value_present"

export interface DifyImportIssue {
  code: DifyImportBlockerCode
  path: string
  message: string
}

export interface DifyImportWarning {
  code: "older_dsl_version" | "feature_not_ported"
  path: string
  message: string
}

export interface DifyImportPreflight {
  profile: "dify-1.16"
  ok: boolean
  workflow?: VisualWorkflow
  appMode?: "workflow" | "chatflow"
  blockers: DifyImportIssue[]
  warnings: DifyImportWarning[]
}

export type DifyToolBinding =
  | { kind: "plugin"; pluginId: string; toolName: string }
  | { kind: "mcp"; serverId: string; toolName: string }

export interface DifyImportResolver {
  resolvePlugin(input: {
    uniqueIdentifier: string
    currentIdentifier?: string
  }): Promise<string | undefined>
  resolveModel(input: {
    provider: string
    model: string
  }): Promise<{ provider: string; model: string } | undefined>
  resolveTool(input: { providerId: string; toolName: string }): Promise<DifyToolBinding | undefined>
  resolveKnowledge(datasetId: string): Promise<string | undefined>
}
