/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AccountSummary } from "@/types/subscription"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const setActiveMock = jest.fn(async () => undefined)
const renameMock = jest.fn(async () => undefined)
const removeMock = jest.fn(async () => undefined)
const state: { accounts: AccountSummary[]; activeAccountId: string | null; loading: boolean } = {
  accounts: [],
  activeAccountId: null,
  loading: false,
}
const presets = { supported: false }

jest.mock("@/lib/subscription/core/hooks", () => ({
  useAccounts: () => ({
    accounts: state.accounts,
    activeAccountId: state.activeAccountId,
    loading: state.loading,
    setActive: setActiveMock,
    rename: renameMock,
    remove: removeMock,
  }),
}))
jest.mock("./account-usage-chips", () => ({
  AccountUsageChips: () => null,
  // The chips query is hoisted to the list so it runs once instead of
  // once per row.
  useAccountUsageIndex: () => new Map(),
}))
jest.mock("./account-preset-selector", () => ({
  AccountPresetSelector: () => <div data-testid="preset-selector" />,
  providerSupportsPresets: () => presets.supported,
}))

import { AccountList } from "./account-list"

function summary(over: Partial<AccountSummary>): AccountSummary {
  return {
    id: "a1",
    provider: "opencode",
    variant: "opencode-zen",
    expiresAtMs: 0,
    createdAtMs: 0,
    lastUsedAtMs: 0,
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  state.accounts = []
  state.activeAccountId = null
  state.loading = false
  presets.supported = false
})

/** Render with a single account already staged, then open its actions menu. */
async function renderAndOpenMenu() {
  const user = userEvent.setup()
  render(<AccountList provider="opencode" />)
  await user.click(screen.getAllByRole("button").at(-1)!)
  return user
}

describe("AccountList", () => {
  it("shows the empty state when there are no accounts", () => {
    render(<AccountList provider="opencode" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("shows a loading indicator while accounts load", () => {
    state.loading = true
    render(<AccountList provider="opencode" />)
    expect(screen.queryByText("empty")).not.toBeInTheDocument()
  })

  it("marks the active account and switches on selecting another", async () => {
    state.accounts = [summary({ id: "a1", label: "One" }), summary({ id: "a2", label: "Two" })]
    state.activeAccountId = "a1"
    presets.supported = true
    const user = userEvent.setup()
    render(<AccountList provider="opencode" onAdd={jest.fn()} />)

    expect(screen.getByText("active")).toBeInTheDocument()
    expect(screen.getAllByTestId("preset-selector")).toHaveLength(2)

    const radios = screen.getAllByLabelText("setActive")
    expect(radios[0]).toBeDisabled() // the active account's radio
    await user.click(radios[1])
    expect(setActiveMock).toHaveBeenCalledWith("a2")
  })

  it("renames an account and clears the label back to default when blank", async () => {
    state.accounts = [summary({ id: "a1", label: "One" })]
    const user = await renderAndOpenMenu()
    await user.click(await screen.findByText("rename"))
    const input = await screen.findByDisplayValue("One")
    await user.clear(input)
    await user.click(screen.getByText("confirm"))
    await waitFor(() => expect(renameMock).toHaveBeenCalledWith("a1", null))
  })

  it("closes the rename dialog on cancel without renaming", async () => {
    state.accounts = [summary({ id: "a1", label: "One" })]
    const user = await renderAndOpenMenu()
    await user.click(await screen.findByText("rename"))
    await screen.findByDisplayValue("One")
    await user.click(screen.getByText("cancel"))
    await waitFor(() => expect(screen.queryByText("renameDialogTitle")).not.toBeInTheDocument())
    expect(renameMock).not.toHaveBeenCalled()
  })

  it("removes a non-discovered account after confirmation", async () => {
    state.accounts = [summary({ id: "z1", variant: "opencode-zen", label: "zen" })]
    const user = await renderAndOpenMenu()
    expect(await screen.findByText("remove")).toBeInTheDocument()
    expect(screen.queryByText("unlink")).not.toBeInTheDocument()
    await user.click(screen.getByText("remove"))
    expect(await screen.findByText("removeDialogTitle")).toBeInTheDocument()
    await user.click(screen.getByText("removeConfirm"))
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("z1"))
  })

  it("unlinks a discovered account and clarifies the external file is kept", async () => {
    state.accounts = [summary({ id: "disc", variant: "opencode-discovered", label: "openai" })]
    const user = await renderAndOpenMenu()
    expect(await screen.findByText("unlink")).toBeInTheDocument()
    await user.click(screen.getByText("unlink"))
    expect(await screen.findByText("unlinkDialogTitle")).toBeInTheDocument()
    expect(screen.getByText("unlinkDialogBody")).toBeInTheDocument()
    await user.click(screen.getByText("unlinkConfirm"))
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("disc"))
  })

  it("renames an account to a new label", async () => {
    state.accounts = [summary({ id: "a1", label: "One" })]
    const user = await renderAndOpenMenu()
    await user.click(await screen.findByText("rename"))
    const input = await screen.findByDisplayValue("One")
    await user.clear(input)
    await user.type(input, "Renamed")
    await user.click(screen.getByText("confirm"))
    await waitFor(() => expect(renameMock).toHaveBeenCalledWith("a1", "Renamed"))
  })

  it("falls back to the id when an account has no label or email", async () => {
    state.accounts = [summary({ id: "abcdef123456", label: undefined, email: undefined })]
    const user = await renderAndOpenMenu()
    expect(screen.getByText("abcdef12")).toBeInTheDocument() // id.slice(0, 8)
    // The rename input starts empty when there is no label (covers `?? ""`).
    await user.click(await screen.findByText("rename"))
    expect(screen.getByLabelText("renameLabel")).toHaveValue("")
  })

  it("dismisses the rename dialog on escape", async () => {
    state.accounts = [summary({ id: "a1", label: "One" })]
    const user = await renderAndOpenMenu()
    await user.click(await screen.findByText("rename"))
    await screen.findByText("renameDialogTitle")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText("renameDialogTitle")).not.toBeInTheDocument())
  })

  it("dismisses the remove dialog on escape", async () => {
    state.accounts = [summary({ id: "z1", label: "zen" })]
    const user = await renderAndOpenMenu()
    await user.click(await screen.findByText("remove"))
    await screen.findByText("removeDialogTitle")
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByText("removeDialogTitle")).not.toBeInTheDocument())
  })
})

// `expiresAtMs` always rode along in the cheap summary but nothing rendered it,
// so a user with several saved accounts had no read-out until they switched.
describe("AccountList credential expiry", () => {
  const HOUR = 3_600_000

  it("hides the line for logins that never expire (the documented 0 sentinel)", () => {
    state.accounts = [summary({ id: "z1", label: "zen", expiresAtMs: 0 })]
    render(<AccountList provider="opencode" />)
    expect(screen.queryByTestId("account-expiry")).not.toBeInTheDocument()
  })

  it("shows the expiry timestamp while the token is valid", () => {
    state.accounts = [summary({ id: "a1", label: "claude", expiresAtMs: Date.now() + 8 * HOUR })]
    render(<AccountList provider="anthropic" />)
    expect(screen.getByTestId("account-expiry")).toHaveAttribute("data-state", "valid")
  })

  // Deliberately not "expired"/"broken": an elapsed access token refreshes on
  // next use, and refresh failures are not persisted anywhere in the vault.
  it("marks an elapsed token stale rather than claiming the account is dead", () => {
    state.accounts = [summary({ id: "a1", label: "claude", expiresAtMs: Date.now() - HOUR })]
    render(<AccountList provider="anthropic" />)
    const line = screen.getByTestId("account-expiry")
    expect(line).toHaveAttribute("data-state", "stale")
    expect(line).toHaveTextContent("expiryStale")
  })

  it("renders one line per account", () => {
    state.accounts = [
      summary({ id: "a1", expiresAtMs: Date.now() + 8 * HOUR }),
      summary({ id: "a2", expiresAtMs: Date.now() - HOUR }),
      summary({ id: "a3", expiresAtMs: 0 }),
    ]
    render(<AccountList provider="anthropic" />)
    expect(screen.getAllByTestId("account-expiry")).toHaveLength(2)
  })
})
