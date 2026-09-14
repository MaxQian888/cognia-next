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
  normalizeLegacyBotWriteKey,
  replayBotDeliveryRemotely,
  runBotManuallyRemotely,
  setBotTriggerArmedRemotely,
} from "./remote"
import { hasPendingBotInstallationMutation } from "./pending-installations"

describe("botWriteIdempotencyKey", () => {
  it("gives arm/disarm/arm different UUIDs while a queue retry retains its receipt", async () => {
    const keys: string[] = []
    for (const armed of [true, false, true]) {
      keys.push(
        await botWriteIdempotencyKey(
          BOT_WRITE_COMMANDS.setTriggerArmed,
          { installationId: "boti_1", triggerId: "nightly", armed },
          () => crypto.randomUUID()
        )
      )
    }
    expect(new Set(keys).size).toBe(3)
    for (const key of keys) expect(key).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("gives an explicit retry a new UUID after the prior request received a cached 503", async () => {
    const first = await botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.replayDelivery,
      { deliveryId: "bdl_9" },
      () => crypto.randomUUID()
    )
    const next = await botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.replayDelivery,
      { deliveryId: "bdl_9" },
      () => crypto.randomUUID()
    )
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(next).not.toBe(first)
  })

  it("normalizes only exact legacy Bot receipts, preserving unrelated or malformed keys", async () => {
    const replay = {
      id: "old-row",
      command: "bot_delivery_replay" as const,
      payload: { deliveryId: "bdl_9" },
      idempotencyKey: "bot-replay:bdl_9",
    }
    expect(await normalizeLegacyBotWriteKey(replay)).toMatch(/^[0-9a-f-]{36}$/)
    expect(await normalizeLegacyBotWriteKey(replay)).toBe(await normalizeLegacyBotWriteKey(replay))
    expect(await normalizeLegacyBotWriteKey({ ...replay, id: "next-click" })).not.toBe(
      await normalizeLegacyBotWriteKey(replay)
    )
    expect(await normalizeLegacyBotWriteKey({ ...replay, idempotencyKey: "malformed" })).toBe(
      "malformed"
    )
    expect(await normalizeLegacyBotWriteKey({ ...replay, command: "connector_send" })).toBe(
      replay.idempotencyKey
    )
    expect(await normalizeLegacyBotWriteKey({ ...replay, payload: {} })).toBe(replay.idempotencyKey)
    const arm = {
      id: "first-arm",
      command: "bot_trigger_set_armed" as const,
      payload: { installationId: "i", triggerId: "t", armed: true },
      idempotencyKey: "bot-arm:i:t:1",
    }
    expect(await normalizeLegacyBotWriteKey(arm)).not.toBe(
      await normalizeLegacyBotWriteKey({ ...arm, id: "last-arm" })
    )
    expect(await normalizeLegacyBotWriteKey(arm)).toBe(await normalizeLegacyBotWriteKey(arm))
    expect(await normalizeLegacyBotWriteKey({ ...arm, payload: {} })).toBe(arm.idempotencyKey)
  })

  it("mints a FRESH key per manual run, because two presses are two runs", async () => {
    // A derived key would fold the second press onto the first, and there is
    // nothing in the payload that distinguishes them.
    let n = 0
    const mint = () => `uuid-${(n += 1)}`
    const first = await botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.runManual,
      { installationId: "a" },
      mint
    )
    const second = await botWriteIdempotencyKey(
      BOT_WRITE_COMMANDS.runManual,
      { installationId: "a" },
      mint
    )
    expect(first).not.toBe(second)
  })
})

it("preserves valid UUIDs and malformed legacy argument shapes", async () => {
  const uuid = crypto.randomUUID()
  const base = {
    id: "r",
    command: "bot_trigger_set_armed" as const,
    payload: { installationId: "i", triggerId: "t", armed: true },
    idempotencyKey: "bot-arm:i:t:1",
  }
  for (const payload of [
    { installationId: "i" },
    { installationId: "i", triggerId: "t" },
    { installationId: "i", triggerId: "t", armed: "true" },
  ]) {
    expect(await normalizeLegacyBotWriteKey({ ...base, payload })).toBe(base.idempotencyKey)
  }
  expect(await normalizeLegacyBotWriteKey({ ...base, idempotencyKey: uuid })).toBe(uuid)
  expect(
    await normalizeLegacyBotWriteKey({
      ...base,
      payload: { ...base.payload, armed: false },
      idempotencyKey: "bot-arm:i:t:0",
    })
  ).toMatch(/^[0-9a-f-]{36}$/)
  expect(await botWriteIdempotencyKey(BOT_WRITE_COMMANDS.mutateInstallation, {}, () => uuid)).toBe(
    uuid
  )
})

it("carries optional labels, input and trigger on the same durable receipts", async () => {
  await runBotManuallyRemotely(
    {
      installationId: "i",
      triggerId: "t",
      input: { number: 25 },
      idempotencyKey: crypto.randomUUID(),
    },
    { label: "Manual" }
  )
  expect(enqueue).toHaveBeenLastCalledWith(
    expect.objectContaining({
      label: "Manual",
      payload: expect.objectContaining({ triggerId: "t", input: { number: 25 } }),
    })
  )
  await replayBotDeliveryRemotely("d", { label: "Retry" })
  expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Retry" }))
  await setBotTriggerArmedRemotely(
    { installationId: "absent", triggerId: "t", armed: false },
    { label: "Disable" }
  )
  expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Disable" }))
})

describe("setBotTriggerArmedRemotely", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    enqueue.mockClear()
  })

  it("enqueues the absolute value under a UUID", async () => {
    await setBotTriggerArmedRemotely({
      installationId: "boti_1",
      triggerId: "nightly",
      armed: true,
    })
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        command: BOT_WRITE_COMMANDS.setTriggerArmed,
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
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

  it("queues a UUID per explicit retry while the Host deduplicates the delivery", async () => {
    await replayBotDeliveryRemotely("bdl_9")
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        command: BOT_WRITE_COMMANDS.replayDelivery,
        idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
        payload: { deliveryId: "bdl_9" },
      })
    )
  })
})
