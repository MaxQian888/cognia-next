import { toast } from "sonner"

import { _resetMigrationToastFlag, subscriptionInitOnce } from "./migration"
import { subscriptionInit } from "./transport"

jest.mock("./transport", () => ({
  subscriptionInit: jest.fn(),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
  },
}))

const mockedInit = subscriptionInit as jest.MockedFunction<typeof subscriptionInit>
const mockedSuccess = toast.success as jest.MockedFunction<typeof toast.success>

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

beforeEach(() => {
  mockedInit.mockReset()
  mockedSuccess.mockReset()
})

describe("subscriptionInitOnce", () => {
  it("returns zero migrations + no toast when nothing legacy exists", async () => {
    mockedInit.mockResolvedValueOnce([
      { kind: "no-legacy-data", provider: "anthropic" },
      { kind: "no-legacy-data", provider: "codex" },
      { kind: "no-legacy-data", provider: "opencode" },
    ])
    const result = await subscriptionInitOnce({ storage: new MemoryStorage() })
    expect(result.migratedCount).toBe(0)
    expect(result.toastShown).toBe(false)
    expect(mockedSuccess).not.toHaveBeenCalled()
  })

  it("counts only `migrated` outcomes", async () => {
    mockedInit.mockResolvedValueOnce([
      { kind: "migrated", provider: "anthropic", accountId: "a-1" },
      { kind: "already-migrated", provider: "codex" },
      { kind: "no-legacy-data", provider: "opencode" },
    ])
    const result = await subscriptionInitOnce({
      storage: new MemoryStorage(),
      translateToast: (key, params) =>
        key === "toastBody" ? `count=${(params as { count: number }).count}` : key,
    })
    expect(result.migratedCount).toBe(1)
    expect(result.toastShown).toBe(true)
    expect(mockedSuccess).toHaveBeenCalledWith("toastTitle", {
      description: "count=1",
    })
  })

  it("only fires the toast once per profile even across multiple boots", async () => {
    const storage = new MemoryStorage()
    mockedInit.mockResolvedValueOnce([{ kind: "migrated", provider: "anthropic", accountId: "a" }])
    const first = await subscriptionInitOnce({ storage })
    expect(first.toastShown).toBe(true)
    expect(mockedSuccess).toHaveBeenCalledTimes(1)

    // Second boot, same migration result.
    mockedInit.mockResolvedValueOnce([{ kind: "migrated", provider: "anthropic", accountId: "a" }])
    const second = await subscriptionInitOnce({ storage })
    expect(second.toastShown).toBe(false)
    expect(second.migratedCount).toBe(1)
    expect(mockedSuccess).toHaveBeenCalledTimes(1) // no second toast
  })

  it("_resetMigrationToastFlag lets the toast fire again", async () => {
    const storage = new MemoryStorage()
    mockedInit.mockResolvedValueOnce([{ kind: "migrated", provider: "anthropic", accountId: "a" }])
    await subscriptionInitOnce({ storage })
    _resetMigrationToastFlag(storage)
    mockedInit.mockResolvedValueOnce([{ kind: "migrated", provider: "anthropic", accountId: "a" }])
    const reFire = await subscriptionInitOnce({ storage })
    expect(reFire.toastShown).toBe(true)
  })

  it("swallows transport errors and returns the message", async () => {
    mockedInit.mockRejectedValueOnce(new Error("keyring offline"))
    const result = await subscriptionInitOnce({ storage: new MemoryStorage() })
    expect(result.error).toBe("keyring offline")
    expect(result.outcomes).toEqual([])
    expect(result.migratedCount).toBe(0)
    expect(mockedSuccess).not.toHaveBeenCalled()
  })

  it("falls back to English defaults when no translator is supplied", async () => {
    mockedInit.mockResolvedValueOnce([{ kind: "migrated", provider: "codex", accountId: "c" }])
    await subscriptionInitOnce({ storage: new MemoryStorage() })
    expect(mockedSuccess).toHaveBeenCalledWith(
      expect.stringContaining("upgraded"),
      expect.objectContaining({ description: expect.stringContaining("1") })
    )
  })

  it("pluralises the fallback body when multiple accounts migrate", async () => {
    mockedInit.mockResolvedValueOnce([
      { kind: "migrated", provider: "anthropic", accountId: "a" },
      { kind: "migrated", provider: "codex", accountId: "c" },
    ])
    await subscriptionInitOnce({ storage: new MemoryStorage() })
    expect(mockedSuccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        description: expect.stringMatching(/2 legacy accounts/),
      })
    )
  })
})
