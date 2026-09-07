const setLocal = jest.fn(async () => ({ id: "boti_1" }))
const runLocal = jest.fn(async () => ({ deliveryId: "bdl_1", created: true }))
const replayLocal = jest.fn(async () => true)
const relayArm = jest.fn(async (_input: unknown) => ({ id: "job_1" }))
const relayRun = jest.fn(async (_input: unknown) => ({ id: "job_2" }))
const relayReplay = jest.fn(async (_id: string) => ({ id: "job_3" }))

jest.mock("./local", () => ({
  setBotTriggerArmedLocally: (...args: unknown[]) => setLocal(...(args as [])),
  runBotManuallyLocally: (...args: unknown[]) => runLocal(...(args as [])),
  replayBotDeliveryLocally: (...args: unknown[]) => replayLocal(...(args as [])),
  BotControlTargetMissingError: class extends Error {},
  MANUAL_RUN_EVENT_TYPE: "manual.run",
}))
jest.mock("./remote", () => ({
  setBotTriggerArmedRemotely: (input: unknown) => relayArm(input),
  runBotManuallyRemotely: (input: unknown) => relayRun(input),
  replayBotDeliveryRemotely: (id: string) => relayReplay(id),
  botWriteIdempotencyKey: () => "k",
}))

import {
  BOT_WRITE_COMMANDS,
  BotWriteUnavailableError,
  replayBotDeliveryWrite,
  runBotManually,
  setBotTriggerArmed,
} from "./index"
import { __setBotWriteRouteDepsForTests } from "./route"

let restore: (() => void) | undefined

function route(over: Parameters<typeof __setBotWriteRouteDepsForTests>[0]) {
  restore?.()
  restore = __setBotWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    isRunnerOwnedHere: () => false,
    hasLocalDatabase: () => false,
    getRuntimeSnapshot: (() => ({ target: null })) as never,
    activeHostFeatureManifest: () => null,
    ...over,
  })
}

beforeEach(() => {
  setLocal.mockClear()
  runLocal.mockClear()
  replayLocal.mockClear()
  relayArm.mockClear()
  relayRun.mockClear()
  relayReplay.mockClear()
})

afterEach(() => {
  restore?.()
  restore = undefined
})

describe("the facade picks the executor", () => {
  it("runs a local arm through the domain mutator", async () => {
    route({ hasLocalDatabase: () => true })
    await setBotTriggerArmed({ installationId: "boti_1", triggerId: "n", armed: true })
    expect(setLocal).toHaveBeenCalledWith({
      installationId: "boti_1",
      triggerId: "n",
      armed: true,
    })
    expect(relayArm).not.toHaveBeenCalled()
  })

  it("runs a local manual run and replay once a runner is here", async () => {
    route({ hasLocalDatabase: () => true, isRunnerOwnedHere: () => true })
    await runBotManually({ installationId: "boti_1", idempotencyKey: "k" })
    await replayBotDeliveryWrite("bdl_1")
    expect(runLocal).toHaveBeenCalled()
    expect(replayLocal).toHaveBeenCalledWith("bdl_1")
  })

  it("throws a typed error on a shell that cannot act at all", async () => {
    route({})
    await expect(
      setBotTriggerArmed({ installationId: "boti_1", triggerId: "n", armed: true })
    ).rejects.toBeInstanceOf(BotWriteUnavailableError)
    expect(setLocal).not.toHaveBeenCalled()
  })

  it("carries the command and the availability on the error, so a control can explain itself", async () => {
    route({ hasLocalDatabase: () => true })
    const caught = await runBotManually({ installationId: "boti_1", idempotencyKey: "k" }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(caught).toBeInstanceOf(BotWriteUnavailableError)
    const error = caught as BotWriteUnavailableError
    expect(error.command).toBe(BOT_WRITE_COMMANDS.runManual)
    expect(error.availability).toEqual({ state: "unsupported", reason: "operation-unavailable" })
  })

  it("does not reach the relay when the remote host cannot take the command", async () => {
    // A queued row that the host will reject is worse than a refusal here: it
    // dead-letters somewhere the user is not looking.
    route({ isRemoteHostActive: () => true, activeHostFeatureManifest: () => null })
    await expect(
      setBotTriggerArmed({ installationId: "boti_1", triggerId: "n", armed: true })
    ).rejects.toBeInstanceOf(BotWriteUnavailableError)
    expect(relayArm).not.toHaveBeenCalled()
  })
})

describe("the facade routes to the relay", () => {
  const ALL_THREE = [
    BOT_WRITE_COMMANDS.setTriggerArmed,
    BOT_WRITE_COMMANDS.runManual,
    BOT_WRITE_COMMANDS.replayDelivery,
  ]

  /**
   * A remote host that advertises the whole control feature AND reports every
   * operation healthy. A schema-2 manifest needs both: the feature descriptor
   * says the host implements it, the operation health says it can right now.
   */
  function manifest(operations: readonly string[]) {
    return {
      schemaVersion: 2,
      features: { "bots.control": { version: 1, operations: [...operations] } },
      operations: operations.map((name) => ({ name, healthy: true })),
    } as never
  }

  function connectedHost() {
    route({
      isRemoteHostActive: () => true,
      activeHostFeatureManifest: () => manifest(ALL_THREE),
    })
  }

  it("relays an arm and answers undefined, because the queue row is not an installation", async () => {
    connectedHost()
    const result = await setBotTriggerArmed({
      installationId: "boti_1",
      triggerId: "n",
      armed: true,
    })
    expect(relayArm).toHaveBeenCalledWith({
      installationId: "boti_1",
      triggerId: "n",
      armed: true,
    })
    expect(setLocal).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it("relays a manual run without inventing a delivery id", async () => {
    // The Host mints it from the idempotency key. Reporting one here would
    // name a row this device cannot see.
    connectedHost()
    const result = await runBotManually({ installationId: "boti_1", idempotencyKey: "k" })
    expect(relayRun).toHaveBeenCalledWith({ installationId: "boti_1", idempotencyKey: "k" })
    expect(runLocal).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it("relays a replay and leaves the verdict to sync", async () => {
    connectedHost()
    const result = await replayBotDeliveryWrite("bdl_9")
    expect(relayReplay).toHaveBeenCalledWith("bdl_9")
    expect(replayLocal).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })

  it("prefers the relay over the local leg on a desktop driving a remote host", async () => {
    // The ordering trap: that desktop still reports `always-on` while its own
    // runtimes are torn down.
    route({
      isRemoteHostActive: () => true,
      hasLocalDatabase: () => true,
      isRunnerOwnedHere: () => true,
      activeHostFeatureManifest: () => manifest([BOT_WRITE_COMMANDS.runManual]),
    })
    await runBotManually({ installationId: "boti_1", idempotencyKey: "k" })
    expect(relayRun).toHaveBeenCalled()
    expect(runLocal).not.toHaveBeenCalled()
  })
})
