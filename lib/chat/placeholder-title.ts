/**
 * The titles a conversation carries before it has a real one.
 *
 * A new row is stamped with a machine placeholder (`createSession` writes
 * "New chat", older writers "New conversation") and keeps it until the first
 * message names it. Two readers care, for different reasons:
 *
 * - the title generator, which may only overwrite a title nobody chose
 *   (`lib/ai/generation/run-title-task.ts` re-exports these);
 * - the conversation lists, which must not print the stored English
 *   placeholder to a reader of another language (`sessionDisplayTitle`).
 *
 * Kept free of imports so a sidebar row can depend on it without pulling the
 * title-generation pipeline into its module graph.
 */

/**
 * Includes common i18n defaults so {@link isPlaceholderTitle} works whatever
 * locale wrote the row. Adding to this set requires no Dexie schema change.
 */
export const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  "New chat",
  "New conversation",
  // zh-CN / zh-TW common defaults
  "新对话",
  "新聊天",
  "新建会话",
  "新建聊天",
  // ja
  "新しい会話",
  // fr
  "Nouvelle conversation",
  // de
  "Neue Unterhaltung",
  // es
  "Nueva conversación",
])

/**
 * True when `title` is empty or one of the known machine placeholders — i.e.
 * the instant first-message preview is allowed to claim it. A user rename
 * replaces the placeholder, so this also doubles as the "not yet renamed"
 * gate for the instant-preview write in the chat hooks.
 */
export function isPlaceholderTitle(title: string | undefined | null): boolean {
  return !title || PLACEHOLDER_TITLES.has(title)
}

/**
 * The title a conversation list prints: the stored one, unless it is empty
 * (`labels.untitled`) or a machine placeholder (`labels.placeholder`, the
 * reader's own words for "a new chat").
 */
export function sessionDisplayTitle(
  title: string | undefined | null,
  labels: { untitled: string; placeholder: string }
): string {
  if (!title) return labels.untitled
  if (PLACEHOLDER_TITLES.has(title)) return labels.placeholder
  return title
}
