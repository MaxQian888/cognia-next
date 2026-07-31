/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"
import type { AccountListProps } from "./manage/account-list"
import type { AccountDetailProps } from "./manage/account-detail"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockState: {
  accounts: LocalAccountRecord[]
  activeAccountId: string | null
  unlockedAccountId: string | null
  error: string | null
}
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}))

const created: LocalAccountRecord = {
  id: "acct_new",
  displayName: "New",
  passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
  createdAt: 1,
  updatedAt: 1,
}

jest.mock("./manage/account-list", () => ({
  AccountList: (props: AccountListProps) => (
    <div data-testid="stub-list">
      <button data-testid="stub-select-beta" onClick={() => props.onSelect("acct_beta")}>
        select
      </button>
      <button data-testid="stub-create" onClick={() => props.onCreated?.(created)}>
        create
      </button>
      <span data-testid="stub-list-selected">{props.selectedId ?? "none"}</span>
      <span data-testid="stub-list-error">{props.error ?? "no-error"}</span>
    </div>
  ),
}))
jest.mock("./manage/account-detail", () => ({
  AccountDetail: (props: AccountDetailProps) => (
    <div data-testid="stub-detail">
      <span data-testid="stub-detail-account">{props.account?.id ?? "none"}</span>
      <button data-testid="stub-back" onClick={props.onBack}>
        back
      </button>
    </div>
  ),
}))

import { AccountManageDialog } from "./account-manage-dialog"

function account(id: string, displayName: string): LocalAccountRecord {
  return {
    id,
    displayName,
    passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
    createdAt: 1,
    updatedAt: 1,
  }
}

function setState(overrides: Partial<typeof mockState> = {}) {
  mockState = {
    accounts: [
      account("acct_alpha", "Alpha"),
      account("acct_beta", "Beta"),
      account("acct_new", "New"),
    ],
    activeAccountId: "acct_alpha",
    unlockedAccountId: "acct_alpha",
    error: null,
    ...overrides,
  }
}

beforeEach(() => setState())

const listCol = () => screen.getByTestId("account-manage-list-col")
const detailCol = () => screen.getByTestId("account-manage-detail-col")

function renderDialog() {
  return render(<AccountManageDialog open onOpenChange={jest.fn()} />)
}

describe("AccountManageDialog", () => {
  it("renders both columns and defaults to the first sorted account", () => {
    renderDialog()
    expect(screen.getByTestId("stub-list")).toBeInTheDocument()
    expect(screen.getByTestId("stub-detail-account")).toHaveTextContent("acct_alpha")
  })

  it("passes the store error into the list", () => {
    setState({ error: "boom" })
    renderDialog()
    expect(screen.getByTestId("stub-list-error")).toHaveTextContent("boom")
  })

  it("selecting an account swaps to the detail pane on narrow layouts", () => {
    renderDialog()
    expect(detailCol().className).toMatch(/hidden/)
    expect(listCol().className).not.toMatch(/hidden/)

    fireEvent.click(screen.getByTestId("stub-select-beta"))
    expect(screen.getByTestId("stub-detail-account")).toHaveTextContent("acct_beta")
    expect(listCol().className).toMatch(/hidden/)
    expect(detailCol().className).not.toMatch(/hidden/)
  })

  it("selects the newly created account", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("stub-create"))
    expect(screen.getByTestId("stub-detail-account")).toHaveTextContent("acct_new")
  })

  it("back returns to the list on narrow layouts", () => {
    renderDialog()
    fireEvent.click(screen.getByTestId("stub-select-beta"))
    fireEvent.click(screen.getByTestId("stub-back"))
    expect(listCol().className).not.toMatch(/hidden/)
    expect(detailCol().className).toMatch(/hidden/)
  })

  it("falls back to an empty detail when there are no accounts", () => {
    setState({ accounts: [], activeAccountId: null, unlockedAccountId: null })
    renderDialog()
    expect(screen.getByTestId("stub-detail-account")).toHaveTextContent("none")
  })
})
