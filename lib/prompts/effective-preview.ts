/**
 * The Prompt Center's effective chat preview (ADR-0236 §4, revision R5).
 *
 * It lays out the system prompt a chat turn starts from, segment by segment in
 * the order `resolveSendOptions` joins them, from the same pure rules the send
 * path uses (`selectBaseSystemPrompt`, `buildPersonaSection`,
 * `buildWorkspaceInstructionsSection`, the instruction loader's own section).
 * It never re-runs the send path: that mints gateway tickets and reads live
 * per-turn state. Sections only a turn can produce (memory recall, goals,
 * plans, team protocol, visual output, sandbox hints, compaction recovery) are
 * named as assembled at send time instead of being guessed at.
 */

import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"
import { buildWorkspaceInstructionsSection } from "@/lib/workspace/workspace-instructions"
import {
  buildPersonaSection,
  selectBaseSystemPrompt,
  type BaseSystemPromptInput,
  type BaseSystemPromptSource,
  type PersonaInput,
} from "./base-selection"

/** The separator `resolveSendOptions` joins system-prompt sections with. */
export const SYSTEM_PROMPT_SECTION_SEPARATOR = "\n\n---\n\n"

export type EffectiveSegmentKind =
  "base" | "persona" | "harness" | "instructions" | "workspace" | "mode" | "skills"

export interface EffectiveSegment {
  kind: EffectiveSegmentKind
  /** For the base: which rung of the selection supplied it. */
  baseSource?: BaseSystemPromptSource
  /** The owner's display name (agent, workspace, mode). */
  label?: string
  /** Exactly what the turn sends for this section. Absent for `skills`. */
  text?: string
  /** For `skills`: the Skills a turn may deliver; the runtime picks per turn. */
  items?: readonly string[]
  chars: number
  tokens: number
}

/** Why a section the user might expect is not in the preview. */
export type EffectiveOmissionReason =
  /** Bare mode skips on-disk instruction discovery. */
  | "bare-mode"
  /** This host has no project filesystem to read instruction files from. */
  | "no-filesystem"
  /** The loader failed; the send path would also continue without it. */
  | "load-failed"
  /** The selected owner supplies nothing for the section. */
  | "empty"

export interface EffectiveOmission {
  kind: EffectiveSegmentKind
  reason: EffectiveOmissionReason
}

/** Sections only a live turn produces, in send order. */
export const SEND_TIME_SECTIONS = [
  "memory",
  "project-continuity",
  "knowledge",
  "goal",
  "plan",
  "visual-output",
  "team-protocol",
  "sandbox",
  "brief-mode",
  "compaction-recovery",
  "output-style",
] as const

export type SendTimeSection = (typeof SEND_TIME_SECTIONS)[number]

export interface EffectivePreviewInput {
  base: BaseSystemPromptInput
  /** Display name of the agent whose prompt and persona apply. */
  agentName?: string
  persona?: PersonaInput
  /** `renderHarnessSections(character.harness)`. */
  harnessText?: string
  /** The instruction loader's rendered section, or why there is none. */
  instructions: { section: string } | { omitted: Exclude<EffectiveOmissionReason, "empty"> }
  workspace?: { name: string; customInstructions?: string } | null
  /** The active mode's resolved section. */
  mode?: { name: string; text: string } | null
  /** Names of the Skills the agent may deliver. */
  skills?: readonly string[]
}

export interface EffectivePreview {
  segments: EffectiveSegment[]
  omitted: EffectiveOmission[]
  /** The joined text of every segment that has text, as the turn sends it. */
  text: string
  chars: number
  tokens: number
  sendTime: readonly SendTimeSection[]
}

function textSegment(
  kind: EffectiveSegmentKind,
  text: string,
  extra: Partial<EffectiveSegment> = {}
): EffectiveSegment {
  return { kind, text, chars: text.length, tokens: estimateFallbackTokens(text), ...extra }
}

export function composeEffectivePreview(input: EffectivePreviewInput): EffectivePreview {
  const segments: EffectiveSegment[] = []
  const omitted: EffectiveOmission[] = []
  const push = (
    kind: EffectiveSegmentKind,
    text: string | undefined,
    extra: Partial<EffectiveSegment> = {}
  ) => {
    // The send path drops blank sections before joining.
    if (text && text.trim().length > 0) segments.push(textSegment(kind, text, extra))
    else omitted.push({ kind, reason: "empty" })
  }

  const base = selectBaseSystemPrompt(input.base)
  push("base", base.text, {
    baseSource: base.source,
    ...(base.source === "character" && input.agentName ? { label: input.agentName } : {}),
  })
  push(
    "persona",
    buildPersonaSection(input.persona),
    input.agentName ? { label: input.agentName } : {}
  )
  push("harness", input.harnessText, input.agentName ? { label: input.agentName } : {})
  if ("section" in input.instructions) push("instructions", input.instructions.section)
  else omitted.push({ kind: "instructions", reason: input.instructions.omitted })
  push(
    "workspace",
    buildWorkspaceInstructionsSection(input.workspace),
    input.workspace ? { label: input.workspace.name } : {}
  )
  push("mode", input.mode?.text, input.mode ? { label: input.mode.name } : {})
  if (input.skills && input.skills.length > 0) {
    segments.push({ kind: "skills", items: [...input.skills], chars: 0, tokens: 0 })
  } else {
    omitted.push({ kind: "skills", reason: "empty" })
  }

  const text = segments
    .map((segment) => segment.text)
    .filter((part): part is string => Boolean(part))
    .join(SYSTEM_PROMPT_SECTION_SEPARATOR)
  return {
    segments,
    omitted,
    text,
    chars: text.length,
    tokens: estimateFallbackTokens(text),
    sendTime: SEND_TIME_SECTIONS,
  }
}
