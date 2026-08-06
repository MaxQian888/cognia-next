// Pure functions that decide which members of a team should respond to a
// user turn. Kept dependency-free so they can be unit-tested without React,
// IndexedDB, or Tauri.

import type { Character, Team, TeamMember } from "@cognia/agent-config-types"
import { resolveTeamResponseCap } from "./team-primary-router"

/**
 * Parse `@Name` mentions out of `text`, matched against `members` by name.
 *
 * - Case-insensitive.
 * - Longest-match-first, so "Code Reviewer Pro" beats "Code Reviewer".
 * - The matched name must be followed by whitespace, common punctuation, or
 *   end-of-string — so "@Coder!" matches but "@Coderbot" does not.
 * - Returns each member at most once, in the order they were first mentioned.
 *
 * Generic over any `{ id, name }` shape so the same scanner backs both team
 * member routing (`Character`) and the chat composer's `@agent` subagent
 * resolution (`SubagentMentionTarget` projected to `{ id, name: handle }`).
 */
export function parseMentions<T extends { id: string; name: string }>(
  text: string,
  members: readonly T[]
): T[] {
  if (!text || members.length === 0) return []

  // Pre-sort by descending name length so we always try the longest match first.
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length)
  const lower = text.toLowerCase()
  const seen = new Set<string>()
  const result: T[] = []

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue
    // The `@` must sit at the start or follow whitespace — otherwise it's an
    // email (`me@host`) or a `path/@thing`, not a mention. Mirrors the
    // composer's `detectTrigger` boundary so the popover and the send-time
    // scanner agree on what counts as a mention.
    const before = i === 0 ? "" : text[i - 1]
    if (before !== "" && !/\s/.test(before)) continue
    const start = i + 1
    if (start >= text.length) continue

    for (const m of sorted) {
      const name = m.name.toLowerCase()
      if (!name) continue
      if (lower.slice(start, start + name.length) !== name) continue
      const after = lower[start + name.length]
      if (after !== undefined && !isDelimiter(after)) continue
      if (!seen.has(m.id)) {
        seen.add(m.id)
        result.push(m)
      }
      // Skip past the matched name so we don't re-scan its interior.
      i = start + name.length - 1
      break
    }
  }
  return result
}

function isDelimiter(ch: string): boolean {
  // Whitespace and the most common sentence punctuation. Anything else (a
  // letter, digit, or `_`) means the @-token is bleeding into another word.
  return /[\s.,!?;:)\]"'`]/.test(ch)
}

/**
 * Decide which team members should respond to this turn.
 *
 * - `mention_round_robin`: if any members are mentioned, return them in the
 *   order they appear; otherwise every member replies once in declared order.
 * - `round_robin`: every member replies once, regardless of mentions.
 * - `manual`: nobody replies automatically — the user picks via the member
 *   list. Returns an empty list.
 */
export function routeTurn(
  team: Pick<Team, "members" | "orchestration" | "maxResponses">,
  members: readonly Character[],
  userText: string,
  primaryCharacterId?: string
): Character[] {
  // Order members per the team's declared order; drop any whose row no longer
  // exists (a deleted character shouldn't be sent).
  const byId = new Map(members.map((c) => [c.id, c]))
  const ordered: Character[] = []
  for (const slot of team.members) {
    const c = byId.get(slot.characterId)
    if (c && !ordered.some((candidate) => candidate.id === c.id)) ordered.push(c)
  }

  const cap = resolveTeamResponseCap(team.maxResponses)
  // An explicit @ always wins, independent of the no-mention policy. This is
  // what makes a group conversation addressable without changing the team's
  // default moderator/all/smart-primary behavior.
  const mentioned = parseMentions(userText, ordered)
  if (mentioned.length > 0) return mentioned.slice(0, cap)

  switch (team.orchestration) {
    case "manual":
      // Manual + supervisor are both "no automatic linear fanout"; supervisor
      // is handled by the orchestrator hook (runSupervisorTurn).
      return []
    case "supervisor":
      return []
    case "round_robin":
      return ordered.slice(0, cap)
    case "mention_round_robin":
    default: {
      const selected = primaryCharacterId
        ? ordered.find((member) => member.id === primaryCharacterId)
        : undefined
      return (selected ? [selected] : ordered.slice(0, 1)).slice(0, cap)
    }
  }
}

// ---- Supervisor mode helpers ---------------------------------------------

/** A directive parsed out of the supervisor's reply. */
export interface Dispatch {
  characterId: string
  characterName: string
  task: string
}

const DISPATCH_RE = /<dispatch\s+to=["']([^"']+)["']\s*>([\s\S]*?)<\/dispatch>/gi

/**
 * Extract `<dispatch to="Name">…task…</dispatch>` directives from the
 * supervisor's text. Names are matched against `members` case-insensitively
 * (after trim). Unmatched names are silently dropped — the orchestrator
 * treats a no-dispatch supervisor turn as "supervisor answers directly".
 *
 * The regex is non-greedy, so a nested `<dispatch>` inside the body is
 * captured verbatim as text inside the outer task and is NOT re-parsed.
 * Malformed (unclosed) tags are ignored.
 *
 * Returns dispatches in source order; the same member may appear multiple
 * times (the orchestrator runs them sequentially).
 */
export function parseDispatches(text: string, members: readonly Character[]): Dispatch[] {
  if (!text) return []
  const byName = new Map<string, Character>()
  for (const m of members) {
    if (m.name) byName.set(m.name.trim().toLowerCase(), m)
  }
  if (byName.size === 0) return []

  const out: Dispatch[] = []
  // Reset regex state because /g instances retain `lastIndex`.
  DISPATCH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DISPATCH_RE.exec(text)) !== null) {
    const wantedName = match[1].trim().toLowerCase()
    const task = match[2].trim()
    if (!task) continue
    const target = byName.get(wantedName)
    if (!target) continue
    out.push({
      characterId: target.id,
      characterName: target.name,
      task,
    })
  }
  return out
}

/**
 * Strip every `<dispatch>` block (along with surrounding whitespace) so the
 * supervisor's user-facing text doesn't show its internal directives. Used
 * when a round-2 supervisor turn still contains dispatch tags despite being
 * told not to emit any.
 */
export function stripDispatches(text: string): string {
  return text
    .replace(DISPATCH_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Build the supervisor system-prompt addendum that introduces the available
 * members and explains the dispatch protocol. The orchestrator appends this
 * to the supervisor's resolved system prompt before each supervisor turn.
 */
export function buildSupervisorRoster(
  members: readonly Character[],
  memberByCharId: ReadonlyMap<string, TeamMember>
): string {
  if (members.length === 0) return ""
  const lines = ["## Available members"]
  for (const m of members) {
    const slot = memberByCharId.get(m.id)
    const role = slot?.role?.trim()
    const desc = (m.description ?? "").trim().slice(0, 80)
    const pieces: string[] = [`- ${m.name}`]
    if (role) pieces.push(`(role: ${role})`)
    if (desc) pieces.push(`— ${desc}`)
    lines.push(pieces.join(" "))
  }
  lines.push("")
  lines.push('To dispatch a member: emit <dispatch to="Name">specific task</dispatch>.')
  lines.push(
    "Plain text outside <dispatch> tags is your reply to the user. If you can answer alone, just answer."
  )
  return lines.join("\n")
}
