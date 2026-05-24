import type { ParsedError, ParsedNode } from "../types"

/**
 * Cognia runtime / sidecar / dispatch failures → stable category id. These are
 * host-emitted strings (see the sidecar dispatchers and run-and-capture), so
 * the patterns are intentionally specific to avoid false positives.
 */
const RUNTIME_RULES: ReadonlyArray<{ re: RegExp; category: string }> = [
  {
    re: /session[^\n]{0,80}did not end within|session[^\n]{0,40}timed out/i,
    category: "sessionTimeout",
  },
  { re: /sidecar[^\n]{0,20}(?:exited|crashed)|sidecar_exited/i, category: "sidecarExited" },
  {
    re: /has no resolvable[^\n]{0,40}protocol|no resolvable AI[- ]?SDK protocol/i,
    category: "providerMisconfigured",
  },
  {
    re: /model is required when provider|no model (?:selected|configured|set)/i,
    category: "modelRequired",
  },
  {
    re: /plugin tool not found|tool not found:|unknown (?:plugin )?tool\b/i,
    category: "pluginToolMissing",
  },
  {
    re: /dispatch[^\n]{0,30}failed|failed to dispatch|dispatch returned null/i,
    category: "dispatchFailed",
  },
]

/**
 * Recognise Cognia runtime failures surfaced as plain strings — session
 * timeouts, sidecar process exits, provider/model misconfiguration, missing
 * plugin tools, dispatch failures — and emit a `category` badge node plus a
 * `text` node carrying the original message. Returns `null` when no runtime
 * signal is present.
 */
export const runtimeErrorParser = {
  name: "runtime-error",

  parse(text: string): ParsedError | null {
    for (const rule of RUNTIME_RULES) {
      if (rule.re.test(text)) {
        const nodes: ParsedNode[] = [
          { kind: "category", content: text.trim(), category: rule.category },
          { kind: "text", content: text },
        ]
        return { nodes, parsed: true }
      }
    }
    return null
  },
}
