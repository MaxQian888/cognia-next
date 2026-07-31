/**
 * Turn an external CLI binary into a `cli-tools` skeleton.
 *
 * This branch deliberately stops short of a working tool. Producing a
 * usable `cliTools` entry requires knowing, per flag, whether it takes a
 * value, whether it repeats, what the exit codes mean, and how the output
 * should be parsed. A binary's `--help` states almost none of that — no
 * help text says that ripgrep's exit code 1 means "no matches, which is
 * success" — and the converter never executes anything anyway. A guessed
 * parameter table would lint green and misbehave, which is worse than an
 * obviously-unfinished one.
 *
 * So the skeleton declares the capability, the permission, and the binary
 * requirement, and leaves `cliTools` empty. The host validator already
 * flags that shape as `manifest.capability.field_missing`, so
 * `cognia plugin lint` (and `lint -W` in CI) marks the plugin unfinished
 * with no new rule. The generated README carries the full argv DSL
 * reference and points at `plugins/ripgrep-tools`.
 */

import type { PluginCliToolDef } from "@/types/plugin/plugin-cli-tool"
import type { ConvertCandidate } from "./types"

/** Permission the host requires before any declarative CLI tool may run. */
export const CLI_EXECUTE_PERMISSION = "cli:execute"

/** One binary requirement, as it appears under `manifest.requires.binaries`. */
export interface CliBinaryRequirement {
  name: string
  minVersion?: string
  documentation?: string
}

export interface BuiltCliSkeleton {
  binary: CliBinaryRequirement
  /** Always empty — see the module header. */
  cliTools: PluginCliToolDef[]
  todos: string[]
}

/** Reject shell metacharacters and paths; `requires.binaries` holds a name. */
export function assertBinaryName(binary: string): string {
  const name = binary.trim()
  if (!name) throw new Error("--input is required for --from cli (the binary name, e.g. `rg`)")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `"${binary}" is not a bare binary name — pass the name as it appears on PATH (e.g. \`rg\`), not a path or command line`
    )
  }
  return name
}

/** The only candidate a CLI input offers is the binary itself. */
export function listCliCandidates(binary: string): ConvertCandidate[] {
  const name = assertBinaryName(binary)
  return [{ id: name, label: name, detail: "external binary resolved on PATH" }]
}

/** Build the skeleton for one binary. */
export function buildCliSkeleton(binary: string): BuiltCliSkeleton {
  const name = assertBinaryName(binary)
  return {
    binary: { name },
    cliTools: [],
    todos: [
      `cliTools is empty — add at least one tool definition, or \`cognia plugin lint\` will report manifest.capability.field_missing`,
      `set requires.binaries[0].minVersion and documentation so users get an actionable message when ${name} is missing`,
      `see README.md for the argv DSL and plugins/ripgrep-tools for a complete example`,
    ],
  }
}
