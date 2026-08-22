/**
 * The Telegram update types this adapter asks the platform to deliver.
 *
 * The list is EXPLICIT, so Telegram's own defaults do not apply: anything not
 * named here is silently never delivered. Bot API 7.0's `message_reaction` was
 * the first casualty (audited fix #3); `my_chat_member` was the second — it is
 * in Telegram's default set, but naming any list at all opts out of that set,
 * so the bot never learned it had been added to or removed from a chat.
 *
 * BOTH delivery transports must send the SAME list or webhook bots silently
 * lose whatever long-poll bots gained:
 *   - long poll  → `getUpdates?allowed_updates=…` (`transport-longpoll.ts`)
 *   - webhook    → `setWebhook.allowed_updates`  (`webhook-registration.ts`)
 * That is why the list lives in its own module rather than next to either
 * caller, and why `allowed-updates.test.ts` pins its contents: adding a type
 * to one transport and not the other is the drift this module exists to stop.
 */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
  "message_reaction",
  "my_chat_member",
] as const

export type TelegramAllowedUpdate = (typeof TELEGRAM_ALLOWED_UPDATES)[number]
