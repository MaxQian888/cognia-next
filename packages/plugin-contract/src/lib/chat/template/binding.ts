// What a composer draft remembers about the template it came from.
//
// The text in the box already carries WHICH parameters exist — every
// `{{id}}` token is right there, and `listParamTokens` reads them back after a
// reload without help. What the text cannot carry is what each one is set TO,
// because the chip overlay is a character-for-character mirror of the textarea:
// a pill can only ever paint the token it covers, never a substituted value.
//
// So the values live beside the text, on the draft row. That is a deliberate
// trade with one real cost — you never see the finished sentence while editing
// — bought against two things worth more: a reload restores the draft exactly,
// and the composer stays a plain `<textarea>`, with everything (IME, paste
// folding, ghost text, voice, `@` completion) still working.
//
// Nothing here reaches for a store, a database or a registry: these are the
// pure shapes and predicates, so the send path, the overlay and the persistence
// layer all answer "is this filled?" the same way.

/**
 * One parameter's value.
 *
 * A resource carries `{id, label}` rather than a bare id on purpose. Ids are
 * device-local — a workspace, a squad, an MCP server or a file path resolved on
 * one machine may not exist on another — and a template is meant to travel. The
 * label is what the send path falls back to when the id no longer resolves, so
 * a shared template degrades to a human-readable phrase instead of leaking a
 * raw nanoid into the prompt or silently substituting nothing.
 */
export type ChatTemplateParamValue =
  | { kind: "text"; value: string }
  | {
      kind: "resource"
      resourceKind: string
      id: string
      label: string
      /**
       * The exact token the `@` menu would have inserted for this pick, e.g.
       * `@src/app.ts`. Absent on a value that arrived from a device where the
       * pick could not be replayed, which is precisely when the label is the
       * only honest thing left to say.
       */
      raw?: string
    }

export interface ChatTemplateBinding {
  templateId: string
  /** The template version in force when this draft was inserted. */
  version: string
  /** Values by parameter id. A parameter with no entry is simply unfilled. */
  params: Record<string, ChatTemplateParamValue>
  insertedAt: number
}

export type ChatTemplateParamState = "empty" | "filled" | "unresolved"

export function isParamFilled(value: ChatTemplateParamValue | undefined): boolean {
  if (!value) return false
  return value.kind === "text" ? value.value.trim().length > 0 : value.id.length > 0
}

export function paramValueText(value: ChatTemplateParamValue | undefined): string {
  if (!value) return ""
  if (value.kind === "text") return value.value
  return value.raw ?? value.label
}

export function paramState(
  value: ChatTemplateParamValue | undefined,
  isResolvable?: (value: Extract<ChatTemplateParamValue, { kind: "resource" }>) => boolean
): ChatTemplateParamState {
  if (!isParamFilled(value)) return "empty"
  const filled = value as ChatTemplateParamValue
  if (filled.kind === "resource" && isResolvable && !isResolvable(filled)) return "unresolved"
  return "filled"
}

export function withParamValue(
  binding: ChatTemplateBinding,
  paramId: string,
  value: ChatTemplateParamValue
): ChatTemplateBinding {
  return { ...binding, params: { ...binding.params, [paramId]: value } }
}

export function pruneBinding(
  binding: ChatTemplateBinding,
  presentParamIds: readonly string[]
): ChatTemplateBinding {
  const present = new Set(presentParamIds)
  const kept = Object.entries(binding.params).filter(([id]) => present.has(id))
  if (kept.length === Object.keys(binding.params).length) return binding
  return { ...binding, params: Object.fromEntries(kept) }
}
