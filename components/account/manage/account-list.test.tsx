/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

jest.mock("./account-create-form", () => ({
  AccountCreateForm: () => <div data-testid="create-form" />,
}))

import { AccountList } from "./account-list"

function account(id: string, displayName: string): LocalAccountRecord {
  return {
    id,
    displayName,
    passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
    createdAt: Date.UTC(2024, 0, 1, 12),
    updatedAt: Date.UTC(2024, 0, 1, 12),
  }
}

const accounts = [account("acct_alpha", "Alpha"), account("acct_beta", "Beta")]

function renderList(props: Partial<React.ComponentProps<typeof AccountList>> = {}) {
  return render(
    <AccountList
      accounts={accounts}
      activeAccountId="acct_alpha"
      unlockedAccountId="acct_alpha"
      selectedId="acct_alpha"
      onSelect={props.onSelect ?? jest.fn()}
      {...props}
    />
  )
}

describe("AccountList", () => {
  it("renders a row per account with status pills", () => {
    renderList()
    expect(screen.getByTestId("account-manage-row-acct_alpha")).toBeInTheDocument()
    expect(screen.getByTestId("account-manage-row-acct_beta")).toBeInTheDocument()
    // Alpha is active, Beta is locked.
    expect(screen.getByText("statusActive")).toBeInTheDocument()
    expect(screen.getByText("statusLocked")).toBeInTheDocument()
  })

  it("selects a row on click", () => {
    const onSelect = jest.fn()
    renderList({ onSelect })
    fireEvent.click(screen.getByTestId("account-manage-row-acct_beta"))
    expect(onSelect).toHaveBeenCalledWith("acct_beta")
  })

  it("filters the list by search query", () => {
    renderList()
    fireEvent.change(screen.getByTestId("account-list-search"), { target: { value: "beta" } })
    expect(screen.queryByTestId("account-manage-row-acct_alpha")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-manage-row-acct_beta")).toBeInTheDocument()
  })

  it("shows a no-match state when the search misses", () => {
    renderList()
    fireEvent.change(screen.getByTestId("account-list-search"), { target: { value: "zzz" } })
    expect(screen.getByTestId("account-list-no-match")).toBeInTheDocument()
  })

  it("shows an empty state when there are no accounts", () => {
    renderList({ accounts: [], activeAccountId: null, unlockedAccountId: null, selectedId: null })
    expect(screen.getByTestId("account-list-empty")).toBeInTheDocument()
  })

  it("renders a list-level error banner", () => {
    renderList({ error: "boom" })
    expect(screen.getByText("boom")).toBeInTheDocument()
  })

  it("marks an unlocked-but-inactive account", () => {
    renderList({ activeAccountId: "acct_alpha", unlockedAccountId: "acct_beta" })
    expect(screen.getByText("statusUnlocked")).toBeInTheDocument()
  })
})
