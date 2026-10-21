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

/**
 * The template a draft was inserted from, and what its parameters are set to.
 *
 * `version` is pinned at insert and never followed. Editing a template must not
 * silently rewrite the message someone is halfway through composing, and a
 * re-run whose body changed underneath it is a result you cannot explain: you
 * would not know whether the parameters moved or the template did.
 */
export interface ChatTemplateBinding {
  templateId: string
  /** The template version in force when this draft was inserted. */
  version: string
  /** Values by parameter id. A parameter with no entry is simply unfilled. */
  params: Record<string, ChatTemplateParamValue>
  insertedAt: number
}

/** How a parameter chip should read. Mirrors `ParamPillState` in the overlay. */
export type ChatTemplateParamState = "empty" | "filled" | "unresolved"

/** Whether a value counts as supplied. Whitespace alone does not. */
export function isParamFilled(value: ChatTemplateParamValue | undefined): boolean {
  if (!value) return false
  return value.kind === "text" ? value.value.trim().length > 0 : value.id.length > 0
}

/**
 * The text a parameter contributes when the message is sent.
 *
 * For a resource that is the token the `@` menu would have inserted — the file
 * mention the agent can actually open, not a prose description of it. When the
 * token is missing (a value that travelled from another device) the LABEL is
 * what goes in: a prompt reads "the auth module", never a raw `root-a1b2c3`,
 * and a mention that would resolve to nothing here is worse than a phrase.
 */
export function paramValueText(value: ChatTemplateParamValue | undefined): string {
  if (!value) return ""
  if (value.kind === "text") return value.value
  return value.raw ?? value.label
}

/**
 * How to paint one parameter's chip.
 *
 * `isResolvable` answers "does this resource still exist on this device?" and
 * is only consulted for resource values — a text value cannot dangle. Omit it
 * and resources are assumed resolvable, which is the right default for the
 * device that filled them in.
 */
export function paramState(
  value: ChatTemplateParamValue | undefined,
  isResolvable?: (value: Extract<ChatTemplateParamValue, { kind: "resource" }>) => boolean
): ChatTemplateParamState {
  if (!isParamFilled(value)) return "empty"
  const filled = value as ChatTemplateParamValue
  if (filled.kind === "resource" && isResolvable && !isResolvable(filled)) return "unresolved"
  return "filled"
}

/** A binding with one parameter set, leaving the others untouched. */
export function withParamValue(
  binding: ChatTemplateBinding,
  paramId: string,
  value: ChatTemplateParamValue
): ChatTemplateBinding {
  return { ...binding, params: { ...binding.params, [paramId]: value } }
}

/**
 * Drop values whose token is no longer in the text.
 *
 * Breaking a token is how a user demotes a chip back to ordinary characters, so
 * the value it held has to go with it — otherwise retyping `{{module}}` later
 * would silently resurrect a value from a sentence that no longer exists.
 * Returns the same object when nothing changed, so callers can skip a write.
 */
export function pruneBinding(
  binding: ChatTemplateBinding,
  presentParamIds: readonly string[]
): ChatTemplateBinding {
  const present = new Set(presentParamIds)
  const kept = Object.entries(binding.params).filter(([id]) => present.has(id))
  if (kept.length === Object.keys(binding.params).length) return binding
  return { ...binding, params: Object.fromEntries(kept) }
}
