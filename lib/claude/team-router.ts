// Pure functions that decide which members of a team should respond to a
// user turn. Kept dependency-free so they can be unit-tested without React,
// IndexedDB, or Tauri.

import type { Character, RoomReplyMode, Team, TeamMember } from "@cognia/agent-config-types"
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
 * The room-level inputs to routing (ADR-0177 batch 3). All optional: a
 * caller that passes nothing gets the routing every team had before rooms
 * had settings.
 */
export interface RouteTurnOptions {
  /**
   * `roomSettings.mutedMemberIds`. The room never picks a muted member on
   * its own initiative. An explicit `@` or a composer pick still reaches
   * one, because those are the user's initiative, not the room's.
   */
  mutedMemberIds?: readonly string[]
  /**
   * The members the user picked in the composer, in pick order. Beats every
   * policy below, mute and reply mode included, for the same reason a
   * mention does: the user said who should answer.
   */
  explicitTargetIds?: readonly string[]
  /** `roomSettings.replyMode`. `auto` is the shape every room had before. */
  replyMode?: RoomReplyMode
}

/**
 * Decide which team members should respond to this turn.
 *
 * In order of precedence:
 *
 * - `replyMode === "asleep"`: nobody, whatever else was said. The turn is
 *   stored and the room stays quiet until the mode changes.
 * - A composer pick (`explicitTargetIds`), then an `@` mention: exactly
 *   those members, muted or not.
 * - `replyMode === "mention_only"`: nobody, since nobody was addressed.
 * - Then the team's own policy over the members that are not muted:
 *   `mention_round_robin` picks the primary responder (or the first member),
 *   `round_robin` picks everyone, `manual` and `supervisor` pick nobody
 *   here (the user, or the supervisor loop, decides).
 */
export function routeTurn(
  team: Pick<Team, "members" | "orchestration" | "maxResponses">,
  members: readonly Character[],
  userText: string,
  primaryCharacterId?: string,
  opts: RouteTurnOptions = {}
): Character[] {
  // Order members per the team's declared order; drop any whose row no longer
  // exists (a deleted character shouldn't be sent).
  const byId = new Map(members.map((c) => [c.id, c]))
  const ordered: Character[] = []
  for (const slot of team.members) {
    const c = byId.get(slot.characterId)
    if (c && !ordered.some((candidate) => candidate.id === c.id)) ordered.push(c)
  }

  if (opts.replyMode === "asleep") return []

  const cap = resolveTeamResponseCap(team.maxResponses)
  // A pick, then an explicit @, always win, independent of the no-mention
  // policy. This is what makes a group conversation addressable without
  // changing the team's default moderator/all/smart-primary behavior.
  const picked = explicitTargetsOf(opts.explicitTargetIds, ordered)
  if (picked.length > 0) return picked.slice(0, cap)
  const mentioned = parseMentions(userText, ordered)
  if (mentioned.length > 0) return mentioned.slice(0, cap)

  if (opts.replyMode === "mention_only") return []

  const muted = new Set(opts.mutedMemberIds ?? [])
  const eligible = ordered.filter((member) => !muted.has(member.id))

  switch (team.orchestration) {
    case "manual":
      // Manual + supervisor are both "no automatic linear fanout"; supervisor
      // is handled by the orchestrator (runSupervisorTurn).
      return []
    case "supervisor":
      return []
    case "round_robin":
      return eligible.slice(0, cap)
    case "mention_round_robin":
    default: {
      const selected = primaryCharacterId
        ? eligible.find((member) => member.id === primaryCharacterId)
        : undefined
      return (selected ? [selected] : eligible.slice(0, 1)).slice(0, cap)
    }
  }
}

/** The picked members that are on the team, in pick order, each once. */
function explicitTargetsOf(
  ids: readonly string[] | undefined,
  ordered: readonly Character[]
): Character[] {
  if (!ids || ids.length === 0) return []
  const byId = new Map(ordered.map((member) => [member.id, member]))
  const out: Character[] = []
  for (const id of ids) {
    const member = byId.get(id)
    if (member && !out.includes(member)) out.push(member)
  }
  return out
}

/** Why a user turn produced no reply on purpose. */
export type TurnHoldReason = "asleep" | "mention_only" | "manual"

export interface UserTurnPlan {
  targets: Character[]
  /**
   * Set when the room chose silence. `null` with no targets means the
   * supervisor loop owns the turn, or the roster is empty.
   */
  held: TurnHoldReason | null
}

/**
 * `routeTurn` plus the reason nobody was picked, so the runner can tell a
 * held turn (the room's settings said so) from a supervisor turn (someone
 * else decides) without re-deriving the policy.
 */
export function planUserTurn(
  team: Pick<Team, "members" | "orchestration" | "maxResponses">,
  members: readonly Character[],
  userText: string,
  primaryCharacterId?: string,
  opts: RouteTurnOptions = {}
): UserTurnPlan {
  const targets = routeTurn(team, members, userText, primaryCharacterId, opts)
  return { targets, held: holdReasonFor(team, targets, opts) }
}

/**
 * The hold reason for a routing result. Split from `planUserTurn` so the
 * runner can call `routeTurn` itself (its test doubles that one call) and
 * still name why an empty result is silence rather than a supervisor turn.
 */
export function holdReasonFor(
  team: Pick<Team, "orchestration">,
  targets: readonly Character[],
  opts: RouteTurnOptions = {}
): TurnHoldReason | null {
  if (targets.length > 0) return null
  if (opts.replyMode === "asleep") return "asleep"
  if (opts.replyMode === "mention_only") return "mention_only"
  if (team.orchestration === "manual") return "manual"
  return null
}

/**
 * The member that spoke last, if it is still a candidate (ADR-0177 batch 3).
 *
 * A follow-up that names nobody most often continues the exchange the user
 * was just having, so the smart primary router is told who that was and
 * keeps them unless another member clearly fits better, and the
 * deterministic fallback (no utility model) is that member instead of
 * whoever is first on the roster. A last speaker that is muted or gone is
 * not sticky: the room is not going to pick them anyway.
 */
export function stickyResponderOf<T extends { id: string }>(
  messages: readonly { role: string; metadata?: unknown }[],
  candidates: readonly T[]
): T | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role !== "assistant") continue
    const senderId = (message.metadata as { senderId?: unknown } | undefined)?.senderId
    if (typeof senderId !== "string") continue
    return candidates.find((candidate) => candidate.id === senderId)
  }
  return undefined
}

/** `TeamMember.talkativeness` clamped to 0..1, absent and malformed read as 0. */
export function clampTalkativeness(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
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

// ---- Handoff: letting the room continue without the user ------------------

/**
 * Members a reply hands the floor to.
 *
 * `parseMentions` only ever ran on the USER's text, so an agent writing
 * "@Ben, can you check the migration?" was addressing nobody: the sentence
 * read as prose and the room stopped until a human pushed it. Scanning replies
 * with the same scanner is what makes a team able to hold a conversation
 * rather than take turns answering one person.
 *
 * Self-mentions are dropped. A member that says its own name is narrating, not
 * handing over, and honouring it would let one agent loop on itself forever.
 */
export function parseHandoffTargets(
  replyText: string,
  members: readonly Character[],
  speakerId: string
): Character[] {
  return parseMentions(replyText, members).filter((member) => member.id !== speakerId)
}

/** One member's contribution to the round that just finished. */
export interface TeamReply {
  characterId: string
  text: string
  /**
   * The member asked the group to stop, via {@link HANDOFF_STOP_TOKEN}.
   *
   * A flag rather than a scan of `text`, because the orchestrator strips the
   * token before the message is stored. Reading it back off the transcript
   * would find nothing, and the room would run to its ceiling while looking
   * as though the protocol worked.
   */
  stopRequested?: boolean
}

/**
 * What a member writes to end the handoff chain.
 *
 * The three ceilings below are the room's budget, not its judgement. They can
 * only ever say "that is enough spending", never "we are finished", so a team
 * that reached an answer in one exchange still burned every round it was
 * allowed. This is the other half: the members decide when the work is done,
 * and the ceilings remain there for when they do not.
 *
 * A tag rather than a bare word (AutoGen's convention is a plain `TERMINATE`)
 * because these members write prose to each other, and a plain word appears in
 * ordinary sentences about stopping. It matches the `<dispatch>` shape the
 * supervisor protocol in this same file already uses.
 */
export const HANDOFF_STOP_TOKEN = "<stop-handoff/>"

const HANDOFF_STOP_RE = /<\s*\/?\s*stop-handoff\s*\/?\s*>/gi

/** Whether a reply asked for the chain to end. */
export function hasHandoffStopToken(text: string): boolean {
  HANDOFF_STOP_RE.lastIndex = 0
  return HANDOFF_STOP_RE.test(text)
}

/**
 * Remove the token from what the reader sees.
 *
 * The message is stored and rendered like any other, so leaving the tag in
 * would put a piece of the room's internal protocol in front of the user.
 * Same reason `stripDispatches` exists a few lines up.
 */
export function stripHandoffStopToken(text: string): string {
  return text
    .replace(HANDOFF_STOP_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Why the room stopped continuing on its own. `null` means it did not. */
export type AutoRoundStop = "budget" | "cap" | "repeat" | "no-handoff" | "token"

export interface AutoRoundPlan {
  /** Members to run next, in the order they were first addressed. */
  targets: Character[]
  stop: AutoRoundStop | null
}

/**
 * A member may hold the floor at most this many times inside ONE user turn.
 *
 * Two, not one, because "A asks B, B answers, A concludes" is the shape that
 * makes a handoff worth having. Not more, because A and B addressing each
 * other is otherwise a perpetual motion machine that bills by the token: the
 * time-based ping-pong guard in `lib/ai/agent/team/gates/message-guard.ts` cannot
 * help here, since these rounds run back to back with no gap between them.
 */
export const MAX_TURNS_PER_MEMBER_PER_ROUND = 2

export interface PlanAutoRoundArgs {
  /** What the members who just spoke produced. */
  replies: readonly TeamReply[]
  members: readonly Character[]
  /** How many member replies this user turn has already produced. */
  spokenCount: number
  /** `Team.maxResponses`, already resolved. */
  responseCap: number
  /** Completed auto rounds so far. The first handoff round is 0. */
  round: number
  /** `Team.maxAutoRounds`. Zero disables handoff entirely. */
  maxAutoRounds: number
  /** Every member id that has spoken in this user turn, including repeats. */
  spokenIds: readonly string[]
  /**
   * `roomSettings.mutedMemberIds` (ADR-0177 batch 3). A handoff to a muted
   * member is dropped, and a muted member never chimes in.
   */
  mutedMemberIds?: readonly string[]
  /**
   * The team's slots, for each speaker's `handoffTargets` and each member's
   * `talkativeness`. Absent means every member may hand off to anyone and
   * nobody chimes in, the shape every team had before.
   */
  slots?: ReadonlyMap<string, Pick<TeamMember, "handoffTargets" | "talkativeness">>
  /** The roll behind talkativeness. Injected so a test is deterministic. */
  random?: () => number
}

/**
 * Decide who speaks next when nobody has typed anything.
 *
 * Three independent ceilings, all of which must hold: the round budget, the
 * team's existing response cap, and the per-member limit above. Any one of
 * them ending the chain is reported rather than silently observed, because a
 * room that stops has to be able to say why.
 */
export function planAutoRound(args: PlanAutoRoundArgs): AutoRoundPlan {
  const { replies, members, spokenCount, responseCap, round, maxAutoRounds, spokenIds } = args
  const muted = new Set(args.mutedMemberIds ?? [])
  const roll = args.random ?? Math.random

  // Read the round first, then decide whether the room may pay for it. The
  // ceilings used to be checked up front, which made every stop reason mean
  // the same thing: the chain ended. Asking who was handed the floor first is
  // what lets `no-handoff` (the room finished) be told apart from `budget`
  // and `cap` (the room was cut off), and only the second kind is worth
  // telling anyone about.
  if (replies.some((reply) => reply.stopRequested)) return { targets: [], stop: "token" }

  const spokenTally = new Map<string, number>()
  for (const id of spokenIds) spokenTally.set(id, (spokenTally.get(id) ?? 0) + 1)
  const atLimit = (id: string) => (spokenTally.get(id) ?? 0) >= MAX_TURNS_PER_MEMBER_PER_ROUND

  const picked: Character[] = []
  const seen = new Set<string>()
  let blockedByRepeat = false
  for (const reply of replies) {
    // The speaker's transition graph. `undefined` is the open room every
    // team had before; `[]` is a member that may be addressed but never
    // passes the floor on.
    const allowed = args.slots?.get(reply.characterId)?.handoffTargets
    for (const target of parseHandoffTargets(reply.text, members, reply.characterId)) {
      if (seen.has(target.id) || muted.has(target.id)) continue
      if (allowed && !allowed.includes(target.id)) continue
      if (atLimit(target.id)) {
        blockedByRepeat = true
        continue
      }
      seen.add(target.id)
      picked.push(target)
    }
  }
  const handoffCount = picked.length

  // Talkativeness: a member nobody addressed may still speak up, once per
  // round, with the probability its slot declares. Never the members that
  // just spoke (they had their say), never a muted one, never past the
  // per-member limit. Absent talkativeness is 0, so a team that never set
  // it sees no change.
  const justSpoke = new Set(replies.map((reply) => reply.characterId))
  for (const member of members) {
    if (seen.has(member.id) || muted.has(member.id) || justSpoke.has(member.id)) continue
    const eagerness = clampTalkativeness(args.slots?.get(member.id)?.talkativeness)
    if (eagerness <= 0 || atLimit(member.id)) continue
    if (roll() < eagerness) {
      seen.add(member.id)
      picked.push(member)
    }
  }

  if (picked.length === 0) {
    return { targets: [], stop: blockedByRepeat ? "repeat" : "no-handoff" }
  }
  // Running out of rounds cuts a handoff chain off, which the room reports.
  // It only ends a talkative member's chiming in, which is not worth a word.
  if (maxAutoRounds <= 0 || round >= maxAutoRounds) {
    return { targets: [], stop: handoffCount > 0 ? "budget" : "no-handoff" }
  }
  const remaining = responseCap - spokenCount
  if (remaining <= 0) return { targets: [], stop: handoffCount > 0 ? "cap" : "no-handoff" }

  // Truncating is not a stop: the members that did fit still speak, and the
  // next round's checks are what end the chain.
  return { targets: picked.slice(0, remaining), stop: null }
}
