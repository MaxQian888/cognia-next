/**
 * Build the capability-aware system-prompt section for an IM channel.
 *
 * Consumer: `lib/claude/build-options.ts:resolveSendOptions` calls
 * {@link buildCapabilityPromptSection} when building the per-channel system
 * prompt so the assistant knows which A2UI kinds render natively, which
 * degrade, and which are unsupported on the current platform.
 *
 * (The former per-surface evaluator `evaluateSurfaceAgainstCapability` had
 * no runtime consumer — adapters branch on their own matrix inside their
 * mappers — and was removed on 2026-08-18.)
 */

import type { A2UICapabilityMatrix } from "@/types/connectors/capability"
import { componentKindsByLevel } from "@/types/connectors/capability"
import type { PlatformSkillCapability } from "@/types/connectors/skill-capability"
import { resolvePrompt } from "@/lib/prompts/resolve"
import type { PromptOverrideSnapshot } from "@/lib/prompts/snapshot"
import { definePrompt } from "@/lib/prompts/types"

/** Kind lists and skill summaries are short; generous so clipping never applies. */
const LIST_MAX = 20_000

type CapabilityLine = "header" | "native" | "simulated" | "fallback" | "unsupported" | "skills"

function capabilityPrompt(input: {
  line: CapabilityLine
  variable: string
  outputContract: string
  defaultBody: string
}) {
  return definePrompt({
    id: `chat.connector-capability.${input.line}`,
    contractVersion: 1,
    kind: "feature-template",
    group: "chat",
    operation: "replace-template",
    scopes: ["account"],
    activation: "next-operation",
    // Advisory wording: the platform mappers degrade any kind they cannot
    // render to plain text themselves, so nothing parses this text.
    risk: "ordinary",
    hosts: ["app"],
    maxChars: 2_000,
    variables: [{ name: input.variable, required: true, maxChars: LIST_MAX }],
    outputContract: input.outputContract,
    consumers: ["lib/connectors/a2ui-bridge/capability-evaluator.ts"],
    defaultBody: input.defaultBody,
  })
}

/**
 * The per-channel capability section, one Prompt Center entry per line
 * (ADR-0236): a line is emitted only when its level has kinds, and the
 * template syntax has no conditionals. Lines join with a newline in code.
 */
export const CONNECTOR_CAPABILITY_PROMPTS = {
  header: capabilityPrompt({
    line: "header",
    variable: "platform",
    outputContract:
      "First line of the IM channel capability section; {{platform}} is the platform id.",
    defaultBody:
      "This conversation is delivered via {{platform}}. The platform supports a limited A2UI subset:",
  }),
  native: capabilityPrompt({
    line: "native",
    variable: "kinds",
    outputContract:
      "Emitted when the channel renders some A2UI kinds natively; {{kinds}} is a comma list.",
    defaultBody: "- Renders natively: {{kinds}}.",
  }),
  simulated: capabilityPrompt({
    line: "simulated",
    variable: "kinds",
    outputContract:
      "Emitted when some kinds are simulated with a multi-step exchange; {{kinds}} is a comma list.",
    defaultBody:
      "- Available via multi-step UX — do not assume a synchronous reply on the same turn: {{kinds}}.",
  }),
  fallback: capabilityPrompt({
    line: "fallback",
    variable: "kinds",
    outputContract: "Emitted when some kinds degrade to plain text; {{kinds}} is a comma list.",
    defaultBody:
      "- Degrades to plain text on this channel: {{kinds}} (avoid when fidelity matters).",
  }),
  unsupported: capabilityPrompt({
    line: "unsupported",
    variable: "kinds",
    outputContract: "Emitted when some kinds are not supported at all; {{kinds}} is a comma list.",
    defaultBody: "- NOT supported — do not emit: {{kinds}}.",
  }),
  skills: capabilityPrompt({
    line: "skills",
    variable: "skills",
    outputContract:
      "Emitted when the channel serves built-in skill families; {{skills}} lists each family with its mutations.",
    defaultBody:
      "- Built-in skills available on this channel: {{skills}}. " +
      "Write/destructive operations route through an A2UI confirm card by default.",
  }),
} as const

function capabilityLine(
  line: CapabilityLine,
  value: string,
  snapshot: PromptOverrideSnapshot | null | undefined
): string {
  const def = CONNECTOR_CAPABILITY_PROMPTS[line]
  return resolvePrompt(def, { values: { [def.variables[0].name]: value }, snapshot }).text
}

/**
 * Build the capability summary the build-options resolver appends to the
 * system prompt. Concise (single paragraph, three bullets) so it fits
 * into the existing prompt budget without dominating.
 *
 * `skillCapabilities` (added at ADR-0026) appends an extra bullet
 * declaring the built-in skill families this channel can serve, e.g.
 *   `- Built-in skills available on this channel: lark.calendar
 *     (read+write), lark.doc (read+write), …`
 * so the assistant knows which lark-cli-backed tools it can invoke
 * without paying the cost of probing each tool at decision time.
 */
export function buildCapabilityPromptSection(
  platform: string,
  matrix: A2UICapabilityMatrix,
  skillCapabilities?: readonly PlatformSkillCapability[],
  /** The turn's frozen Prompt Center snapshot; the loaded one when omitted. */
  snapshot?: PromptOverrideSnapshot | null
): string {
  const native = componentKindsByLevel(matrix, "native")
  const simulated = componentKindsByLevel(matrix, "simulated")
  const fallback = componentKindsByLevel(matrix, "fallback")
  const unsupported = componentKindsByLevel(matrix, "unsupported")

  const lines: string[] = [capabilityLine("header", platform, snapshot)]
  if (native.length > 0) {
    lines.push(capabilityLine("native", native.join(", "), snapshot))
  }
  if (simulated.length > 0) {
    lines.push(capabilityLine("simulated", simulated.join(", "), snapshot))
  }
  if (fallback.length > 0) {
    lines.push(capabilityLine("fallback", fallback.join(", "), snapshot))
  }
  if (unsupported.length > 0) {
    lines.push(capabilityLine("unsupported", unsupported.join(", "), snapshot))
  }
  if (skillCapabilities && skillCapabilities.length > 0) {
    const summary = skillCapabilities
      .map((c) => `${c.family} (${c.mutations.join("+")})`)
      .join(", ")
    lines.push(capabilityLine("skills", summary, snapshot))
  }
  return lines.join("\n")
}
