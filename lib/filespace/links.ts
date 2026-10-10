/**
 * Links that open a conversation's files (ADR-0222 §2).
 *
 * Two spellings of one target, both extensions of a link that already exists:
 *
 * - desktop: `cognia://session/<id>?view=files[&path=…][&line=…]` —
 *   `buildSessionDeeplink` plus the parameters in `./link-params.ts`, so every
 *   existing parser that only knows the session still opens the conversation;
 * - app/web: `/?session=<id>&view=files[&path=…][&line=…]` —
 *   `buildSessionHref`'s query plus the same parameters.
 *
 * The CLI's `cognia open --session <id> --files` builds the desktop form;
 * `link-fixtures.json` holds both implementations to the same strings.
 */

import { PERMALINK_SESSION_PARAM } from "@/lib/chat/message-permalink"
import { buildSessionDeeplink } from "@/lib/navigation/cognia-deeplink"

import { filesViewParams, type ParsedFilesView } from "./link-params"

export interface ConversationFilesTarget extends ParsedFilesView {
  sessionId: string
}

/** `?session=…&view=files…`, the app-route query. */
export function conversationFilesQuery(target: ConversationFilesTarget): string {
  const params = new URLSearchParams()
  params.set(PERMALINK_SESSION_PARAM, target.sessionId)
  for (const [key, value] of filesViewParams(target)) params.set(key, value)
  return `?${params.toString()}`
}

/** The `cognia://` form. */
export function buildConversationFilesDeeplink(target: ConversationFilesTarget): string {
  const base = buildSessionDeeplink(target.sessionId)
  return `${base}${base.includes("?") ? "&" : "?"}${filesViewParams(target).toString()}`
}

/**
 * The link to hand someone (or the clipboard) for a conversation's files.
 * Desktop links use the OS scheme; elsewhere the app route, absolute when an
 * origin is known.
 */
export function buildConversationFilesLink(
  target: ConversationFilesTarget,
  opts: { desktop: boolean; origin?: string | null }
): string {
  if (opts.desktop) return buildConversationFilesDeeplink(target)
  const origin =
    opts.origin !== undefined
      ? opts.origin
      : typeof window !== "undefined"
        ? window.location.origin
        : null
  const query = conversationFilesQuery(target)
  if (!origin) return `/${query}`
  return `${origin.replace(/\/+$/, "")}/${query}`
}
