// Which `{{parameter}}` kinds may hold a REFERENCE rather than typed text.
//
// The set is not a taste call — it is derived from a property the mention
// registry already has. A parameter occupies a position in a sentence, so its
// value has to produce text AT that position. `lib/chat/mentions/pick-registry`
// already splits its handlers exactly along that line: `toContextRef` returns a
// handle for the picks that insert a token (`@src/app.ts`, `@reviewer`) and
// null for the picks whose whole effect is a side effect — enabling a skill,
// applying a preset, staging a remote document, citing a workflow node. Those
// contribute no characters, so as a parameter they would leave a hole in the
// sentence and silently change the session instead.
//
// `resource-kinds.test.ts` pins that equivalence, so registering a new
// insertion-style mention fails the build until it is considered here too.

import type { ContextRef } from "@/lib/chat/mentions/types"
import type { ChatTemplateParamValue } from "./binding"

/** Mention kinds a parameter may be bound to. */
export const RESOURCE_PARAM_KINDS = ["file", "agent", "subagent"] as const

export type ResourceParamKind = (typeof RESOURCE_PARAM_KINDS)[number]

export function isResourceParamKind(value: string | undefined): value is ResourceParamKind {
  return !!value && (RESOURCE_PARAM_KINDS as readonly string[]).includes(value)
}

/** One candidate in the parameter's picker. */
export interface ResourceOption {
  /** Stable handle: relPath for a file, name for an agent, handle for a subagent. */
  id: string
  /** What the row reads as. Falls back to the id when a kind has no separate name. */
  label: string
  description?: string
  /** The exact token this pick would have inserted, e.g. `@src/app.ts`. */
  raw: string
}

/**
 * Project a mention handle into a picker row, or null when that kind cannot be
 * a parameter value.
 *
 * Going through `ContextRef` rather than reading the popover item directly is
 * the point: whatever the `@` menu would have inserted for this pick is exactly
 * what the parameter substitutes, with no second opinion about how a file path
 * or an agent handle is spelled.
 */
export function resourceOptionFromRef(ref: ContextRef): ResourceOption | null {
  if (!isResourceParamKind(ref.kind)) return null
  return {
    id: ref.id,
    label: ref.label ?? ref.id,
    raw: ref.raw ?? `@${ref.id}`,
  }
}

/** The bound value for a picked option. */
export function resourceParamValue(
  resourceKind: ResourceParamKind,
  option: ResourceOption
): ChatTemplateParamValue {
  return {
    kind: "resource",
    resourceKind,
    id: option.id,
    label: option.label,
    raw: option.raw,
  }
}
