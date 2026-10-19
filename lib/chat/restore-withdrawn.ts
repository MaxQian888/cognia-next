/**
 * Hand the conversation sends Stop took back out of the HostState outbox
 * (`withdrawUnsentHostStateMessages`) to the composer they came from.
 *
 * Shared by the desktop controller's Stop and the paired-phone stream's
 * interrupt, so both put the words back the same way: one append, in the
 * order they were typed, naming the files whose bytes stayed on the Host.
 */

import { dispatchComposerAppend } from "@/lib/chat/composer-append"
import { getDraft, setDraft } from "@/lib/db/chat-drafts"
import type { WithdrawnHostStateMessage } from "@/lib/db/mobile-outbound-queue"

/** Text of several sends joined back into one draft, oldest first. */
export function joinWithdrawnText(withdrawn: readonly WithdrawnHostStateMessage[]): string {
  return withdrawn
    .map((message) => message.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

/**
 * Append `withdrawn` to `sessionId`'s composer. When no composer for that
 * conversation is mounted to claim it, the text goes onto the stored draft
 * instead, where the composer reads it when it next opens — never dropped.
 */
export async function restoreWithdrawnToComposer(
  sessionId: string,
  withdrawn: readonly WithdrawnHostStateMessage[]
): Promise<void> {
  if (withdrawn.length === 0) return
  const text = joinWithdrawnText(withdrawn)
  const missing = withdrawn.flatMap((message) => message.attachmentNames)
  const claimed = dispatchComposerAppend({
    sessionId,
    ...(text ? { text } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  })
  if (claimed || !text) return
  const stored = await getDraft(sessionId)
  const current = stored?.text ?? ""
  const merged = current.trim() ? `${current}\n\n${text}` : text
  await setDraft(sessionId, merged, stored?.attachments ?? [])
}
