/**
 * Declarative tool rules: the harness's tool-loop middleware (ADR-0237, C8).
 *
 * Harness² lets an editor write plugin code that runs inside the tool loop.
 * Cognia does not run model-written code as middleware. The recurring shapes
 * that code served are declared instead and applied by this engine:
 *
 * - `error-hint`        a recurring error signature gets a targeted hint
 * - `trim-output`       a noisy result is cut down before it crowds context
 * - `call-cap`          a runaway tool is stopped past N calls per turn, with a reason:
 *                        denied at a permission gate, or its result withheld when
 *                        the call never reached one
 * - `verify-after-write` a write is followed by a reminder to re-check it
 *
 * Every rule can only add text, shorten a result or deny a call. Nothing here
 * can allow a call, re-admit a denied tool or execute anything, so a rule can
 * never widen what a run may do. Patterns are case-insensitive substrings, never
 * regular expressions: a model-written regex is a ReDoS waiting to happen.
 */

import {
  HARNESS_TOOL_RULE_KINDS,
  HARNESS_TOOL_RULES_VERSION,
  type HarnessToolRule,
  type HarnessToolRuleKind,
} from "@cognia/agent-config-types/agent-harness"

export const MAX_TOOL_RULES = 32
const MAX_TEXT = 1_000
const MAX_PATTERNS = 8
const MAX_PATTERN_CHARS = 200
const MIN_TRIM_CHARS = 500
const MAX_TRIM_CHARS = 200_000
const MAX_CALL_CAP = 200
const RULE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TOOL_PATTERN = /^(\*|[A-Za-z0-9_.:-]{1,128}\*?)$/

/** Engine version, part of every snapshot's runtime fingerprint. */
export const TOOL_RULE_ENGINE_VERSION = `tool-rules-${HARNESS_TOOL_RULES_VERSION}.1`

export type ToolRulesParseResult =
  { ok: true; rules: HarnessToolRule[] } | { ok: false; errors: string[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function text(v: unknown, field: string, errors: string[], max = MAX_TEXT): string {
  if (typeof v !== "string" || !v.trim()) {
    errors.push(`${field} must be a non-empty string`)
    return ""
  }
  if (v.length > max) errors.push(`${field} is ${v.length} chars; the limit is ${max}`)
  return v.trim()
}

function int(v: unknown, field: string, min: number, max: number, errors: string[]): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    errors.push(`${field} must be an integer from ${min} to ${max}`)
    return min
  }
  return v
}

const ALLOWED_KEYS: Record<HarnessToolRuleKind, readonly string[]> = {
  "error-hint": ["id", "kind", "tool", "patterns", "hint"],
  "trim-output": ["id", "kind", "tool", "maxChars"],
  "call-cap": ["id", "kind", "tool", "maxCalls", "reason"],
  "verify-after-write": ["id", "kind", "tool", "reminder"],
}

/** Validate an already-parsed `{ version, rules }` document or a bare rule array. */
export function validateHarnessToolRules(value: unknown): ToolRulesParseResult {
  const errors: string[] = []
  let list: unknown
  if (Array.isArray(value)) list = value
  else if (isRecord(value)) {
    if (value.version !== undefined && value.version !== HARNESS_TOOL_RULES_VERSION) {
      errors.push(`version must be ${HARNESS_TOOL_RULES_VERSION}`)
    }
    for (const key of Object.keys(value)) {
      if (key !== "version" && key !== "rules") errors.push(`unknown top-level key "${key}"`)
    }
    list = value.rules
  }
  if (!Array.isArray(list)) {
    return { ok: false, errors: [...errors, 'expected {"version": 1, "rules": [...]}'] }
  }
  if (list.length > MAX_TOOL_RULES) {
    errors.push(`${list.length} rules; the limit is ${MAX_TOOL_RULES}`)
  }
  const rules: HarnessToolRule[] = []
  const ids = new Set<string>()
  list.forEach((raw, index) => {
    const at = `rules[${index}]`
    if (!isRecord(raw)) {
      errors.push(`${at} must be an object`)
      return
    }
    const kind = raw.kind as HarnessToolRuleKind
    if (!HARNESS_TOOL_RULE_KINDS.includes(kind)) {
      errors.push(`${at}.kind must be one of ${HARNESS_TOOL_RULE_KINDS.join(" | ")}`)
      return
    }
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_KEYS[kind].includes(key)) {
        errors.push(`${at}.${key} is not a field of a ${kind} rule`)
      }
    }
    const id = typeof raw.id === "string" ? raw.id : ""
    if (!RULE_ID.test(id)) errors.push(`${at}.id must match ${RULE_ID.source}`)
    else if (ids.has(id)) errors.push(`${at}.id "${id}" is used twice`)
    ids.add(id)
    const tool = typeof raw.tool === "string" ? raw.tool.trim() : ""
    if (!TOOL_PATTERN.test(tool)) {
      errors.push(`${at}.tool must be a tool name, "prefix*" or "*"`)
    }
    switch (kind) {
      case "error-hint": {
        const patterns = Array.isArray(raw.patterns) ? raw.patterns : []
        if (patterns.length === 0 || patterns.length > MAX_PATTERNS) {
          errors.push(`${at}.patterns must hold 1 to ${MAX_PATTERNS} strings`)
        }
        const clean = patterns.map((p, i) =>
          text(p, `${at}.patterns[${i}]`, errors, MAX_PATTERN_CHARS)
        )
        rules.push({ id, kind, tool, patterns: clean, hint: text(raw.hint, `${at}.hint`, errors) })
        break
      }
      case "trim-output":
        rules.push({
          id,
          kind,
          tool,
          maxChars: int(raw.maxChars, `${at}.maxChars`, MIN_TRIM_CHARS, MAX_TRIM_CHARS, errors),
        })
        break
      case "call-cap":
        rules.push({
          id,
          kind,
          tool,
          maxCalls: int(raw.maxCalls, `${at}.maxCalls`, 1, MAX_CALL_CAP, errors),
          reason: text(raw.reason, `${at}.reason`, errors),
        })
        break
      case "verify-after-write":
        rules.push({ id, kind, tool, reminder: text(raw.reminder, `${at}.reminder`, errors) })
        break
    }
  })
  return errors.length ? { ok: false, errors } : { ok: true, rules }
}

/** Parse `tool_rules.json` text. An empty file means no rules. */
export function parseHarnessToolRules(json: string): ToolRulesParseResult {
  if (!json.trim()) return { ok: true, rules: [] }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    return {
      ok: false,
      errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  return validateHarnessToolRules(value)
}

/** Does a rule's `tool` pattern cover this tool name? */
export function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1))
  return pattern === toolName
}

/**
 * Per-turn counters for `call-cap` rules: how many calls of each capped tool
 * actually ran this turn. A call the gate denied does not count.
 */
export interface ToolRuleState {
  calls: Map<string, number>
}

export function createToolRuleState(): ToolRuleState {
  return { calls: new Map() }
}

export type PreToolDecision =
  { action: "allow" } | { action: "deny"; reason: string; ruleId: string }

function capReason(rule: Extract<HarnessToolRule, { kind: "call-cap" }>, toolName: string): string {
  return `${rule.reason} (harness rule ${rule.id}: ${toolName} is limited to ${rule.maxCalls} calls per turn)`
}

/**
 * Decide a call before it runs, for the calls that reach a pre-execution gate
 * (a permission request). Reads the counter; {@link projectToolResult} is what
 * advances it, once the call has run.
 */
export function evaluatePreToolUse(
  rules: readonly HarnessToolRule[],
  state: ToolRuleState,
  toolName: string
): PreToolDecision {
  for (const rule of rules) {
    if (rule.kind !== "call-cap" || !toolMatches(rule.tool, toolName)) continue
    if ((state.calls.get(`${rule.id}:${toolName}`) ?? 0) >= rule.maxCalls) {
      return { action: "deny", ruleId: rule.id, reason: capReason(rule, toolName) }
    }
  }
  return { action: "allow" }
}

/**
 * The text of a tool result when it is textual: a string, or content blocks
 * that are all `{ type: "text" }`. `null` for anything else (images, binary,
 * structured objects), which the engine never rewrites.
 */
export function toolResultText(result: unknown): string | null {
  if (typeof result === "string") return result
  const blocks = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.content)
      ? result.content
      : null
  if (!blocks || blocks.length === 0) return null
  const texts: string[] = []
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null
    texts.push(block.text)
  }
  return texts.join("\n")
}

function trimMiddle(body: string, maxChars: number, ruleId: string): string {
  if (body.length <= maxChars) return body
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  const cut = body.length - head - tail
  return `${body.slice(0, head)}\n[… ${cut} chars trimmed by harness rule ${ruleId} …]\n${body.slice(body.length - tail)}`
}

export interface ToolResultProjection {
  changed: boolean
  /** The rewritten result as text; only meaningful when `changed`. */
  output: string
  appliedRuleIds: string[]
}

/**
 * Apply the result-side rules to one tool result, and count the call against
 * any `call-cap` covering it.
 *
 * A call past its cap that ran anyway (an auto-allowed tool never reaches a
 * pre-execution gate) has its result withheld and replaced by the cap's reason:
 * the model gets the teaching message instead of more of what kept it looping.
 * Every other rule only reshapes text, so a non-text result is left alone
 * (though it is still counted).
 */
export function projectToolResult(
  rules: readonly HarnessToolRule[],
  state: ToolRuleState,
  toolName: string,
  result: unknown,
  isError: boolean
): ToolResultProjection {
  for (const rule of rules) {
    if (rule.kind !== "call-cap" || !toolMatches(rule.tool, toolName)) continue
    const key = `${rule.id}:${toolName}`
    const used = (state.calls.get(key) ?? 0) + 1
    state.calls.set(key, used)
    if (used > rule.maxCalls) {
      return {
        changed: true,
        output: `[harness rule ${rule.id}] Result withheld. ${capReason(rule, toolName)}`,
        appliedRuleIds: [rule.id],
      }
    }
  }
  const original = toolResultText(result)
  if (original === null) return { changed: false, output: "", appliedRuleIds: [] }
  let body = original
  const applied: string[] = []
  for (const rule of rules) {
    if (rule.kind !== "trim-output" || !toolMatches(rule.tool, toolName)) continue
    const next = trimMiddle(body, rule.maxChars, rule.id)
    if (next !== body) {
      body = next
      applied.push(rule.id)
    }
  }
  const appendix: string[] = []
  if (isError) {
    const haystack = original.toLowerCase()
    for (const rule of rules) {
      if (rule.kind !== "error-hint" || !toolMatches(rule.tool, toolName)) continue
      if (rule.patterns.some((p) => haystack.includes(p.toLowerCase()))) {
        appendix.push(`[harness hint ${rule.id}] ${rule.hint}`)
        applied.push(rule.id)
      }
    }
  } else {
    for (const rule of rules) {
      if (rule.kind !== "verify-after-write" || !toolMatches(rule.tool, toolName)) continue
      appendix.push(`[harness reminder ${rule.id}] ${rule.reminder}`)
      applied.push(rule.id)
    }
  }
  if (appendix.length) body = `${body}\n\n${appendix.join("\n")}`
  return { changed: applied.length > 0, output: body, appliedRuleIds: applied }
}

/** Rules a run should apply before calls (any `call-cap`). */
export function hasPreToolRules(rules: readonly HarnessToolRule[] | undefined): boolean {
  return (rules ?? []).some((r) => r.kind === "call-cap")
}

/** Rules a run should apply to results: all of them, since results advance call caps. */
export function hasResultRules(rules: readonly HarnessToolRule[] | undefined): boolean {
  return (rules ?? []).length > 0
}
