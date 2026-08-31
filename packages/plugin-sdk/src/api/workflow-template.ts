/** Portable workflow-template authoring surface. Runtime registry access uses `ctx.workflow`. */

export { defineWorkflowTemplate } from "../define/define-workflow-template"

export type {
  PluginWorkflowTemplateDef,
  PluginWorkflowTemplateEdge,
  PluginWorkflowTemplateNode,
} from "@/types/plugin/plugin-workflow-template"
export type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
export type {
  PluginWorkflowTemplateWarning,
  PluginWorkflowTemplateWarningCode,
  WorkflowTemplateValidationResult,
} from "@/lib/plugin/registries/workflow-template-registry"
