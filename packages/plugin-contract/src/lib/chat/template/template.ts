/**
 * The plugin contract's share of `lib/chat/template/template.ts`, which re-exports these.
 */
import type { ResourceParamKind } from "./resource-kinds"

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
