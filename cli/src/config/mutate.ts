/**
 * Writer for `~/.cognia/config.json` (the non-secret user config). Backs
 * `cognia-agent config set`. Validates the merged result against the schema so
 * a bad value is rejected before it lands on disk. Injectable fs for tests.
 */

import fs from "node:fs"
import path from "node:path"

import { cliConfigFileSchema, type CliConfigFile } from "./schema"
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
export const SETTABLE_KEYS = ["provider", "model", "systemPrompt", "permissionMode", "cwd"] as const
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
