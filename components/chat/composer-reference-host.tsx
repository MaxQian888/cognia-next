"use client"

/**
 * Turns a "reference this" request from anywhere in the app into a staged
 * context chip on the focused composer.
 *
 * Mounted once at the root, next to `ReportProblemHost` and `GateModalsHost`,
 * for the reason those are: the requester (⌘K) is not inside any composer's
 * tree, several composers can be mounted at once (the chat pane plus every
 * aside), and exactly ONE of them should receive the chip.
 *
 * `sessionId: null` is what makes that true — `useEntityMentionStaging` then
 * writes to the FOCUSED composer projection, which is the one the user is
 * looking at. A per-composer subscription would stage the same reference into
 * every open pane.
 *
 * Renders nothing.
 */

import { useEffect } from "react"

import { useEntityMentionStaging } from "@/hooks/chat/use-entity-mention-staging"
import { onComposerReferenceRequest } from "@/lib/chat/composer-reference-request"

export function ComposerReferenceHost() {
  // The focused composer, not a named one — see the docblock.
  const stage = useEntityMentionStaging({ sessionId: null })

  useEffect(
    () =>
      onComposerReferenceRequest((candidate) => {
        // `stageEntity` already reports its own failures (record deleted
        // between the search and the pick, an unreadable body) as toasts, and
        // resolves to null rather than throwing.
        void stage(candidate)
      }),
    [stage]
  )

  return null
}
