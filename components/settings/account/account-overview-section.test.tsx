/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  // Ignores the namespace arg, so both useTranslations("settings.account") and
  // useTranslations("subscription") echo their keys.
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

const useCredentialMock = jest.fn()
const useUsageMock = jest.fn()
const refreshMock = jest.fn()
const signOutMock = jest.fn()
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => useCredentialMock(),
  useAnthropicUsage: () => useUsageMock(),
}))

const useCompanionConfigMock = jest.fn()
jest.mock("@/hooks/companion/use-companion-config", () => ({
  useCompanionConfig: () => useCompanionConfigMock(),
}))

jest.mock("../profile/profile-section", () => ({
  ProfileSection: ({ showEmail }: { showEmail?: boolean }) => (
    <div data-testid="stub-profile-section" data-show-email={String(showEmail)} />
  ),
}))

let mockIsTauri = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

// Capture the quick-switch onValueChange so tests can drive it without the
// Radix Select pointer machinery (awkward in jsdom).
let mockSwitchOnValueChange: ((v: string) => void | Promise<void>) | null = null
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange: (v: string) => void
    children: React.ReactNode
  }) => {
    mockSwitchOnValueChange = onValueChange
    return (
      <div data-testid="account-switch-select" data-value={value ?? ""}>
        {children}
      </div>
    )
  },
  SelectTrigger: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div {...rest}>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <div data-testid={`account-switch-item-${value}`} data-value={value}>
      {children}
    </div>
  ),
}))

interface MockAccount {
  id: string
  displayName: string
}
let mockAccounts: MockAccount[] = []
let mockActiveAccountId: string | null = null
let mockUnlockedAccountId: string | null = null
const lockMock = jest.fn()
const switchAccountMock = jest.fn()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: unknown) => unknown) =>
    selector({
      accounts: mockAccounts,
      activeAccountId: mockActiveAccountId,
      unlockedAccountId: mockUnlockedAccountId,
      lock: lockMock,
      switchAccount: switchAccountMock,
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

const SIGNED_IN = {
  credential: {
    email: "max@example.com",
    plan: "pro",
    expiresAtMs: Date.UTC(2027, 0, 1, 0, 0, 0),
  },
  loading: false,
  refresh: refreshMock,
  signOut: signOutMock,
}

beforeEach(() => {
  pushMock.mockReset()
  toastSuccessMock.mockReset()
  toastErrorMock.mockReset()
  writeClipboardTextMock.mockReset()
  writeClipboardTextMock.mockResolvedValue(undefined)
  lockMock.mockReset()
  switchAccountMock.mockReset()
  switchAccountMock.mockResolvedValue(undefined)
  refreshMock.mockReset()
  refreshMock.mockResolvedValue(undefined)
  signOutMock.mockReset()
  signOutMock.mockResolvedValue(undefined)
  mockSwitchOnValueChange = null
  mockIsTauri = false
  mockAccounts = []
  mockActiveAccountId = null
  mockUnlockedAccountId = null
  mockAutoLockMinutes = 0
  useCredentialMock.mockReturnValue({
    credential: null,
    loading: false,
    refresh: refreshMock,
    signOut: signOutMock,
  })
  useUsageMock.mockReturnValue({ latest: null })
  useCompanionConfigMock.mockReturnValue({ paired: false, shortDeviceId: null })
})

describe("AccountOverviewSection", () => {
  it("embeds the profile editor with the email line suppressed", () => {
    render(<AccountOverviewSection />)
    expect(screen.getByTestId("account-overview-section")).toBeInTheDocument()
    const stub = screen.getByTestId("stub-profile-section")
    expect(stub).toBeInTheDocument()
    expect(stub).toHaveAttribute("data-show-email", "false")
  })

  it("renders signed-out state with a connect CTA and no session actions", () => {
    render(<AccountOverviewSection />)
    expect(screen.getByText("notSignedIn")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-connect")).toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-copy-email")).not.toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-signout")).not.toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-refresh")).not.toBeInTheDocument()
    expect(screen.queryByTestId("account-overview-expiry")).not.toBeInTheDocument()
    expect(screen.queryByLabelText("usageFiveHour")).not.toBeInTheDocument()
  })

  it("routes the connect CTA to the subscription section", async () => {
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-connect"))
    expect(pushMock).toHaveBeenCalledWith("/settings?section=subscription")
  })

  it("renders the plan, email, expiry, session actions and usage when signed in", () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
    useUsageMock.mockReturnValue({
      latest: {
        fiveHour: { utilization: 0.5, resetAt: Date.now() + 3_600_000 },
        sevenDay: { utilization: 0.2, resetAt: Date.now() + 90_000_000 },
      },
    })
    render(<AccountOverviewSection />)
    expect(screen.getByTestId("account-overview-plan")).toHaveTextContent("PRO")
    expect(screen.getByTestId("account-overview-email")).toHaveTextContent("max@example.com")
    expect(screen.getByTestId("account-overview-expiry")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-signout")).toBeInTheDocument()
    expect(screen.getByTestId("account-overview-refresh")).toBeInTheDocument()
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
    expect(screen.getByLabelText("usageSevenDay")).toBeInTheDocument()
    // PRO shows in the plan badge and the subscription jump-off card.
    expect(screen.getAllByText("PRO").length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByTestId("account-overview-connect")).not.toBeInTheDocument()
  })

  it("signs out and toasts on success", async () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-signout"))
    expect(signOutMock).toHaveBeenCalledTimes(1)
    expect(toastSuccessMock).toHaveBeenCalledWith("signedOut")
  })

  it("refreshes the session and toasts on success", async () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-refresh"))
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(toastSuccessMock).toHaveBeenCalledWith("sessionRefreshed")
  })

  it("toasts an error when signing out fails", async () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
    signOutMock.mockRejectedValue(new Error("boom"))
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-signout"))
    expect(toastErrorMock).toHaveBeenCalledWith("sessionActionFailed")
  })

  it("copies the email to the clipboard and toasts on success", async () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-copy-email"))
    expect(writeClipboardTextMock).toHaveBeenCalledWith("max@example.com")
    expect(toastSuccessMock).toHaveBeenCalledWith("emailCopied")
  })

  it("toasts an error when the clipboard write fails", async () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
    writeClipboardTextMock.mockRejectedValue(new Error("denied"))
    const user = userEvent.setup()
    render(<AccountOverviewSection />)
    await user.click(screen.getByTestId("account-overview-copy-email"))
    expect(toastErrorMock).toHaveBeenCalledWith("emailCopyFailed")
  })

  it("renders a usage row without a reset hint and skips the missing window", () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
    useUsageMock.mockReturnValue({
      latest: { fiveHour: { utilization: 0.9 }, sevenDay: null },
    })
    render(<AccountOverviewSection />)
    expect(screen.getByLabelText("usageFiveHour")).toBeInTheDocument()
    expect(screen.queryByLabelText("usageSevenDay")).not.toBeInTheDocument()
  })

  it("ignores a reset time already in the past", () => {
    useCredentialMock.mockReturnValue(SIGNED_IN)
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

  it("switches to another local account through the quick-switch dropdown", async () => {
    mockIsTauri = true
    mockAccounts = [
      { id: "acct_alpha", displayName: "Alpha" },
      { id: "acct_beta", displayName: "Beta" },
    ]
    mockActiveAccountId = "acct_alpha"
    render(<AccountOverviewSection />)

    await screen.findByTestId("account-overview-switch")
    await act(async () => {
      await mockSwitchOnValueChange?.("acct_beta")
    })
    expect(switchAccountMock).toHaveBeenCalledWith("acct_beta")
    expect(screen.queryByTestId("stub-manage-dialog")).not.toBeInTheDocument()
  })

  it("opens the manage dialog when switching to a locked account", async () => {
    mockIsTauri = true
    mockAccounts = [
      { id: "acct_alpha", displayName: "Alpha" },
      { id: "acct_beta", displayName: "Beta" },
    ]
    mockActiveAccountId = "acct_alpha"
    switchAccountMock.mockRejectedValue(new Error("locked"))
    render(<AccountOverviewSection />)

    await screen.findByTestId("account-overview-switch")
    await act(async () => {
      await mockSwitchOnValueChange?.("acct_beta")
    })
    expect(toastErrorMock).toHaveBeenCalledWith("switchAccountRequiresUnlock")
    expect(screen.getByTestId("stub-manage-dialog")).toBeInTheDocument()
  })

  it("hides the quick-switch dropdown with a single local account", async () => {
    mockIsTauri = true
    mockAccounts = [{ id: "acct_alpha", displayName: "Alpha" }]
    mockActiveAccountId = "acct_alpha"
    render(<AccountOverviewSection />)
    await screen.findByTestId("account-overview-manage-local")
    expect(screen.queryByTestId("account-overview-switch")).not.toBeInTheDocument()
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
