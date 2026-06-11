/**
 * `/plugin` controller — discover and inspect installed plugins (read-only) and
 * toggle their enabled state. Reuses the file-based plugin discovery; plugin
 * TOOL execution from the CLI (the `plugin_tool_exec` round-trip) is a tracked
 * follow-up, so this surfaces the inventory + supported/enabled state honestly.
 */
import { discoverPlugins, type PluginInfo } from "../../plugin/discover-plugins"
import { readDisabledPlugins, setPluginDisabled } from "../../plugin/plugin-state"
import { openDocument } from "./shared"
import { buildToolsDocument } from "./tool-doc"
import type { TuiAction } from "../state/types"

export interface PluginDeps {
  dispatch: (action: TuiAction) => void
  roots: string[]
  home: string
  list?: () => Promise<PluginInfo[]>
  getDisabled?: () => Set<string>
  setEnabled?: (id: string, disabled: boolean) => void
}

const loadPlugins = (deps: PluginDeps) => (deps.list ?? (() => discoverPlugins(deps.roots)))()
const disabledOf = (deps: PluginDeps) =>
  (deps.getDisabled ?? (() => readDisabledPlugins(deps.home)))()

export async function pluginList(deps: PluginDeps): Promise<void> {
  const plugins = await loadPlugins(deps)
  if (plugins.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: "No plugins installed. Drop a plugin folder under .cognia/plugins/.",
    })
    return
  }
  const disabled = disabledOf(deps)
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Plugins (Enter inspects)",
      items: plugins.map((p) => ({
        id: p.id,
        label: p.name,
        hint: `${p.type}${p.supported ? "" : " · unsupported"} · ${
          disabled.has(p.id) ? "off" : "on"
        }`,
      })),
      index: 0,
      onSelectCommand: "plugin show",
    },
  })
}

/** Render a plugin's detail as a markdown document. Pure (unit-tested raw). */
export function buildPluginDocument(plugin: PluginInfo, enabled: boolean): string {
  const support = plugin.supported
    ? "runnable in CLI"
    : `not runnable in CLI (${plugin.type} needs the desktop host)`
  const lines: string[] = [
    `# ${plugin.name}`,
    "",
    `\`${plugin.id}\` · v${plugin.version} · ${plugin.type} · ${enabled ? "enabled" : "disabled"}`,
    "",
    `_${support}_`,
    "",
  ]
  if (plugin.description) lines.push(`> ${plugin.description}`, "")
  if (plugin.tools.length > 0) {
    lines.push(
      `**Tools (${plugin.tools.length}):** ${plugin.tools.map((t) => t.name).join(", ")}`,
      "",
      `_Run \`/plugin tools ${plugin.id}\` to see each tool's schema._`
    )
  } else {
    lines.push("_This plugin declares no agent tools._")
  }
  return lines.join("\n")
}

export async function pluginShow(id: string, deps: PluginDeps): Promise<void> {
  const plugins = await loadPlugins(deps)
  const plugin = plugins.find((p) => p.id === id)
  if (!plugin) {
    deps.dispatch({ type: "NOTICE", message: `Plugin ${id} not found.` })
    return
  }
  const enabled = !disabledOf(deps).has(plugin.id)
  openDocument(deps.dispatch, {
    title: `Plugin · ${plugin.name}`,
    body: buildPluginDocument(plugin, enabled),
    format: "markdown",
  })
}

/** `/plugin tools <id>` — show each declared tool's description + schema. */
export async function pluginTools(id: string, deps: PluginDeps): Promise<void> {
  const plugins = await loadPlugins(deps)
  const plugin = plugins.find((p) => p.id === id)
  if (!plugin) {
    deps.dispatch({ type: "NOTICE", message: `Plugin ${id} not found.` })
    return
  }
  if (plugin.tools.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message: `Plugin "${plugin.name}" declares no agent tools.`,
    })
    return
  }
  openDocument(deps.dispatch, {
    title: `Tools · ${plugin.name} (${plugin.tools.length})`,
    body: buildToolsDocument(
      plugin.tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        schema: t.parametersSchema,
      })),
      `${plugin.tools.length} tool${plugin.tools.length === 1 ? "" : "s"} declared by \`${plugin.id}\`.`
    ),
    format: "markdown",
  })
}

export function pluginSetEnabled(id: string, enabled: boolean, deps: PluginDeps): void {
  ;(deps.setEnabled ?? ((i, d) => setPluginDisabled(deps.home, i, d)))(id, !enabled)
  deps.dispatch({
    type: "NOTICE",
    message: `Plugin "${id}" ${enabled ? "enabled" : "disabled"}.`,
  })
}
