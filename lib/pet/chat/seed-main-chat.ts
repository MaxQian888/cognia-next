// "Open full chat" escape hatch from the pet chat panel: create a fresh main
// chat session, seed its composer draft with the user's text, and make it
// active. The caller then routes to `/` (the composer reads the draft back on
// mount — see `components/chat/composer.tsx`). Mirrors the goal quick-create
// dialog's create → seed → activate flow.
//
// Collaborators are injectable so this is unit-tested without the store/Dexie.

import { useSessionStore } from "@/stores/chat/session-store"
import { setDraft } from "@/lib/db/chat-drafts"

export interface SeedMainChatDeps {
  createSession?: () => { id: string }
  setActiveSession?: (id: string) => void
  setDraft?: (sessionId: string, text: string) => Promise<void>
}

/**
 * Create a new chat session seeded with `seedText` and activate it. Returns the
 * new session id. The draft write is best-effort — a failed persist must not
 * block navigation, so the session is still activated.
 */
export async function seedMainChat(seedText: string, deps: SeedMainChatDeps = {}): Promise<string> {
  const store = useSessionStore.getState()
  const createSession = deps.createSession ?? (() => store.createSession())
  const setActiveSession = deps.setActiveSession ?? ((id: string) => store.setActiveSession(id))
  const setDraftFn = deps.setDraft ?? setDraft

  const session = createSession()
  const text = seedText.trim()
  if (text) await setDraftFn(session.id, text).catch(() => {})
  setActiveSession(session.id)
  return session.id
}
