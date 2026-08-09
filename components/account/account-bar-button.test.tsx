/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

interface MockState {
  accounts: LocalAccountRecord[]
  lock: jest.Mock
  activeAccountId: string | null
}
let mockState: MockState

const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastErrorMock(...args) } }))

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: MockState) => unknown) => selector(mockState),
  selectActiveAccount: (s: MockState) => s.accounts.find((a) => a.id === s.activeAccountId) ?? null,
}))

jest.mock("./account-manage-dialog", () => ({
  AccountManageDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="manage-dialog" /> : null,
}))
jest.mock("./runtime-target-menu-section", () => ({
  RuntimeTargetMenuSection: ({ onSwitched }: { onSwitched: () => void }) => (
    <button type="button" data-testid="runtime-target-switch" onClick={onSwitched}>
      switch
    </button>
  ),
}))
jest.mock("@/components/ui/separator", () => ({ Separator: () => <hr /> }))

// Inline the popover so its content is always queryable.
jest.mock("@/components/ui/popover", () => {
  const React = jest.requireActual<typeof import("react")>("react")
  const Context = React.createContext({ open: false, onOpenChange: (_open: boolean) => {} })
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode
      open: boolean
      onOpenChange: (open: boolean) => void
    }) => (
      <Context.Provider value={{ open, onOpenChange }}>
        <div data-testid="account-popover" data-open={String(open)}>
          {children}
        </div>
      </Context.Provider>
    ),
    PopoverTrigger: ({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) => {
      const { open, onOpenChange } = React.useContext(Context)
      return React.cloneElement(children, { onClick: () => onOpenChange(!open) })
    },
    PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  }
})

import { AccountBarButton } from "./account-bar-button"

function acc(id: string, displayName: string): LocalAccountRecord {
  return { id, displayName } as LocalAccountRecord
}

beforeEach(() => {
  mockState = { accounts: [], lock: jest.fn().mockResolvedValue(undefined), activeAccountId: null }
  toastErrorMock.mockReset()
})

describe("AccountBarButton", () => {
  it("renders nothing when there are no accounts", () => {
    const { container } = render(<AccountBarButton />)
    expect(container.firstChild).toBeNull()
  })

  it("shows the active account's initial", () => {
    mockState = { accounts: [acc("a1", "Ada")], lock: jest.fn(), activeAccountId: "a1" }
    render(<AccountBarButton />)
    expect(screen.getByTestId("account-bar-button")).toHaveTextContent("A")
  })

  it("locks the account and closes the popover after runtime clearing succeeds", async () => {
    mockState = {
      accounts: [acc("a1", "Ada")],
      lock: jest.fn().mockResolvedValue(undefined),
      activeAccountId: "a1",
    }
    render(<AccountBarButton />)
    fireEvent.click(screen.getByTestId("account-bar-button"))
    fireEvent.click(screen.getByTestId("account-bar-lock"))
    expect(mockState.lock).toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId("account-popover")).toHaveAttribute("data-open", "false")
    )
  })

  it("keeps the popover open and reports a runtime-clear failure", async () => {
    mockState = {
      accounts: [acc("a1", "Ada")],
      lock: jest.fn().mockRejectedValue(new Error("runtime busy")),
      activeAccountId: "a1",
    }
    render(<AccountBarButton />)
    fireEvent.click(screen.getByTestId("account-bar-button"))
    fireEvent.click(screen.getByTestId("account-bar-lock"))

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("runtime busy"))
    expect(screen.getByTestId("account-popover")).toHaveAttribute("data-open", "true")
  })

  it("opens the manage dialog on Manage click", () => {
    mockState = {
      accounts: [acc("a1", "Ada")],
      lock: jest.fn().mockResolvedValue(undefined),
      activeAccountId: "a1",
    }
    render(<AccountBarButton />)
    expect(screen.queryByTestId("manage-dialog")).toBeNull()
    fireEvent.click(screen.getByTestId("account-bar-manage"))
    expect(screen.getByTestId("manage-dialog")).toBeInTheDocument()
  })

  it("closes the account popover after switching runtime targets", () => {
    mockState = {
      accounts: [acc("a1", "Ada")],
      lock: jest.fn().mockResolvedValue(undefined),
      activeAccountId: "a1",
    }
    render(<AccountBarButton />)
    fireEvent.click(screen.getByTestId("account-bar-button"))
    expect(screen.getByTestId("account-popover")).toHaveAttribute("data-open", "true")
    fireEvent.click(screen.getByTestId("runtime-target-switch"))
    expect(screen.getByTestId("account-popover")).toHaveAttribute("data-open", "false")
  })

  it("falls back to the user icon when no account is active", () => {
    mockState = { accounts: [acc("a1", "Ada")], lock: jest.fn(), activeAccountId: null }
    render(<AccountBarButton />)
    // No initial rendered → the fallback icon path.
    expect(screen.getByTestId("account-bar-button")).not.toHaveTextContent("A")
  })
})
