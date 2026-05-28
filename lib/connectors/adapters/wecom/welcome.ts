/**
 * WeCom `enter_chat` welcome resolution.
 *
 * The 智能机器人 fires an `enter_chat` event when a user opens the bot chat;
 * the bot may reply with a welcome message via `aibot_respond_welcome_msg`
 * within 5 s. We do NOT hardcode a greeting (it would be un-i18n'd and
 * presumptuous) — the operator configures one on the adapter
 * (`settings.welcomeMessage`). When unset, we skip the welcome reply.
 */

import type { IMQuickCommand } from "@/lib/connectors/quick-commands/types"

export interface WeComAdapterSettings {
  /** Optional operator-configured greeting sent on enter_chat. */
  welcomeMessage?: string
  /**
   * Quick-command list. Each entry becomes a button on the persistent
   * menu card pushed on `enter_chat`. Empty/undefined → no menu card.
   * See `lib/connectors/quick-commands/types.ts:IMQuickCommand`.
   */
  quickCommands?: IMQuickCommand[]
  [k: string]: unknown
}

/**
 * Resolve the welcome text to send on `enter_chat`, or `null` to skip.
 * Trims whitespace; an empty / whitespace-only configured value is treated
 * as "no welcome".
 */
export function resolveWelcomeMessage(settings: WeComAdapterSettings | undefined): string | null {
  const raw = settings?.welcomeMessage
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}
