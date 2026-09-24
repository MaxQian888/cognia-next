/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { AccountSummary, ProviderId } from "@/types/subscription"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
let accountCenterWidth = 900
jest.mock("@/hooks/use-element-width", () => ({
  useElementWidth: () => accountCenterWidth,
}))

const getAccountDetail = jest.fn()
jest.mock("@/lib/subscription/core/transport", () => ({
  getAccountDetail: (...args: unknown[]) => getAccountDetail(...args),
}))

function summary(
  provider: ProviderId,
  id: string,
  over: Partial<AccountSummary> = {}
): AccountSummary {
  return {
    id,
    provider,
    variant:
      provider === "anthropic" ? "anthropic" : provider === "codex" ? "codex" : "opencode-zen",
    expiresAtMs: 0,
    createdAtMs: 1,
    lastUsedAtMs: 2,
    authMode: provider === "codex" ? "chatgpt" : "api_key",
    credentialSource: provider === "codex" ? "oauth" : "managed",
    health: "ready",
    isExternal: false,
    ...over,
  }
}

const reloadSubscriptionAccounts = jest.fn()
const stateByProvider: Record<ProviderId, ReturnType<typeof accountState>> = {
  anthropic: accountState(),
  codex: accountState(),
  opencode: accountState(),
  commandcode: accountState(),
}

function accountState() {
  return {
    accounts: [] as AccountSummary[],
    activeAccountId: null as string | null,
    loading: false,
    error: null as string | null,
    pendingAction: null,
    pendingAccountId: null,
    reload: jest.fn(async () => undefined),
    setActive: jest.fn(async () => undefined),
    rename: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  }
}

jest.mock("@/lib/subscription/core/hooks", () => ({
  useAccounts: (provider: ProviderId) => stateByProvider[provider],
  useSubscriptionAccounts: () => ({
    providers: Object.keys(stateByProvider).map((id) => ({
      id,
      name: id === "commandcode" ? "CommandCode" : id,
      authMode: "api-key",
      source: "builtin",
    })),
    byProvider: stateByProvider,
    loading: false,
    error: null,
    reload: reloadSubscriptionAccounts,
  }),
}))
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  setProviderDefaultAccount: jest.fn(async () => undefined),
  inspectProviderAccountReferences: jest.fn(async () => ({
    sessions: [],
    characters: [],
    isDefault: false,
    isActive: false,
  })),
}))
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (value: { settings: unknown }) => unknown) =>
    selector({ settings: { defaultAccountIds: { codex: "codex-1" } } }),
}))
jest.mock("./account-usage-chips", () => ({
  useAccountUsageIndex: () => new Map(),
  AccountUsageChips: () => null,
}))
jest.mock("./account-preset-selector", () => ({
  AccountPresetSelector: () => <div data-testid="account-preset-selector" />,
}))
jest.mock("./add-account-dialog/anthropic", () => ({ AnthropicAddAccountDialog: () => null }))
jest.mock("./add-account-dialog/codex", () => ({ CodexAddAccountDialog: () => null }))
jest.mock("./add-account-dialog/opencode", () => ({ OpencodeAddAccountDialog: () => null }))

jest.mock("./add-account-dialog/subscription", () => ({
  SubscriptionAccountDialog: ({ providerId }: { providerId?: string }) => (
    <div data-testid={`${providerId ?? "custom"}-dialog`} />
  ),
}))

import { AccountCenter } from "./account-center"

beforeEach(() => {
  jest.clearAllMocks()
  accountCenterWidth = 900
  stateByProvider.anthropic.accounts = [summary("anthropic", "claude-1", { label: "Claude Pro" })]
  stateByProvider.anthropic.activeAccountId = "claude-1"
  stateByProvider.codex.accounts = [summary("codex", "codex-1", { label: "ChatGPT Plus" })]
  stateByProvider.codex.activeAccountId = null
  stateByProvider.opencode.accounts = [
    summary("opencode", "external-1", {
      label: "OpenCode external",
      variant: "opencode-discovered",
      authMode: "external",
      credentialSource: "file",
      health: "source_unavailable",
      isExternal: true,
    }),
  ]
  stateByProvider.opencode.activeAccountId = null
  stateByProvider.commandcode.accounts = []
  stateByProvider.commandcode.activeAccountId = null
  getAccountDetail.mockResolvedValue(null)
})

describe("AccountCenter", () => {
  it("renders all providers and explains active versus default", async () => {
    render(<AccountCenter />)
    expect(screen.getAllByText("Claude Pro").length).toBeGreaterThan(0)
    expect(screen.getAllByText("ChatGPT Plus").length).toBeGreaterThan(0)
    expect(screen.getAllByText("OpenCode external").length).toBeGreaterThan(0)
    expect(screen.getAllByText("badges.active").length).toBeGreaterThan(0)
    expect(screen.getAllByText("badges.default").length).toBeGreaterThan(0)
    expect(screen.getByText("activeHelp")).toBeInTheDocument()
    expect(screen.getByText("defaultHelp")).toBeInTheDocument()
    await waitFor(() => expect(getAccountDetail).toHaveBeenCalledWith("anthropic", "claude-1"))
  })

  it("filters by provider without dropping the selected detail contract", async () => {
    render(<AccountCenter />)
    fireEvent.click(screen.getByTestId("account-filter-codex"))
    expect(screen.getAllByText("ChatGPT Plus").length).toBeGreaterThan(0)
    expect(screen.queryByText("Claude Pro")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-center-detail")).toBeInTheDocument()
    await waitFor(() => expect(getAccountDetail).toHaveBeenCalledWith("codex", "codex-1"))
  })

  it("does not expose mutation actions for an external OpenCode pointer", async () => {
    const user = userEvent.setup()
    render(<AccountCenter />)
    await user.click(screen.getByTestId("account-center-row-opencode-external-1"))
    const more = screen.getAllByLabelText("actions.more").at(-1)!
    await user.click(more)
    expect(await screen.findByText("actions.removeLocal")).toBeInTheDocument()
    expect(screen.queryByText("actions.activate")).not.toBeInTheDocument()
    expect(screen.queryByText("actions.update")).not.toBeInTheDocument()
    await waitFor(() => expect(getAccountDetail).toHaveBeenCalledWith("opencode", "external-1"))
  })

  it("offers preset binding for managed OpenCode accounts but not discovery pointers", async () => {
    const user = userEvent.setup()
    stateByProvider.opencode.accounts.push(summary("opencode", "managed-1", { plan: "go" }))
    render(<AccountCenter />)
    await user.click(screen.getByTestId("account-center-row-opencode-managed-1"))
    expect(screen.getByTestId("account-preset-selector")).toBeInTheDocument()
    await user.click(screen.getByTestId("account-center-row-opencode-external-1"))
    expect(screen.queryByTestId("account-preset-selector")).not.toBeInTheDocument()
  })

  it("ships container-query list/detail classes for narrow and wide panes", async () => {
    render(<AccountCenter />)
    const center = screen.getByTestId("account-center")
    expect(center).toHaveClass("@container/account-center")
    expect(center.querySelector('[class*="@[680px]/account-center:grid-cols"]')).not.toBeNull()
    await waitFor(() => expect(getAccountDetail).toHaveBeenCalledWith("anthropic", "claude-1"))
  })

  it.each([320, 520, 650])("opens account detail in a Sheet at %dpx", async (width) => {
    accountCenterWidth = width
    const user = userEvent.setup()
    render(<AccountCenter />)

    await user.click(screen.getByTestId("account-center-row-codex-codex-1"))
    expect(await screen.findByRole("dialog")).toBeInTheDocument()
    expect(screen.getAllByText("ChatGPT Plus").length).toBeGreaterThan(1)
  })

  it("keeps detail inline once the Account Center has 680px", async () => {
    accountCenterWidth = 680
    const user = userEvent.setup()
    render(<AccountCenter />)

    await user.click(screen.getByTestId("account-center-row-codex-codex-1"))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByTestId("account-center-detail")).toBeInTheDocument()
  })
})

it("offers CommandCode in the unified add menu and opens its shared dialog", async () => {
  render(<AccountCenter />)
  await userEvent.click(screen.getByRole("button", { name: "add" }))
  await userEvent.click(screen.getByRole("menuitem", { name: "CommandCode" }))
  expect(screen.getByTestId("commandcode-dialog")).toBeInTheDocument()
})

it("loads CommandCode accounts and supports their preset and activation controls", async () => {
  stateByProvider.commandcode.accounts = [
    summary("commandcode", "cc-1", { variant: "commandcode", label: "CommandCode work" }),
  ]
  render(<AccountCenter />)
  await userEvent.click(screen.getByTestId("account-filter-commandcode"))
  await waitFor(() => expect(getAccountDetail).toHaveBeenCalledWith("commandcode", "cc-1"))
  expect(screen.getByTestId("account-preset-selector")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "actions.activate" }))
  expect(stateByProvider.commandcode.setActive).toHaveBeenCalledWith("cc-1")
})

it("offers custom subscription creation without adding a provider-specific dialog", async () => {
  render(<AccountCenter />)
  await userEvent.click(screen.getByRole("button", { name: "add" }))
  await userEvent.click(screen.getByRole("menuitem", { name: "customSubscription" }))
  expect(screen.getByTestId("custom-dialog")).toBeInTheDocument()
})

it("renders registry-provided accounts without a hardcoded provider hook", async () => {
  stateByProvider["custom-service"] = accountState()
  stateByProvider["custom-service"].accounts = [
    summary("custom-service", "dynamic-account", { variant: "api-key", label: "Dynamic account" }),
  ]
  render(<AccountCenter />)
  await userEvent.click(screen.getByTestId("account-filter-custom-service"))
  expect(
    screen.getByTestId("account-center-row-custom-service-dynamic-account")
  ).toBeInTheDocument()
  delete stateByProvider["custom-service"]
})

it("surfaces a provider load failure while retaining the other accounts", async () => {
  stateByProvider.codex.error = "keyring locked"
  render(<AccountCenter />)
  expect(screen.getByRole("alert")).toHaveTextContent("keyring locked")
  expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "retry" }))
  expect(reloadSubscriptionAccounts).toHaveBeenCalledWith({ allowInteraction: true })
  expect(screen.getByTestId("account-center-row-anthropic-claude-1")).toBeInTheDocument()
  stateByProvider.codex.error = null
})
