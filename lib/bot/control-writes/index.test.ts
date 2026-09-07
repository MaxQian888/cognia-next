const setLocal = jest.fn(async () => ({ id: "boti_1" }))
const runLocal = jest.fn(async () => ({ deliveryId: "bdl_1", created: true }))
const replayLocal = jest.fn(async () => true)
const relay = jest.fn(async () => {
  throw new Error("relayed")
})

jest.mock("./local", () => ({
  setBotTriggerArmedLocally: (...args: unknown[]) => setLocal(...(args as [])),
  runBotManuallyLocally: (...args: unknown[]) => runLocal(...(args as [])),
  replayBotDeliveryLocally: (...args: unknown[]) => replayLocal(...(args as [])),
  BotControlTargetMissingError: class extends Error {},
  MANUAL_RUN_EVENT_TYPE: "manual.run",
}))
jest.mock("./remote", () => ({
  relayBotWrite: (...args: unknown[]) => relay(...(args as [])),
  BotRelayNotImplementedError: class extends Error {},
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
  relay.mockClear()
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
    expect(relay).not.toHaveBeenCalled()
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
    expect(relay).not.toHaveBeenCalled()
  })
})
