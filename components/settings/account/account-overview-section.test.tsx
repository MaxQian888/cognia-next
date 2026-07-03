/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}))

const toastSuccessMock = jest.fn()
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}))

const writeClipboardTextMock = jest.fn<Promise<void>, [string]>()
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (text: string) => writeClipboardTextMock(text),
}))

const useUserProfileMock = jest.fn()
jest.mock("@/lib/profile/use-user-profile", () => ({
  useUserProfile: () => useUserProfileMock(),
}))

const useCredentialMock = jest.fn()
const useUsageMock = jest.fn()
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => useCredentialMock(),
  useAnthropicUsage: () => useUsageMock(),
}))

const useCompanionConfigMock = jest.fn()
jest.mock("@/hooks/companion/use-companion-config", () => ({
  useCompanionConfig: () => useCompanionConfigMock(),
}))

jest.mock("../profile/profile-section", () => ({
  ProfileSection: () => <div data-testid="stub-profile-section" />,
}))

let mockIsTauri = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

interface MockAccount {
  id: string
  displayName: string
}
let mockAccounts: MockAccount[] = []
let mockActiveAccountId: string | null = null
let mockUnlockedAccountId: string | null = null
const lockMock = jest.fn()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: unknown) => unknown) =>
    selector({
      accounts: mockAccounts,
      activeAccountId: mockActiveAccountId,
      unlockedAccountId: mockUnlockedAccountId,
      lock: lockMock,
    }),
  selectActiveAccount: (s: { accounts: MockAccount[]; activeAccountId: string | null }) =>
    s.accounts.find((a) => a.id === s.activeAccountId) ?? null,
}))

let mockAutoLockMinutes = 0
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { accountAutoLockMinutes: mockAutoLockMinutes } }),
}))

jest.mock("@/components/account/account-manage-dialog", () => ({
  AccountManageDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-manage-dialog" /> : null,
}))

import { AccountOverviewSection } from "./account-overview-section"

beforeEach(() => {
  pushMock.mockReset()
  toastSuccessMock.mockReset()
  toastErrorMock.mockReset()
  writeClipboardTextMock.mockReset()
  writeClipboardTextMock.mockResolvedValue(undefined)
  lockMock.mockReset()
  mockIsTauri = false
  mockAccounts = []
  mockActiveAccountId = null
  mockUnlockedAccountId = null
  mockAutoLockMinutes = 0
  useUserProfileMock.mockReturnValue({
    profile: {},
    resolvedDisplayName: null,
    resolvedAvatarUrl: null,
  })
  useCredentialMock.mockReturnValue({ credential: null, loading: false })
  useUsageMock.mockReturnValue({ latest: null })
  useCompanionConfigMock.mockReturnValue({ paired: false, shortDeviceId: null })
})

describe("AccountOverviewSection", () => {
  it("renders signed-out identity with a connect CTA and no usage", () => {
    render(<AccountOverviewSection />)
    expect(screen.getByTestId("account-overview-section")).toBeInTheDocument()
    expect(screen.getByTestId("stub-profile-section")).toBeInTheDocument()
    expect(screen.getByText("notSignedIn")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-connect")).toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-copy-email")).not.toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-avatar-img")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("usageFiveHour")).not.toBeInTheDocument()
  })

  it("routes the connect CTA to the subscription section", async () => {
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-connect"))
    expect(pushMock).toHaveBeenCalledWith("/settings?section=subscription")
  })

  it("renders signed-in identity with avatar, email, pronouns, status and usage", () => {
    useUserProfileMock.mockReturnValue({
      profile: { pronouns: "they/them", statusMessage: "shipping" },
      resolvedDisplayName: "Max",
      resolvedAvatarUrl: "data:image/webp;base64,AA",
    })
    useCredentialMock.mockReturnValue({
      credential: { email: "max@example.com", plan: "pro" },
      loading: false,
    })
    useUsageMock.mockReturnValue({
      latest: {
        fiveHour: { utilization: 0.5, resetAt: Date.now() + 3_600_000 },
        sevenDay: { utilization: 0.2, resetAt: Date.now() + 90_000_000 },
      },
    })
    render(<AccountOverviewSection />)
    expect(screen.getByTestId("account-overview-avatar-img")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-name")).toHaveTextContent("Max")
    expect(screen.getByTestId("account-overview-email")).toHaveTextContent("max@example.com")
    expect(screen.getByText("they/them")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-status")).toHaveTextContent("shipping")
    // Plan label appears in both the identity badge and the subscription card.
    expect(screen.getAllByText("PRO").length).toBeGreaterThanOrEqual(2)
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
    expect(screen.getByLabelText("usageSevenDay")).toBeInTheDocument()
    // Signed in → no connect CTA.
    expect(screen.queryByTestId("account-overview-connect")).not.toBeInTheDocument()
  })

  it("copies the email to the clipboard and toasts on success", async () => {
    useCredentialMock.mockReturnValue({
      credential: { email: "max@example.com", plan: "pro" },
      loading: false,
    })
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-copy-email"))
    expect(writeClipboardTextMock).toHaveBeenCalledWith("max@example.com")
    expect(toastSuccessMock).toHaveBeenCalledWith("emailCopied")
  })

  it("toasts an error when the clipboard write fails", async () => {
    useCredentialMock.mockReturnValue({
      credential: { email: "max@example.com", plan: "pro" },
      loading: false,
    })
    writeClipboardTextMock.mockRejectedValue(new Error("denied"))
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-copy-email"))
    expect(toastErrorMock).toHaveBeenCalledWith("emailCopyFailed")
  })

  it("renders a usage row without a reset hint and skips the missing window", () => {
    useUsageMock.mockReturnValue({
      latest: { fiveHour: { utilization: 0.9 }, sevenDay: null },
    })
    render(<AccountOverviewSection />)
    // fiveHour renders (no resetAt → no reset hint); sevenDay (null) is skipped.
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
    expect(screen.queryByLabelText("usageSevenDay")).not.toBeInTheDocument()
  })

  it("ignores a reset time already in the past", () => {
    useUsageMock.mockReturnValue({
      latest: { fiveHour: { utilization: 0.4, resetAt: Date.now() - 1000 }, sevenDay: null },
    })
    render(<AccountOverviewSection />)
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
  })

  it("jumps to the subscription section", async () => {
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-manage-subscription"))
    expect(pushMock).toHaveBeenCalledWith("/settings?section=subscription")
  })

  it("shows a pair CTA when unpaired and routes to /pair", async () => {
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    expect(screen.getByText("deviceUnpaired")).toBeInTheDocument()
    await user.click(screen.getByTestId("account-overview-pair"))
    expect(pushMock).toHaveBeenCalledWith("/pair")
  })

  it("shows the device id and a manage button when paired", async () => {
    useCompanionConfigMock.mockReturnValue({ paired: true, shortDeviceId: "ABCDEFGH" })
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    expect(screen.getByText('devicePaired:{"id":"ABCDEFGH"}')).toBeInTheDocument()
    await user.click(screen.getByTestId("account-overview-manage-devices"))
    expect(pushMock).toHaveBeenCalledWith("/settings?section=companion")
  })

  it("hides the local accounts and security cards off Tauri", async () => {
    mockIsTauri = false
    render(<AccountOverviewSection />)
    // Give the post-hydration effect a tick; the cards must stay hidden.
    await Promise.resolve()
    expect(screen.queryByTestId("account-overview-manage-local")).not.toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-manage-security")).not.toBeInTheDocument()
  })

  it("shows the local accounts card on Tauri and opens the manage dialog", async () => {
    mockIsTauri = true
    mockAccounts = [
      { id: "acct_alpha", displayName: "Alpha" },
      { id: "acct_beta", displayName: "Beta" },
    ]
    mockActiveAccountId = "acct_alpha"
    const user = userEvent.setup()
    render(<AccountOverviewSection />)

    const manage = await screen.findByTestId("account-overview-manage-local")
    expect(screen.getByTestId("account-overview-local-summary")).toHaveTextContent(
      'localAccountsSummary:{"name":"Alpha","count":2}'
    )
    expect(screen.queryByTestId("stub-manage-dialog")).not.toBeInTheDocument()
    await user.click(manage)
    expect(screen.getByTestId("stub-manage-dialog")).toBeInTheDocument()
  })

  it("shows a lock-now action only when an account is unlocked", async () => {
    mockIsTauri = true
    mockAccounts = [{ id: "acct_alpha", displayName: "Alpha" }]
    mockActiveAccountId = "acct_alpha"
    mockUnlockedAccountId = "acct_alpha"
    const user = userEvent.setup()
    render(<AccountOverviewSection />)

    const lock = await screen.findByTestId("account-overview-lock-now")
    await user.click(lock)
    expect(lockMock).toHaveBeenCalledTimes(1)
    expect(toastSuccessMock).toHaveBeenCalledWith("lockedNow")
  })

  it("hides the lock-now action when no account is unlocked", async () => {
    mockIsTauri = true
    mockAccounts = [{ id: "acct_alpha", displayName: "Alpha" }]
    mockActiveAccountId = "acct_alpha"
    mockUnlockedAccountId = null
    render(<AccountOverviewSection />)
    await screen.findByTestId("account-overview-manage-local")
    expect(screen.queryByTestId("account-overview-lock-now")).not.toBeInTheDocument()
  })

  it("surfaces the auto-lock state and jumps to the security section", async () => {
    mockIsTauri = true
    mockAutoLockMinutes = 15
    const user = userEvent.setup()
    render(<AccountOverviewSection />)

    const manage = await screen.findByTestId("account-overview-manage-security")
    expect(screen.getByTestId("account-overview-security-summary")).toHaveTextContent(
      'securityAutoLockOn:{"minutes":15}'
    )
    await user.click(manage)
    expect(pushMock).toHaveBeenCalledWith("/settings?section=security")
  })

  it("shows the auto-lock-off summary when auto-lock is disabled", async () => {
    mockIsTauri = true
    mockAutoLockMinutes = 0
    render(<AccountOverviewSection />)
    await screen.findByTestId("account-overview-manage-security")
    expect(screen.getByTestId("account-overview-security-summary")).toHaveTextContent(
      "securityAutoLockOff"
    )
  })
})
