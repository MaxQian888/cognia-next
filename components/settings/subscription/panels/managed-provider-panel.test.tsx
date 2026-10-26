/** @jest-environment jsdom */
import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { SubscriptionProviderDefinition } from "@/lib/subscription/core/provider-registry"
import { useAccounts } from "@/lib/subscription/core/hooks"
import { isTauri } from "@/lib/tauri"
import { ManagedProviderPanel } from "./managed-provider-panel"

jest.mock("@/lib/subscription/core/hooks", () => ({ useAccounts: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("../preset-picker", () => ({ PresetPicker: () => <span>presets</span> }))
jest.mock("../provider-quota-panel", () => ({
  ProviderQuotaPanel: ({ provider }: { provider: string }) => <span>quota:{provider}</span>,
}))
jest.mock("../add-account-dialog/managed-key", () => ({
  ManagedKeyAccountDialog: ({ definition }: { definition: SubscriptionProviderDefinition }) => (
    <div role="dialog">{definition.name}</div>
  ),
}))
jest.mock("@/components/providers/ai/provider-icon", () => ({
  ProviderIcon: () => null,
}))

const definition: SubscriptionProviderDefinition = {
  id: "plugin:kimi",
  name: "Kimi Code",
  source: "plugin",
  authMode: "api-key",
  billingMode: "subscription",
  baseUrl: "https://api.kimi.com/coding/v1",
  relatedProviderIds: ["moonshot"],
  apiKeyUrl: "https://kimi.com/code/console",
  usageUrl: "https://kimi.com/code/usage",
  docsUrl: "https://kimi.com/code/docs",
  usage: {
    baseUrl: "https://quota.kimi.com/v2",
    request: { path: "/usage", useBaseUrlOrigin: true },
    extract: {
      kind: "window",
      windows: [{ id: "plan", labelKey: "subscription.limits.meter.plan", usedPctPath: "percent" }],
    },
  },
}

function accountsResult(
  overrides: Partial<ReturnType<typeof useAccounts>> = {}
): ReturnType<typeof useAccounts> {
  return {
    accounts: [],
    activeAccountId: null,
    loading: false,
    error: null,
    pendingAction: null,
    pendingAccountId: null,
    reload: jest.fn(async () => {}),
    setActive: jest.fn(async () => {}),
    rename: jest.fn(async () => {}),
    remove: jest.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  jest.mocked(useAccounts).mockReturnValue(
    accountsResult({
      accounts: [
        {
          id: "acc",
          label: "Work plan",
          provider: definition.id,
          variant: "api-key",
          expiresAtMs: 0,
          createdAtMs: 0,
          lastUsedAtMs: 0,
          authMode: "api-key",
          credentialSource: "managed",
          health: "ready",
          isExternal: false,
        },
      ],
      activeAccountId: "acc",
    })
  )
  jest.mocked(isTauri).mockReturnValue(true)
})

it("shows subscription account, declared quota and destinations with links to separate billing sources", () => {
  const manage = jest.fn()
  render(<ManagedProviderPanel provider={definition} onManageAccounts={manage} />)
  expect(screen.getByText("Subscription plan")).toBeInTheDocument()
  expect(screen.getByText("Active account: Work plan")).toBeInTheDocument()
  expect(screen.getByText("https://api.kimi.com/coding/v1")).toBeInTheDocument()
  expect(screen.getByText("https://quota.kimi.com/usage")).toBeInTheDocument()
  expect(screen.getByText("quota:plugin:kimi")).toBeInTheDocument()
  expect(screen.queryByText("presets")).not.toBeInTheDocument()
  expect(screen.getByRole("link", { name: "Open AI connection" })).toHaveAttribute(
    "href",
    "/settings?section=ai-connections&provider=plugin%3Akimi"
  )
  expect(screen.getByRole("link", { name: /pay-as-you-go API/ })).toHaveAttribute(
    "href",
    "/settings?section=ai-connections&provider=moonshot"
  )
  fireEvent.click(screen.getByRole("button", { name: "Manage accounts" }))
  expect(manage).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole("button", { name: "Add account" }))
  expect(screen.getByRole("dialog")).toHaveTextContent("Kimi Code")
})

it("keeps preset editing for legacy custom services and explains missing automatic usage", () => {
  render(
    <ManagedProviderPanel
      provider={{ ...definition, billingMode: undefined, usage: undefined }}
      onManageAccounts={jest.fn()}
    />
  )
  expect(screen.getByText("presets")).toBeInTheDocument()
  expect(screen.getByText(/does not declare automatic quota queries/)).toBeInTheDocument()
  expect(screen.queryByText("quota:plugin:kimi")).not.toBeInTheDocument()
})

it("does not offer native key storage outside the desktop app", () => {
  jest.mocked(isTauri).mockReturnValue(false)
  render(<ManagedProviderPanel provider={definition} onManageAccounts={jest.fn()} />)
  expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled()
  expect(screen.getByText("Account management requires the desktop app.")).toBeInTheDocument()
})

it.each([
  [{ loading: true }, "Loading accounts…"],
  [{ error: "vault locked" }, "Accounts are unavailable. Open account management to retry."],
  [
    { activeAccountId: null },
    "No active account. Add an account or select one in account management.",
  ],
])("handles account status (%s)", (state, text) => {
  jest.mocked(useAccounts).mockReturnValue(accountsResult(state))
  render(<ManagedProviderPanel provider={definition} onManageAccounts={jest.fn()} />)
  expect(screen.getByText(text)).toBeInTheDocument()
})
