/**
 * Plugin SDK - `workflow-trigger` capability surface.
 *
 * Re-exports the trigger authoring helper, plugin trigger registry, lifecycle
 * runner, and per-workflow mute helpers used by the workflow runtime.
 */

export { defineWorkflowTrigger } from "../define/define-workflow-trigger"

export {
  getPluginTrigger,
  isTriggerMuted,
  listPluginTriggers,
  registerPluginTrigger,
  setTriggerMuted,
  startPluginTriggerInstance,
  subscribePluginTriggerRegistry,
  subscribeTriggerMuteChanges,
  unregisterPluginTrigger,
} from "@/lib/workflow/triggers/registry"

export type {
  TriggerInstanceHandle,
  TriggerRegistration,
  TriggerRegistryEvent,
  TriggerRegistryListener,
} from "@/lib/workflow/triggers/registry"

export type {
  PluginTriggerDef,
  PluginTriggerHandle,
  PluginTriggerLogger,
  PluginTriggerStartContext,
} from "@/types/plugin/plugin-workflow"
