/**
 * Plugin SDK — `workflow` capability surface (ADR-0017).
 *
 * Re-exports the type contracts plugins use to contribute custom workflow
 * node executors and trigger sources to the visual editor + runtime. The
 * runtime API (`ctx.workflow.registerNode` / `registerTrigger`) lives on
 * `PluginContext` and is re-exported from `@cognia/plugin-sdk/context` as
 * `PluginWorkflowAPI`. The manifest-side block (`PluginManifestWorkflowsBlock`)
 * is re-exported here for static authoring.
 *
 * Source: `types/plugin/plugin-workflow.ts`.
 */

export type {
  PluginNodeDef,
  PluginNodeExecuteFn,
  PluginTriggerDef,
  PluginTriggerHandle,
  PluginTriggerStartContext,
  PluginTriggerLogger,
  PluginManifestNodeDef,
  PluginManifestTriggerDef,
  PluginManifestWorkflowsBlock,
} from "@/types/plugin/plugin-workflow"
