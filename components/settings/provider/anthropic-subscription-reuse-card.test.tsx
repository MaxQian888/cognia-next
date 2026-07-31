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
const reload = jest.fn()
let hookResult: { credential: Cred; loading: boolean } = { credential: null, loading: false }
type Discovered = { accessToken: string; refreshToken: string; subscriptionType?: string } | null
let discoveredResult: Discovered = null
// Records the options the card passes to the discovery hook so tests can assert
// the external-keychain probe is gated (enabled=false) when a credential exists.
let lastDiscoveryOptions: { enabled?: boolean } | undefined
jest.mock("@/lib/subscription/anthropic/hooks", () => ({
  useActiveAnthropicCredential: () => ({ ...hookResult, reload }),
  useAnthropicDiscovery: (opts?: { enabled?: boolean }) => {
    lastDiscoveryOptions = opts
    return {
      discovered: discoveredResult,
      loading: false,
      error: null,
      reload: jest.fn(),
    }
  },
}))

jest.mock("@/lib/subscription/anthropic/discovery", () => ({
  adoptAndActivateDiscoveredAuth: jest.fn(),
  discoveredToCredential: (d: { accessToken: string; refreshToken: string }) =>
    d.accessToken.trim() && d.refreshToken.trim() ? { mode: "subscription" } : null,
}))
import { adoptAndActivateDiscoveredAuth } from "@/lib/subscription/anthropic/discovery"
const adoptMock = adoptAndActivateDiscoveredAuth as jest.Mock

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point }: { point: string }) => (
    <div data-testid="plugin-slot" data-point={point} />
  ),
}))

import { AnthropicSubscriptionReuseCard } from "./anthropic-subscription-reuse-card"

beforeEach(() => {
  replace.mockClear()
  reload.mockClear()
  adoptMock.mockReset()
  tauri = true
  hookResult = { credential: null, loading: false }
  discoveredResult = null
  lastDiscoveryOptions = undefined
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

  it("desktop + local CLI login detected shows the one-click reuse alert instead of sign-in", () => {
    discoveredResult = { accessToken: "oat", refreshToken: "ort", subscriptionType: "max" }
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.getByText("localLoginTitle")).toBeInTheDocument()
    expect(screen.getByText("localLoginBodyPlan")).toBeInTheDocument()
    expect(screen.queryByText("signedOutTitle")).not.toBeInTheDocument()
  })

  it("one-click reuse adopts + activates then reloads the credential", async () => {
    discoveredResult = { accessToken: "oat", refreshToken: "ort" }
    adoptMock.mockResolvedValue({ id: "acct-1" })
    const user = userEvent.setup()
    render(<AnthropicSubscriptionReuseCard />)
    await user.click(screen.getByRole("button", { name: "localLoginAction" }))
    expect(adoptMock).toHaveBeenCalledWith(discoveredResult)
    expect(reload).toHaveBeenCalled()
  })

  it("surfaces an adopt failure inline", async () => {
    discoveredResult = { accessToken: "oat", refreshToken: "ort" }
    adoptMock.mockRejectedValue(new Error("vault sealed"))
    const user = userEvent.setup()
    render(<AnthropicSubscriptionReuseCard />)
    await user.click(screen.getByRole("button", { name: "localLoginAction" }))
    expect(await screen.findByText("vault sealed")).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it("unusable discovered credential falls back to the sign-in prompt", () => {
    discoveredResult = { accessToken: "", refreshToken: "" }
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.getByText("signedOutTitle")).toBeInTheDocument()
    expect(screen.queryByText("localLoginTitle")).not.toBeInTheDocument()
  })

  it("gates the external-keychain probe off when a credential is already active", () => {
    hookResult = { credential: { mode: "subscription", plan: "max" }, loading: false }
    render(<AnthropicSubscriptionReuseCard />)
    expect(lastDiscoveryOptions).toEqual({ enabled: false })
  })

  it("gates the probe off while the active credential is still loading", () => {
    hookResult = { credential: null, loading: true }
    render(<AnthropicSubscriptionReuseCard />)
    expect(lastDiscoveryOptions).toEqual({ enabled: false })
  })

  it("enables the probe only once no credential is present", () => {
    hookResult = { credential: null, loading: false }
    render(<AnthropicSubscriptionReuseCard />)
    expect(lastDiscoveryOptions).toEqual({ enabled: true })
  })

  it("active account wins over a detected local login", () => {
    hookResult = { credential: { mode: "subscription", plan: "max" }, loading: false }
    discoveredResult = { accessToken: "oat", refreshToken: "ort" }
    render(<AnthropicSubscriptionReuseCard />)
    expect(screen.getByText("signedInTitle")).toBeInTheDocument()
    expect(screen.queryByText("localLoginTitle")).not.toBeInTheDocument()
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
