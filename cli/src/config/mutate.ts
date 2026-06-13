/**
 * Writer for `~/.cognia/config.json` (the non-secret user config). Backs
 * `cognia-agent config set`. Validates the merged result against the schema so
 * a bad value is rejected before it lands on disk. Injectable fs for tests.
 */

import fs from "node:fs"
import path from "node:path"

import {
  cliConfigFileSchema,
  type CliConfigFile,
  type MascotConfig,
  type StatusBarConfig,
} from "./schema"
import { userConfigPath, type FileReader } from "./load"

export interface ConfigMutateFs {
  read: FileReader
  write: (absPath: string, content: string) => void
  mkdirp: (dir: string) => void
}

export const realConfigMutateFs: ConfigMutateFs = {
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  write: (p, content) => fs.writeFileSync(p, content),
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
}

/** Top-level scalar keys editable via `config set`. */
export const SETTABLE_KEYS = [
  "provider",
  "model",
  "systemPrompt",
  "permissionMode",
  "cwd",
  "thinkingLevel",
  "outputStyle",
  "theme",
] as const
export type SettableKey = (typeof SETTABLE_KEYS)[number]

function readUserConfig(home: string, fsx: ConfigMutateFs): CliConfigFile {
  const raw = fsx.read(userConfigPath(home))
  if (raw === null) return {}
  return cliConfigFileSchema.parse(JSON.parse(raw))
}

/**
 * Set one top-level scalar key in config.json, validating the merged file.
 * Returns the absolute path written.
 */
export function setConfigValue(
  home: string,
  key: string,
  value: string,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  if (!(SETTABLE_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown config key "${key}" — settable: ${SETTABLE_KEYS.join(", ")}`)
  }
  const current = readUserConfig(home, fsx)
  const merged = cliConfigFileSchema.parse({ ...current, [key]: value })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Remember a model for a SPECIFIC provider in `config.json`
 * (`providers[providerId].model`). This is the per-provider memory that lets
 * each provider reuse its own last-selected model and stops a single global
 * `model` pin from bleeding across providers. It also CLEARS any legacy
 * top-level `model` key, so an old global pin can't keep shadowing the
 * per-provider value. Validates the merged file before writing; returns the
 * absolute path written.
 */
export function setProviderModel(
  home: string,
  providerId: string,
  modelId: string,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  // Drop the legacy global `model` pin while promoting the per-provider value.
  const { model: _legacyTopLevelModel, ...rest } = current
  const providers = {
    ...rest.providers,
    [providerId]: { ...rest.providers?.[providerId], model: modelId },
  }
  const merged = cliConfigFileSchema.parse({ ...rest, providers })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Merge a status-bar patch into `config.json`'s `statusBar` object (the footer
 * isn't a scalar so it can't go through {@link setConfigValue}). Validates the
 * merged file before writing. Returns the absolute path written.
 */
export function setStatusBarConfig(
  home: string,
  patch: StatusBarConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const statusBar = { ...current.statusBar, ...patch }
  const merged = cliConfigFileSchema.parse({ ...current, statusBar })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Merge a mascot patch into `config.json`'s `mascot` object (same shape as
 * {@link setStatusBarConfig} — an object, not a scalar). Validates the merged
 * file before writing. Returns the absolute path written.
 */
export function setMascotConfig(
  home: string,
  patch: MascotConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const mascot = { ...current.mascot, ...patch }
  const merged = cliConfigFileSchema.parse({ ...current, mascot })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Replace `config.json`'s `additionalRoots` array (the `/add-dir` extra working
 * roots). An array, not a scalar, so it can't go through {@link setConfigValue}.
 * Writes the array verbatim (the controller dedupes/validates first); an empty
 * array clears the key. Validates the merged file; returns the path written.
 */
export function setAdditionalRoots(
  home: string,
  roots: string[],
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const merged = cliConfigFileSchema.parse({
    ...current,
    additionalRoots: roots.length > 0 ? roots : undefined,
  })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Set the boolean `pluginTools` gate in `config.json`. A dedicated writer (not
 * {@link setConfigValue}) because that one only handles string scalars. Used by
 * the effort slider to couple the `"ultracode"` tier to the in-tree
 * dynamic-workflow plugin tools. Validates the merged file; returns the path.
 */
export function setPluginToolsConfig(
  home: string,
  enabled: boolean,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const merged = cliConfigFileSchema.parse({ ...current, pluginTools: enabled })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}
