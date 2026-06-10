/**
 * Derive a one-line usage hint for a command — shown inline in the palette and
 * after a resolved command in the composer. Pure.
 */
import type { CommandArgSpec, CommandDescriptor } from "./types"

function formatSpec(spec: CommandArgSpec): string {
  const positional = spec.style === "positional"
  const token = positional ? spec.name : `--${spec.name}`
  return spec.required ? `<${token}>` : `[${token}]`
}

export function formatArgHint(desc: CommandDescriptor): string {
  if (desc.argumentHint) return desc.argumentHint
  if (desc.subcommands && desc.subcommands.length > 0) {
    return `<${desc.subcommands.map((s) => s.name).join(" | ")}>`
  }
  if (desc.args && desc.args.length > 0) {
    return desc.args.map(formatSpec).join(" ")
  }
  return ""
}
