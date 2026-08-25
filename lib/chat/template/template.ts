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

/** Parameter kinds that carry a plain string value. */
export type ChatTemplateParamKind = "string" | "enum"

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
  /** Render the editor as a multi-line field. */
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
