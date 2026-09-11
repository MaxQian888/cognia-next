/**
 * Pure builder for the `/menu` command center — a searchable, clickable index
 * that fronts every slash command. It leads with the curated quick actions (each
 * annotated with its live value, so the panel doubles as a status readout) and
 * then appends every other visible registry command, so a user can fuzzy-jump to
 * any command without remembering its exact name — the Claude-Code command
 * palette. Pure data transform: no Ink/IO, unit-tests without a render.
 */
import { buildQuickActions, type CommandPaletteState } from "./build-quick-actions"
import { createCliTranslator } from "../i18n"
import { supportsFeature, isBuiltinBackend, type BackendFeature } from "./backend-capabilities"
import { localizedCommandDescription } from "../commands/help-model"
import { listVisibleCommands } from "../commands/registry"
import type { ResolvedConfig } from "../../config/schema"
import type { QuickActionRow } from "../state/types"

/**
 * Curated quick actions first (with live hints), then every other visible
 * registry command as a row. A command is skipped when a curated row already
 * runs it (matched by the `/name` the row dispatches), so the common pickers
 * aren't duplicated. `command` is always `/<name>`; the hint is the command's
 * one-line description.
 */
export function buildCommandPalette(
  config: ResolvedConfig,
  state: CommandPaletteState = {}
): QuickActionRow[] {
  const t = createCliTranslator(config.locale, "cliUiCommands")
  const curated = buildQuickActions(config, state)
  // The bare command each curated row runs (`/model effort` → `model`), so a
  // registry command already fronted by a curated row is not listed twice.
  const curatedCommands = new Set(
    curated.map((r) => r.command.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase()).filter(Boolean)
  )
  const rest: QuickActionRow[] = listVisibleCommands()
    .filter((c) => !curatedCommands.has(c.name.toLowerCase()))
    .map((c) => ({
      id: `cmd:${c.name}`,
      label: `/${c.name}`,
      hint: localizedCommandDescription(c, t),
      command: `/${c.name}`,
    }))
  const contextual: QuickActionRow[] = []
  if (state.activity?.status === "running") {
    const command =
      state.activity.kind === "goal"
        ? "/goal status"
        : state.activity.kind === "loop"
          ? "/status"
          : "/agents"
    contextual.push({
      id: "currentActivity",
      label: t("activity", { label: state.activity.label }),
      command,
    })
  }
  if (state.lastPlan)
    contextual.push({ id: "currentPlan", label: t("reviewPlan"), command: "/plan" })
  const features: Record<string, BackendFeature> = {
    model: "modelPicker",
    think: "thinking",
    thinking: "thinking",
    mcp: "mcp",
    skills: "skills",
    skill: "skills",
    plugin: "plugins",
    plugins: "plugins",
    compact: "compact",
    resume: "resume",
    continue: "resume",
    // /limits is also the read-only explanation of an unavailable native
    // quota surface, so it remains reachable without that capability.
    hooks: "hooks",
  }
  return [...contextual, ...curated, ...rest].map((row) => {
    const name = row.command.slice(1).split(/\s+/)[0]
    const feature = features[name]
    let reason: string | undefined
    if (feature && !supportsFeature(state.backendCapabilities, feature)) {
      reason = t("unavailable", {
        reason: state.backendCapabilities?.features[feature]?.reason ?? t("unsupported"),
      })
    } else if (name === "provider" && !isBuiltinBackend(config.agentBackend)) {
      reason = t("unavailable", { reason: t("providerOwned") })
    } else if (
      state.turnStatus &&
      state.turnStatus !== "idle" &&
      ["model", "provider", "backend", "compact", "clear", "resume"].includes(name)
    ) {
      reason = t("busy")
    }
    return reason ? { ...row, disabledReason: reason } : row
  })
}
