/**
 * Build a focused help document for a single slash command — the body shown by
 * `/help <command>`. Pure presenter: renders the command's description, aliases,
 * usage hint, structured arguments, and subcommands as markdown so the document
 * pager colourises it. Complements the category-grouped `/help` overlay (which
 * only lists names) with per-command detail the user would otherwise have to
 * guess.
 */
import type { CommandArgSpec, CommandDescriptor, SubcommandSpec } from "./types"

function renderArg(a: CommandArgSpec): string {
  const opt = a.required ? "" : " _(optional)_"
  const choices = a.type === "enum" && a.options?.length ? ` — one of: ${a.options.join(", ")}` : ""
  const label = a.label && a.label !== a.name ? ` — ${a.label}` : ""
  return `- \`${a.name}\`${opt}${label}${choices}`
}

function renderSub(cmd: string, s: SubcommandSpec): string {
  const hint = s.argumentHint ? ` ${s.argumentHint}` : ""
  return `- \`/${cmd} ${s.name}${hint}\` — ${s.description}`
}

/** The title + markdown body for `/help <command>`. */
export function buildCommandHelpDocument(desc: CommandDescriptor): {
  title: string
  body: string
} {
  const lines: string[] = []
  lines.push(`# /${desc.name}`)
  if (desc.aliases && desc.aliases.length > 0) {
    lines.push("")
    lines.push(`**Aliases:** ${desc.aliases.map((a) => `/${a}`).join(", ")}`)
  }
  lines.push("")
  lines.push(desc.description)
  if (desc.argumentHint) {
    lines.push("")
    lines.push(`**Usage:** \`/${desc.name} ${desc.argumentHint}\``)
  }
  if (desc.args && desc.args.length > 0) {
    lines.push("")
    lines.push("## Arguments")
    for (const a of desc.args) lines.push(renderArg(a))
  }
  if (desc.subcommands && desc.subcommands.length > 0) {
    lines.push("")
    lines.push("## Subcommands")
    for (const s of desc.subcommands) lines.push(renderSub(desc.name, s))
  }
  return { title: `Help: /${desc.name}`, body: lines.join("\n") }
}
