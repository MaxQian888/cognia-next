"use client"

/**
 * An editable summary draft of a conversation, for the surfaces that seed
 * something new from one: the branch dialog's summary branch and the shared
 * panel's "share from now on" background (ADR-0241).
 *
 * Runs the canonical summarizer (`summarizeMaterial`, PII-gated) through the
 * utility model, then a headless turn. When no model summary is possible the
 * draft falls back to the deterministic head/tail digest and says why, so a
 * digest is never passed off as a summary. The text stays editable: nothing
 * is used until the caller's own confirm step.
 */

import { useRef, useState } from "react"
import { useLocale } from "next-intl"
import type { UIMessage } from "ai"
import { useChatStore, selectVisibleMessages } from "@/stores/chat/chat-store"
import { useSettingsStore } from "@/stores/settings"
import { getSession } from "@/lib/db/sessions"
import { buildAgentBackedLlmClient } from "@/lib/ai/generation/agent-backed-client"
import { renderConversationSegments, structuralSummary } from "@/lib/ai/generation/summarizer"
import { summarizeMaterial, type SummaryOutcome } from "@/lib/ai/generation/summarize-material"

/** Why the draft holds a digest rather than a model summary. */
export type SummaryFallbackReason = Extract<SummaryOutcome, { kind: "unavailable" }>["reason"]

/**
 * A session's OWN visible thread, keyed off its id rather than the store's
 * top-level `messages`, which mirror the active session only. The slice is
 * materialised lazily, so the active session falls back to the top level.
 */
export function readVisibleSessionMessages(sessionId: string): UIMessage[] {
  const state = useChatStore.getState()
  const slice = state.sessions[sessionId]
  if (slice) return selectVisibleMessages(slice.messages, slice.activeBranchByGroup)
  if (sessionId === state.activeSessionId) {
    return selectVisibleMessages(state.messages, state.activeBranchByGroup)
  }
  return []
}

export interface ConversationSummaryDraftOptions {
  sessionId: string
  /** Broker lease label for the headless fallback: what the runs console shows. */
  turnLabel: string
  onError?: (error: unknown) => void
}

export function useConversationSummaryDraft({
  sessionId,
  turnLabel,
  onError,
}: ConversationSummaryDraftOptions) {
  const locale = useLocale()
  // One draft per session. A host that keeps this hook mounted across
  // sessions (the mobile shell's panel) must never show, submit or overwrite
  // one session's draft as another's: a summary that returns after the user
  // moved on lands in its own session's slot, never in the current one.
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; fallback: SummaryFallbackReason | null }>
  >({})
  const [pending, setPending] = useState<Record<string, true>>({})
  // Bumped per session by every generate and reset: an older request's result is dropped.
  const generations = useRef(new Map<string, number>())
  const own = drafts[sessionId]
  const text = own?.text ?? ""
  const fallback = own?.fallback ?? null
  const generating = pending[sessionId] === true

  const write = (
    forSession: string,
    draft: { text: string; fallback: SummaryFallbackReason | null }
  ) => setDrafts((previous) => ({ ...previous, [forSession]: draft }))
  const settle = (forSession: string) =>
    setPending((previous) => {
      const { [forSession]: _done, ...rest } = previous
      return rest
    })

  const setText = (next: string) =>
    write(sessionId, { text: next, fallback: own?.fallback ?? null })

  const generate = async (messages: UIMessage[]) => {
    const forSession = sessionId
    const request = (generations.current.get(forSession) ?? 0) + 1
    generations.current.set(forSession, request)
    const current = () => generations.current.get(forSession) === request
    setPending((previous) => ({ ...previous, [forSession]: true }))
    try {
      const session = await getSession(forSession)
      const appSettings = useSettingsStore.getState().settings
      // The utility model, then a headless turn. The utility client alone is
      // null on a subscription account (no renderer key), which made every
      // summary there a silent head/tail digest.
      const client = await buildAgentBackedLlmClient({
        session,
        appSettings,
        featureId: "conversation-summary",
        label: turnLabel,
      })
      const outcome = await summarizeMaterial({
        segments: renderConversationSegments(messages),
        purpose: "branch-seed",
        client,
        locale,
      })
      if (!current()) return
      if (outcome.kind === "summary") {
        write(forSession, { text: outcome.text, fallback: null })
      } else {
        // Still a usable draft, but it now SAYS it is not a summary, and why.
        write(forSession, {
          text: outcome.reason === "empty" ? "" : structuralSummary(messages),
          fallback: outcome.reason,
        })
      }
    } catch (error) {
      if (current()) onError?.(error)
    } finally {
      if (current()) settle(forSession)
    }
  }

  const reset = () => {
    generations.current.set(sessionId, (generations.current.get(sessionId) ?? 0) + 1)
    setDrafts((previous) => {
      const { [sessionId]: _dropped, ...rest } = previous
      return rest
    })
    settle(sessionId)
  }

  return { text, setText, generating, fallback, generate, reset }
}
