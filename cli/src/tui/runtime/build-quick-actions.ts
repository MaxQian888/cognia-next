/**
 * Pure builder for the `/menu` command center — a curated, clickable index of
 * the most common interactions, each annotated with its current value so the
 * panel doubles as an at-a-glance status readout. Picking a row runs its slash
 * command (the panel just calls `runCommandLine(row.command)`), so this stays a
 * pure data transform with no Ink/IO and unit-tests without a render.
 */
import { resolveActiveModel } from "../../config/active-model"
import { DEFAULT_MOUSE_MODE, type ResolvedConfig } from "../../config/schema"
import type { QuickActionRow } from "../state/types"

/**
 * Build the quick-action rows for the active config. State-derived hints (mode,
 * model, thinking level, mouse model) read straight from the resolved config so
 * the row shows what is currently in effect.
 */
export function buildQuickActions(config: ResolvedConfig): QuickActionRow[] {
  const model = resolveActiveModel(config) ?? "default"
  const thinking =
    config.thinkingLevel && config.thinkingLevel !== "off" ? config.thinkingLevel : "off"
  const mouse = config.mouse ?? DEFAULT_MOUSE_MODE
  return [
    { id: "mode", label: "⚖ Permission mode", hint: config.permissionMode, command: "/mode" },
    { id: "model", label: "✦ Model", hint: model, command: "/model" },
    { id: "provider", label: "☷ Provider", hint: config.provider, command: "/provider" },
    { id: "thinking", label: "🧠 Thinking effort", hint: thinking, command: "/think" },
    { id: "settings", label: "⚙ Settings", hint: "open the settings panel", command: "/settings" },
    { id: "mcp", label: "🔌 MCP servers", hint: "connect & inspect", command: "/mcp" },
    { id: "skills", label: "🛠 Skills", hint: "enable / disable", command: "/skills" },
    { id: "agents", label: "◆ Subagents", hint: "dispatch & watch", command: "/agents" },
    { id: "tools", label: "🧰 Tools", hint: "browse the catalog", command: "/tools" },
    { id: "usage", label: "📊 Usage & cost", hint: "tokens · cost", command: "/usage" },
    { id: "context", label: "▣ Context", hint: "breakdown & compact", command: "/context" },
    { id: "diff", label: "± Git diff", hint: "working-tree changes", command: "/diff" },
    { id: "theme", label: "🎨 Theme", hint: "recolour the UI", command: "/theme" },
    { id: "mouse", label: "🖱 Mouse model", hint: mouse, command: "/mouse" },
    { id: "help", label: "? Help", hint: "all commands & keys", command: "/help" },
  ]
}
