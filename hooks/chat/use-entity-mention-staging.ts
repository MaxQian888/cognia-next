"use client"

/**
 * Turn a picked record (`@memory:` / `@issue:` / `@plan:` / `@chat:` /
 * `@artifact:`) into a staged context-selection chip.
 *
 * The counterpart of `use-remote-doc-staging.ts`, and it makes the same choice
 * for the same reason: it does NOT invent a delivery path. Once the body is
 * text it becomes an ordinary `ContextSelectionRef`, rejoining the pipeline the
 * dock's "reference in chat", the browser's page selections and the desktop
 * selection capture all already use — one chip bar, one `Referenced context:`
 * block in `formatContextSelectionsForLLM`, one clear-on-send.
 *
 * Why a context chip and not an attachment (which is what a remote document
 * gets): an attachment is a FILE, and a memory is not a file. Staging a
 * three-line memory as `memory.md` would make the model reason about a document
 * that does not exist, and the user's own chip would name a filename they never
 * chose. The chip says what the thing is.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"

import {
  entitySelectionFrom,
  getEntityMentionSource,
  type EntityMentionCandidate,
} from "@/lib/chat/mentions/entity-sources"
import { useChatStore } from "@/stores/chat"
import type { EntitySelectionRef } from "@/types/artifact/artifact"

export interface UseEntityMentionStagingOptions {
  /** Conversation the chip belongs to; `null` uses the focused projection. */
  sessionId: string | null
}

export function useEntityMentionStaging({ sessionId }: UseEntityMentionStagingOptions) {
  const t = useTranslations("chat.composer.popover")

  return useCallback(
    async (candidate: EntityMentionCandidate): Promise<EntitySelectionRef | null> => {
      const source = getEntityMentionSource(candidate.entityKind)
      if (!source) {
        // Only reachable if a dynamically registered source was removed between
        // the search and the pick. Silent would leave the user staring at a
        // composer that swallowed their pick.
        toast.error(t("entityUnavailable", { title: candidate.title }))
        return null
      }
      try {
        const body = await source.snapshot(candidate)
        // `null` means the record is gone (deleted in another window between
        // the pick and the read), and an empty body means there is nothing to
        // hand the model. Both must SAY so: an empty chip claiming to carry an
        // issue is worse than no chip, because the user would then believe the
        // model had read it.
        if (!body || !body.trim()) {
          toast.error(t("entityEmpty", { title: candidate.title }))
          return null
        }
        // The fingerprint is read in the same breath as the body, so the two
        // describe the same instant. A failure here must not lose the pick: an
        // unfingerprinted chip is un-checkable, which the UI says, and that is
        // strictly better than no chip at all.
        const fingerprint = source.fingerprint
          ? await source.fingerprint(candidate).catch(() => undefined)
          : undefined
        const selection = entitySelectionFrom(candidate, body, { fingerprint })
        useChatStore.getState().addContextSelection(selection, sessionId)
        toast.success(t("entityStaged", { title: candidate.title }))
        return selection
      } catch (err) {
        loggers.chat.warn("entity mention staging failed", {
          entityKind: candidate.entityKind,
          err: err instanceof Error ? err.message : String(err),
        })
        toast.error(
          t("entityFailed", {
            title: candidate.title,
            reason: err instanceof Error ? err.message : String(err),
          })
        )
        return null
      }
    },
    [sessionId, t]
  )
}
