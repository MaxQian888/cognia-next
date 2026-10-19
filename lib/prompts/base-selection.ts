/**
 * Which text a chat turn starts from (ADR-0236 §2.3), as one pure rule shared
 * by the send path (`resolveSendOptions`) and the Prompt Center's effective
 * preview, so the preview can never describe a precedence the send path does
 * not apply.
 *
 * It selects ONE base by nullish precedence; it never concatenates. An
 * explicit empty string is a choice (a session that cleared its prompt) and
 * stops the chain, exactly as `??` does.
 */

export type BaseSystemPromptSource =
  "session" | "team-member" | "character" | "app-default" | "none"

export interface BaseSystemPromptInput {
  sessionPrompt?: string
  memberOverride?: string
  characterPrompt?: string
  appDefault?: string
}

export interface BaseSystemPromptSelection {
  text: string | undefined
  source: BaseSystemPromptSource
}

export function selectBaseSystemPrompt(input: BaseSystemPromptInput): BaseSystemPromptSelection {
  if (input.sessionPrompt != null) return { text: input.sessionPrompt, source: "session" }
  if (input.memberOverride != null) return { text: input.memberOverride, source: "team-member" }
  if (input.characterPrompt != null) return { text: input.characterPrompt, source: "character" }
  if (input.appDefault != null) return { text: input.appDefault, source: "app-default" }
  return { text: undefined, source: "none" }
}

/** The persona fields a turn projects into guidance (ADR-0030). */
export interface PersonaInput {
  tone?: string
  personality?: string
}

/**
 * The character's free-form tone and personality as the short guidance block
 * appended after the base. Shared with the preview for the same reason as the
 * base rule. Empty when the persona says nothing.
 */
export function buildPersonaSection(persona: PersonaInput | undefined): string {
  if (!persona) return ""
  const parts: string[] = []
  const tone = persona.tone?.trim()
  const personality = persona.personality?.trim()
  if (tone) parts.push(`Tone: ${tone}`)
  if (personality) parts.push(personality)
  return parts.length > 0 ? `## Persona\n\n${parts.join("\n\n")}` : ""
}
