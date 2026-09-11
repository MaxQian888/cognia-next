/**
 * Pure builder for the `/menu` command center — a curated, clickable index of
 * the most common interactions, each annotated with its current value so the
 * panel doubles as an at-a-glance status readout. Picking a row runs its slash
 * command (the panel just calls `runCommandLine(row.command)`), so this stays a
 * pure data transform with no Ink/IO and unit-tests without a render.
 */
import { backendIdentity } from "./backend-identity"
import { effectivePermissionMode } from "./backend-capabilities"
import { createCliTranslator } from "../i18n"
import {
  DEFAULT_MOUSE_MODE,
  DEFAULT_SELECTION_MODE,
  type ResolvedConfig,
} from "../../config/schema"
import type { QuickActionRow, TuiState } from "../state/types"

/**
 * Build the quick-action rows for the active config. State-derived hints (mode,
 * model, thinking level, mouse model) read straight from the resolved config so
 * the row shows what is currently in effect.
 */
export type CommandPaletteState = Partial<
  Pick<TuiState, "backendCapabilities" | "turnStatus" | "activity" | "lastPlan">
>

export function buildQuickActions(
  config: ResolvedConfig,
  state: CommandPaletteState = {}
): QuickActionRow[] {
  const t = createCliTranslator(config.locale, "cliUiCommands")
  const identity = backendIdentity(config, state.backendCapabilities?.presetId)
  const model = identity.model ?? t("backendDefault")
  const thinking =
    config.thinkingLevel && config.thinkingLevel !== "off" ? config.thinkingLevel : "off"
  const mouse = config.mouse ?? DEFAULT_MOUSE_MODE
  const selection = config.selection ?? DEFAULT_SELECTION_MODE
  return [
    {
      id: "mode",
      label: t("permissionLabel"),
      hint: effectivePermissionMode(state.backendCapabilities, config.permissionMode),
      command: "/mode",
    },
    { id: "model", label: t("modelLabel"), hint: model, command: "/model" },
    { id: "provider", label: t("providerLabel"), hint: identity.provider, command: "/provider" },
    { id: "thinking", label: t("thinkingLabel"), hint: thinking, command: "/think" },
    { id: "settings", label: t("settingsLabel"), hint: t("settingsHint"), command: "/settings" },
    { id: "mcp", label: t("mcpLabel"), hint: t("mcpHint"), command: "/mcp" },
    { id: "skills", label: t("skillsLabel"), hint: t("skillsHint"), command: "/skills" },
    { id: "agents", label: t("agentsLabel"), hint: t("agentsHint"), command: "/agents" },
    { id: "tools", label: t("toolsLabel"), hint: t("toolsHint"), command: "/tools" },
    { id: "usage", label: t("usageLabel"), hint: t("usageHint"), command: "/usage" },
    { id: "context", label: t("contextLabel"), hint: t("contextHint"), command: "/context" },
    { id: "diff", label: t("diffLabel"), hint: t("diffHint"), command: "/diff" },
    { id: "theme", label: t("themeLabel"), hint: t("themeHint"), command: "/theme" },
    { id: "mouse", label: t("mouseLabel"), hint: mouse, command: "/mouse" },
    { id: "selection", label: t("selectionLabel"), hint: selection, command: "/select" },
    { id: "copy", label: t("copyLabel"), hint: t("copyHint"), command: "/copy" },
    { id: "help", label: t("helpLabel"), hint: t("helpHint"), command: "/help" },
  ]
}
