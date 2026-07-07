/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
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

jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (s: MockState) => unknown) => selector(mockState),
  selectActiveAccount: (s: MockState) => s.accounts.find((a) => a.id === s.activeAccountId) ?? null,
}))

jest.mock("./account-manage-dialog", () => ({
  AccountManageDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="manage-dialog" /> : null,
}))

// Inline the popover so its content is always queryable.
jest.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import { AccountBarButton } from "./account-bar-button"

function acc(id: string, displayName: string): LocalAccountRecord {
  return { id, displayName } as LocalAccountRecord
}

beforeEach(() => {
  mockState = { accounts: [], lock: jest.fn(), activeAccountId: null }
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

  it("locks the account on Lock click", () => {
    mockState = { accounts: [acc("a1", "Ada")], lock: jest.fn(), activeAccountId: "a1" }
    render(<AccountBarButton />)
    fireEvent.click(screen.getByTestId("account-bar-lock"))
    expect(mockState.lock).toHaveBeenCalled()
  })

  it("opens the manage dialog on Manage click", () => {
    mockState = { accounts: [acc("a1", "Ada")], lock: jest.fn(), activeAccountId: "a1" }
    render(<AccountBarButton />)
    expect(screen.queryByTestId("manage-dialog")).toBeNull()
    fireEvent.click(screen.getByTestId("account-bar-manage"))
    expect(screen.getByTestId("manage-dialog")).toBeInTheDocument()
  })

  it("falls back to the user icon when no account is active", () => {
    mockState = { accounts: [acc("a1", "Ada")], lock: jest.fn(), activeAccountId: null }
    render(<AccountBarButton />)
    // No initial rendered → the fallback icon path.
    expect(screen.getByTestId("account-bar-button")).not.toHaveTextContent("A")
  })
})
