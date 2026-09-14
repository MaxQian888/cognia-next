/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

const setBotTriggerArmed = jest.fn(
  async (_input: { installationId: string; triggerId: string; armed: boolean }) => undefined
)
const runBotManually = jest.fn(
  async (_input: {
    idempotencyKey: string
  }): Promise<{ deliveryId: string; created: boolean } | undefined> => ({
    deliveryId: "bdl_1",
    created: true,
  })
)
const replayBotDeliveryWrite = jest.fn(
  async (_deliveryId: string): Promise<boolean | undefined> => true
)

let route = "local"
let availability = { state: "available", reason: "local-host" }

// The error classes are declared INSIDE the factory. `jest.mock` is hoisted
// above every `const` in this file, so referring to one declared out here is a
// temporal-dead-zone error at import time rather than a failing assertion.
jest.mock("@/lib/bot/control-writes", () => {
  class BotWriteUnavailableError extends Error {
    readonly command = "bot_run_manual"
    readonly route = "unavailable"
    readonly availability = { state: "unsupported", reason: "requires-companion" }
  }
  class BotControlTargetMissingError extends Error {
    readonly what = "trigger"
  }
  return {
    BOT_WRITE_COMMANDS: {
      setTriggerArmed: "bot_trigger_set_armed",
      runManual: "bot_run_manual",
      replayDelivery: "bot_delivery_replay",
    },
    BotWriteUnavailableError,
    BotControlTargetMissingError,
    setBotTriggerArmed: (input: { installationId: string; triggerId: string; armed: boolean }) =>
      setBotTriggerArmed(input),
    runBotManually: (input: { idempotencyKey: string }) => runBotManually(input),
    replayBotDeliveryWrite: (deliveryId: string) => replayBotDeliveryWrite(deliveryId),
    resolveBotWriteRoute: () => route,
    resolveBotWriteAvailability: () => availability,
  }
})

let notifyRoute: (() => void) | undefined
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  subscribeRuntimeSnapshot: (listener: () => void) => {
    notifyRoute = listener
    return () => {
      notifyRoute = undefined
    }
  },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  subscribeActiveRemoteTransport: () => () => {},
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { subscribe: () => () => {} },
}))

const success = jest.fn()
const error = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => success(...a), error: (...a: unknown[]) => error(...a) },
}))

import { useBotControlActions, useBotWriteReadiness } from "./use-bot-control-writes"

const { BotWriteUnavailableError: FakeUnavailable, BotControlTargetMissingError: FakeMissing } =
  jest.requireMock("@/lib/bot/control-writes") as {
    BotWriteUnavailableError: new (message: string) => Error
    BotControlTargetMissingError: new (message: string) => Error
  }

beforeEach(() => {
  setBotTriggerArmed.mockClear().mockResolvedValue(undefined)
  runBotManually.mockClear().mockResolvedValue({ deliveryId: "bdl_1", created: true })
  replayBotDeliveryWrite.mockClear().mockResolvedValue(true)
  success.mockClear()
  error.mockClear()
  route = "local"
  availability = { state: "available", reason: "local-host" }
})

describe("useBotWriteReadiness", () => {
  it("reports the route and whether a control may act", () => {
    const { result } = renderHook(() => useBotWriteReadiness("bot_run_manual"))
    expect(result.current).toEqual({ route: "local", availability, can: true })
  })

  it("re-reads when the runtime changes under it", () => {
    // A control that asked once at mount keeps offering itself after the
    // desktop it was reading pairs with a remote host.
    const { result } = renderHook(() => useBotWriteReadiness("bot_run_manual"))
    expect(result.current.can).toBe(true)

    route = "unavailable"
    availability = { state: "unsupported", reason: "requires-companion" }
    act(() => notifyRoute?.())
    expect(result.current.can).toBe(false)
  })
})

describe("useBotControlActions", () => {
  it("routes explicit backfill input through the existing manual write", async () => {
    const { result } = renderHook(() => useBotControlActions())
    await act(async () => result.current.runNow("installation", "backfill", { numbers: "12,34" }))
    expect(runBotManually).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "installation",
        triggerId: "backfill",
        input: { numbers: "12,34" },
      })
    )
  })
  it("routes an arm through the facade and reports it", async () => {
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.setTriggerArmed("boti_1", "n", true))
    expect(setBotTriggerArmed).toHaveBeenCalledWith({
      installationId: "boti_1",
      triggerId: "n",
      armed: true,
    })
    expect(success).toHaveBeenCalledWith("Trigger armed")
  })

  it("mints a fresh idempotency key per press, because two presses are two runs", async () => {
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.runNow("boti_1", "run"))
    await act(() => result.current.runNow("boti_1", "run"))
    const calls = runBotManually.mock.calls as unknown as Array<[{ idempotencyKey: string }]>
    const [first] = calls[0]!
    const [second] = calls[1]!
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey)
  })

  it("tells a fresh run from one that was already queued", async () => {
    runBotManually.mockResolvedValue({ deliveryId: "bdl_1", created: false })
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.runNow("boti_1"))
    expect(success).toHaveBeenCalledWith("That run is already queued.")
  })

  it("reports the queued Host request instead of claiming a duplicate manual run", async () => {
    route = "remote"
    runBotManually.mockResolvedValue(undefined)
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.runNow("installation", "scan"))
    expect(success).toHaveBeenCalledWith("Request queued for the Host.")
    expect(success).not.toHaveBeenCalledWith("That run is already queued.")
    expect(result.current.pending.size).toBe(0)
  })

  it("explains an unavailable write with its reason, not a generic failure", async () => {
    setBotTriggerArmed.mockRejectedValue(new FakeUnavailable("nope"))
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.setTriggerArmed("boti_1", "n", true))
    expect(error).toHaveBeenCalledWith("That change cannot be made from here", {
      description: "This browser cannot run Bots. Pair a Host or use the desktop app.",
    })
  })

  it("names which target went missing", async () => {
    setBotTriggerArmed.mockRejectedValue(new FakeMissing("gone"))
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.setTriggerArmed("boti_1", "n", true))
    expect(error).toHaveBeenCalledWith("That trigger is not declared by this definition.")
  })

  it("keeps the underlying message for anything unexpected", async () => {
    // "Something went wrong" is the sentence that makes a bug report
    // impossible to act on.
    setBotTriggerArmed.mockRejectedValue(new Error("QuotaExceededError"))
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.setTriggerArmed("boti_1", "n", true))
    expect(error).toHaveBeenCalledWith("The change could not be saved", {
      description: "QuotaExceededError",
    })
  })

  it.each([
    [undefined, "Retry request queued for the Host."],
    [false, "A retry already exists or this delivery cannot be retried."],
    [true, "Delivery queued again"],
  ] as const)(
    "distinguishes the queued remote receipt from host result %s",
    async (receipt, message) => {
      replayBotDeliveryWrite.mockResolvedValue(receipt)
      const { result } = renderHook(() => useBotControlActions())
      await act(() => result.current.replayDelivery("delivery"))
      expect(success).toHaveBeenCalledWith(message)
    }
  )

  it("localizes the typed or serialized retry readiness error without showing host English text", async () => {
    replayBotDeliveryWrite.mockRejectedValue({
      code: "bot_delivery_replay_unavailable",
      message: "English host implementation detail",
    })
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.replayDelivery("delivery"))
    expect(error).toHaveBeenCalledWith(
      "Enable this Bot on its owning Host and restore its definition and original run before retrying."
    )
    expect(JSON.stringify(error.mock.calls)).not.toContain("English host")
  })

  it("clears the pending key even when the write throws", async () => {
    replayBotDeliveryWrite.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useBotControlActions())
    await act(() => result.current.replayDelivery("bdl_9"))
    expect(result.current.pending.has("delivery:bdl_9")).toBe(false)
  })
})
