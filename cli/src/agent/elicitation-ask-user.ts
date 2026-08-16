/**
 * Render an external agent's blocking question through the CLI's existing
 * `ask_user` overlay.
 *
 * The TUI already has a tested overlay for "the agent is asking you something":
 * `AskUserDialog`, driven by `useAskUserStore`, with keyboard handling, option
 * selection, free text and a cancel path. An elicitation is the same shape of
 * interaction, so it reuses that surface rather than growing a second form
 * widget that would have to re-solve every one of those problems.
 *
 * The adapter is pure and lives here — not in the overlay — so the mapping is
 * unit-testable without Ink, and so the overlay keeps knowing only about
 * `ask_user`.
 *
 * One question per schema property, asked in order. Pi always emits exactly one
 * (`piDialogSchema`); ACP may emit several, and asking them in sequence is what
 * lets a multi-field schema be answered at all through a single-question UI.
 */

import type { AskUserOption, AskUserRequest, AskUserAnswer } from "@/lib/claude/ask-user-tool"
import type {
  AcpElicitationPropertySchema,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpElicitationValue,
} from "@/types/agent/external-agent"

/** Values a boolean question offers. Stable ids so the answer maps back exactly. */
const BOOLEAN_OPTIONS: AskUserOption[] = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
]

/** The choices a property offers, from either ACP spelling. */
function choicesOf(schema: AcpElicitationPropertySchema): AskUserOption[] {
  if (schema.oneOf?.length) {
    return schema.oneOf.map((option) => ({
      value: option.const,
      label: option.title ?? option.const,
    }))
  }
  if (schema.enum?.length) {
    return schema.enum.map((value) => ({ value, label: value }))
  }
  if (schema.items?.enum?.length) {
    return schema.items.enum.map((value) => ({ value, label: value }))
  }
  return []
}

/**
 * Turn one schema property into a question the `ask_user` overlay can render.
 *
 * `message` leads because it is the sentence the agent actually wrote; the
 * property title is appended only when it says something different, so a Pi
 * dialog whose title and message coincide does not ask itself twice.
 */
export function elicitationPropertyToAskUser(
  request: AcpElicitationRequest,
  key: string,
  schema: AcpElicitationPropertySchema
): AskUserRequest {
  const label = schema.title ?? key
  const question =
    label && label !== request.message ? `${request.message} — ${label}` : request.message

  if (schema.type === "boolean") {
    return { question, options: BOOLEAN_OPTIONS, multiSelect: false, allowText: false }
  }

  const options = choicesOf(schema)
  return {
    question,
    options,
    multiSelect: schema.type === "array",
    // With no fixed choices the only way to answer is to type one. A default
    // (an `editor` prefill) still needs free text so it can be revised.
    allowText: options.length === 0,
  }
}

/**
 * Read one property's value back out of an overlay answer.
 *
 * Returns `undefined` when the user gave nothing, so the caller can leave the
 * key absent rather than sending an empty string the agent would treat as a
 * deliberate blank.
 */
export function askUserAnswerToValue(
  schema: AcpElicitationPropertySchema,
  answer: AskUserAnswer
): AcpElicitationValue | undefined {
  if (schema.type === "boolean") {
    const picked = answer.selected[0]
    return picked === undefined ? undefined : picked === "true"
  }
  if (schema.type === "array") {
    return answer.selected
  }
  if (answer.selected.length > 0) return answer.selected[0]
  const text = answer.text.trim()
  if (text.length > 0) return text
  // An `editor`/`input` left untouched falls back to whatever the agent
  // prefilled, which is what the user saw and chose not to change.
  return typeof schema.default === "string" ? schema.default : undefined
}

/** The properties to ask about, in a stable order. */
export function elicitationProperties(
  request: AcpElicitationRequest
): Array<[string, AcpElicitationPropertySchema]> {
  return Object.entries(request.requestedSchema?.properties ?? {})
}

/**
 * Ask every property in turn and assemble the response.
 *
 * A cancel at any point cancels the whole elicitation: the remaining questions
 * belong to the same request, and answering half of one is not an answer.
 */
export async function answerElicitationThroughAskUser(
  request: AcpElicitationRequest,
  ask: (question: AskUserRequest) => Promise<AskUserAnswer>
): Promise<AcpElicitationResponse> {
  const properties = elicitationProperties(request)

  // A `url` elicitation, or a schema with no fields, has nothing to collect —
  // it is a yes/no about whether the user completed something out of band.
  if (properties.length === 0) {
    const answer = await ask({
      question: request.message,
      options: BOOLEAN_OPTIONS,
      multiSelect: false,
      allowText: false,
    })
    if (answer.cancelled) return { requestId: request.id, action: "cancel" }
    return {
      requestId: request.id,
      action: answer.selected[0] === "true" ? "accept" : "decline",
    }
  }

  const content: Record<string, AcpElicitationValue> = {}
  for (const [key, schema] of properties) {
    const answer = await ask(elicitationPropertyToAskUser(request, key, schema))
    if (answer.cancelled) return { requestId: request.id, action: "cancel" }
    const value = askUserAnswerToValue(schema, answer)
    if (value !== undefined) content[key] = value
  }

  return { requestId: request.id, action: "accept", content }
}
