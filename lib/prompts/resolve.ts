/**
 * Select the text a code-owned prompt slot uses for one operation (ADR-0236).
 *
 * Order of operations, which is the whole contract:
 *
 * 1. Only scopes the definition declares participate, and only for ids the
 *    caller actually supplied: a workspace override applies to a call that
 *    names that workspace, never to "whatever is open".
 * 2. Among eligible overrides the most specific scope wins
 *    (session > agent > workspace > account). One override is selected; they
 *    do not accumulate.
 * 3. The selected override is checked against the definition as it is now:
 *    an older contract, a body that no longer validates, or a body the PII
 *    gate refuses all fall back to the shipped default, with the reason
 *    recorded. A broken override never becomes empty instructions.
 * 4. Placeholders are rendered with the caller's values.
 *
 * Scope selection is not authority: an override cannot grant tools, widen
 * permissions or reclassify task data, because none of those are read from
 * prompt text.
 */

import { loggers } from "@cognia/logging"
import { renderPromptTemplate, validatePromptBody } from "./template"
import {
  loadPromptOverrideSnapshot,
  peekPromptOverrideSnapshot,
  type ActivePromptOverride,
  type PromptOverrideSnapshot,
} from "./snapshot"
import { recordPromptResolution } from "./resolution-log"
import {
  PROMPT_SCOPE_SPECIFICITY,
  type PromptDefinitionV1,
  type PromptFallbackReason,
  type PromptResolutionContext,
  type PromptScope,
  type PromptSource,
} from "./types"

// Created on first use: this module sits under many feature modules, and a
// logger built at import time would make each of them fail to load wherever a
// test stubs the logging package with only the namespace it reads itself.
let log: ReturnType<typeof loggers.ai.child> | null = null

export interface ResolvePromptOptions {
  context?: PromptResolutionContext
  values?: Readonly<Record<string, string | undefined>>
  /** Snapshot to read; defaults to the active account's loaded snapshot. */
  snapshot?: PromptOverrideSnapshot | null
}

export interface ResolvedPrompt {
  /** Rendered text to send. */
  text: string
  /** The template before rendering (shipped or override). */
  body: string
  source: PromptSource
}

function targetFor(scope: PromptScope, context: PromptResolutionContext): string | undefined {
  switch (scope) {
    case "account":
      return ""
    case "workspace":
      return context.workspaceId || undefined
    case "agent":
      return context.agentId || undefined
    case "session":
      return context.sessionId || undefined
  }
}

/** The most specific eligible override, before validity checks. Pure. */
export function selectPromptOverride(
  def: Pick<PromptDefinitionV1, "id" | "scopes">,
  context: PromptResolutionContext,
  snapshot: PromptOverrideSnapshot
): ActivePromptOverride | undefined {
  const candidates = snapshot.byPrompt.get(def.id)
  if (!candidates?.length) return undefined
  for (const scope of [...PROMPT_SCOPE_SPECIFICITY].reverse()) {
    if (!def.scopes.includes(scope)) continue
    const targetId = targetFor(scope, context)
    if (targetId === undefined) continue
    const hit = candidates.find((row) => row.scope === scope && row.targetId === targetId)
    if (hit) return hit
  }
  return undefined
}

/** Validity of an override body against the current definition, cached per revision. */
const verdicts = new Map<string, PromptFallbackReason | null>()
const MAX_VERDICTS = 500

function overrideVerdict(
  def: PromptDefinitionV1,
  override: ActivePromptOverride
): PromptFallbackReason | null {
  const key = `${def.id}\u0000${def.contractVersion}\u0000${override.revisionId}`
  const cached = verdicts.get(key)
  if (cached !== undefined) return cached
  let verdict: PromptFallbackReason | null = null
  if (override.contractVersion !== def.contractVersion) {
    verdict = "contract-incompatible"
  } else {
    const issues = validatePromptBody(def, override.body)
    if (issues.some((issue) => issue.code === "pii")) verdict = "pii-blocked"
    else if (issues.length > 0) verdict = "invalid-body"
  }
  if (verdicts.size >= MAX_VERDICTS) verdicts.clear()
  verdicts.set(key, verdict)
  // Signalled once per revision, not on every call that falls back.
  if (verdict) signal(def, verdict)
  return verdict
}

function signal(def: PromptDefinitionV1, reason: PromptFallbackReason): void {
  const code =
    reason === "contract-incompatible"
      ? "prompt_contract_incompatible"
      : reason === "pii-blocked"
        ? "prompt_override_pii_blocked"
        : reason === "invalid-body"
          ? "prompt_resolution_failed"
          : "prompt_authority_unavailable"
  // Bounded fields only: the prompt id and the reason, never the text.
  log ??= loggers.ai.child("prompts")
  log.warn(code, { promptId: def.id, reason })
}

/**
 * Resolve synchronously from the loaded snapshot. When no snapshot is loaded
 * the shipped body is used and the resolution says so, instead of claiming
 * that no override exists.
 */
export function resolvePrompt(
  def: PromptDefinitionV1,
  options: ResolvePromptOptions = {}
): ResolvedPrompt {
  const context = options.context ?? {}
  const snapshot = options.snapshot === undefined ? peekPromptOverrideSnapshot() : options.snapshot
  let body = def.defaultBody
  let source: PromptSource = { kind: "default" }

  if (def.operation !== "inspect-only") {
    if (!snapshot) {
      source = { kind: "default", fallback: "snapshot-unavailable" }
    } else {
      const override = selectPromptOverride(def, context, snapshot)
      if (override) {
        const verdict = overrideVerdict(def, override)
        if (verdict) {
          source = { kind: "default", fallback: verdict, skippedRevisionId: override.revisionId }
        } else {
          body = override.body
          source = {
            kind: "override",
            scope: override.scope,
            bindingId: override.bindingId,
            revisionId: override.revisionId,
          }
        }
      }
    }
  }

  const text = renderPromptTemplate(def, body, options.values)
  recordPromptResolution({ promptId: def.id, source, context, at: Date.now() })
  return { text, body, source }
}

/**
 * Resolve after making sure the active account's snapshot is loaded. A
 * caller that froze a snapshot for a multi-step operation (a team planning
 * run, a turn) passes it, and every step reads that same revision set.
 */
export async function resolvePromptAsync(
  def: PromptDefinitionV1,
  options: ResolvePromptOptions = {}
): Promise<ResolvedPrompt> {
  if (options.snapshot !== undefined) return resolvePrompt(def, options)
  let snapshot: PromptOverrideSnapshot | null = peekPromptOverrideSnapshot()
  if (!snapshot) snapshot = await loadPromptOverrideSnapshot().catch(() => null)
  return resolvePrompt(def, { ...options, snapshot })
}

/** Test seam: forget cached override verdicts. */
export function __resetPromptVerdictsForTests(): void {
  verdicts.clear()
}
