/**
 * Ask the active conversation's composer to insert an `@mention`, from a
 * surface that is nowhere near it.
 *
 * The composer exposes `insertMention(name)` on an imperative handle, and the
 * two shells hold that ref — so anything rendered *inside* their tree can
 * mention a teammate by being handed a callback. The team-members panel is not
 * inside their tree: it lives in the Context Workbench, whose panel renderers
 * are assembled in `components/artifacts/chat-dock-panels.tsx` and know
 * nothing about the chat pane. Threading a ref through the dock kernel to
 * reach one panel would couple the workbench to the composer for good.
 *
 * Same shape and same reasoning as `lib/shell/command-palette-request.ts`: one
 * DOM event on `window`, no store, no import cycle between the panel and the
 * composer. The shells subscribe next to the ref they already hold.
 */

export const COMPOSER_MENTION_REQUEST_EVENT = "cognia:composer:mention"

export interface ComposerMentionRequestDetail {
  /** Character name, exactly as it should read after the `@`. */
  name: string
}

export function requestComposerMention(name: string): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<ComposerMentionRequestDetail>(COMPOSER_MENTION_REQUEST_EVENT, {
      detail: { name },
    })
  )
}

/** Subscribe a shell's composer; returns the unsubscribe. */
export function onComposerMentionRequest(handler: (name: string) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ComposerMentionRequestDetail>).detail
    // A name is the whole payload; a malformed event must not insert "@undefined".
    if (detail && typeof detail.name === "string" && detail.name.length > 0) {
      handler(detail.name)
    }
  }
  window.addEventListener(COMPOSER_MENTION_REQUEST_EVENT, listener)
  return () => window.removeEventListener(COMPOSER_MENTION_REQUEST_EVENT, listener)
}
