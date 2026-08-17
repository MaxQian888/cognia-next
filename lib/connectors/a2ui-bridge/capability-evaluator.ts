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
  skillCapabilities?: readonly PlatformSkillCapability[]
): string {
  const native = componentKindsByLevel(matrix, "native")
  const simulated = componentKindsByLevel(matrix, "simulated")
  const fallback = componentKindsByLevel(matrix, "fallback")
  const unsupported = componentKindsByLevel(matrix, "unsupported")

  const lines: string[] = [
    `This conversation is delivered via ${platform}. The platform supports a limited A2UI subset:`,
  ]
  if (native.length > 0) {
    lines.push(`- Renders natively: ${native.join(", ")}.`)
  }
  if (simulated.length > 0) {
    lines.push(
      `- Available via multi-step UX — do not assume a synchronous reply on the same turn: ${simulated.join(", ")}.`
    )
  }
  if (fallback.length > 0) {
    lines.push(
      `- Degrades to plain text on this channel: ${fallback.join(", ")} (avoid when fidelity matters).`
    )
  }
  if (unsupported.length > 0) {
    lines.push(`- NOT supported — do not emit: ${unsupported.join(", ")}.`)
  }
  if (skillCapabilities && skillCapabilities.length > 0) {
    const summary = skillCapabilities
      .map((c) => `${c.family} (${c.mutations.join("+")})`)
      .join(", ")
    lines.push(
      `- Built-in skills available on this channel: ${summary}. ` +
        `Write/destructive operations route through an A2UI confirm card by default.`
    )
  }
  return lines.join("\n")
}
