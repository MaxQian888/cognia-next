/**
 * What a workflow node's card says about its own configuration.
 *
 * The card used to render the node-level `notes` annotation as its only body
 * text. Notes are free text the author leaves for themselves, so typing one
 * into a node whose actual required param (an agent turn's Prompt) was still
 * empty made the node *look* configured, while the only hint that it was not
 * was a bare issue-count badge. The card now leads with the node's primary
 * configured content, names any required params that are still empty, and
 * shows notes as a secondary annotation.
 *
 * Pure and synchronous: every input is already on the node or in the editor
 * store's diagnostics, so the card costs no fetch.
 */

import type { Diagnostic } from "@/lib/workflow/diagnostics/types"
import { validateNodeParams, type FieldError } from "@/lib/workflow/nodes/validate-params"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

/**
 * Params that carry the content a node acts on — what an author would say the
 * node "does" — in priority order. The first one holding a non-empty string is
 * the card's preview line. Ordered so the instruction outranks its framing
 * (`prompt` before `systemPrompt`) and the payload outranks its address
 * (`content` before `path`).
 */
export const NODE_PREVIEW_FIELDS: readonly string[] = [
  "prompt",
  "userPrompt",
  "finderPrompt",
  "goal",
  "objective",
  "rawObjective",
  "objectiveText",
  "content",
  "text",
  "body",
  "message",
  "query",
  "input",
  "title",
  "description",
  "command",
  "expression",
  "code",
  "template",
  "url",
  "path",
  "relPath",
  "sourcePath",
  "scriptPath",
  "cron",
  "systemPrompt",
]

/** Upper bound on preview text handed to the DOM; CSS clamps what is shown. */
export const NODE_PREVIEW_MAX_CHARS = 280

/** i18n key the param validator emits for an empty required field. */
const REQUIRED_KEY = "required"
const REQUIRED_MESSAGE_KEY = `workflows.validation.${REQUIRED_KEY}`
/** Object-level refinements land under this pseudo-field; it names no param. */
const ROOT_FIELD = "_root"

export interface NodeBodyPreview {
  /** The param the text came from. */
  field: string
  /** Trimmed value, capped at {@link NODE_PREVIEW_MAX_CHARS}. */
  text: string
}

/** The node's primary configured content, or `null` when none is set yet. */
export function nodeBodyPreview(
  params: Record<string, unknown> | undefined
): NodeBodyPreview | null {
  if (!params) return null
  for (const field of NODE_PREVIEW_FIELDS) {
    const raw = params[field]
    if (typeof raw !== "string") continue
    const text = raw.trim()
    if (!text) continue
    return {
      field,
      text:
        text.length > NODE_PREVIEW_MAX_CHARS ? `${text.slice(0, NODE_PREVIEW_MAX_CHARS)}…` : text,
    }
  }
  return null
}

/**
 * Required params that are still empty, read from the editor diagnostics (the
 * source of truth whenever a store is mounted). Order follows the diagnostics,
 * which follow the param schema, so the first name is the first field in the
 * form.
 */
export function missingRequiredFromDiagnostics(diagnostics: readonly Diagnostic[]): string[] {
  const out: string[] = []
  for (const d of diagnostics) {
    if (d.code !== "nodeParam" || d.messageKey !== REQUIRED_MESSAGE_KEY) continue
    if (!d.field || d.field === ROOT_FIELD || out.includes(d.field)) continue
    out.push(d.field)
  }
  return out
}

/**
 * Same as {@link missingRequiredFromDiagnostics}, from a node's param
 * validation result — the fallback for renders without an editor store.
 */
export function missingRequiredFromValidation(
  fields: Record<string, FieldError> | undefined
): string[] {
  if (!fields) return []
  return Object.entries(fields)
    .filter(([field, error]) => error.key === REQUIRED_KEY && field !== ROOT_FIELD)
    .map(([field]) => field)
}

/**
 * Every param a built-in kind requires, as the validator reports them for an
 * empty params object. The card names these when they are missing, so each
 * one needs a `workflows.node.paramLabels.<field>` translation — the i18n
 * coverage test enumerates the catalog through this.
 */
export function requiredParamFields(kind: WorkflowNodeKind): string[] {
  return missingRequiredFromValidation(validateNodeParams(kind, {}).fields)
}
