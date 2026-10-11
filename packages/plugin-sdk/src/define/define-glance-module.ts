/**
 * Plugin SDK helper for the `glance` capability (ADR-0225 §6).
 *
 * Pure typesafety pass-through: wrapping a module declaration in
 * `defineGlanceModule()` checks it against `PluginGlanceModuleInput` (id,
 * title, titleKey, icon, sizes, platforms). Declare it in
 * `manifest.glanceModules[]` or at activation with `ctx.glance.register(...)`,
 * then publish its data with `ctx.glance.update(id, data)`.
 *
 * A glance module is data, never React: the host renders it in the tray panel
 * and the phone's Glance drawer with its own components.
 */

import type { PluginGlanceModuleInput } from "@/types/plugin/plugin-glance"

export function defineGlanceModule(module: PluginGlanceModuleInput): PluginGlanceModuleInput {
  return module
}
