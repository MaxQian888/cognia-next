/**
 * Deep links that point at one message in one conversation.
 *
 * This is NOT the public share link (`lib/share/`, ADR-0037). A share link
 * publishes a copy of a conversation to a URL anyone can open; a permalink is
 * private navigation — it only resolves inside this app, for this user, against
 * their local database. The two must stay verbally distinct in the UI as well
 * ("Copy link to message" vs "Share"), because handing someone the wrong one is
 * either a privacy accident or a dead link.
 *
 * Shape follows the app's static-export deep-link idiom (`/memory?id=…`):
 * query params on an existing route, read with `useSearchParams` inside a
 * `<Suspense>` boundary. A dynamic `[id]` route cannot exist under
 * `output: "export"`.
 */

export const PERMALINK_SESSION_PARAM = "session"
export const PERMALINK_MESSAGE_PARAM = "message"

export interface MessagePermalinkTarget {
  sessionId: string
  messageId: string
}

/** Minimal read surface shared by `URLSearchParams` and Next's `ReadonlyURLSearchParams`. */
export interface ReadableParams {
  get(name: string): string | null
}

/**
 * The query string for a permalink, e.g. `?session=s1&message=m2`.
 *
 * Split from {@link buildMessagePermalink} because the in-app navigation path
 * needs exactly this — it pushes a route, not an absolute URL.
 */
export function messagePermalinkQuery(target: MessagePermalinkTarget): string {
  const params = new URLSearchParams()
  params.set(PERMALINK_SESSION_PARAM, target.sessionId)
  params.set(PERMALINK_MESSAGE_PARAM, target.messageId)
  return `?${params.toString()}`
}

/**
 * A permalink to copy. Absolute when an origin is available so the link
 * survives being pasted into notes or another window; relative otherwise
 * (SSR/prerender, where `window` does not exist).
 */
export function buildMessagePermalink(
  target: MessagePermalinkTarget,
  opts?: { origin?: string | null }
): string {
  const query = messagePermalinkQuery(target)
  const origin =
    opts?.origin !== undefined
      ? opts.origin
      : typeof window !== "undefined"
        ? window.location.origin
        : null
  if (!origin) return `/${query}`
  // The chat lives at the root route; keep the trailing slash off so the link
  // reads as a path, not a directory.
  return `${origin.replace(/\/+$/, "")}/${query}`
}

/**
 * An in-app link to a conversation, landing on one turn when we know which.
 *
 * The half-known case is real and was being hand-written: a memory records
 * `sourceSessionId` always and `sourceMessageId` only since v122, so its "jump
 * to source" has to degrade to the conversation rather than lose the link.
 * Both `/memory` link sites built `/?session=…` by hand and therefore never
 * used the message id even when it was there — the route format lives here, so
 * the choice between the two should too.
 *
 * NOT a {@link MessagePermalinkTarget}: that type stays strict because
 * {@link parseMessagePermalink} requires both halves, and a session-only query
 * is not a permalink — it is "open this conversation", which the session store
 * already handles.
 */
export function buildSessionHref(sessionId: string, messageId?: string | null): string {
  if (messageId) return messagePermalinkQuery({ sessionId, messageId })
  const params = new URLSearchParams()
  params.set(PERMALINK_SESSION_PARAM, sessionId)
  return `?${params.toString()}`
}

/**
 * Read a permalink target out of the current query, or null when this is an
 * ordinary visit. Both params are required: a session without a message is just
 * "open this conversation" (which the session store already handles), and a
 * message without a session cannot be resolved — messages are stored per
 * session and the id alone does not say which one to load.
 */
export function parseMessagePermalink(
  params: ReadableParams | null
): MessagePermalinkTarget | null {
  if (!params) return null
  const sessionId = params.get(PERMALINK_SESSION_PARAM)
  const messageId = params.get(PERMALINK_MESSAGE_PARAM)
  if (!sessionId || !messageId) return null
  return { sessionId, messageId }
}
