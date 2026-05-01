/**
 * Synthesizer — turn a distilled `TwinProfile` + a recent-chunk sample into
 * one Character draft + N Skill drafts. Outputs draft payloads (not yet
 * Dexie rows) so the orchestrator can stamp ids / job linkage.
 */

import { extractJson, type LlmClient } from "../llm"
import { applyTemplate, SYNTHESIZER_PROMPT } from "../prompts"
import type { TwinChunk, TwinDraftPayload, TwinProfile } from "@/types/twin"

export interface SynthesizerInput {
  profile: TwinProfile
  /** Recent chunks for grounding; pass <= 30 to keep the prompt tractable. */
  recentChunks: TwinChunk[]
}

export interface SynthDraft {
  payload: TwinDraftPayload
  rationale: string
  /** Set on skill drafts derived from a playbook. */
  sourcePlaybookId?: string
}

export interface SynthesizerResult {
  drafts: SynthDraft[]
  /** Updated voice summary the orchestrator persists onto the profile. */
  voiceSummary: string
}

interface RawCharacter {
  name?: string
  description?: string
  systemPrompt?: string
  voiceSummary?: string
}

interface RawSkill {
  name?: string
  description?: string
  content?: string
  sourcePlaybookId?: string
  rationale?: string
}

interface RawPayload {
  character?: RawCharacter
  skills?: RawSkill[]
}

function formatProfileForPrompt(profile: TwinProfile): string {
  // Compress the profile into prompt-friendly bullet points; the schema is
  // already covered by the template, so the model just needs the data.
  const parts: string[] = []
  if (profile.voiceSummary) parts.push(`Voice summary: ${profile.voiceSummary}`)
  if (profile.styleSamples.length > 0) {
    parts.push(
      `Style samples (${profile.styleSamples.length}):\n` +
        profile.styleSamples
          .slice(0, 5)
          .map((s) => `- ${s.contextLabel}: ${s.summary}`)
          .join("\n")
    )
  }
  if (profile.playbooks.length > 0) {
    parts.push(
      `Playbooks (${profile.playbooks.length}):\n` +
        profile.playbooks
          .map((p) => `- [${p.id}] ${p.title} (confidence=${p.confidence.toFixed(2)})`)
          .join("\n")
    )
  }
  if (profile.entities.length > 0) {
    parts.push(
      `Entities (${profile.entities.length}):\n` +
        profile.entities
          .slice(0, 20)
          .map((e) => `- ${e.role}: ${e.name}${e.relation ? ` (${e.relation})` : ""}`)
          .join("\n")
    )
  }
  return parts.join("\n\n")
}

function formatChunksForPrompt(chunks: TwinChunk[]): string {
  return chunks
    .slice(0, 30)
    .map((c) => `[${c.id}]\n${c.contentRedacted}`)
    .join("\n\n---\n\n")
}

export async function runSynthesizer(
  llm: LlmClient,
  input: SynthesizerInput
): Promise<SynthesizerResult> {
  const prompt = applyTemplate(SYNTHESIZER_PROMPT, {
    profile: formatProfileForPrompt(input.profile),
    chunks: formatChunksForPrompt(input.recentChunks),
  })

  const response = await llm.complete(prompt, { temperature: 0.2, maxTokens: 6000 })
  const parsed = extractJson<RawPayload>(response)

  const drafts: SynthDraft[] = []

  if (parsed.character) {
    const c = parsed.character
    drafts.push({
      payload: {
        kind: "character",
        data: {
          name: c.name?.trim() || `Twin of ${input.profile.twinId}`,
          description: c.description,
          systemPrompt: c.systemPrompt ?? "",
        },
      },
      rationale: `Synthesized from ${input.profile.styleSamples.length} style samples + ${input.profile.playbooks.length} playbooks.`,
    })
  }

  const skillsRaw = Array.isArray(parsed.skills) ? parsed.skills : []
  for (const skill of skillsRaw) {
    if (!skill.name || !skill.content) continue
    drafts.push({
      payload: {
        kind: "skill",
        data: {
          name: skill.name.trim(),
          description: skill.description,
          content: skill.content,
        },
        sourcePlaybookId: skill.sourcePlaybookId,
      },
      sourcePlaybookId: skill.sourcePlaybookId,
      rationale: skill.rationale ?? "Derived from a high-confidence playbook.",
    })
  }

  const voiceSummary = parsed.character?.voiceSummary?.trim() ?? input.profile.voiceSummary

  return { drafts, voiceSummary }
}
