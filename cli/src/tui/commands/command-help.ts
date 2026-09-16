/** Focused, localized help for a slash command. Contributed copy stays intact. */
import commandMessages from "@/i18n/messages/en/cliUiCommands.json"
import { createCliTranslator, type CliLocale } from "../i18n"
import { localizedCommandDescription } from "./help-model"
import type { CommandArgSpec, CommandDescriptor, SubcommandSpec } from "./types"

type Translator = ReturnType<typeof createCliTranslator>
const subcommands: Record<string, Record<string, string>> = commandMessages.subcommands
const argumentLabels: Record<
  string,
  Record<string, Record<string, string>>
> = commandMessages.argumentsLabels

function renderArg(a: CommandArgSpec, t: Translator, command: string, subcommand = ""): string {
  const opt = a.required ? "" : ` _(${t("optional")})_`
  const choices =
    a.type === "enum" && a.options?.length
      ? ` — ${t("oneOf", { choices: a.options.join(", ") })}`
      : ""
  const translatedLabel = argumentLabels[command]?.[subcommand]?.[a.name]
    ? t(`argumentsLabels.${command}.${subcommand}.${a.name}`)
    : a.label
  const label = translatedLabel && translatedLabel !== a.name ? ` — ${translatedLabel}` : ""
  return `- \`${a.name}\`${opt}${label}${choices}`
}

function renderSub(cmd: string, s: SubcommandSpec, t: Translator): string {
  const hint = s.argumentHint ? ` ${s.argumentHint}` : ""
  const description = subcommands[cmd]?.[s.name] ? t(`subcommands.${cmd}.${s.name}`) : s.description
  const lines = [`- \`/${cmd} ${s.name}${hint}\` — ${description}`]
  for (const arg of s.args ?? []) lines.push(`  ${renderArg(arg, t, cmd, s.name)}`)
  return lines.join("\n")
}

/** Identifiers, enum values and usage syntax remain executable in every locale. */
export function buildCommandHelpDocument(
  desc: CommandDescriptor,
  locale?: CliLocale
): {
  title: string
  body: string
} {
  const t = createCliTranslator(locale, "cliUiCommands")
  const lines: string[] = [`# /${desc.name}`]
  if (desc.aliases && desc.aliases.length > 0) {
    lines.push("", `**${t("aliases")}** ${desc.aliases.map((a) => `/${a}`).join(", ")}`)
  }
  lines.push("", localizedCommandDescription(desc, t))
  if (desc.argumentHint) lines.push("", `**${t("usage")}** \`/${desc.name} ${desc.argumentHint}\``)
  if (desc.args && desc.args.length > 0) {
    lines.push("", `## ${t("argsTitle")}`)
    for (const a of desc.args) lines.push(renderArg(a, t, desc.name))
  }
  if (desc.subcommands && desc.subcommands.length > 0) {
    lines.push("", `## ${t("subcommandsTitle")}`)
    for (const s of desc.subcommands) lines.push(renderSub(desc.name, s, t))
  }
  return { title: t("helpTitle", { command: desc.name }), body: lines.join("\n") }
}
