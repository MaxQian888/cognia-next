/**
 * `/plugin` controller — discover and inspect installed plugins (read-only) and
 * toggle their enabled state. Reuses the file-based plugin discovery; plugin
 * TOOL execution from the CLI (the `plugin_tool_exec` round-trip) is a tracked
 * follow-up, so this surfaces the inventory + supported/enabled state honestly.
 */
import { discoverPlugins, type PluginInfo } from "../../plugin/discover-plugins"
import { readDisabledPlugins, setPluginDisabled } from "../../plugin/plugin-state"
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

export async function pluginShow(id: string, deps: PluginDeps): Promise<void> {
  const plugins = await loadPlugins(deps)
  const plugin = plugins.find((p) => p.id === id)
  if (!plugin) {
    deps.dispatch({ type: "NOTICE", message: `Plugin ${id} not found.` })
    return
  }
  const support = plugin.supported
    ? "runnable in CLI"
    : `not runnable in CLI (${plugin.type} needs the desktop host)`
  deps.dispatch({
    type: "NOTICE",
    message: `${plugin.name} v${plugin.version} [${plugin.type}]\n${plugin.description}\n${support}`,
  })
}

export function pluginSetEnabled(id: string, enabled: boolean, deps: PluginDeps): void {
  ;(deps.setEnabled ?? ((i, d) => setPluginDisabled(deps.home, i, d)))(id, !enabled)
  deps.dispatch({
    type: "NOTICE",
    message: `Plugin "${id}" ${enabled ? "enabled" : "disabled"}.`,
  })
}
