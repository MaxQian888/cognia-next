/**
 * Rows for the `/config` settings panel. Each row reflects a current setting and
 * names the action taken when it is selected (open a sub-switcher, or surface an
 * info notice). Pure so the App router + the panel render share one definition.
 */
import { authMode } from "./builtins"
import type { ResolvedConfig } from "../../config/schema"

export type ConfigMenuAction = "provider" | "model" | "mode" | "auth" | "cwd"

export interface ConfigMenuRow {
  action: ConfigMenuAction
  label: string
  value: string
}

export function configMenuRows(config: ResolvedConfig): ConfigMenuRow[] {
  return [
    { action: "provider", label: "Provider", value: config.provider },
    { action: "model", label: "Model", value: config.model ?? "default" },
    { action: "mode", label: "Permission mode", value: config.permissionMode },
    { action: "auth", label: "Auth", value: authMode(config) },
    { action: "cwd", label: "Working dir", value: config.cwd },
  ]
}
