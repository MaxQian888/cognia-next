/**
 * Plugin SDK helper for the `tray` capability.
 *
 * Pure typesafety pass-through — wrapping a tray item in `defineTrayItem()`
 * checks the shape against `PluginTrayItemInput` (id/label/icon/when/category/
 * accelerator + the `onClick` handler). Register the result at activation via
 * `ctx.tray.register(...)` / `ctx.tray.registerMany([...])`.
 *
 * For a fully declarative tray entry (no `onClick`, dispatched by command/slash
 * and visible before activation), use a `quickActions` manifest entry with the
 * `"tray"` surface instead.
 */

import type { PluginTrayItemInput } from "@/types/plugin/plugin"

export function defineTrayItem(item: PluginTrayItemInput): PluginTrayItemInput {
  return item
}
