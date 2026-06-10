/**
 * Per-user plugin enable/disable overlay, persisted to
 * `~/.cognia/plugin-state.json` as `{ "disabled": ["id", …] }`. Plugins are
 * enabled by default; this records the `/plugin disable` opt-outs.
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface PluginStateFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, data: string): void
}

const defaultFs: PluginStateFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    nodeFs.writeFileSync(p, data, "utf8")
  },
}

export function pluginStatePath(home: string): string {
  return path.join(home, "plugin-state.json")
}

export function readDisabledPlugins(home: string, fs: PluginStateFs = defaultFs): Set<string> {
  const file = pluginStatePath(home)
  if (!fs.exists(file)) return new Set()
  try {
    const parsed = JSON.parse(fs.readText(file)) as { disabled?: unknown }
    if (Array.isArray(parsed.disabled)) {
      return new Set(parsed.disabled.filter((n): n is string => typeof n === "string"))
    }
  } catch {
    // corrupt → empty
  }
  return new Set()
}

export function setPluginDisabled(
  home: string,
  id: string,
  disabled: boolean,
  fs: PluginStateFs = defaultFs
): Set<string> {
  const set = readDisabledPlugins(home, fs)
  if (disabled) set.add(id)
  else set.delete(id)
  fs.writeText(pluginStatePath(home), JSON.stringify({ disabled: [...set] }, null, 2))
  return set
}
