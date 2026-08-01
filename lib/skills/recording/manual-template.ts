/**
 * The no-model path.
 *
 * When no utility model is configured — or the call fails — the user still has a
 * reviewed timeline, and that is enough to write a real skill from. This builds
 * a **complete** `When to use / Inputs / Steps / Verify` document from it, not a
 * stub with TODOs: a template the user has to fill in from scratch is barely
 * better than an empty editor, and the timeline already knows the steps.
 *
 * Every user-facing string is passed in by the caller (which holds the
 * `next-intl` translator), so this module stays pure and locale-agnostic.
 */

import { inputsForSkillBody, type InputVariable } from "./input-variables"
import { includedSteps, type RecordedStepView } from "./step-model"
import type { GeneratedDraft } from "./state-machine"

/** Localized chrome for the generated document. */
export interface ManualTemplateStrings {
  whenToUseHeading: string
  inputsHeading: string
  stepsHeading: string
  verifyHeading: string
  /** Shown under `When to use`, with `{scope}` interpolated by the caller. */
  whenToUseBody: string
  noInputs: string
  noVerify: string
  secretSuffix: string
  defaultName: string
  defaultDescription: string
  /** Fallback line for a step with no derivable description. */
  unnamedStep: string
  clickStep: (target: string) => string
  typeStep: (target: string, value: string) => string
  secretStep: (target: string) => string
  keysStep: (chord: string) => string
  scrollStep: (direction: "up" | "down") => string
}

export interface ManualTemplateOptions {
  views: readonly RecordedStepView[]
  variables: readonly InputVariable[]
  strings: ManualTemplateStrings
  category: string
  tags: string[]
}

function stepLine(view: RecordedStepView, s: ManualTemplateStrings): string {
  if (view.intent) return view.intent
  const step = view.captured
  if (!step) return s.unnamedStep

  const target = step.element?.name ?? step.element?.automationId ?? step.ocrHint ?? ""
  if (!target && step.kind !== "scroll" && !step.text) return s.unnamedStep

  switch (step.kind) {
    case "click":
      return s.clickStep(target)
    case "scroll":
      return s.scrollStep((step.scrollDy ?? 0) < 0 ? "down" : "up")
    case "type":
      if (!step.text) return s.typeStep(target, "")
      if (step.text.kind === "sensitive") return s.secretStep(target)
      if (step.text.kind === "keys") return s.keysStep(step.text.chord)
      return s.typeStep(target, step.text.value)
    case "outOfScope":
      return s.unnamedStep
  }
}

/**
 * Assemble the document.
 *
 * Note the input rows carry only names and a secret marker — never a recorded
 * sample. That is the same rule the model payload follows, for the same reason:
 * the user's actual typed data does not belong in a reusable artifact.
 */
export function buildManualSkillDraft(options: ManualTemplateOptions): GeneratedDraft {
  const { views, variables, strings: s } = options
  const included = includedSteps(views)
  const inputs = inputsForSkillBody(variables)
  const verifications = included.filter((view) => view.verify)

  const content = [
    `## ${s.whenToUseHeading}`,
    "",
    s.whenToUseBody,
    "",
    `## ${s.inputsHeading}`,
    "",
    inputs.length > 0
      ? inputs
          .map((i) => `- \`{{${i.name}}}\`${i.sensitive ? ` — ${s.secretSuffix}` : ""}`)
          .join("\n")
      : s.noInputs,
    "",
    `## ${s.stepsHeading}`,
    "",
    included.map((view, index) => `${index + 1}. ${stepLine(view, s)}`).join("\n"),
    "",
    `## ${s.verifyHeading}`,
    "",
    verifications.length > 0
      ? verifications.map((view) => `- ${view.verify}`).join("\n")
      : s.noVerify,
    "",
  ].join("\n")

  return {
    name: s.defaultName,
    description: s.defaultDescription,
    content,
    tags: options.tags,
    category: options.category,
    // Never guessed. A manual template has no basis for claiming a tool, and an
    // invented name would be inert at run time while looking authoritative.
    allowedTools: [],
  }
}
