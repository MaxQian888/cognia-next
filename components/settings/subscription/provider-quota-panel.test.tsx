/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauriMock() }))

const useAccountsMock = jest.fn()
jest.mock("@/lib/subscription/core/hooks", () => ({
  useAccounts: (provider: string) => useAccountsMock(provider),
}))

const refreshMock = jest.fn()
const setQueryEnabledMock = jest.fn(async () => {})
let limitsResult: { snapshot: unknown; refreshing: boolean; queryEnabled?: boolean } = {
  snapshot: null,
  refreshing: false,
}
jest.mock("@/lib/subscription/limits/hooks", () => ({
  useProviderLimits: () => ({
    ...limitsResult,
    unavailable: false,
    queryEnabled: limitsResult.queryEnabled ?? true,
    setQueryEnabled: setQueryEnabledMock,
    refresh: refreshMock,
  }),
}))

jest.mock("@/components/settings/subscription/balance-card", () => ({
  BalanceCard: ({ provider, accountId, label, queryEnabled }: Record<string, unknown>) => (
    <div data-testid={`balance-${provider}-${accountId}`} data-query-enabled={String(queryEnabled)}>
      {String(label)}
    </div>
  ),
}))

jest.mock("@/components/settings/subscription/limits-meters-card", () => ({
  LimitsMetersCard: ({ provider, accountId, label }: Record<string, string>) => (
    <div data-testid={`limits-${provider}-${accountId}`}>{label}</div>
  ),
}))

import { ProviderQuotaPanel } from "./provider-quota-panel"

const NOW = Date.now()

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  limitsResult = { snapshot: null, refreshing: false }
  useAccountsMock.mockReturnValue({
    accounts: [{ id: "acc-1", label: "Work", provider: "codex" }],
    activeAccountId: "acc-1",
  })
})

describe("ProviderQuotaPanel", () => {
  it("renders the windows + balance cards for the active account", () => {
    render(<ProviderQuotaPanel provider="codex" now={NOW} />)
    expect(screen.getByTestId("limits-codex-acc-1")).toHaveTextContent("Work")
    expect(screen.getByTestId("balance-codex-acc-1")).toHaveTextContent("Work")
  })

  it("renders nothing when the provider has no active account", () => {
    useAccountsMock.mockReturnValue({ accounts: [], activeAccountId: null })
    const { container } = render(<ProviderQuotaPanel provider="opencode" now={NOW} />)
    expect(container).toBeEmptyDOMElement()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("auto-fetches once when no fresh snapshot exists", async () => {
    render(<ProviderQuotaPanel provider="codex" now={NOW} />)
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1))
  })

  it("does not auto-fetch Anthropic quota before explicit opt-in", async () => {
    limitsResult = { snapshot: null, refreshing: false, queryEnabled: false }
    render(<ProviderQuotaPanel provider="anthropic" now={NOW} />)
    await waitFor(() => expect(screen.getByTestId("balance-anthropic-acc-1")).toBeInTheDocument())
    expect(screen.getByTestId("balance-anthropic-acc-1")).toHaveAttribute(
      "data-query-enabled",
      "false"
    )
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("lets the user opt the active account into quota queries", async () => {
    limitsResult = { snapshot: null, refreshing: false, queryEnabled: false }
    render(<ProviderQuotaPanel provider="codex" now={NOW} />)

    await userEvent.click(screen.getByRole("button", { name: "Enable quota queries" }))

    expect(setQueryEnabledMock).toHaveBeenCalledWith(true)
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("skips the auto-fetch when the stored snapshot is fresh", async () => {
    limitsResult = {
      snapshot: { provider: "codex", accountId: "acc-1", fetchedAt: NOW - 1000, meters: [] },
      refreshing: false,
    }
    render(<ProviderQuotaPanel provider="codex" now={NOW} />)
    await waitFor(() => expect(screen.getByTestId("limits-codex-acc-1")).toBeInTheDocument())
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("does not auto-fetch outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    render(<ProviderQuotaPanel provider="codex" now={NOW} />)
    await waitFor(() => expect(screen.getByTestId("limits-codex-acc-1")).toBeInTheDocument())
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("falls back to an email label then the account id", () => {
    useAccountsMock.mockReturnValue({
      accounts: [{ id: "acc-2", email: "me@example.com", provider: "codex" }],
      activeAccountId: "acc-2",
    })
    render(<ProviderQuotaPanel provider="codex" now={NOW} />)
    expect(screen.getByTestId("limits-codex-acc-2")).toHaveTextContent("me@example.com")
  })

  it("ticks its own clock when no now prop is given", () => {
    render(<ProviderQuotaPanel provider="codex" />)
    expect(screen.getByTestId("limits-codex-acc-1")).toBeInTheDocument()
  })
})
