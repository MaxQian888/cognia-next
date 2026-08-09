/**
 * Template engine for parameterized terminal commands.
 *
 * Supports the following variable syntax:
 *   ${input:label}              — prompts user for text input
 *   ${input:label:default}      — with a default value
 *   ${select:label:opt1,opt2}   — dropdown selection
 *   ${env:NAME}                 — resolved from session env vars
 *   ${cwd}                      — current working directory
 *   ${clipboard}                — clipboard content
 *   ${date:FORMAT}              — formatted date (YYYY, MM, DD, HH, mm, ss substitution)
 *
 * Parsing extracts the variables; resolution fills them in. `input` and
 * `select` types require interactive prompting — they aren't auto-resolvable.
 */

/** The variable types the engine recognizes. */
export type TemplateVarKind = "input" | "select" | "env" | "cwd" | "clipboard" | "date"

/** A parsed variable occurrence within a template string. */
export interface TemplateVariable {
  /** Full matched token including `${…}`. */
  raw: string
  kind: TemplateVarKind
  /** User-visible label (for `input` / `select`) or the format/env-name. */
  label: string
  /** Default value for `input`, or undefined. */
  defaultValue?: string
  /** Selectable options for `select`. */
  options?: string[]
}

/** Regex to find template variables. */
const VAR_RE = /\$\{(input|select|env|cwd|clipboard|date)(?::([^}]*))?}/g

/**
 * Parse a template string and extract all variable occurrences.
 * Returns an empty array if no variables are found.
 */
export function parseTemplateVars(template: string): TemplateVariable[] {
  const vars: TemplateVariable[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  // Reset lastIndex for the global regex.
  VAR_RE.lastIndex = 0
  while ((match = VAR_RE.exec(template)) !== null) {
    const raw = match[0]
    if (seen.has(raw)) continue
    seen.add(raw)

    const kind = match[1] as TemplateVarKind
    const args = match[2] ?? ""

    switch (kind) {
      case "input": {
        // ${input:label} or ${input:label:default}
        const colonIdx = args.indexOf(":")
        if (colonIdx === -1) {
          vars.push({ raw, kind, label: args || "Value" })
        } else {
          vars.push({
            raw,
            kind,
            label: args.slice(0, colonIdx) || "Value",
            defaultValue: args.slice(colonIdx + 1),
          })
        }
        break
      }
      case "select": {
        // ${select:label:opt1,opt2,opt3}
        const colonIdx = args.indexOf(":")
        if (colonIdx === -1) {
          vars.push({ raw, kind, label: args || "Choice", options: [] })
        } else {
          const label = args.slice(0, colonIdx) || "Choice"
          const options = args
            .slice(colonIdx + 1)
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
          vars.push({ raw, kind, label, options })
        }
        break
      }
      case "env":
        vars.push({ raw, kind, label: args })
        break
      case "cwd":
        vars.push({ raw, kind, label: "cwd" })
        break
      case "clipboard":
        vars.push({ raw, kind, label: "clipboard" })
        break
      case "date":
        vars.push({ raw, kind, label: args || "YYYY-MM-DD" })
        break
    }
  }
  return vars
}

/** Whether a template contains any variables that need prompting (input/select). */
export function hasInteractiveVars(template: string): boolean {
  return parseTemplateVars(template).some((v) => v.kind === "input" || v.kind === "select")
}

/** Whether a template contains any variables at all. */
export function hasTemplateVars(template: string): boolean {
  VAR_RE.lastIndex = 0
  return VAR_RE.test(template)
}

/**
 * Context for resolving non-interactive variables.
 */
export interface TemplateResolveContext {
  /** Session env vars. */
  env?: Record<string, string>
  /** Current working directory. */
  cwd?: string | null
  /** Clipboard text content. */
  clipboard?: string | null
}

/**
 * Resolve a template given user-supplied values for interactive vars and
 * context for auto-resolvable ones.
 *
 * `values` is keyed by the `raw` token string (e.g. `"${input:name}"`).
 */
export function resolveTemplate(
  template: string,
  values: Record<string, string>,
  ctx: TemplateResolveContext = {}
): string {
  return template.replace(VAR_RE, (raw, kind: TemplateVarKind, args: string | undefined) => {
    // User-supplied value takes precedence.
    if (raw in values) return values[raw]

    switch (kind) {
      case "env": {
        const name = args ?? ""
        return ctx.env?.[name] ?? ""
      }
      case "cwd":
        return ctx.cwd ?? ""
      case "clipboard":
        return ctx.clipboard ?? ""
      case "date": {
        const format = args ?? "YYYY-MM-DD"
        return formatDate(format, new Date())
      }
      default:
        // Unresolved interactive vars stay as-is (shouldn't happen if prompting worked).
        return raw
    }
  })
}

/**
 * Simple date formatter supporting YYYY, MM, DD, HH, mm, ss tokens.
 * Exported for testing.
 */
export function formatDate(format: string, date: Date): string {
  const y = String(date.getFullYear())
  const M = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  const H = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")

  return format
    .replace("YYYY", y)
    .replace("MM", M)
    .replace("DD", d)
    .replace("HH", H)
    .replace("mm", m)
    .replace("ss", s)
}
