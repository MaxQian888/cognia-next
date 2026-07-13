/**
 * @jest-environment jsdom
 */

// IPC + transport are Tauri round-trips; controllable so each case drives the
// probe outcome. jest.fn lives inside the factory (modules call these at
// effect time, but defining them inline keeps the TDZ-safe convention used
// across this repo's mocks).
jest.mock("@/lib/claude/ipc", () => ({
  hasApiKey: jest.fn(async () => false),
  hasOauthBearer: jest.fn(async () => false),
}))

jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: jest.fn(async () => ({ activeAccountId: null, env: [] })),
  getAccount: jest.fn(async () => null),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

let unlockedAccountId: string | null = "local_acct_a"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: { unlockedAccountId: string | null }) => unknown) =>
    selector({ unlockedAccountId }),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { chat: { warn: jest.fn(), error: jest.fn() } },
}))

// Standalone (BYOK) branch — controllable from each test.
const mockStandalone = { value: false }
const mockResolution = { value: { kind: "unresolved" } as { kind: string } }
jest.mock("@/lib/runtime/standalone-mode", () => ({
  isStandaloneChatMode: () => mockStandalone.value,
}))
jest.mock("@/lib/ai/chat/resolve-standalone-provider", () => ({
  resolveStandaloneProvider: () => mockResolution.value,
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: Object.assign(
    (selector: (s: { settings?: { updatedAt?: number } }) => unknown) =>
      selector({ settings: { updatedAt: 1 } }),
    { getState: () => ({ settings: { updatedAt: 1 } }) }
  ),
}))

import { renderHook, waitFor, act } from "@testing-library/react"

import { useCredentialStatus } from "./use-credential-status"
import { hasApiKey, hasOauthBearer } from "@/lib/claude/ipc"
import { getActiveAccount, getAccount } from "@/lib/subscription/core/transport"
import { isTauri } from "@/lib/tauri"
import {
  notifySubscriptionChanged,
  __resetSubscriptionEventsForTesting,
} from "@/lib/subscription/core/subscription-events"

const mHasApiKey = hasApiKey as jest.Mock
const mHasOauthBearer = hasOauthBearer as jest.Mock
const mGetActive = getActiveAccount as jest.Mock
const mGetAccount = getAccount as jest.Mock
const mIsTauri = isTauri as jest.Mock

beforeEach(() => {
  unlockedAccountId = "local_acct_a"
  mockStandalone.value = false
  mockResolution.value = { kind: "unresolved" }
  mIsTauri.mockReturnValue(true)
  mHasApiKey.mockResolvedValue(false)
  mHasOauthBearer.mockResolvedValue(false)
  mGetActive.mockResolvedValue({ activeAccountId: null, env: [] })
  mGetAccount.mockResolvedValue(null)
})

afterEach(() => {
  __resetSubscriptionEventsForTesting()
  jest.clearAllMocks()
})

describe("useCredentialStatus", () => {
  it("returns keyOk=null outside Tauri and never probes", async () => {
    mIsTauri.mockReturnValue(false)
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(mHasApiKey).not.toHaveBeenCalled())
    expect(result.current.keyOk).toBeNull()
    expect(result.current.plan).toBeNull()
  })

  it("reports keyOk=false when neither api key nor bearer is present", async () => {
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(false))
    expect(result.current.plan).toBeNull()
    // No bearer → no plan probe.
    expect(mGetActive).not.toHaveBeenCalled()
  })

  it("reports keyOk=true on a bare api key without fetching a plan", async () => {
    mHasApiKey.mockResolvedValue(true)
    mHasOauthBearer.mockResolvedValue(false)
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
    expect(mGetActive).not.toHaveBeenCalled()
  })

  it("surfaces the active subscription tier when a bearer is present", async () => {
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockResolvedValue({ activeAccountId: "acc_1", env: [] })
    mGetAccount.mockResolvedValue({
      id: "acc_1",
      credential: { provider: "anthropic", plan: "max" },
    })
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.plan).toBe("max"))
    expect(result.current.keyOk).toBe(true)
  })

  it("yields plan=null when the active account is not an Anthropic credential", async () => {
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockResolvedValue({ activeAccountId: "acc_1", env: [] })
    mGetAccount.mockResolvedValue({
      id: "acc_1",
      credential: { provider: "openai" },
    })
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
  })

  it("keeps keyOk=true but plan=null when the plan read throws", async () => {
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockRejectedValue(new Error("no local account"))
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
  })

  it("treats probe failures (Error and non-Error) as not configured", async () => {
    mHasApiKey.mockRejectedValue(new Error("ipc down"))
    mHasOauthBearer.mockRejectedValue("string failure")
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(false))
    expect(result.current.plan).toBeNull()
  })

  it("treats probe failures with swapped error types as not configured", async () => {
    mHasApiKey.mockRejectedValue("string failure")
    mHasOauthBearer.mockRejectedValue(new Error("ipc down"))
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(false))
    expect(result.current.plan).toBeNull()
  })

  it("yields plan=null when the Anthropic credential has no plan field", async () => {
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockResolvedValue({ activeAccountId: "acc_1", env: [] })
    mGetAccount.mockResolvedValue({ id: "acc_1", credential: { provider: "anthropic" } })
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
  })

  it("yields plan=null when there is no active anthropic account", async () => {
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockResolvedValue({ activeAccountId: null, env: [] })
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
    expect(mGetAccount).not.toHaveBeenCalled()
  })

  it("yields plan=null when the active account cannot be loaded", async () => {
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockResolvedValue({ activeAccountId: "acc_1", env: [] })
    mGetAccount.mockResolvedValue(null)
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
  })

  it("swallows a non-Error plan-read rejection", async () => {
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockRejectedValue("vault locked")
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
  })

  it("resolves keyOk from local settings in standalone (BYOK) mode without the keyring", async () => {
    mockStandalone.value = true
    mockResolution.value = { kind: "resolved" }
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(true))
    expect(result.current.plan).toBeNull()
    expect(mHasApiKey).not.toHaveBeenCalled()
    expect(mHasOauthBearer).not.toHaveBeenCalled()
  })

  it("reports keyOk=false in standalone mode when no provider key is configured", async () => {
    mockStandalone.value = true
    mockResolution.value = { kind: "unresolved" }
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(false))
    expect(result.current.plan).toBeNull()
  })

  it("re-probes when a subscription-changed event fires", async () => {
    const { result } = renderHook(() => useCredentialStatus())
    await waitFor(() => expect(result.current.keyOk).toBe(false))

    // The bearer lands after the boot rebuild pushes it.
    mHasOauthBearer.mockResolvedValue(true)
    mGetActive.mockResolvedValue({ activeAccountId: "acc_1", env: [] })
    mGetAccount.mockResolvedValue({
      id: "acc_1",
      credential: { provider: "anthropic", plan: "pro" },
    })

    act(() => {
      notifySubscriptionChanged()
    })

    await waitFor(() => expect(result.current.keyOk).toBe(true))
    await waitFor(() => expect(result.current.plan).toBe("pro"))
  })
})
