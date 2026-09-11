/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import type { SubscriptionProviderDefinition } from "@/lib/subscription/core/provider-registry"

let providers: SubscriptionProviderDefinition[] = []
jest.mock("@/lib/subscription/core/hooks", () => ({ useSubscriptionProviders: () => providers }))
jest.mock("./anthropic", () => ({
  AnthropicAddAccountDialog: () => <div data-testid="anthropic" />,
}))
jest.mock("./codex", () => ({ CodexAddAccountDialog: () => <div data-testid="codex" /> }))
jest.mock("./managed-key", () => ({
  ManagedKeyAccountDialog: ({ definition }: { definition?: SubscriptionProviderDefinition }) => (
    <div data-testid={definition?.id ?? "custom"} />
  ),
}))
import { SubscriptionAccountDialog } from "./subscription"

it.each(["anthropic-oauth", "codex-oauth", "api-key"] as const)(
  "dispatches %s by capability rather than provider id",
  (authMode) => {
    providers = [{ id: "new-provider", name: "New provider", authMode, source: "builtin" }]
    render(<SubscriptionAccountDialog providerId="new-provider" open onOpenChange={jest.fn()} />)
    expect(
      screen.getByTestId(
        authMode === "anthropic-oauth"
          ? "anthropic"
          : authMode === "codex-oauth"
            ? "codex"
            : "new-provider"
      )
    ).toBeInTheDocument()
  }
)

it("opens a custom subscription form without a registered provider", () => {
  providers = []
  render(<SubscriptionAccountDialog open onOpenChange={jest.fn()} />)
  expect(screen.getByTestId("custom")).toBeInTheDocument()
})

it("does not turn removed plugin providers into a new custom subscription", () => {
  providers = []
  render(<SubscriptionAccountDialog providerId="missing-plugin" open onOpenChange={jest.fn()} />)
  expect(screen.getByText(/provider definition was removed/)).toBeInTheDocument()
  expect(screen.queryByTestId("custom")).not.toBeInTheDocument()
})
