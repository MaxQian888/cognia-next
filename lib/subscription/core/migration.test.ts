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

// Host detection: jsdom is plain web, so default the suite to "a host exists"
// and let the skip tests flip these off explicitly.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockIsTauri(),
  isCapacitor: () => mockIsCapacitor(),
  // `hasHostRuntime()` resolves the host PROFILE, which reads the platform, so
  // this mock has to answer consistently with the flags above. A partial mock
  // left `detectPlatform` undefined and the profile resolver threw.
  detectPlatform: () => (mockIsTauri() ? "tauri" : mockIsCapacitor() ? "mobile" : "web"),
}))

jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => mockHasWebCompanion(),
}))

const mockIsTauri = jest.fn(() => true)
const mockIsCapacitor = jest.fn(() => false)
const mockHasWebCompanion = jest.fn(() => false)

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
  mockIsTauri.mockReturnValue(true)
  mockIsCapacitor.mockReturnValue(false)
  mockHasWebCompanion.mockReturnValue(false)
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

  it("skips the command entirely in web mode with no backend", async () => {
    mockIsTauri.mockReturnValue(false)
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    const result = await subscriptionInitOnce({ storage: new MemoryStorage() })

    expect(result).toEqual({
      outcomes: [],
      migratedCount: 0,
      toastShown: false,
      skipped: true,
    })
    expect(result.error).toBeUndefined()
    expect(mockedInit).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(mockedSuccess).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each([
    ["capacitor", () => mockIsCapacitor.mockReturnValue(true)],
    ["a paired web companion", () => mockHasWebCompanion.mockReturnValue(true)],
  ])("skips the client-local migration on %s", async (_label, enableHost) => {
    mockIsTauri.mockReturnValue(false)
    enableHost()

    const result = await subscriptionInitOnce({ storage: new MemoryStorage() })

    expect(result.skipped).toBe(true)
    expect(mockedInit).not.toHaveBeenCalled()
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
