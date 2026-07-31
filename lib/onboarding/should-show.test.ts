import type { AppSettings } from "@cognia/agent-config-types"
import { shouldShowOnboarding } from "./should-show"

jest.mock("@/lib/subscription/core/transport", () => ({
  getActiveAccount: jest.fn(),
}))

import { getActiveAccount } from "@/lib/subscription/core/transport"

const mockedGetActive = getActiveAccount as jest.MockedFunction<typeof getActiveAccount>

function makeSettings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    id: "singleton",
    permissionMode: "default",
    alwaysAllowTools: [],
    builtinTools: {} as AppSettings["builtinTools"],
    ...patch,
  } as AppSettings
}

beforeEach(() => {
  mockedGetActive.mockReset()
  mockedGetActive.mockResolvedValue({ activeAccountId: undefined, env: [] })
})

describe("shouldShowOnboarding", () => {
  it("returns true on a fresh install with no sessions, no apiKey, no subscription", async () => {
    const out = await shouldShowOnboarding(makeSettings(), 0)
    expect(out).toBe(true)
    expect(mockedGetActive).toHaveBeenCalledTimes(3)
  })

  it("returns false when any chat session already exists", async () => {
    const out = await shouldShowOnboarding(makeSettings(), 1)
    expect(out).toBe(false)
    expect(mockedGetActive).not.toHaveBeenCalled()
  })

  it("returns false when onboarding was previously dismissed", async () => {
    const out = await shouldShowOnboarding(
      makeSettings({ onboardingDismissedAt: "2026-05-18T00:00:00.000Z" }),
      0
    )
    expect(out).toBe(false)
    expect(mockedGetActive).not.toHaveBeenCalled()
  })

  it("returns false when a direct apiKey is already configured", async () => {
    const out = await shouldShowOnboarding(makeSettings({ apiKey: "sk-ant-existing" }), 0)
    expect(out).toBe(false)
    expect(mockedGetActive).not.toHaveBeenCalled()
  })

  it("returns false when Anthropic has an active subscription account", async () => {
    mockedGetActive.mockImplementation(async (provider) =>
      provider === "anthropic"
        ? { activeAccountId: "acct-1", env: [] }
        : { activeAccountId: undefined, env: [] }
    )
    const out = await shouldShowOnboarding(makeSettings(), 0)
    expect(out).toBe(false)
  })

  it("returns false when Codex has an active subscription account", async () => {
    mockedGetActive.mockImplementation(async (provider) =>
      provider === "codex"
        ? { activeAccountId: "acct-2", env: [] }
        : { activeAccountId: undefined, env: [] }
    )
    const out = await shouldShowOnboarding(makeSettings(), 0)
    expect(out).toBe(false)
  })

  it("returns false when OpenCode has an active subscription account", async () => {
    mockedGetActive.mockImplementation(async (provider) =>
      provider === "opencode"
        ? { activeAccountId: "acct-3", env: [] }
        : { activeAccountId: undefined, env: [] }
    )
    const out = await shouldShowOnboarding(makeSettings(), 0)
    expect(out).toBe(false)
  })

  it("treats subscription IPC failures as 'no active account' (does not block fresh install)", async () => {
    mockedGetActive.mockRejectedValue(new Error("ipc unavailable (web mode)"))
    const out = await shouldShowOnboarding(makeSettings(), 0)
    expect(out).toBe(true)
  })
})
