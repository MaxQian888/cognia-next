import type { Character, TeamMember } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export const DEFAULT_TEAM_RESPONSE_CAP = 4
export const MAX_TEAM_RESPONSE_CAP = 12

export function resolveTeamResponseCap(maxResponses: number | undefined): number {
  if (!Number.isInteger(maxResponses)) return DEFAULT_TEAM_RESPONSE_CAP
  return Math.min(MAX_TEAM_RESPONSE_CAP, Math.max(1, maxResponses!))
}

export function duplicateTeamResponseIds(
  responses: readonly { id: string; text: string; existing: boolean }[]
): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const response of responses) {
    const signature = response.text.trim().replace(/\s+/g, " ").toLocaleLowerCase()
    if (!signature) continue
    if (!response.existing && seen.has(signature)) duplicates.add(response.id)
    else seen.add(signature)
  }
  return duplicates
}

interface SelectPrimaryResponderArgs {
  client: Pick<LlmClient, "complete"> | null
  userText: string
  members: readonly Character[]
  memberByCharId: ReadonlyMap<string, TeamMember>
}

/**
 * Use the configured utility model to select one primary Agent for an
 * unmentioned group-chat turn. The model sees stable roster tokens rather
 * than Agent names, and all locally-derived text is redacted then checked
 * again before leaving the device. Any unavailable/invalid/unsafe result
 * deterministically falls back to the first declared member.
 */
export async function selectPrimaryResponder({
  client,
  userText,
  members,
  memberByCharId,
}: SelectPrimaryResponderArgs): Promise<Character | undefined> {
  const fallback = members[0]
  if (!fallback || !client) return fallback

  const nameHints = members.map((member) => member.name).filter(Boolean)
  const roster = members
    .map((member, index) => {
      const role = memberByCharId.get(member.id)?.role?.trim() ?? ""
      const description = member.description?.trim() ?? ""
      return `A${index + 1} | ${role} | ${description}`
    })
    .join("\n")
  const source = `User request:\n${userText.trim()}\n\nCandidate Agents:\n${roster}`
  const prompt = redactText(source, nameHints).redacted
  if (!hasNoLeakingPii(prompt)) return fallback

  try {
    const raw = await client.complete(prompt, {
      system:
        "Select exactly one primary responder for a multi-Agent group chat. " +
        "Reply with only its roster token (for example A2). Do not answer the request.",
      temperature: 0,
      maxTokens: 8,
    })
    const match = raw.trim().match(/^A(\d+)$/i)
    if (!match) return fallback
    const index = Number(match[1]) - 1
    return members[index] ?? fallback
  } catch {
    return fallback
  }
}
