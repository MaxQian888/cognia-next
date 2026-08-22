/**
 * Drift guard for the shared `allowed_updates` list.
 *
 * The list is a wire contract with Telegram, not an implementation detail:
 * dropping an entry makes the bot go permanently deaf to that update type on
 * BOTH transports, with no error anywhere. Pinning the exact contents means a
 * change has to be deliberate, and the transport tests
 * (`transport-longpoll.test.ts`, `webhook-registration.test.ts`) assert that
 * each transport actually sends THIS list.
 */

import { TELEGRAM_ALLOWED_UPDATES } from "./allowed-updates"

describe("TELEGRAM_ALLOWED_UPDATES", () => {
  it("pins the exact set of update types both transports request", () => {
    expect([...TELEGRAM_ALLOWED_UPDATES]).toEqual([
      "message",
      "edited_message",
      "channel_post",
      "edited_channel_post",
      "callback_query",
      "message_reaction",
      "my_chat_member",
    ])
  })

  it("includes the membership update the bot needs to notice joins and removals", () => {
    // Regression: naming any allowed_updates list opts out of Telegram's
    // default set, so `my_chat_member` has to be listed explicitly.
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("my_chat_member")
  })

  it("has no duplicates", () => {
    expect(new Set(TELEGRAM_ALLOWED_UPDATES).size).toBe(TELEGRAM_ALLOWED_UPDATES.length)
  })
})
