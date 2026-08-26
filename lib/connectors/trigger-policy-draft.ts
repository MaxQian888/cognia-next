/**
 * Editable projection of a `TriggerPolicy`.
 *
 * ## Why a draft shape at all
 *
 * A stored policy is two arrays of discriminated unions with no stable ids.
 * Rendering that as an add/remove list means React keys by index, a kind picker
 * per row, and an operator staring at "rule 3 of 5" instead of at the question
 * they actually have: *when does this bot answer?* The draft flattens both
 * arrays into one slot per kind — a toggle plus its parameters — which is what
 * the question looks like.
 *
 * ## Why merging duplicates is safe
 *
 * Rules are OR and blockers are AND-NOT, so every duplicate of a kind has an
 * exactly equivalent single-rule form, and {@link toTriggerPolicyDraft}
 * collapses to it rather than dropping anything:
 *
 *   - id / word / prefix lists — union. `[a] OR [b]` is `[a, b]`.
 *   - `rate-limit` — per-field minimum. Blocking at `>= a` or at `>= b` is
 *     blocking at `>= min(a, b)`. An absent `perTenantPerMin` imposes no
 *     ceiling, so it loses to any present one rather than winning as `min`.
 *   - `cooldown-after-bot-reply` — maximum. Inside `a` seconds or inside `b`
 *     seconds is inside `max(a, b)` seconds.
 *
 * The merged form can report a different *reason string* than the original
 * would have (a merged rate limit names one bucket where two limits might have
 * named either), but never a different decision.
 *
 * The one shape with no equivalent single-rule form is two `keyword` rules that
 * disagree on `caseInsensitive`: merging them either widens the case-sensitive
 * words or narrows the case-insensitive ones. Those extra rules are kept
 * verbatim in {@link TriggerPolicyDraft.residualRules}, survive a round trip
 * untouched, and are surfaced in the editor rather than silently discarded.
 */

import type { TriggerBlocker, TriggerPolicy, TriggerRule } from "@/types/connectors/policy"

export interface TriggerRuleDraft {
  /** Every message in a chat the platform reports as private. */
  privateDefault: boolean
  /** The bot was @-mentioned. */
  selfMention: boolean
  /** The message replies to one this bot sent. */
  replyToBot: boolean
  slashCommand: { enabled: boolean; prefixes: string[] }
  keyword: { enabled: boolean; words: string[]; caseInsensitive: boolean }
  userAllowlist: { enabled: boolean; userIds: string[] }
  channelAllowlist: { enabled: boolean; channelIds: string[] }
}

export interface TriggerBlockerDraft {
  userBlocklist: { enabled: boolean; userIds: string[] }
  channelBlocklist: { enabled: boolean; channelIds: string[] }
  keywordBlocklist: { enabled: boolean; words: string[] }
  rateLimit: {
    enabled: boolean
    perUserPerMin: number
    perChannelPerMin: number
    /** `undefined` = no workspace-wide ceiling (what single-tenant installs want). */
    perTenantPerMin: number | undefined
  }
  cooldown: { enabled: boolean; secs: number }
}

export interface TriggerPolicyDraft {
  rules: TriggerRuleDraft
  blockers: TriggerBlockerDraft
  storeUnmatchedInDraftMode: boolean
  /**
   * Rules the per-kind slots cannot represent exactly — today only the second
   * `caseInsensitive` variant of a `keyword` rule. Preserved verbatim so
   * editing anything else never destroys them.
   */
  residualRules: TriggerRule[]
}

/** The values a slot carries while its toggle is off, so turning it on has a shape. */
export function emptyTriggerPolicyDraft(): TriggerPolicyDraft {
  return {
    rules: {
      privateDefault: false,
      selfMention: false,
      replyToBot: false,
      slashCommand: { enabled: false, prefixes: [] },
      keyword: { enabled: false, words: [], caseInsensitive: true },
      userAllowlist: { enabled: false, userIds: [] },
      channelAllowlist: { enabled: false, channelIds: [] },
    },
    blockers: {
      userBlocklist: { enabled: false, userIds: [] },
      channelBlocklist: { enabled: false, channelIds: [] },
      keywordBlocklist: { enabled: false, words: [] },
      rateLimit: {
        enabled: false,
        perUserPerMin: 5,
        perChannelPerMin: 20,
        perTenantPerMin: undefined,
      },
      cooldown: { enabled: false, secs: 3 },
    },
    storeUnmatchedInDraftMode: false,
    residualRules: [],
  }
}

function union(base: string[], extra: string[]): string[] {
  const seen = new Set(base)
  const out = [...base]
  for (const value of extra) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function toTriggerPolicyDraft(policy: TriggerPolicy | undefined): TriggerPolicyDraft {
  const draft = emptyTriggerPolicyDraft()
  draft.storeUnmatchedInDraftMode = policy?.storeUnmatchedInDraftMode ?? false

  for (const rule of policy?.rules ?? []) {
    switch (rule.kind) {
      case "private-default":
        draft.rules.privateDefault = true
        break
      case "self-mention":
        draft.rules.selfMention = true
        break
      case "reply-to-bot":
        draft.rules.replyToBot = true
        break
      case "slash-command":
        draft.rules.slashCommand = {
          enabled: true,
          prefixes: union(
            draft.rules.slashCommand.enabled ? draft.rules.slashCommand.prefixes : [],
            rule.prefixes
          ),
        }
        break
      case "keyword":
        // Same case mode merges; a disagreeing one has no single-rule
        // equivalent and is kept aside rather than widened or narrowed.
        if (!draft.rules.keyword.enabled) {
          draft.rules.keyword = {
            enabled: true,
            words: [...rule.words],
            caseInsensitive: rule.caseInsensitive,
          }
        } else if (draft.rules.keyword.caseInsensitive === rule.caseInsensitive) {
          draft.rules.keyword.words = union(draft.rules.keyword.words, rule.words)
        } else {
          draft.residualRules.push(rule)
        }
        break
      case "user-allowlist":
        draft.rules.userAllowlist = {
          enabled: true,
          userIds: union(
            draft.rules.userAllowlist.enabled ? draft.rules.userAllowlist.userIds : [],
            rule.userIds
          ),
        }
        break
      case "channel-allowlist":
        draft.rules.channelAllowlist = {
          enabled: true,
          channelIds: union(
            draft.rules.channelAllowlist.enabled ? draft.rules.channelAllowlist.channelIds : [],
            rule.channelIds
          ),
        }
        break
    }
  }

  for (const blocker of policy?.blockers ?? []) {
    switch (blocker.kind) {
      case "user-blocklist":
        draft.blockers.userBlocklist = {
          enabled: true,
          userIds: union(
            draft.blockers.userBlocklist.enabled ? draft.blockers.userBlocklist.userIds : [],
            blocker.userIds
          ),
        }
        break
      case "channel-blocklist":
        draft.blockers.channelBlocklist = {
          enabled: true,
          channelIds: union(
            draft.blockers.channelBlocklist.enabled
              ? draft.blockers.channelBlocklist.channelIds
              : [],
            blocker.channelIds
          ),
        }
        break
      case "keyword-blocklist":
        draft.blockers.keywordBlocklist = {
          enabled: true,
          words: union(
            draft.blockers.keywordBlocklist.enabled ? draft.blockers.keywordBlocklist.words : [],
            blocker.words
          ),
        }
        break
      case "rate-limit": {
        const current = draft.blockers.rateLimit
        draft.blockers.rateLimit = {
          enabled: true,
          perUserPerMin: current.enabled
            ? Math.min(current.perUserPerMin, blocker.perUserPerMin)
            : blocker.perUserPerMin,
          perChannelPerMin: current.enabled
            ? Math.min(current.perChannelPerMin, blocker.perChannelPerMin)
            : blocker.perChannelPerMin,
          // An absent ceiling is "unbounded", so it never wins a minimum.
          perTenantPerMin:
            current.enabled && current.perTenantPerMin !== undefined
              ? blocker.perTenantPerMin !== undefined
                ? Math.min(current.perTenantPerMin, blocker.perTenantPerMin)
                : current.perTenantPerMin
              : blocker.perTenantPerMin,
        }
        break
      }
      case "cooldown-after-bot-reply":
        draft.blockers.cooldown = {
          enabled: true,
          secs: draft.blockers.cooldown.enabled
            ? Math.max(draft.blockers.cooldown.secs, blocker.secs)
            : blocker.secs,
        }
        break
    }
  }

  return draft
}

export function fromTriggerPolicyDraft(draft: TriggerPolicyDraft): TriggerPolicy {
  const rules: TriggerRule[] = []
  if (draft.rules.privateDefault) rules.push({ kind: "private-default" })
  if (draft.rules.selfMention) rules.push({ kind: "self-mention" })
  if (draft.rules.replyToBot) rules.push({ kind: "reply-to-bot" })
  if (draft.rules.slashCommand.enabled) {
    rules.push({ kind: "slash-command", prefixes: [...draft.rules.slashCommand.prefixes] })
  }
  if (draft.rules.keyword.enabled) {
    rules.push({
      kind: "keyword",
      words: [...draft.rules.keyword.words],
      caseInsensitive: draft.rules.keyword.caseInsensitive,
    })
  }
  if (draft.rules.userAllowlist.enabled) {
    rules.push({ kind: "user-allowlist", userIds: [...draft.rules.userAllowlist.userIds] })
  }
  if (draft.rules.channelAllowlist.enabled) {
    rules.push({
      kind: "channel-allowlist",
      channelIds: [...draft.rules.channelAllowlist.channelIds],
    })
  }
  rules.push(...draft.residualRules)

  const blockers: TriggerBlocker[] = []
  if (draft.blockers.userBlocklist.enabled) {
    blockers.push({ kind: "user-blocklist", userIds: [...draft.blockers.userBlocklist.userIds] })
  }
  if (draft.blockers.channelBlocklist.enabled) {
    blockers.push({
      kind: "channel-blocklist",
      channelIds: [...draft.blockers.channelBlocklist.channelIds],
    })
  }
  if (draft.blockers.keywordBlocklist.enabled) {
    blockers.push({
      kind: "keyword-blocklist",
      words: [...draft.blockers.keywordBlocklist.words],
    })
  }
  if (draft.blockers.rateLimit.enabled) {
    blockers.push({
      kind: "rate-limit",
      perUserPerMin: draft.blockers.rateLimit.perUserPerMin,
      perChannelPerMin: draft.blockers.rateLimit.perChannelPerMin,
      // Spread so an unset ceiling stays ABSENT rather than becoming an
      // explicit `undefined`, which `toEqual` and a Dexie round trip both
      // treat as a different policy from the one the operator saved.
      ...(draft.blockers.rateLimit.perTenantPerMin !== undefined
        ? { perTenantPerMin: draft.blockers.rateLimit.perTenantPerMin }
        : {}),
    })
  }
  if (draft.blockers.cooldown.enabled) {
    blockers.push({ kind: "cooldown-after-bot-reply", secs: draft.blockers.cooldown.secs })
  }

  return { rules, blockers, storeUnmatchedInDraftMode: draft.storeUnmatchedInDraftMode }
}

/**
 * Ways a policy fails to answer a message an operator would expect it to.
 *
 * - `no-rules` — nothing matches, so the bot never runs a turn at all. It
 *   subsumes the other two, and is reported alone.
 * - `plain-private` — a direct message that does not address the bot matches
 *   nothing. Only `private-default` covers that case: a keyword rule covers its
 *   words and an allowlist covers its listed ids, neither of which is "any
 *   private message".
 * - `group-mention` — an @-mention in a group matches nothing. Only
 *   `self-mention` covers it; `reply-to-bot` needs a prior bot message and
 *   `private-default` does not apply outside private chats.
 *
 * Reported, never enforced: a bot deliberately kept narrow (see
 * `addressedOnlyChatPolicy`) has `plain-private` on purpose, and a platform
 * without a group scope has `group-mention` harmlessly.
 */
export type TriggerCoverageGap = "no-rules" | "plain-private" | "group-mention"

export function triggerCoverageGaps(policy: TriggerPolicy | undefined): TriggerCoverageGap[] {
  const rules = policy?.rules ?? []
  if (rules.length === 0) return ["no-rules"]
  const gaps: TriggerCoverageGap[] = []
  if (!rules.some((r) => r.kind === "private-default")) gaps.push("plain-private")
  if (!rules.some((r) => r.kind === "self-mention")) gaps.push("group-mention")
  return gaps
}

/**
 * Slots that are switched on but carry nothing to match against, so they are
 * inert. Returned rather than auto-disabled: the toggle is the operator's, and
 * an empty list mid-edit is a normal state, not a correction to make for them.
 */
export type TriggerDraftWarning =
  | "slash-command-empty"
  | "keyword-empty"
  | "user-allowlist-empty"
  | "channel-allowlist-empty"
  | "user-blocklist-empty"
  | "channel-blocklist-empty"
  | "keyword-blocklist-empty"
  | "rate-limit-blocks-everything"

export function triggerDraftWarnings(draft: TriggerPolicyDraft): TriggerDraftWarning[] {
  const warnings: TriggerDraftWarning[] = []
  const { rules, blockers } = draft
  if (rules.slashCommand.enabled && rules.slashCommand.prefixes.length === 0) {
    warnings.push("slash-command-empty")
  }
  if (rules.keyword.enabled && rules.keyword.words.length === 0) warnings.push("keyword-empty")
  if (rules.userAllowlist.enabled && rules.userAllowlist.userIds.length === 0) {
    warnings.push("user-allowlist-empty")
  }
  if (rules.channelAllowlist.enabled && rules.channelAllowlist.channelIds.length === 0) {
    warnings.push("channel-allowlist-empty")
  }
  if (blockers.userBlocklist.enabled && blockers.userBlocklist.userIds.length === 0) {
    warnings.push("user-blocklist-empty")
  }
  if (blockers.channelBlocklist.enabled && blockers.channelBlocklist.channelIds.length === 0) {
    warnings.push("channel-blocklist-empty")
  }
  if (blockers.keywordBlocklist.enabled && blockers.keywordBlocklist.words.length === 0) {
    warnings.push("keyword-blocklist-empty")
  }
  // The evaluator blocks at `recent.length >= limit`, so a limit of 0 blocks
  // the first message of every minute — the bot goes completely silent.
  if (
    blockers.rateLimit.enabled &&
    (blockers.rateLimit.perUserPerMin < 1 ||
      blockers.rateLimit.perChannelPerMin < 1 ||
      (blockers.rateLimit.perTenantPerMin !== undefined && blockers.rateLimit.perTenantPerMin < 1))
  ) {
    warnings.push("rate-limit-blocks-everything")
  }
  return warnings
}
