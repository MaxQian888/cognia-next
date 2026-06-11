/**
 * Discover installed plugins by scanning `.cognia/plugins/<id>/plugin.json`
 * (project + home). Read-only inventory — parses the manifest without loading or
 * executing plugin code. Only `type: "frontend"` plugins are CLI-runnable today;
 * python / wasm / vscode-extension / hybrid need the Tauri host and are surfaced
 * as "unsupported in CLI".
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import type { PluginType } from "@/types/plugin/plugin"

export interface PluginFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  readText(path: string): Promise<string>
}

const defaultFs: PluginFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async readDir(p) {
    try {
      return await nodeFs.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFs.readFile(p, "utf8"),
}

/** A declared agent tool surfaced from a plugin manifest's `tools` array. */
export interface PluginToolInfo {
  name: string
  description: string
  category?: string
  /** JSON-Schema for the tool's parameters (`manifest.tools[].parametersSchema`). */
  parametersSchema?: Record<string, unknown>
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  type: PluginType
  dir: string
  /** Whether the CLI can run this plugin's tools (frontend/JS only). */
  supported: boolean
  /** Agent tools the manifest declares (`manifest.tools`). Empty when none. */
  tools: PluginToolInfo[]
}

function parseManifest(text: string, dir: string): PluginInfo | null {
  let m: Record<string, unknown>
  try {
    m = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof m.id !== "string" || typeof m.name !== "string" || typeof m.type !== "string") {
    return null
  }
  return {
    id: m.id,
    name: m.name,
    version: typeof m.version === "string" ? m.version : "0.0.0",
    description: typeof m.description === "string" ? m.description : "",
    type: m.type as PluginType,
    dir,
    supported: m.type === "frontend",
    tools: parseTools(m.tools),
  }
}

/** Parse the manifest `tools` array, skipping malformed entries. */
function parseTools(raw: unknown): PluginToolInfo[] {
  if (!Array.isArray(raw)) return []
  const out: PluginToolInfo[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const t = entry as Record<string, unknown>
    if (typeof t.name !== "string") continue
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      ...(typeof t.category === "string" ? { category: t.category } : {}),
      ...(t.parametersSchema && typeof t.parametersSchema === "object"
        ? { parametersSchema: t.parametersSchema as Record<string, unknown> }
        : {}),
    })
  }
  return out
}

/** Scan the plugin dirs and return parsed manifests (first id wins). */
export async function discoverPlugins(
  roots: string[],
  fs: PluginFs = defaultFs
): Promise<PluginInfo[]> {
  const byId = new Map<string, PluginInfo>()
  for (const root of roots) {
    const pluginsDir = path.join(root, ".cognia", "plugins")
    if (!(await fs.exists(pluginsDir))) continue
    for (const entry of await fs.readDir(pluginsDir)) {
      const dir = path.join(pluginsDir, entry)
      const manifestPath = path.join(dir, "plugin.json")
      if (!(await fs.exists(manifestPath))) continue
      let text: string
      try {
        text = await fs.readText(manifestPath)
      } catch {
        continue
      }
      const info = parseManifest(text, dir)
      if (info && !byId.has(info.id)) byId.set(info.id, info)
    }
  }
  return [...byId.values()]
}
