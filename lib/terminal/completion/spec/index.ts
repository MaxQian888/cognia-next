/**
 * Registry of the in-repo CLI completion specs. Lookup is by head word,
 * case-insensitive, with Windows `.exe`-style suffixes stripped so
 * `git.exe` still resolves the git spec.
 */

import type { CliSpec } from "./types"
import { gitSpec } from "./specs/git"
import { npmSpec, pnpmSpec, yarnSpec } from "./specs/node-package-managers"
import { bunSpec, cargoSpec, denoSpec, goSpec, nodeSpec } from "./specs/rust-and-runtimes"
import { dockerSpec, kubectlSpec, terraformSpec } from "./specs/containers-and-cloud"
import { brewSpec, ghSpec, makeSpec, pipSpec } from "./specs/dev-tools"

export const ALL_SPECS: CliSpec[] = [
  gitSpec,
  npmSpec,
  pnpmSpec,
  yarnSpec,
  cargoSpec,
  nodeSpec,
  denoSpec,
  bunSpec,
  goSpec,
  dockerSpec,
  kubectlSpec,
  terraformSpec,
  ghSpec,
  pipSpec,
  makeSpec,
  brewSpec,
]

const REGISTRY: Map<string, CliSpec> = new Map(ALL_SPECS.map((s) => [s.name.toLowerCase(), s]))

/** Look up the spec for a typed head word (`git`, `Git.exe`, …). */
export function getSpec(head: string): CliSpec | null {
  const normalized = head.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "")
  return REGISTRY.get(normalized) ?? null
}
