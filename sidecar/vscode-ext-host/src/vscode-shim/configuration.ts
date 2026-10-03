/**
 * `vscode.workspace.getConfiguration` and `onDidChangeConfiguration`.
 *
 * Settings are flat VS Code keys (`myExt.server.path`). The renderer owns
 * them: before activation and after every change it reports the defaults
 * every installed extension contributes and the values the user set
 * (`workspace:configurationChanged`, with the keys that changed). The host
 * also reads the defaults its own extension's `package.json` declares, so
 * they hold even when the app's copy of the manifest predates them.
 *
 * Reads are synchronous, as in VS Code. Reading a prefix (`myExt.server`)
 * gives the object assembled from every key under it. Values come back as
 * copies, so an extension changing one does not change the setting.
 *
 * There is one level of values (the user's): updates aimed at the workspace
 * or a folder land there too, and language-specific values are refused.
 */

import { readFileSync } from "node:fs"
import * as nodePath from "node:path"

import type { RpcConnection } from "../rpc"
import { EventEmitter } from "./types"

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string, scope?: unknown): boolean
}

export interface ConfigurationInspect<T> {
  key: string
  defaultValue?: T
  globalValue?: T
  workspaceValue?: T
  workspaceFolderValue?: T
  defaultLanguageValue?: T
  globalLanguageValue?: T
  workspaceLanguageValue?: T
  workspaceFolderLanguageValue?: T
  languageIds?: string[]
}

type Flat = Record<string, unknown>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value)
}

/** Assemble the nested object every flat key under `prefix` describes, or `undefined` for none. */
function subtree(flat: Flat, prefix: string): unknown {
  const keys = Object.keys(flat)
    .filter((key) => key === prefix || key.startsWith(`${prefix}.`) || prefix === "")
    .sort((a, b) => a.split(".").length - b.split(".").length)
  if (keys.length === 0) return undefined
  if (keys.length === 1 && keys[0] === prefix) return clone(flat[prefix])
  let root: Record<string, unknown> = {}
  for (const key of keys) {
    const value = clone(flat[key])
    if (key === prefix) {
      if (isPlainObject(value)) root = { ...value, ...root }
      continue
    }
    const segments = (prefix === "" ? key : key.slice(prefix.length + 1)).split(".")
    let node = root
    for (const segment of segments.slice(0, -1)) {
      if (!isPlainObject(node[segment])) node[segment] = {}
      node = node[segment] as Record<string, unknown>
    }
    const last = segments[segments.length - 1]
    node[last] =
      isPlainObject(value) && isPlainObject(node[last])
        ? { ...(node[last] as Record<string, unknown>), ...value }
        : value
  }
  return root
}

/** The `default`s `package.json` declares under `contributes.configuration`. */
export function packageJsonDefaults(packageJson: unknown): Flat {
  const contributes = isPlainObject(packageJson) ? packageJson.contributes : undefined
  const raw = isPlainObject(contributes) ? contributes.configuration : undefined
  const sections = Array.isArray(raw) ? raw : raw ? [raw] : []
  const defaults: Flat = {}
  for (const section of sections) {
    const properties = isPlainObject(section) ? section.properties : undefined
    if (!isPlainObject(properties)) continue
    for (const [key, property] of Object.entries(properties)) {
      if (isPlainObject(property) && property.default !== undefined && !(key in defaults)) {
        defaults[key] = property.default
      }
    }
  }
  return defaults
}

export class ConfigurationStore {
  private reportedDefaults: Flat = {}
  private ownDefaults: Flat = {}
  private values: Flat = {}
  readonly onDidChange = new EventEmitter<ConfigurationChangeEvent>()

  attach(connection: RpcConnection): void {
    connection.onRequest("workspace:configurationChanged", (params) => {
      const { defaults, values, changed } = params as {
        defaults?: Flat
        values?: Flat
        changed?: string[]
      }
      this.set(defaults ?? {}, values ?? {}, changed ?? [])
      return null
    })
  }

  /** Read the defaults the extension at `extensionPath` declares. */
  loadOwnDefaults(extensionPath: string): void {
    try {
      const text = readFileSync(nodePath.join(extensionPath, "package.json"), "utf-8")
      this.ownDefaults = packageJsonDefaults(JSON.parse(text))
    } catch {
      // No readable package.json: the renderer's defaults are all there is.
      this.ownDefaults = {}
    }
  }

  set(defaults: Flat, values: Flat, changed: string[]): void {
    this.reportedDefaults = defaults
    this.values = values
    if (changed.length === 0) return
    this.onDidChange.fire({
      affectsConfiguration: (section: string) =>
        changed.some(
          (key) => key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`)
        ),
    })
  }

  private defaults(): Flat {
    return { ...this.ownDefaults, ...this.reportedDefaults }
  }

  /** The effective value at `key`: the user's over the default, assembled for a prefix. */
  get(key: string): unknown {
    return subtree({ ...this.defaults(), ...this.values }, key)
  }

  inspect<T>(key: string): ConfigurationInspect<T> {
    return {
      key,
      defaultValue: subtree(this.defaults(), key) as T | undefined,
      globalValue: subtree(this.values, key) as T | undefined,
    }
  }
}

/** `ConfigurationTarget`: Global 1, Workspace 2, WorkspaceFolder 3. */
const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const

/** The object `getConfiguration(section)` returns: the section's settings as properties, and the methods. */
export function createWorkspaceConfiguration(input: {
  store: ConfigurationStore
  connection: RpcConnection
  extensionId: string
  section?: string
}) {
  const { store, connection, extensionId } = input
  const section = input.section ?? ""
  const full = (key: string) => (section ? `${section}.${key}` : key)
  const snapshot = store.get(section)
  const configuration: Record<string, unknown> = isPlainObject(snapshot) ? { ...snapshot } : {}
  Object.defineProperties(configuration, {
    get: {
      value: <T>(key: string, defaultValue?: T): T | undefined => {
        const value = store.get(full(key))
        return value === undefined ? defaultValue : (value as T)
      },
    },
    has: { value: (key: string) => store.get(full(key)) !== undefined },
    inspect: { value: <T>(key: string) => store.inspect<T>(full(key)) },
    update: {
      value: async (
        key: string,
        value: unknown,
        target?: number | boolean | null,
        overrideInLanguage?: boolean
      ): Promise<void> => {
        if (overrideInLanguage) {
          throw new Error("Language-specific settings are not supported")
        }
        const resolvedTarget =
          target === true || target === undefined || target === null
            ? ConfigurationTarget.Global
            : target === false
              ? ConfigurationTarget.Workspace
              : target
        await connection.sendRequest("workspace:configurationUpdate", {
          extensionId,
          key: full(key),
          // JSON has no `undefined`: say so for a value being removed.
          ...(value === undefined ? { remove: true } : { value }),
          target: resolvedTarget,
        })
      },
    },
  })
  return Object.freeze(configuration)
}
