/**
 * Strict tool sampling — per-tool policy for schema-strict mode.
 *
 * The AI SDK's `tool.strict` property tells the model to emit tool calls that
 * *exactly* match the JSON Schema (no extra keys, required fields always
 * present). This module adds a PUBLIC policy layer on top:
 *
 * - `off` (default): tool.strict is not set; the model may emit
 *   approximately-conformant calls and the post-generation schema validator
 *   (which already exists) catches violations.
 * - `prefer`: set tool.strict when the model/provider supports it. When
 *   support is unconfirmed, run without strict and emit a degradation warning.
 * - `require`: set tool.strict and PREFLIGHT-reject when support is absent.
 *   The turn fails with `unsupported_capability` before the provider call.
 *
 * This module NEVER implements provider-specific serialization — it maps the
 * policy to the single `tool.strict` flag that the installed AI SDK provider
 * adapters already consume. If a provider ignores `strict`, the only harm is
 * that the model falls back to approximate conformance (same as `off`).
 *
 * The existing post-generation schema validation is retained as defense in
 * depth regardless of the strict policy.
 */

import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"

// ─── Types ───────────────────────────────────────────────────────────────────

/** Per-tool strict-mode policy. */
export type ToolStrictPolicy = "off" | "prefer" | "require"

/** Metadata about a model's strict-mode support. */
export interface ModelStrictCapability {
  /** Whether the model confirms strict mode compliance in its output. */
  supported: boolean
  /** Source of the capability knowledge. */
  source: "catalog" | "inferred" | "unknown"
}

/** Per-tool policy declaration (for SDK/config callers). */
export interface ToolStrictDeclaration {
  toolName: string
  policy: ToolStrictPolicy
}

// ─── Model capability table ──────────────────────────────────────────────────

/**
 * Static capability table for strict-mode support by model family.
 * Models not in this table are treated as `unknown` (conservative default).
 *
 * This table reflects the AI SDK provider behavior — when a provider ignores
 * the `strict` flag, the model simply falls back to approximate conformance.
 * The risk is a false positive (we set strict, model doesn't honor it) which
 * is caught by the existing post-gen validator.
 */
const STRICT_SUPPORT_PATTERNS: ReadonlyArray<[RegExp, boolean]> = [
  // OpenAI models (GPT-4o, o1, o3, o4, GPT-4.1) support structured outputs
  [/gpt-4o/i, true],
  [/gpt-4\.1/i, true],
  [/(^|[^a-z])o[134]([^a-z]|$)/i, true],
  // Claude models support JSON schema via tool_use but don't have a
  // separate "strict" toggle — they always attempt schema conformance
  [/claude/i, true],
  // Gemini 1.5+ supports controlled generation with JSON schema
  [/gemini-(1\.5|2|3)/i, true],
  // DeepSeek v3 supports json_schema mode
  [/deepseek/i, true],
  // Mistral large/medium support JSON mode
  [/mistral-(large|medium)/i, true],
]

/**
 * Check model capability for strict tool sampling.
 */
export function getModelStrictCapability(modelId: string | undefined): ModelStrictCapability {
  if (!modelId) return { supported: false, source: "unknown" }

  for (const [pattern, supported] of STRICT_SUPPORT_PATTERNS) {
    if (pattern.test(modelId)) {
      return { supported, source: "catalog" }
    }
  }

  return { supported: false, source: "unknown" }
}

// ─── Policy resolution ───────────────────────────────────────────────────────

export interface StrictPolicyResolution {
  /** Whether to set `tool.strict = true` on the tool definition. */
  enableStrict: boolean
  /** Warning to emit when `prefer` degrades to non-strict. */
  degradationWarning?: { code: string; message: string }
  /** Preflight error when `require` cannot be satisfied. */
  preflightError?: AgentStructuredError
}

/**
 * Resolve a tool's strict policy against the model's capability.
 *
 * This function decides whether to set `tool.strict` and, for `require`
 * policies, whether to fail the turn before the provider call.
 */
export function resolveStrictPolicy(
  policy: ToolStrictPolicy,
  modelId: string | undefined,
  toolName?: string
): StrictPolicyResolution {
  if (policy === "off") {
    return { enableStrict: false }
  }

  const capability = getModelStrictCapability(modelId)

  if (policy === "prefer") {
    if (capability.supported) {
      return { enableStrict: true }
    }
    return {
      enableStrict: false,
      degradationWarning: {
        code: "strict_mode_degraded",
        message:
          `strict mode requested (prefer) for tool "${toolName ?? "unknown"}" ` +
          `but model "${modelId ?? "unknown"}" does not confirm strict support ` +
          `(source: ${capability.source}); running without strict`,
      },
    }
  }

  // policy === "require"
  if (capability.supported) {
    return { enableStrict: true }
  }
  return {
    enableStrict: false,
    preflightError: {
      code: "unsupported_capability",
      message:
        `strict mode required for tool "${toolName ?? "unknown"}" ` +
        `but model "${modelId ?? "unknown"}" does not support it ` +
        `(source: ${capability.source})`,
      capability: undefined,
      detail: { toolName, modelId, source: capability.source },
    },
  }
}

// ─── Batch policy application ────────────────────────────────────────────────

export interface StrictPolicyBatchResult {
  /** Per-tool strict decision (tool name → enable strict). */
  decisions: Map<string, boolean>
  /** Warnings from `prefer` degradation. */
  warnings: Array<{ code: string; message: string }>
  /** First preflight error from `require` — caller should reject the turn. */
  preflightError?: AgentStructuredError
}

/**
 * Apply strict policies to a batch of tools.
 *
 * Call this before passing tools to the provider. If `preflightError` is set,
 * reject the turn immediately.
 */
export function applyStrictPolicies(
  declarations: readonly ToolStrictDeclaration[],
  modelId: string | undefined
): StrictPolicyBatchResult {
  const decisions = new Map<string, boolean>()
  const warnings: Array<{ code: string; message: string }> = []
  let preflightError: AgentStructuredError | undefined

  for (const decl of declarations) {
    const resolution = resolveStrictPolicy(decl.policy, modelId, decl.toolName)
    decisions.set(decl.toolName, resolution.enableStrict)
    if (resolution.degradationWarning) {
      warnings.push(resolution.degradationWarning)
    }
    if (resolution.preflightError && !preflightError) {
      preflightError = resolution.preflightError
    }
  }

  return { decisions, warnings, preflightError }
}
