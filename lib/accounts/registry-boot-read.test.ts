import { readAccountRegistryForBoot } from "./registry-boot-read"
import { ACCOUNT_REGISTRY_STATE_ID } from "./account-types"
import type { AccountRegistryBootSnapshot } from "./registry-boot-read"

const snapshot: AccountRegistryBootSnapshot = [
  [],
  { id: ACCOUNT_REGISTRY_STATE_ID, activeAccountId: null, updatedAt: 0 },
]

describe("readAccountRegistryForBoot", () => {
  afterEach(() => jest.useRealTimers())

  it("aborts a stalled read and preserves the timeout when abort rejects the operation", async () => {
    jest.useFakeTimers()
    let signal!: AbortSignal
    const registry = {
      readBootSnapshot: jest.fn((current: AbortSignal) => {
        signal = current
        return new Promise<AccountRegistryBootSnapshot>((_, reject) => {
          current.addEventListener("abort", () => reject(new Error("DatabaseClosedError")))
        })
      }),
    }
    const outcome = readAccountRegistryForBoot(registry).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(15_000)
    expect(await outcome).toMatchObject({
      name: "AccountRegistryBootError",
      code: "registry-timeout",
    })
    expect(signal.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("returns a successful snapshot and releases the watchdog", async () => {
    jest.useFakeTimers()
    const registry = { readBootSnapshot: jest.fn(async () => snapshot) }
    await expect(readAccountRegistryForBoot(registry)).resolves.toBe(snapshot)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("preserves the cause of immediate registry failures with a typed code", async () => {
    const cause = new Error("IndexedDB denied")
    await expect(
      readAccountRegistryForBoot({
        readBootSnapshot: async () => {
          throw cause
        },
      })
    ).rejects.toMatchObject({ code: "registry-unavailable", message: cause.message, cause })
  })

  it("does not let a late result affect a subsequent read", async () => {
    jest.useFakeTimers()
    let resolveOld!: (value: AccountRegistryBootSnapshot) => void
    const registry = {
      readBootSnapshot: jest
        .fn<Promise<AccountRegistryBootSnapshot>, [AbortSignal]>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveOld = resolve
            })
        )
        .mockResolvedValue(snapshot),
    }
    const old = readAccountRegistryForBoot(registry).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(15_000)
    const outcome = await old
    expect(outcome).toMatchObject({ code: "registry-timeout" })
    await expect(readAccountRegistryForBoot(registry)).resolves.toBe(snapshot)
    resolveOld(snapshot)
    await jest.advanceTimersByTimeAsync(0)
    expect(await old).toBe(outcome)
  })
})
