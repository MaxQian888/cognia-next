/**
 * The plugin contract's share of `lib/plugin/registries/workflow-template-registry.ts`, which re-exports these.
 */
export type PluginWorkflowTemplateWarningCode =
  | "missing-skill"
  | "missing-mcp-preset"
  | "missing-native-tool"
  | "missing-subagent"
  | "missing-plugin-node"
  | "missing-plugin-trigger"

export interface PluginWorkflowTemplateWarning {
  code: PluginWorkflowTemplateWarningCode
  missingId: string
}

export interface WorkflowTemplateValidationResult {
  warnings: PluginWorkflowTemplateWarning[]
  ok: boolean
}
