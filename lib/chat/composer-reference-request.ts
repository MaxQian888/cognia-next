/**
 * Ask the active conversation's composer to STAGE a reference, from a surface
 * that is nowhere near it.
 *
 * Same shape and same reasoning as `lib/chat/composer-mention-request.ts` and
 * `lib/shell/command-palette-request.ts`: one DOM event on `window`, no store,
 * no import cycle. The requester here is ⌘K, which is mounted by the shell
 * beside the chat pane rather than inside it — and which must not learn how
 * staging works, because the answer differs per entity kind and already lives
 * in the mention registry.
 *
 * Distinct from `requestComposerMention`, which inserts the TEXT `@name` into
 * the textarea. This one carries an `EntityMentionCandidate` — a record the
 * user pointed at — and the composer resolves it through the same
 * `useEntityMentionStaging` path a pick from the `@` panel takes. So a
 * reference made from ⌘K and one made from the composer produce byte-identical
 * chips, prompts and citations; there is one staging path, not two.
 */

import type { EntityMentionCandidate } from "@/lib/chat/mentions/entity-sources"

export const COMPOSER_REFERENCE_REQUEST_EVENT = "cognia:composer:reference"

export interface ComposerReferenceRequestDetail {
  candidate: EntityMentionCandidate
}

export function requestComposerReference(candidate: EntityMentionCandidate): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<ComposerReferenceRequestDetail>(COMPOSER_REFERENCE_REQUEST_EVENT, {
      detail: { candidate },
    })
  )
}

/** Subscribe a shell's composer; returns the unsubscribe. */
export function onComposerReferenceRequest(
  handler: (candidate: EntityMentionCandidate) => void
): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ComposerReferenceRequestDetail>).detail
    const candidate = detail?.candidate
    // Guarded like the mention seam: a malformed event must stage nothing
    // rather than a chip with no identity, which the user could not remove
    // by recognising it.
    if (
      candidate &&
      typeof candidate.entityKind === "string" &&
      typeof candidate.id === "string" &&
      candidate.id.length > 0
    ) {
      handler(candidate)
    }
  }
  window.addEventListener(COMPOSER_REFERENCE_REQUEST_EVENT, listener)
  return () => window.removeEventListener(COMPOSER_REFERENCE_REQUEST_EVENT, listener)
}
