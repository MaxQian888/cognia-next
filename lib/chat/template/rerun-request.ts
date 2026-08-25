/**
 * Ask a session's composer to load a past turn back for editing.
 *
 * A window event rather than a prop, for the same reason `command-palette-request`
 * is: the message renderer sits three layers down inside the virtualised list,
 * and the composer is a sibling of the list, not a descendant. Threading a
 * callback down to reach a sibling is how a chain of `onX` props that mean
 * nothing to the components in the middle gets built.
 *
 * The session id is not decoration. Several composers are mounted at once in a
 * split pane group, and an unaddressed event would fill in every one of them
 * with a message from a conversation the user is not looking at.
 */

import type { ChatTemplateRun } from "./run"

export const TEMPLATE_RERUN_REQUEST_EVENT = "cognia:chat-template:rerun"

export interface TemplateRerunRequestDetail {
  /** The composer bound to this session, and only that one, should answer. */
  sessionId: string
  run: ChatTemplateRun
}

export function requestTemplateRerun(detail: TemplateRerunRequestDetail): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(TEMPLATE_RERUN_REQUEST_EVENT, { detail }))
}

/** Subscribe one composer; returns the unsubscribe. */
export function onTemplateRerunRequest(
  handler: (detail: TemplateRerunRequestDetail) => void
): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<TemplateRerunRequestDetail>).detail
    if (!detail || typeof detail !== "object") return
    if (typeof detail.sessionId !== "string" || !detail.run) return
    handler(detail)
  }
  window.addEventListener(TEMPLATE_RERUN_REQUEST_EVENT, listener)
  return () => window.removeEventListener(TEMPLATE_RERUN_REQUEST_EVENT, listener)
}
