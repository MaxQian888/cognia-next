/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"

// ── i18n mock ─────────────────────────────────────────────────────────────────
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      onboardingTitle: "Get started",
      onboardingDescription: "Add a key to begin",
      onboardingQuickSetup: "Quick Setup",
      dismissOnboarding: "Dismiss",
      openai: "OpenAI",
      anthropic: "Anthropic",
      google: "Google",
      "modelsDev.update": "Update catalog",
      "modelsDev.syncing": "Syncing…",
      "modelsDev.never": "never",
      "modelsDev.sourceRemote": "Live",
      "modelsDev.sourceBundled": "Bundled",
    }
    if (key === "modelsDev.summary")
      return `${params?.providers} providers · ${params?.models} models`
    if (key === "modelsDev.lastSynced") return `Last synced: ${params?.time}`
    return map[key] ?? key
  },
}))

// ── store mock ────────────────────────────────────────────────────────────────
const storeState = {
  providerOnboardingDismissed: false,
  dismissProviderOnboarding: jest.fn(),
}
jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

// ── catalog hook mock ─────────────────────────────────────────────────────────
const catalogState = {
  row: undefined as
    | undefined
    | { fetchedAt: number; source: "remote" | "bundled"; providers: Record<string, unknown> },
  providerCount: 0,
  modelCount: 0,
  isSyncing: false,
  error: null as string | null,
  sync: jest.fn(),
}
jest.mock("@/hooks/settings/use-models-dev-catalog", () => ({
  useModelsDevCatalog: () => catalogState,
}))

beforeEach(() => {
  storeState.providerOnboardingDismissed = false
  storeState.dismissProviderOnboarding = jest.fn()
  catalogState.row = undefined
  catalogState.providerCount = 0
  catalogState.modelCount = 0
  catalogState.isSyncing = false
  catalogState.error = null
  catalogState.sync = jest.fn()
})

describe("ProviderOnboardingBanner (dismissible hint)", () => {
  it("renders the onboarding hint with quick-setup providers", () => {
    render(<ProviderOnboardingBanner />)
    expect(screen.getByText("Get started")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("Anthropic")).toBeInTheDocument()
    expect(screen.getByText("Google")).toBeInTheDocument()
  })

  it("returns null once dismissed", () => {
    storeState.providerOnboardingDismissed = true
    const { container } = render(<ProviderOnboardingBanner />)
    expect(container.firstChild).toBeNull()
  })

  it("persists dismissal when the close button is clicked", () => {
    render(<ProviderOnboardingBanner />)
    fireEvent.click(screen.getByText("Dismiss"))
    expect(storeState.dismissProviderOnboarding).toHaveBeenCalledTimes(1)
  })

  it("hosts a quiet catalog update control that triggers a sync", () => {
    render(<ProviderOnboardingBanner />)
    fireEvent.click(screen.getByRole("button", { name: "Update catalog" }))
    expect(catalogState.sync).toHaveBeenCalledTimes(1)
  })

  it("does not surface errors as toasts — the control stays silent", () => {
    // An error in the hook must not crash or block the hint; the button remains.
    catalogState.error = "offline"
    render(<ProviderOnboardingBanner />)
    expect(screen.getByRole("button", { name: "Update catalog" })).toBeInTheDocument()
  })

  it("shows a syncing state while a sync is in flight", () => {
    catalogState.isSyncing = true
    render(<ProviderOnboardingBanner />)
    const btn = screen.getByRole("button", { name: "Syncing…" })
    expect(btn).toBeDisabled()
  })

  it("calls onScrollToProvider with the clicked quick-setup provider's id", () => {
    const onScrollToProvider = jest.fn()
    render(<ProviderOnboardingBanner onScrollToProvider={onScrollToProvider} />)
    fireEvent.click(screen.getByText("Anthropic"))
    expect(onScrollToProvider).toHaveBeenCalledWith("anthropic")
  })

  it("does not throw when a quick-setup badge is clicked without a matching sidebar row mounted", () => {
    // No element with id="provider-openai" exists in this render — the
    // internal getElementById lookup must no-op instead of throwing.
    render(<ProviderOnboardingBanner />)
    expect(() => fireEvent.click(screen.getByText("OpenAI"))).not.toThrow()
  })

  it("exposes catalog counts + source via the control's hover title", () => {
    catalogState.row = { fetchedAt: 1_700_000_000_000, source: "remote", providers: {} }
    catalogState.providerCount = 21
    catalogState.modelCount = 350
    render(<ProviderOnboardingBanner />)
    const btn = screen.getByRole("button", { name: "Update catalog" })
    expect(btn.getAttribute("title")).toContain("21 providers · 350 models")
    expect(btn.getAttribute("title")).toContain("Live")
  })
})
