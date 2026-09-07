/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"

const enqueue = jest.fn(
  async (input: { command: string; idempotencyKey: string; payload: Record<string, unknown> }) =>
    ({ id: "job_1", ...input }) as unknown as MobileOutboundJobRow
)
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (input: { command: string; idempotencyKey: string; payload: Record<string, unknown> }) =>
    enqueue(input),
}))

import { BOT_WRITE_COMMANDS } from "./route"
import {
  botWriteIdempotencyKey,
  replayBotDeliveryRemotely,
  runBotManuallyRemotely,
  setBotTriggerArmedRemotely,
} from "./remote"
import { hasPendingBotInstallationMutation } from "./pending-installations"

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

describe("setBotTriggerArmedRemotely", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    enqueue.mockClear()
  })

  it("enqueues the absolute value under a derived key", async () => {
    await setBotTriggerArmedRemotely({
      installationId: "boti_1",
      triggerId: "nightly",
      armed: true,
    })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        command: BOT_WRITE_COMMANDS.setTriggerArmed,
        idempotencyKey: "bot-arm:boti_1:nightly:1",
        payload: { installationId: "boti_1", triggerId: "nightly", armed: true },
      })
    )
  })

  it("flips the local mirror so the switch settles immediately", async () => {
    const row = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
    })
    await setBotTriggerArmedRemotely({
      installationId: row.id,
      triggerId: "nightly",
      armed: false,
    })
    const stored = await getDb().botInstallations.get(row.id)
    expect(stored?.triggerOverrides).toEqual({ nightly: false })
  })

  it("leaves the other overrides alone", async () => {
    const row = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      triggerOverrides: { weekly: true },
    })
    await setBotTriggerArmedRemotely({ installationId: row.id, triggerId: "nightly", armed: true })
    const stored = await getDb().botInstallations.get(row.id)
    expect(stored?.triggerOverrides).toEqual({ weekly: true, nightly: true })
  })

  it("writes nothing locally when the installation is not mirrored here", async () => {
    // A relayed arm for a Bot this device has never seen still has to reach
    // the Host, and inventing a local row for it would put a Bot on screen
    // that no installation anywhere holds.
    await setBotTriggerArmedRemotely({
      installationId: "boti_absent",
      triggerId: "nightly",
      armed: true,
    })
    expect(await getDb().botInstallations.get("boti_absent")).toBeUndefined()
    expect(enqueue).toHaveBeenCalled()
  })

  it("releases the pending marker even when the enqueue throws", async () => {
    // A marker left held would make the sync handler skip this installation
    // forever, freezing the mirror on a value the Host never took.
    enqueue.mockRejectedValueOnce(new Error("offline"))
    await expect(
      setBotTriggerArmedRemotely({ installationId: "boti_1", triggerId: "n", armed: true })
    ).rejects.toThrow("offline")
    expect(hasPendingBotInstallationMutation("boti_1")).toBe(false)
  })
})

describe("runBotManuallyRemotely", () => {
  beforeEach(() => enqueue.mockClear())

  it("reuses the caller's key, so a retry is not a second run", async () => {
    await runBotManuallyRemotely({ installationId: "boti_1", idempotencyKey: "uuid-7" })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        command: BOT_WRITE_COMMANDS.runManual,
        idempotencyKey: "uuid-7",
      })
    )
  })

  it("carries the key in the payload too, because the Host derives the event id from it", async () => {
    await runBotManuallyRemotely({ installationId: "boti_1", idempotencyKey: "uuid-7" })
    const [call] = enqueue.mock.calls as unknown as Array<[{ payload: { idempotencyKey: string } }]>
    expect(call![0].payload.idempotencyKey).toBe("uuid-7")
  })

  it("omits an absent trigger rather than sending undefined", async () => {
    await runBotManuallyRemotely({ installationId: "boti_1", idempotencyKey: "k" })
    const [call] = enqueue.mock.calls as unknown as Array<[{ payload: Record<string, unknown> }]>
    expect("triggerId" in call![0].payload).toBe(false)
  })
})

describe("replayBotDeliveryRemotely", () => {
  beforeEach(() => enqueue.mockClear())

  it("keys on the delivery, so a duplicate request finds nothing to do", async () => {
    await replayBotDeliveryRemotely("bdl_9")
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        command: BOT_WRITE_COMMANDS.replayDelivery,
        idempotencyKey: "bot-replay:bdl_9",
        payload: { deliveryId: "bdl_9" },
      })
    )
  })
})
