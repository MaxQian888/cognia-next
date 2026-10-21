/** Portable workflow-template authoring surface. Runtime registry access uses `ctx.workflow`. */

export { defineWorkflowTemplate } from "../define/define-workflow-template"

export type {
  PluginWorkflowTemplateDef,
  PluginWorkflowTemplateEdge,
  PluginWorkflowTemplateNode,
} from "@cognia/plugin-contract/types/plugin/plugin-workflow-template"
export type { NodeCatalogEntry } from "@cognia/plugin-contract/lib/workflow/nodes/catalog"
export type {
  PluginWorkflowTemplateWarning,
  PluginWorkflowTemplateWarningCode,
  WorkflowTemplateValidationResult,
} from "@cognia/plugin-contract/lib/plugin/registries/workflow-template-registry"
