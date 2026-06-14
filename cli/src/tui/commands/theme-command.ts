/**
 * `/theme` — the TUI colour theme.
 *
 *   /theme                  open the theme picker (reuses the select overlay)
 *   /theme <name>           set a theme (built-in | claude-code | codex | custom:<slug>)
 *   /theme set <name>       same, explicit verb
 *
 * Pure handler: returns a `theme` effect the App persists (scalar config key)
 * and live-applies via the reducer, which re-resolves the palette. The picker
 * re-dispatches `/theme set <id>` through the generic select overlay — no
 * bespoke wiring (mirrors `/mascot` and `/statusbar`).
 */
import { THEME_CHOICES } from "../theme/resolve"
import { getBuiltinTheme } from "../theme/builtins"
import { normalizeInkColor } from "../theme/color"
import type {
  CommandArgSpec,
  CommandContext,
  CommandDescriptor,
  CommandEffect,
  FormRequest,
} from "./types"

function isValid(value: string): boolean {
  return THEME_CHOICES.includes(value) || value.startsWith("custom:")
}

/** The 8 editable base roles, in form order. `text` is optional (terminal default). */
export const BASE_COLOR_KEYS = [
  "accent",
  "secondary",
  "info",
  "success",
  "warning",
  "danger",
  "muted",
  "text",
] as const

/** Build the custom-theme colour form, seeding each field from the closest
 * built-in palette so the user edits real values rather than blanks. */
export function buildCustomThemeForm(ctx: CommandContext): FormRequest {
  const baseName =
    ctx.config.theme && THEME_CHOICES.includes(ctx.config.theme) ? ctx.config.theme : "classic"
  const palette = getBuiltinTheme(baseName) as unknown as Record<string, string | undefined>
  const specs: CommandArgSpec[] = BASE_COLOR_KEYS.map((key) => ({
    name: key,
    label: key,
    type: "string",
    required: key !== "text",
    default: palette[key] ?? "",
    placeholder: "#rrggbb | name | rgb(r,g,b)",
  }))
  return { title: "Custom theme colours", commandName: "theme", subcommand: "custom", specs }
}

/** Parse `--accent #x --muted gray …` into a validated base-colour map. */
export function parseBaseColors(flags: string): Record<string, string> {
  const tokens = flags.split(/\s+/).filter(Boolean)
  const out: Record<string, string> = {}
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t.startsWith("--")) continue
    const key = t.slice(2)
    const value = tokens[i + 1]
    if (!value || value.startsWith("--")) continue
    i++
    if (!(BASE_COLOR_KEYS as readonly string[]).includes(key)) continue
    const color = normalizeInkColor(value)
    if (color !== null) out[key] = color
  }
  return out
}

function handle(ctx: CommandContext): CommandEffect {
  const args = ctx.args.trim()
  if (!args) {
    const current = ctx.config.theme ?? "classic"
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Colour theme",
        items: THEME_CHOICES.map((name) => ({
          id: name,
          label: name,
          hint: name === current ? "current" : undefined,
        })),
        index: 0,
        onSelectCommand: "theme set",
      },
    }
  }

  const [verb, ...rest] = args.split(/\s+/)
  // `/theme custom` → open the colour editor; with flags → apply the edited theme.
  if (verb.toLowerCase() === "custom") {
    const flags = rest.join(" ").trim()
    if (!flags) return { kind: "openForm", form: buildCustomThemeForm(ctx) }
    const base = parseBaseColors(flags)
    if (Object.keys(base).length === 0) {
      return {
        kind: "notice",
        message: "No valid colours — use #rrggbb, an ANSI name, or rgb(r,g,b).",
      }
    }
    return { kind: "customTheme", base }
  }
  const value = (verb.toLowerCase() === "set" ? rest.join(" ") : args).trim()
  if (!isValid(value)) {
    return {
      kind: "notice",
      message: `Unknown theme "${value}" — choose: ${THEME_CHOICES.join(", ")}, or custom:<slug>`,
    }
  }
  return { kind: "theme", theme: value }
}

export const themeCommand: CommandDescriptor = {
  name: "theme",
  description: "switch the TUI colour theme (reuse Claude Code / Codex themes)",
  category: "config",
  argumentHint: "[<name> | set <name> | custom]",
  handler: handle,
}
