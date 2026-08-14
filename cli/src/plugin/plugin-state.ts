/**
 * Per-user plugin enable/disable overlay, persisted to
 * `~/.cognia/plugin-state.json`. The legacy `disabled[]` projection remains
 * readable for older CLIs while `lifecycle` is the canonical CAS state.
 */
import nodeFs from "node:fs"
import path from "node:path"
import {
  PluginLifecycleRevisionError,
  type PluginLifecycleRecord,
  type PluginLifecycleStateAdapter,
} from "@/lib/plugin/core/lifecycle-state"

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

export interface CliPluginStateDocument {
  version: 2
  disabled: string[]
  lifecycle: Record<string, PluginLifecycleRecord>
}

function emptyDocument(): CliPluginStateDocument {
  return { version: 2, disabled: [], lifecycle: {} }
}

export function readPluginState(
  home: string,
  fs: PluginStateFs = defaultFs
): CliPluginStateDocument {
  const file = pluginStatePath(home)
  if (!fs.exists(file)) return emptyDocument()
  try {
    const parsed = JSON.parse(fs.readText(file)) as {
      disabled?: unknown
      lifecycle?: unknown
    }
    const disabled = Array.isArray(parsed.disabled)
      ? parsed.disabled.filter((id): id is string => typeof id === "string")
      : []
    const lifecycle =
      parsed.lifecycle && typeof parsed.lifecycle === "object"
        ? (parsed.lifecycle as Record<string, PluginLifecycleRecord>)
        : {}
    return { version: 2, disabled, lifecycle }
  } catch {
    return emptyDocument()
  }
}

function writePluginState(home: string, document: CliPluginStateDocument, fs: PluginStateFs): void {
  fs.writeText(pluginStatePath(home), JSON.stringify(document, null, 2))
}

export function readDisabledPlugins(home: string, fs: PluginStateFs = defaultFs): Set<string> {
  return new Set(readPluginState(home, fs).disabled)
}

export function setPluginDisabled(
  home: string,
  id: string,
  disabled: boolean,
  fs: PluginStateFs = defaultFs
): Set<string> {
  const document = readPluginState(home, fs)
  const set = new Set(document.disabled)
  if (disabled) set.add(id)
  else set.delete(id)
  const current = document.lifecycle[id] ?? {
    intent: "auto",
    actual: "inactive",
    revision: 0,
    updatedAt: Date.now(),
  }
  document.disabled = [...set].sort()
  document.lifecycle[id] = {
    ...current,
    intent: disabled ? "disabled" : "enabled",
    revision: current.revision + 1,
    updatedAt: Date.now(),
  }
  writePluginState(home, document, fs)
  return set
}

export function createCliPluginLifecycleStateAdapter(
  home: string,
  fs: PluginStateFs = defaultFs
): PluginLifecycleStateAdapter {
  return {
    async read(pluginId) {
      const document = readPluginState(home, fs)
      return (
        document.lifecycle[pluginId] ?? {
          intent: document.disabled.includes(pluginId) ? "disabled" : "auto",
          actual: "inactive",
          revision: 0,
          updatedAt: Date.now(),
        }
      )
    },
    async write(pluginId, expectedRevision, patch) {
      const document = readPluginState(home, fs)
      const current =
        document.lifecycle[pluginId] ??
        ({
          intent: document.disabled.includes(pluginId) ? "disabled" : "auto",
          actual: "inactive",
          revision: 0,
          updatedAt: Date.now(),
        } satisfies PluginLifecycleRecord)
      if (current.revision !== expectedRevision) {
        throw new PluginLifecycleRevisionError(pluginId)
      }
      const next: PluginLifecycleRecord = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      }
      if (patch.dirty === undefined && "dirty" in patch) delete next.dirty
      if (patch.lastError === undefined && "lastError" in patch) delete next.lastError
      document.lifecycle[pluginId] = next
      const disabled = new Set(document.disabled)
      if (next.intent === "disabled") disabled.add(pluginId)
      else disabled.delete(pluginId)
      document.disabled = [...disabled].sort()
      writePluginState(home, document, fs)
      return next
    },
  }
}
