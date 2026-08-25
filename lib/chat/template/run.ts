// What a sent turn remembers about the template it was written from.
//
// The message in the transcript is the FINISHED sentence — the values are
// already substituted in, and nothing in it says which words were parameters.
// That is right for reading and useless for repeating: "run this again for the
// billing module" cannot be recovered from "review the auth module", because
// there is no longer anything marking `auth module` as the answer to anything.
//
// So the turn carries its own pre-substitution text alongside the values. Text
// rather than a template reference on purpose: a message is frequently a
// template plus something the user typed after it, the template may have been
// edited or deleted since, and a repository template may not even exist on the
// device now reading the transcript. Re-running the MESSAGE is a promise this
// can keep; re-running the template is not.

import type { ChatTemplateBinding, ChatTemplateParamValue } from "./binding"

/** Recorded on the user message row as `metadata.templateRun`. */
export interface ChatTemplateRun {
  templateId: string
  /** The template revision in force when this turn was sent. */
  version: string
  /** The message exactly as it read before substitution — tokens intact. */
  text: string
  params: Record<string, ChatTemplateParamValue>
}

/**
 * Build the record for a turn about to go out.
 *
 * Returns null when there is nothing to remember — no binding, or a binding
 * with no values, which is what a message whose tokens were all typed and then
 * broken looks like. A re-run action on a turn with nothing to vary would be a
 * button that reproduces the message it is attached to.
 */
export function templateRunFromBinding(
  binding: ChatTemplateBinding | undefined,
  text: string
): ChatTemplateRun | null {
  if (!binding || Object.keys(binding.params).length === 0) return null
  return {
    templateId: binding.templateId,
    version: binding.version,
    text,
    params: { ...binding.params },
  }
}

/**
 * Read a run back off a message row.
 *
 * `metadata` is persisted, so this is parsing untrusted-shaped data from a row
 * that may have been written by an older build or synced from another device:
 * a field-by-field check, not a cast. A malformed record reads as absent, which
 * costs one hidden button and never a crashed transcript.
 */
export function readChatTemplateRun(metadata: unknown): ChatTemplateRun | null {
  if (!metadata || typeof metadata !== "object") return null
  const raw = (metadata as { templateRun?: unknown }).templateRun
  if (!raw || typeof raw !== "object") return null
  const run = raw as Record<string, unknown>
  if (typeof run.templateId !== "string" || typeof run.version !== "string") return null
  if (typeof run.text !== "string" || !run.text.trim()) return null
  if (!run.params || typeof run.params !== "object" || Array.isArray(run.params)) return null
  const params: Record<string, ChatTemplateParamValue> = {}
  for (const [id, value] of Object.entries(run.params as Record<string, unknown>)) {
    const parsed = readParamValue(value)
    if (parsed) params[id] = parsed
  }
  if (Object.keys(params).length === 0) return null
  return { templateId: run.templateId, version: run.version, text: run.text, params }
}

function readParamValue(value: unknown): ChatTemplateParamValue | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (raw.kind === "text") {
    return typeof raw.value === "string" ? { kind: "text", value: raw.value } : null
  }
  if (raw.kind !== "resource") return null
  if (
    typeof raw.resourceKind !== "string" ||
    typeof raw.id !== "string" ||
    typeof raw.label !== "string"
  ) {
    return null
  }
  return {
    kind: "resource",
    resourceKind: raw.resourceKind,
    id: raw.id,
    label: raw.label,
    ...(typeof raw.raw === "string" ? { raw: raw.raw } : {}),
  }
}

/**
 * The binding a re-run starts from.
 *
 * `insertedAt` is stamped NOW rather than carried: this draft is being written
 * now, and the field is the composer's own bookkeeping about the draft in the
 * box, not a property of the turn being repeated.
 */
export function bindingFromRun(run: ChatTemplateRun, now: number): ChatTemplateBinding {
  return {
    templateId: run.templateId,
    version: run.version,
    params: { ...run.params },
    insertedAt: now,
  }
}
