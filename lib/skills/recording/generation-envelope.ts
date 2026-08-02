/**
 * Everything that leaves the device, assembled once.
 *
 * The load-bearing property: [`buildGenerationEnvelope`] returns **the exact
 * strings that are sent**, and the preview renders those same strings. Not a
 * summary of them, not a reconstruction — the same object. `generation-envelope`
 * tests assert byte-identity, which is what makes "preview exactly what leaves
 * the device" a fact rather than an intention.
 *
 * What is excluded, and why each matters:
 *
 * - **Excluded steps.** The user said no.
 * - **Screenshots.** They never enter a prompt at all — the model works from the
 *   structured transcript, and a frame of the user's screen is the single most
 *   sensitive thing a recording holds.
 * - **Recorded input samples.** A `variable` keeps the user's actual typed value
 *   on device and sends only the placeholder.
 * - **Sensitive text.** Never captured in the first place; the placeholder here
 *   carries no length and no shape.
 * - **Out-of-scope markers.** Reported to the user as a count; nothing about
 *   them is sent.
 *
 * PII redaction runs over the assembled transcript as a last line of defence,
 * before it is handed back — so the preview shows the redacted form too.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"

import { applyVariableMapping, inputsForSkillBody, type InputVariable } from "./input-variables"
import { includedSteps, type RecordedStepView } from "./step-model"

/** Beyond this the transcript is truncated with an explicit notice. */
export const MAX_ENVELOPE_STEPS = 80
const MAX_LABEL_CHARS = 120

export interface EnvelopeOptions {
  variables: readonly InputVariable[]
  /** BCP-47 tag the skill should be written in. */
  locale: string
  /** Tool names the model is allowed to propose, for the system prompt. */
  toolCatalog: readonly string[]
}

export interface GenerationEnvelope {
  systemPrompt: string
  userPrompt: string
  /** True when redaction altered the transcript. Surfaced to the user. */
  redacted: boolean
  /** Steps beyond `MAX_ENVELOPE_STEPS`, so the UI can say what was dropped. */
  truncatedSteps: number
  /** Included steps actually described. */
  describedSteps: number
}

function truncate(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  return trimmed.length > MAX_LABEL_CHARS ? `${trimmed.slice(0, MAX_LABEL_CHARS)}…` : trimmed
}

/** One transcript line per included step. */
function describeStep(
  view: RecordedStepView,
  index: number,
  variables: readonly InputVariable[]
): string {
  const n = index + 1
  if (view.intent) return `${n}. ${truncate(view.intent)}`
  if (view.manual) return `${n}. (manual step)`

  const step = view.captured
  if (!step) return `${n}. (manual step)`

  const target =
    step.element?.name ??
    step.element?.automationId ??
    step.ocrHint ??
    step.element?.controlType ??
    "an unlabeled control"
  const where = step.element?.windowTitle ? ` in "${truncate(step.element.windowTitle)}"` : ""

  switch (step.kind) {
    case "click":
      return `${n}. Click "${truncate(target)}"${where}.`
    case "scroll": {
      const direction = (step.scrollDy ?? 0) < 0 ? "down" : "up"
      return `${n}. Scroll ${direction}${where}.`
    }
    case "type": {
      if (!step.text) return `${n}. Type into "${truncate(target)}"${where}.`
      if (step.text.kind === "sensitive") {
        // Deliberately shapeless. Even "typed 8 characters" narrows a password.
        return `${n}. Enter a secret value into "${truncate(target)}"${where}.`
      }
      if (step.text.kind === "keys") {
        return `${n}. Press ${truncate(step.text.chord)}${where}.`
      }
      const value = applyVariableMapping(step.text.value, variables, view.seq)
      return `${n}. Type "${truncate(value)}" into "${truncate(target)}"${where}.`
    }
    case "outOfScope":
      return `${n}. (skipped — outside the recording's scope)`
  }
}

export function buildSystemPrompt(options: EnvelopeOptions, categoryIds: string): string {
  const tools =
    options.toolCatalog.length > 0
      ? `Only these tool names exist: ${options.toolCatalog.join(", ")}.`
      : "No tool catalog is available; return an empty allowedTools array."
  return [
    "You are an expert at turning a recorded desktop workflow into a reusable SKILL.md procedure.",
    "You are given a transcript of what a user did, already reviewed and edited by them.",
    "Write a skill an AI agent could follow to reproduce the workflow with different inputs, using its own tools (it will NOT replay exact coordinates).",
    "",
    `Write the skill in ${options.locale}.`,
    "",
    "Output ONLY a JSON object (no markdown fences, no preamble) with these keys:",
    '- "name": a short imperative title (<= 60 chars, letters/numbers/spaces/hyphens only).',
    '- "description": one sentence on what the skill accomplishes and when to use it.',
    '- "content": a markdown procedure with these sections, in order:',
    "    ## When to use",
    "    ## Inputs   (the variables a caller must supply)",
    "    ## Steps    (numbered, imperative; describe intent, not pixel coordinates)",
    "    ## Verify   (how to confirm the workflow succeeded)",
    '- "tags": an array of 2-5 short lowercase tags.',
    `- "category": one of ${categoryIds}.`,
    `- "allowedTools": an array of tool names the skill needs, or []. ${tools} Never invent tool names.`,
    "",
    "Placeholders written as {{name}} are caller-supplied inputs — keep them as placeholders.",
    "Do not fabricate steps that are not implied by the transcript.",
  ].join("\n")
}

/**
 * Assemble the outbound payload.
 *
 * Callers must send `systemPrompt`/`userPrompt` verbatim; anything that
 * re-derives them defeats the guarantee this module exists to provide.
 */
export function buildGenerationEnvelope(
  views: readonly RecordedStepView[],
  options: EnvelopeOptions,
  categoryIds: string
): GenerationEnvelope {
  const included = includedSteps(views)
  const described = included.slice(0, MAX_ENVELOPE_STEPS)
  const truncatedSteps = included.length - described.length

  const lines = described.map((view, index) => describeStep(view, index, options.variables))
  const inputs = inputsForSkillBody(options.variables)

  const sections: string[] = ["Recorded workflow transcript:", ""]
  if (inputs.length > 0) {
    sections.push(
      "Caller-supplied inputs:",
      ...inputs.map((i) => `- {{${i.name}}}${i.sensitive ? " (secret — never log or echo)" : ""}`),
      ""
    )
  }
  sections.push(...lines)

  const verifications = included
    .filter((view) => view.verify)
    .map((view) => `- ${truncate(view.verify!)}`)
  if (verifications.length > 0) {
    sections.push("", "The user expects these to be true afterwards:", ...verifications)
  }
  if (truncatedSteps > 0) {
    sections.push(
      "",
      `(${truncatedSteps} further steps were omitted for length; the procedure continues past the last line.)`
    )
  }

  const assembled = sections.join("\n")
  const clean = hasNoLeakingPii(assembled)
  const userPrompt = clean ? assembled : redactText(assembled).redacted

  return {
    systemPrompt: buildSystemPrompt(options, categoryIds),
    userPrompt,
    redacted: !clean,
    truncatedSteps,
    describedSteps: described.length,
  }
}
