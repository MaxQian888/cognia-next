import type { Character, TeamMember } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { hasNoLeakingPii, redactText } from "@cognia/redact"

export const DEFAULT_TEAM_RESPONSE_CAP = 4
export const MAX_TEAM_RESPONSE_CAP = 12
/**
 * Ceiling on `Team.maxAutoRounds`. A room that continues on its own spends
 * real money per round with nobody watching, so the editor refuses a number
 * large enough for that to be a surprise.
 */
export const MAX_AUTO_ROUNDS = 5

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
  /** The candidates, already without the room's muted members. */
  members: readonly Character[]
  memberByCharId: ReadonlyMap<string, TeamMember>
  /**
   * The member that spoke last (ADR-0177 batch 3). The model is told to keep
   * it unless another candidate clearly fits the request better, and it is
   * the deterministic answer when no utility model is available.
   */
  sticky?: Character
}

/**
 * The member a room falls back to when the utility model cannot decide: the
 * sticky one, else the most talkative (declared order breaks ties), else the
 * first declared. Exported so the router test and the editor's help text can
 * name the same rule.
 */
export function fallbackPrimaryResponder(
  members: readonly Character[],
  memberByCharId: ReadonlyMap<string, Pick<TeamMember, "talkativeness">>,
  sticky?: Character
): Character | undefined {
  if (sticky && members.some((member) => member.id === sticky.id)) return sticky
  let best: Character | undefined
  let bestEagerness = 0
  for (const member of members) {
    const eagerness = talkativenessOf(memberByCharId.get(member.id)?.talkativeness)
    if (eagerness > bestEagerness) {
      best = member
      bestEagerness = eagerness
    }
  }
  return best ?? members[0]
}

function talkativenessOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/**
 * Use the configured utility model to select one primary Agent for an
 * unmentioned group-chat turn. The model sees stable roster tokens rather
 * than Agent names, and all locally-derived text is redacted then checked
 * again before leaving the device. Any unavailable/invalid/unsafe result
 * deterministically falls back to {@link fallbackPrimaryResponder}.
 */
export async function selectPrimaryResponder({
  client,
  userText,
  members,
  memberByCharId,
  sticky,
}: SelectPrimaryResponderArgs): Promise<Character | undefined> {
  const fallback = fallbackPrimaryResponder(members, memberByCharId, sticky)
  if (!fallback || !client) return fallback

  const nameHints = members.map((member) => member.name).filter(Boolean)
  const stickyIndex = sticky ? members.findIndex((member) => member.id === sticky.id) : -1
  const roster = members
    .map((member, index) => {
      const slot = memberByCharId.get(member.id)
      const role = slot?.role?.trim() ?? ""
      const description = member.description?.trim() ?? ""
      const eagerness = talkativenessOf(slot?.talkativeness)
      const columns = [`A${index + 1}`, role, description]
      if (eagerness > 0) columns.push(`speaks up ${Math.round(eagerness * 100)}% of the time`)
      return columns.join(" | ")
    })
    .join("\n")
  const continuity =
    stickyIndex >= 0
      ? `\n\nA${stickyIndex + 1} answered the previous turn. Keep A${stickyIndex + 1} unless another candidate clearly fits this request better.`
      : ""
  const source = `User request:\n${userText.trim()}\n\nCandidate Agents:\n${roster}${continuity}`
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
