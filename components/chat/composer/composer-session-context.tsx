"use client"

/**
 * Which conversation the surrounding composer belongs to.
 *
 * The composer's draft state — @-mentions, staged context, permission mode,
 * per-send toggles — is written through actions that default to "the focused
 * conversation". That default is right for the single-pane case and wrong in
 * split view: the unfocused pane has a full composer of its own, and every one
 * of its controls was writing into the pane beside it. Pressing Shift+Tab in
 * the right-hand pane changed the LEFT pane's permission mode, and the mode is
 * read back by `resolveSendOptions` — so the mistake reached the model, not
 * just the chrome.
 *
 * The controls are scattered across the composer's children (attach menu,
 * reference chips, web-search toggle, skill picker, workflow ref chips), most
 * of which have no reason to take a session prop. A context is the honest shape
 * for "which conversation am I inside", and it degrades correctly: outside a
 * provider the value is `undefined`, the actions fall back to the focused
 * conversation, and behaviour is exactly what it was.
 */

import { createContext, useContext } from "react"

const ComposerSessionContext = createContext<string | null | undefined>(undefined)

export const ComposerSessionProvider = ComposerSessionContext.Provider

/**
 * The conversation this composer control writes to.
 *
 * `undefined` means "no provider above me" — the store's actions read that as
 * "the focused conversation", which is the pre-split behaviour.
 */
export function useComposerSessionId(): string | null | undefined {
  return useContext(ComposerSessionContext)
}
