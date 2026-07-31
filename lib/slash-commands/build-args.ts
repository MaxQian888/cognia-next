// Convert the values collected by a slash command's guided parameter form into
// the args string the command's handler / template expects. Pure and
// unit-tested; mirrors the flag syntax the action handlers already parse (e.g.
// `/ocr --provider auto --lang en` in `lib/slash-commands/actions/ocr.ts`).

import type { SlashParamSpec } from "./builtin"

/**
 * Build an args string from param specs + collected values. Values are emitted
 * raw (no quoting) because the downstream parsers — `applyTemplate`'s
 * `$ARGUMENTS`, the `/loop` "rest" splitter, the `/ocr` flag tokenizer — consume
 * them verbatim and do not unquote.
 *   - boolean → emits the bare `--name` flag when truthy, nothing when falsy
 *   - positional → emits the bare value, in spec order
 *   - flag (default) → emits `--name value`
 * Empty/whitespace values are skipped (the form enforces `required`).
 */
export function buildArgs(specs: SlashParamSpec[], values: Record<string, string>): string {
  const parts: string[] = []
  for (const spec of specs) {
    const raw = (values[spec.name] ?? spec.default ?? "").trim()
    if (spec.type === "boolean") {
      if (raw && raw !== "false") parts.push(`--${spec.name}`)
      continue
    }
    if (!raw) continue
    if (spec.style === "positional") {
      parts.push(raw)
    } else {
      parts.push(`--${spec.name}`, raw)
    }
  }
  return parts.join(" ")
}

/** First missing required field, or null when the values satisfy every spec. */
export function firstMissingRequired(
  specs: SlashParamSpec[],
  values: Record<string, string>
): SlashParamSpec | null {
  for (const spec of specs) {
    if (!spec.required) continue
    if (spec.type === "boolean") continue
    const raw = (values[spec.name] ?? spec.default ?? "").trim()
    if (!raw) return spec
  }
  return null
}
