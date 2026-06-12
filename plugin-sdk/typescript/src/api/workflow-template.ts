/**
 * Plugin SDK — `workflow-template` capability surface (ADR-0017 / 0032).
 *
 * Re-exports the `defineWorkflowTemplate()` authoring helper and the dynamic
 * registry plugins use to contribute complete visual-workflow blueprints
 * (nodes + edges + settings + requires) surfaced in the editor's Settings
 * tab → "Plugins & capabilities".
 *
 * Sources:
 *  - `lib/plugin/sdk/define-workflow-template.ts`
 *  - `lib/plugin/registries/workflow-template-registry.ts`
 *  - `types/plugin/plugin-workflow-template.ts`
 *
 * Authors call `defineWorkflowTemplate()` for compile-time shape checks,
 * then declare it in the manifest's `workflowTemplates` array or register it
 * dynamically from `activate(ctx)`. `validateWorkflowTemplateRequires`
 * surfaces missing capability dependencies before the template is offered.
 */

export { defineWorkflowTemplate } from "@/lib/plugin/sdk/define-workflow-template"

export {
  registerWorkflowTemplate,
  unregisterWorkflowTemplateById,
  unregisterWorkflowTemplatesByPlugin,
  getWorkflowTemplate,
  getWorkflowTemplateEntry,
  listWorkflowTemplateIds,
  listWorkflowTemplateEntries,
  validateWorkflowTemplateRequires,
} from "@/lib/plugin/registries/workflow-template-registry"

export type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"
