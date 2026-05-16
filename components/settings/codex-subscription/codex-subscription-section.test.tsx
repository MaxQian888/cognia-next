/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { CodexSubscriptionSection } from "./codex-subscription-section"

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

// The child tabs each touch Tauri / hooks; isolate this test to the shell.
jest.mock("./tabs/overview-tab", () => ({
  CodexSubscriptionOverviewTab: () => <div data-testid="overview-tab" />,
}))
jest.mock("./tabs/account-tab", () => ({
  CodexSubscriptionAccountTab: () => <div data-testid="account-tab" />,
}))
jest.mock("./tabs/usage-tab", () => ({
  CodexSubscriptionUsageTab: () => <div data-testid="usage-tab" />,
}))
jest.mock("./tabs/settings-tab", () => ({
  CodexSubscriptionSettingsTab: () => <div data-testid="settings-tab" />,
}))

const messages = {
  codexSubscription: {
    title: "Codex Subscription",
    description: "OpenAI Codex auth",
    tabs: {
      overview: "Overview",
      account: "Account",
      usage: "Usage",
      settings: "Settings",
    },
  },
}

function renderWithIntl(node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {node}
    </NextIntlClientProvider>
  )
}

describe("CodexSubscriptionSection", () => {
  it("renders the title + tab triggers", () => {
    renderWithIntl(<CodexSubscriptionSection />)
    expect(screen.getByText("Codex Subscription")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Account" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Usage" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Settings" })).toBeInTheDocument()
  })

  it("defaults to the overview tab", () => {
    renderWithIntl(<CodexSubscriptionSection />)
    expect(screen.getByTestId("overview-tab")).toBeInTheDocument()
  })
})
