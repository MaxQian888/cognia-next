/** @jest-environment jsdom */
import React from "react"
import { render, screen } from "@testing-library/react"
import type { SubscriptionProviderDefinition } from "@/lib/subscription/core/provider-registry"
import { useAccounts } from "@/lib/subscription/core/hooks"
import { SubscriptionProviderLinks } from "./subscription-provider-links"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    const label = `${namespace.replace("providers.", "")}.${key}`
    return values ? `${label}:${Object.values(values).join(",")}` : label
  },
}))
jest.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(
      "section=ai-connections&provider=moonshot&subTab=old&innerTab=old&focus=old&keep=1"
    ),
}))
jest.mock("@/lib/subscription/core/hooks", () => ({ useAccounts: jest.fn() }))
jest.mock("@/components/providers/ai/provider-icon", () => ({
  ProviderIcon: ({ providerId }: { providerId: string }) => <span data-brand={providerId} />,
}))

const subscription: SubscriptionProviderDefinition = {
  id: "cognia-kimi-subscription:kimi-code",
  name: "Kimi Code",
  source: "plugin",
  authMode: "api-key",
  billingMode: "subscription",
  brandId: "kimi",
  relatedProviderIds: ["moonshot"],
  baseUrl: "https://api.kimi.com/coding/v1",
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
          id: "account-1",
          label: "Work plan",
          provider: subscription.id,
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
      activeAccountId: "account-1",
    })
  )
})

it("separates a subscription from its PAYG counterpart and links to both settings panels", () => {
  render(<SubscriptionProviderLinks providerId={subscription.id} providers={[subscription]} />)
  expect(screen.getByText("subscriptionLinks.subscriptionBadge")).toBeInTheDocument()
  expect(screen.getByText("subscriptionLinks.subscriptionDescription")).toBeInTheDocument()
  expect(screen.getByText("subscriptionLinks.activeAccount:Work plan")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "subscriptionLinks.manageAccounts" })).toHaveAttribute(
    "href",
    "/settings?section=subscription&keep=1&subTab=accounts"
  )
  expect(screen.getByRole("link", { name: "subscriptionLinks.openSubscription" })).toHaveAttribute(
    "href",
    `/settings?section=subscription&keep=1&subTab=${encodeURIComponent(subscription.id)}`
  )
  expect(screen.getByRole("link", { name: /Moonshot AI/ })).toHaveAttribute(
    "href",
    "/settings?section=ai-connections&keep=1&provider=moonshot"
  )
})

it("shows enabled related subscriptions on a PAYG provider without selecting or copying a key", () => {
  const { rerender } = render(
    <SubscriptionProviderLinks providerId="moonshot" providers={[subscription]} />
  )
  expect(screen.getByText("subscriptionLinks.paygBadge")).toBeInTheDocument()
  expect(screen.getByText("subscriptionLinks.paygDescription")).toBeInTheDocument()
  expect(screen.getByText("Kimi Code")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "subscriptionLinks.openProvider" })).toHaveAttribute(
    "href",
    `/settings?section=ai-connections&keep=1&provider=${encodeURIComponent(subscription.id)}`
  )
  rerender(<SubscriptionProviderLinks providerId="moonshot" providers={[]} />)
  expect(screen.queryByText("Kimi Code")).not.toBeInTheDocument()
  expect(screen.getByText("subscriptionLinks.paygDescription")).toBeInTheDocument()
})

it("does not query unrelated or unavailable subscriptions", () => {
  const { container } = render(
    <SubscriptionProviderLinks providerId="openai" providers={[subscription]} />
  )
  expect(container).toBeEmptyDOMElement()
  expect(useAccounts).not.toHaveBeenCalled()
})

it.each([
  [{ loading: true }, "subscriptionLinks.loadingAccounts"],
  [{ error: "vault locked" }, "subscriptionLinks.accountsUnavailable"],
  [{ activeAccountId: null }, "subscriptionLinks.noActiveAccount"],
])("reports account status without exposing credential data (%s)", (state, message) => {
  jest.mocked(useAccounts).mockReturnValue(accountsResult(state))
  render(<SubscriptionProviderLinks providerId={subscription.id} providers={[subscription]} />)
  expect(screen.getByText(message)).toBeInTheDocument()
})

it("omits unavailable plugin rows while keeping the PAYG distinction", () => {
  render(
    <SubscriptionProviderLinks
      providerId="moonshot"
      providers={[{ ...subscription, available: false }]}
    />
  )
  expect(screen.queryByText("Kimi Code")).not.toBeInTheDocument()
  expect(useAccounts).not.toHaveBeenCalled()
})
