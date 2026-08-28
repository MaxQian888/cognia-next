/**
 * Plugin SDK — `workflow-template` capability surface (ADR-0017 / 0032).
 *
 * Re-exports the `defineWorkflowTemplate()` authoring helper and the dynamic
 * registry plugins use to contribute complete visual-workflow blueprints
 * (nodes + edges + settings + requires) surfaced in the editor's Settings
 * tab → "Plugins & capabilities".
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-workflow-template.ts`
 *  - `lib/plugin/registries/workflow-template-registry.ts`
 *  - `types/plugin/plugin-workflow-template.ts`
 *
 * Authors call `defineWorkflowTemplate()` for compile-time shape checks,
 * then declare it in the manifest's `workflowTemplates` array or register it
 * dynamically from `activate(ctx)`. `validateWorkflowTemplateRequires`
 * surfaces missing capability dependencies before the template is offered.
 */

export { defineWorkflowTemplate } from "../define/define-workflow-template"

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

/**
 * Recompute the "requires" warnings for every registered template. A plugin
 * that registers templates whose requirements depend on other plugins calls
 * this after its own registration so the library reflects the new state
 * without waiting for the next host-side refresh.
 */
export { refreshAllWorkflowTemplateWarnings } from "@/lib/plugin/registries/workflow-template-registry"

export type {
  PluginWorkflowTemplateEdge,
  PluginWorkflowTemplateNode,
} from "@/types/plugin/plugin-workflow-template"

/**
 * The node catalog a contributed node joins, and the validators that prove a
 * contributed TEMPLATE is well formed.
 *
 * A template is a graph, and a graph with a dangling edge or an illegal cycle
 * fails at run time in whatever surface happens to open it. Projecting the
 * template and running the host's own integrity check is how a plugin proves
 * its template is loadable BEFORE shipping it — and it must be the host's
 * check, because the host is what will reject it.
 *
 * `addPluginCatalogEntry` / `removePluginCatalogEntry` are the catalog half:
 * a template that references a plugin-contributed node kind only resolves once
 * that kind is in the catalog, which is what `validateWorkflowTemplateRequires`
 * above reports on.
 */
export {
  addPluginCatalogEntry,
  effectiveRequires,
  getPluginCatalogSnapshot,
  missingCapabilities,
  nodeCatalogEntry,
  NODE_CATALOG,
  removePluginCatalogEntry,
  subscribePluginCatalog,
} from "@/lib/workflow/nodes/catalog"

export type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

export { projectPluginWorkflowTemplate } from "@/lib/workflow/templates/project-plugin-workflow-template"
export { validateGraphIntegrity } from "@/lib/workflow/definition/validate"
