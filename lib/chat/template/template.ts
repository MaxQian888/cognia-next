// What a saved chat template IS, as pure data.
//
// Deliberately separate from `lib/db/chat-templates.ts`: the shape has to be
// readable by the composer, the send path and (later) the portable template
// envelope, none of which should have to reach through Dexie to learn what a
// parameter is.
//
// The declaration is a light layer over what the body already says. Every
// `{{token}}` in the body IS a parameter whether or not anything declared it —
// that is what makes "type `{{module}}` and click it" work with no template at
// all. A declaration only adds what the token cannot express on its own: a
// human label, a description, and whether the message may be sent without it.

import { listParamTokens } from "./param-segments"
import { computeCodeRanges } from "./code-ranges"
import { isParamFilled, type ChatTemplateBinding, type ChatTemplateParamValue } from "./binding"
import { RESOURCE_PARAM_KINDS, type ResourceParamKind } from "./resource-kinds"

/**
 * How a parameter is filled in.
 *
 * `string` is free text, `enum` is a closed list of strings, and `resource`
 * hands the parameter to one of the composer's existing `@` pickers — see
 * `resource-kinds.ts` for why only some mention kinds qualify.
 */
export type ChatTemplateParamKind = "string" | "enum" | "resource"

export interface ChatTemplateParam {
  /** Matches the `{{id}}` token in the body. */
  id: string
  /** Shown in the editor panel. Defaults to the id when a template is derived. */
  label: string
  description?: string
  /** A message with an unfilled required parameter is refused. */
  required: boolean
  kind: ChatTemplateParamKind
  defaultValue?: string
  /** Choices, for `kind: "enum"`. */
  options?: string[]
  /** Which `@` picker to open, for `kind: "resource"`. */
  resourceKind?: ResourceParamKind
  /** Render the editor as a multi-line field. Ignored by the other kinds. */
  multiline?: boolean
}

/** The portable half of a saved template — no ids, no timestamps, no counters. */
export interface ChatTemplateDefinition {
  name: string
  description?: string
  /** Message body, with `{{parameter}}` tokens. */
  body: string
  /** Declarations, in the order they should be walked. */
  params: ChatTemplateParam[]
}

/**
 * Derive declarations from a body, preserving anything already declared.
 *
 * This is how "save what I just wrote as a template" works without asking the
 * user to fill in a form first: the tokens are already in the text, so every
 * one of them becomes a required string parameter labelled by its own id. An
 * existing declaration wins, so re-deriving after an edit keeps the labels and
 * defaults someone took the trouble to write.
 *
 * Order follows the BODY, not the previous list — the editor walks parameters
 * in reading order, and a declaration list that drifted out of order would send
 * Tab jumping backwards through the sentence.
 */
export function deriveParams(
  body: string,
  existing: readonly ChatTemplateParam[] = []
): ChatTemplateParam[] {
  const byId = new Map(existing.map((param) => [param.id, param]))
  const seen = new Set<string>()
  const out: ChatTemplateParam[] = []
  for (const token of listParamTokens(body, computeCodeRanges(body))) {
    if (seen.has(token.paramId)) continue
    seen.add(token.paramId)
    out.push(
      byId.get(token.paramId) ?? {
        id: token.paramId,
        label: token.paramId,
        required: true,
        kind: "string",
      }
    )
  }
  return out
}

/**
 * A slug usable as the stable part of a template id.
 *
 * Mirrors the Studio's own id derivation so a chat template that is later
 * projected into a portable envelope does not need a second naming scheme.
 */
export function templateSlug(name: string): string {
  return (
    name
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  )
}

/**
 * The parameters that must be filled before the message may be sent.
 *
 * A token with NO declaration counts as required. That is the common case —
 * someone typed `{{module}}` into an empty composer — and a literal `{{module}}`
 * reaching the model is never what anyone meant. Declaring a parameter optional
 * is therefore a deliberate act, which is the right way round.
 *
 * `declarations` is looked up by id rather than walked in order: the body owns
 * the order (see `deriveParams`), and a declaration list that drifted out of
 * step must not change WHICH parameters block a send.
 */
export function unfilledRequiredParams(
  paramIds: readonly string[],
  binding: ChatTemplateBinding | undefined,
  declarations: readonly ChatTemplateParam[] = []
): string[] {
  const byId = new Map(declarations.map((param) => [param.id, param]))
  return paramIds.filter((id) => {
    if (isParamFilled(binding?.params[id])) return false
    return byId.get(id)?.required !== false
  })
}

/**
 * Seed values for a fresh insert: last time's value where the body still
 * declares the parameter, otherwise the declared default.
 *
 * Filtering by the CURRENT declarations is what stops a value orphaned by an
 * edit from coming back — the body no longer has that token, so a value for it
 * would sit in the binding forever, invisible and unremovable.
 */
export function seedParamValues(
  declarations: readonly ChatTemplateParam[],
  lastParams: Readonly<Record<string, ChatTemplateParamValue>> | undefined
): Record<string, ChatTemplateParamValue> {
  const out: Record<string, ChatTemplateParamValue> = {}
  for (const param of declarations) {
    const last = lastParams?.[param.id]
    if (isParamFilled(last)) {
      out[param.id] = last as ChatTemplateParamValue
      continue
    }
    // A default only applies to the kinds that carry plain text. A resource
    // default would be a device-local id with no label behind it — exactly the
    // dangling reference the `{id, label}` pair exists to avoid.
    if (param.kind !== "resource" && param.defaultValue?.trim()) {
      out[param.id] = { kind: "text", value: param.defaultValue }
    }
  }
  return out
}

/**
 * The patch that changing a parameter's type implies.
 *
 * A `resource` needs somewhere to pick FROM, so switching to it picks a source
 * when none was chosen — otherwise the type change looks applied while the
 * picker opens on nothing. Fields belonging to the OLD type are deliberately
 * left in place: they are ignored by every other type, and keeping them means
 * switching away and back does not throw away a list of choices someone typed.
 */
export function paramKindChange(
  param: ChatTemplateParam,
  kind: ChatTemplateParamKind
): Partial<ChatTemplateParam> {
  if (kind !== "resource" || param.resourceKind) return { kind }
  return { kind, resourceKind: RESOURCE_PARAM_KINDS[0] }
}
