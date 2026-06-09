/**
 * PII-redaction tool-permission gate for the plugin Agent SDK.
 *
 * Returns a {@link PluginToolPermissionFn} that, instead of hard-denying a tool
 * call, rewrites every string-valued argument through the twin ingest redactor
 * (`lib/twin/ingest/redact.ts`) and lets the call proceed with placeholders
 * substituted (`<EMAIL_001>`, `<API_KEY_002>`, …). This mirrors the sidecar's
 * rewrite-capable `canUseTool` contract (`{ behavior: "allow", updatedInput }`)
 * and reuses the same redactor the Twin / Goal / Connector paths gate on.
 */

import { redactText } from "@/lib/twin/ingest/redact"
import type {
  PluginToolPermissionFn,
  PluginToolPermissionResult,
} from "@/types/plugin/plugin-agent-sdk"

export interface PiiRedactionGateOptions {
  /**
   * Extra name hints fed to the redactor (chat speakers, known employee names).
   * The base redactor only redacts names it is explicitly told about.
   */
  nameHints?: string[]
  /**
   * Called whenever a tool argument was rewritten, with the count of distinct
   * placeholders introduced for that call. Best-effort telemetry hook.
   */
  onRedact?: (toolName: string, redactedCount: number) => void
}

/**
 * Recursively redact every string leaf in `value`, accumulating the number of
 * placeholders introduced. Arrays and plain objects are walked; non-string
 * leaves pass through untouched. Returns a structurally-cloned value.
 */
function redactDeep(value: unknown, nameHints: string[], counter: { count: number }): unknown {
  if (typeof value === "string") {
    const { redacted, map } = redactText(value, nameHints)
    counter.count += Object.keys(map).length
    return redacted
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, nameHints, counter))
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(inner, nameHints, counter)
    }
    return out
  }
  return value
}

/**
 * Build a permission gate that redacts PII out of tool-call arguments.
 *
 * @example
 *   ctx.agent.run(prompt, { canUseTool: createPiiRedactionGate() })
 */
export function createPiiRedactionGate(
  options: PiiRedactionGateOptions = {}
): PluginToolPermissionFn {
  const nameHints = options.nameHints ?? []
  return (toolName, input): PluginToolPermissionResult => {
    const counter = { count: 0 }
    const updated = redactDeep(input, nameHints, counter) as Record<string, unknown>
    if (counter.count > 0) {
      options.onRedact?.(toolName, counter.count)
      return { behavior: "allow", updatedInput: updated }
    }
    // Nothing to rewrite — allow unchanged (no `updatedInput` so the caller
    // keeps the original reference).
    return { behavior: "allow" }
  }
}
