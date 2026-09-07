import { BOT_WRITE_COMMANDS } from "./route"
import { BotRelayNotImplementedError, botWriteIdempotencyKey, relayBotWrite } from "./remote"

const fresh = () => "uuid-1"

describe("botWriteIdempotencyKey", () => {
  it("derives an arming key that names the VALUE, not the act of toggling", () => {
    // The relay replays a queued command after a reconnect. arm, disarm, arm
    // is three distinct rows, and replaying the first still leaves the Host
    // armed. A toggle command would land on disarmed and could not be fixed
    // by any key.
    const arm = botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.setTriggerArmed,
      { installationId: "boti_1", triggerId: "nightly", armed: true },
      fresh
    )
    const disarm = botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.setTriggerArmed,
      { installationId: "boti_1", triggerId: "nightly", armed: false },
      fresh
    )
    expect(arm).toBe("bot-arm:boti_1:nightly:1")
    expect(disarm).toBe("bot-arm:boti_1:nightly:0")
    expect(arm).not.toBe(disarm)
  })

  it("keys a replay on the delivery, so a duplicate finds nothing to do", () => {
    expect(
      botWriteIdempotencyKey(BOT_WRITE_COMMANDS.replayDelivery, { deliveryId: "bdl_9" }, fresh)
    ).toBe("bot-replay:bdl_9")
  })

  it("mints a FRESH key per manual run, because two presses are two runs", () => {
    // A derived key would fold the second press onto the first, and there is
    // nothing in the payload that distinguishes them.
    let n = 0
    const mint = () => `uuid-${(n += 1)}`
    const first = botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.runManual,
      { installationId: "a" },
      mint
    )
    const second = botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.runManual,
      { installationId: "a" },
      mint
    )
    expect(first).not.toBe(second)
  })
})

describe("relayBotWrite", () => {
  it("refuses with a typed error rather than silently doing nothing", async () => {
    // The dormant half. A phone must show a disabled control with a reason,
    // not a button that appears to work.
    await expect(relayBotWrite(BOT_WRITE_COMMANDS.runManual)).rejects.toBeInstanceOf(
      BotRelayNotImplementedError
    )
  })
})
