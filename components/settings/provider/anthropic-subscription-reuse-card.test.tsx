/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams("section=providers"),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

type Cred = { email?: string; mode: string; plan?: string } | null
let hookResult: { credential: Cred; loading: boolean } = { credential: null, loading: false }
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => hookResult,
}))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point }: { point: string }) => (
    <div data-testid="plugin-slot" data-point={point} />
  ),
}))

import { AnthropicSubscriptionReuseCard } from "./anthropic-subscription-reuse-card"

beforeEach(() => {
  replace.mockClear()
  tauri = true
  hookResult = { credential: null, loading: false }
})

describe("AnthropicSubscriptionReuseCard", () => {
  it("renders the settings.ai plugin slot and the privacy note on every platform", () => {
    tauri = false
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.getByTestId("plugin-slot")).toHaveAttribute("data-point", "settings.ai")
    expect(screen.getByText("privacyTitle")).toBeInTheDocument()
  })

  it("on web (no Tauri) hides the subscription + ccswitch alerts", () => {
    tauri = false
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.queryByText("signedOutTitle")).not.toBeInTheDocument()
    expect(screen.queryByText("signedInTitle")).not.toBeInTheDocument()
    expect(screen.queryByText("ccswitchHintTitle")).not.toBeInTheDocument()
  })

  it("desktop + no active account shows the sign-in prompt linking to subscription", async () => {
    const user = userEvent.setup()
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.getByText("signedOutTitle")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "signIn" }))
    expect(replace).toHaveBeenCalledWith("/settings?section=subscription", { scroll: false })
  })

  it("desktop + active account shows the authenticated state and key-optional note", () => {
    hookResult = {
      credential: { email: "me@example.com", mode: "subscription", plan: "max" },
      loading: false,
    }
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.getByText("signedInTitle")).toBeInTheDocument()
    expect(screen.getByText("keyOptional")).toBeInTheDocument()
    expect(screen.queryByText("signedOutTitle")).not.toBeInTheDocument()
  })

  it("manage button routes to the subscription section", async () => {
    hookResult = { credential: { mode: "console" }, loading: false }
    const user = userEvent.setup()
    render(<AnthropicSubscriptionReuseCard />)
    await user.click(screen.getByRole("button", { name: "manage" }))
    expect(replace).toHaveBeenCalledWith("/settings?section=subscription", { scroll: false })
  })

  it("ccswitch hint routes to the ccswitch section on desktop", async () => {
    const user = userEvent.setup()
    render(<AnthropicSubscriptionReuseCard />)
    await user.click(screen.getByRole("button", { name: "ccswitchHintAction" }))
    expect(replace).toHaveBeenCalledWith("/settings?section=ccswitch", { scroll: false })
  })

  it("hides subscription alerts while the credential is still loading", () => {
    hookResult = { credential: null, loading: true }
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.queryByText("signedOutTitle")).not.toBeInTheDocument()
    expect(screen.queryByText("signedInTitle")).not.toBeInTheDocument()
    // Privacy note is independent of loading state.
    expect(screen.getByText("privacyTitle")).toBeInTheDocument()
  })
})
