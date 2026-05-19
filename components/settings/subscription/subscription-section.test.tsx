/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const useRouterMock = jest.fn()
const useSearchParamsMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => useRouterMock(),
  useSearchParams: () => useSearchParamsMock(),
}))

// Stub the four tab components so the section test stays focused on the
// shell behaviour (URL param routing, tab list rendering).
jest.mock("./tabs/overview-tab", () => ({
  SubscriptionOverviewTab: () => <div data-testid="overview-tab">overview</div>,
}))
jest.mock("./tabs/account-tab", () => ({
  SubscriptionAccountTab: () => <div data-testid="account-tab">account</div>,
}))
jest.mock("./tabs/usage-tab", () => ({
  SubscriptionUsageTab: () => <div data-testid="usage-tab">usage</div>,
}))
jest.mock("./tabs/settings-tab", () => ({
  SubscriptionSettingsTab: () => <div data-testid="settings-tab">settings</div>,
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { SubscriptionSection } from "./subscription-section"

const replace = jest.fn()

beforeEach(() => {
  jest.resetAllMocks()
  useRouterMock.mockReturnValue({ replace })
  useSearchParamsMock.mockReturnValue(new URLSearchParams())
})

describe("SubscriptionSection", () => {
  it("renders the overview tab by default", () => {
    render(<SubscriptionSection />)
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()
  })

  it("respects the ?innerTab= query param", () => {
    // `?subTab=` selects the provider (anthropic / codex / opencode);
    // the inner overview/account/usage/settings tab is driven by
    // `?innerTab=` for Anthropic provider.
    useSearchParamsMock.mockReturnValue(new URLSearchParams("innerTab=usage"))
    render(<SubscriptionSection />)
    expect(screen.getByTestId("usage-tab")).toBeInTheDocument()
  })

  it("falls back to overview for an unknown ?innerTab=", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("innerTab=ALIEN"))
    render(<SubscriptionSection />)
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()
  })

  it("clicking a tab updates the URL", () => {
    render(<SubscriptionSection />)
    // This file overrides next-intl with a key-echo mock at the top, so
    // `t("tabs.account")` renders as `tabs.account` and the tab's
    // accessible name is the raw key.
    const trigger = screen.getByRole("tab", { name: "tabs.account" })
    // Radix Tabs needs the full pointer-down → click sequence to fire
    // `onValueChange`; a bare click event in jsdom gets swallowed.
    fireEvent.pointerDown(trigger, { pointerType: "mouse" })
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    expect(replace).toHaveBeenCalled()
    const url = replace.mock.calls.at(-1)![0] as string
    expect(url).toContain("innerTab=account")
  })

  it("renders all four tab triggers", () => {
    render(<SubscriptionSection />)
    for (const id of ["overview", "account", "usage", "settings"]) {
      expect(screen.getByRole("tab", { name: `tabs.${id}` })).toBeInTheDocument()
    }
  })
})
