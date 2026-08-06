/**
 * Surface-agnostic "generate and persist a short title" orchestration.
 *
 * Direct chat, Agent Team chat, workflow runs, and agent-team runs all want
 * the same fire-and-forget pipeline: build the renderer utility-model client,
 * ask the cheap model for a short title, *smooth* the result (don't overwrite
 * with an effectively-identical string), re-check the row is still
 * machine-managed right before writing, then persist. This module owns that
 * orchestration so each surface only supplies its text inputs + a `persist`
 * callback — no surface re-implements `runUtilityModelTasks`.
 *
 * Pure-ish + injectable: `buildUtilityLlmClient` is the only side-effecting
 * dependency, so tests mock it and drive the whole flow with a fake client.
 */

import type { AppSettings, ChatSession, UtilityModelConfig } from "@cognia/agent-config-types"
import { buildAgentRoleLlmClient } from "@/lib/ai/generation/agent-role-client"
import { generateConversationTitle } from "@/lib/ai/generation/title"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

/**
 * Placeholder titles a brand-new session/run carries before it gets a real one.
 * Includes common i18n defaults so `isPlaceholderTitle` works regardless of
 * the user's locale. Adding to this set requires no Dexie schema change.
 */
const PLACEHOLDER_TITLES = new Set([
  "New chat",
  "New conversation",
  // zh-CN / zh-TW common defaults
  "新对话",
  "新聊天",
  "新建会话",
  "新建聊天",
  // ja
  "新しい会話",
  // fr
  "Nouvelle conversation",
  // de
  "Neue Unterhaltung",
  // es
  "Nueva conversación",
])

/**
 * True when `title` is empty or one of the known machine placeholders — i.e.
 * the instant first-message preview is allowed to claim it. A user rename
 * replaces the placeholder, so this also doubles as the "not yet renamed"
 * gate for the instant-preview write in the chat hooks.
 */
export function isPlaceholderTitle(title: string | undefined | null): boolean {
  return !title || PLACEHOLDER_TITLES.has(title)
}

/**
 * True when `title` looks like the instant first-message truncation of
 * `firstMessageText` — i.e. it is a prefix of the user's message, optionally
 * with a trailing ellipsis (`…`). Used by the retry system to decide whether
 * the title still needs upgrading to an LLM-generated one.
 */
export function isInstantPreviewTitle(title: string, firstMessageText: string): boolean {
  if (!title || !firstMessageText) return false
  // Normalize: trim, collapse whitespace, lowercase.
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()
  let normalizedTitle = norm(title)
  const normalizedMessage = norm(firstMessageText)
  // Strip trailing ellipsis (U+2026) or triple dots.
  normalizedTitle = normalizedTitle.replace(/[…]$/, "").replace(/\.{3}$/, "")
  if (!normalizedTitle) return false
  // The title is an instant preview if the message starts with it and the
  // title is short (≤ 45 chars, slightly above the 40-char preview limit).
  return normalizedTitle.length <= 45 && normalizedMessage.startsWith(normalizedTitle)
}

/**
 * Decide whether the turn-complete path should generate an LLM title: the
 * feature is on, this is the first assistant turn, and the title hasn't been
 * manually set (`titleAuto !== false`). Shared by the chat + team hooks.
 */
export function shouldGenerateTitle(opts: {
  titleEnabled: boolean | undefined
  assistantCount: number
  titleAuto: boolean | undefined
}): boolean {
  return opts.titleEnabled !== false && opts.assistantCount === 1 && opts.titleAuto !== false
}

/**
 * Whether two titles are "the same" for smoothing purposes — case-folded with
 * collapsed whitespace. When the LLM title matches the instant preview we skip
 * the write entirely, so the visible title never jumps to an identical value.
 */
export function titlesEquivalent(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase()
  return norm(a) === norm(b)
}

// ── In-flight deduplication ──────────────────────────────────────────────────

/** Sessions with a title generation currently in progress. */
const inFlight = new Set<string>()

/** Whether a title generation is already running for the given dedup key. */
export function isTitleInFlight(key: string): boolean {
  return inFlight.has(key)
}

export interface RunTitleTaskArgs {
  /** Session used for provider/model resolution (null for non-chat runs). */
  session: ChatSession | null | undefined
  appSettings: AppSettings | null | undefined
  /** Per-feature utility-model override (e.g. `settings.conversationTitle`). */
  override?: UtilityModelConfig
  /** Telemetry-only feature id forwarded to the client resolver. */
  featureId: string
  /** Primary text to title (first user message / task description). */
  sourceText: string
  /** Optional secondary text (first assistant reply / run result). */
  resultText?: string
  /** UI locale so the title language matches the user. */
  locale?: string
  /** Framing of the title; defaults to "chat". See `GenerateTitleArgs.kind`. */
  kind?: "chat" | "work"
  /** Title currently shown; an equivalent generated title is dropped (smoothing). */
  currentTitle?: string
  /** Re-checked just before persisting; return false to abort (e.g. user renamed). */
  isStillAuto?: () => boolean | Promise<boolean>
  /** Persist the accepted title. */
  persist: (title: string) => void | Promise<void>
  /**
   * Optional deduplication key (typically the session id). When set, a second
   * concurrent call with the same key returns `null` immediately — prevents
   * redundant LLM calls during rapid session activity.
   */
  dedupKey?: string
}

/**
 * Run the full generate-smooth-persist pipeline. Returns the persisted title,
 * or `null` when nothing was written (disabled, no client, empty/equivalent
 * result, no-longer-auto, dedup collision, or any error). Never throws —
 * fire-and-forget.
 */
export async function runTitleTask(args: RunTitleTaskArgs): Promise<string | null> {
  const {
    session,
    appSettings,
    override,
    featureId,
    sourceText,
    resultText,
    locale,
    kind,
    currentTitle,
    isStillAuto,
    persist,
    dedupKey,
  } = args

  // Dedup guard: bail if another call for the same key is already in flight.
  if (dedupKey && inFlight.has(dedupKey)) return null
  if (dedupKey) inFlight.add(dedupKey)

  try {
    if (override?.enabled === false) return null
    if (!sourceText.trim()) return null
    if (!hasNoLeakingPiiDeep({ sourceText, resultText, locale, kind })) return null

    const client = await buildAgentRoleLlmClient({
      role: "utility",
      session,
      appSettings,
      override,
      featureId,
    })
    if (!client) return null

    const title = await generateConversationTitle(client, {
      firstUserText: sourceText,
      firstAssistantText: resultText,
      locale,
      kind,
    })
    if (!title) return null

    // Smoothing — skip a write that wouldn't visibly change the title.
    if (currentTitle && titlesEquivalent(title, currentTitle)) return null

    // Re-check freshness: the user may have renamed while the model ran.
    if (isStillAuto) {
      const stillAuto = await isStillAuto()
      if (!stillAuto) return null
    }

    await persist(title)
    return title
  } catch {
    return null
  } finally {
    if (dedupKey) inFlight.delete(dedupKey)
  }
}

/**
 * FUTURE: Topic-drift title refresh.
 *
 * Hook point: after `shouldGenerateTitle` returns false (because
 * `assistantCount > 1`), a drift detector could compare the latest user
 * message's embedding against the existing title's embedding. If cosine
 * distance exceeds a threshold, re-run title generation with the latest
 * turn context.
 *
 * Gating:
 * - Feature flag: `settings.conversationTitle.refreshOnDrift?: boolean`
 * - Only when `titleAuto !== false`
 * - Cooldown: at most once every 5 turns
 * - Use the same cheap utility model
 *
 * Not implemented — opt-in future feature. The dedup and retry
 * infrastructure built here supports it without changes.
 */
