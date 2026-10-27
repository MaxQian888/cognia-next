/**
 * @jest-environment jsdom
 */
import React from "react"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { ProviderOnboardingBanner } from "./provider-onboarding-banner"
import { fetchIpInfo } from "@/lib/network/ip-info"

jest.mock("@/lib/network/ip-info", () => ({ fetchIpInfo: jest.fn() }))
const mockFetchIpInfo = jest.mocked(fetchIpInfo)

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
      deepseek: "DeepSeek",
      qwen: "Qwen",
      doubao: "Doubao",
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
  settings: { networkProxy: { ipLookupEnabled: true } },
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

// ── live access mock ──────────────────────────────────────────────────────────
const access = { builtIn: false as boolean | null }
jest.mock("@/hooks/onboarding/use-setup-status", () => ({
  useBuiltInModelAccess: () => access.builtIn,
}))

beforeEach(() => {
  jest.restoreAllMocks()
  mockFetchIpInfo.mockReset()
  mockFetchIpInfo.mockResolvedValue({ ok: true, info: { ip: "192.0.2.1", country: "US" } })
  jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    timeZone: "America/New_York",
  } as Intl.ResolvedDateTimeFormatOptions)
  storeState.settings.networkProxy.ipLookupEnabled = true
  access.builtIn = false
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
  it("uses Chinese providers when the IP lookup detects China", async () => {
    mockFetchIpInfo.mockResolvedValue({ ok: true, info: { ip: "192.0.2.1", country: "CN" } })
    render(<ProviderOnboardingBanner />)
    expect(await screen.findByRole("button", { name: "DeepSeek" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Qwen" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Doubao" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "OpenAI" })).not.toBeInTheDocument()
  })

  it.each(["deepseek", "qwen", "doubao"])("navigates to the Chinese provider %s", async (id) => {
    mockFetchIpInfo.mockResolvedValue({ ok: true, info: { ip: "192.0.2.1", country: "CN" } })
    const onScrollToProvider = jest.fn()
    render(<ProviderOnboardingBanner onScrollToProvider={onScrollToProvider} />)
    const names = { deepseek: "DeepSeek", qwen: "Qwen", doubao: "Doubao" }
    fireEvent.click(await screen.findByRole("button", { name: names[id as keyof typeof names] }))
    expect(onScrollToProvider).toHaveBeenCalledWith(id)
  })

  it.each(["Asia/Shanghai", "Asia/Urumqi"])("uses %s as an offline fallback", async (timeZone) => {
    jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone,
    } as Intl.ResolvedDateTimeFormatOptions)
    mockFetchIpInfo.mockResolvedValue({ ok: false, error: "offline" })
    render(<ProviderOnboardingBanner />)
    expect(await screen.findByRole("button", { name: "DeepSeek" })).toBeInTheDocument()
  })

  it("uses the local fallback without a request when IP lookup is disabled", async () => {
    storeState.settings.networkProxy.ipLookupEnabled = false
    jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Shanghai",
    } as Intl.ResolvedDateTimeFormatOptions)
    render(<ProviderOnboardingBanner />)
    expect(await screen.findByRole("button", { name: "DeepSeek" })).toBeInTheDocument()
    expect(mockFetchIpInfo).not.toHaveBeenCalled()
  })

  it("falls back to the timezone when the lookup has no country", async () => {
    jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Shanghai",
    } as Intl.ResolvedDateTimeFormatOptions)
    mockFetchIpInfo.mockResolvedValue({ ok: true, info: { ip: "192.0.2.1" } })
    render(<ProviderOnboardingBanner />)
    expect(await screen.findByRole("button", { name: "DeepSeek" })).toBeInTheDocument()
  })

  it("ignores an old lookup after IP lookup is disabled", async () => {
    let resolveLookup!: (result: Awaited<ReturnType<typeof fetchIpInfo>>) => void
    mockFetchIpInfo.mockReturnValue(new Promise((resolve) => (resolveLookup = resolve)))
    const { rerender } = render(<ProviderOnboardingBanner />)
    storeState.settings.networkProxy.ipLookupEnabled = false
    rerender(<ProviderOnboardingBanner />)
    await act(async () => {
      resolveLookup({ ok: true, info: { ip: "192.0.2.1", country: "CN" } })
    })
    expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "DeepSeek" })).not.toBeInTheDocument()
  })

  it("prefers a detected non-China country over a China timezone", async () => {
    jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "Asia/Shanghai",
    } as Intl.ResolvedDateTimeFormatOptions)
    render(<ProviderOnboardingBanner />)
    await waitFor(() => expect(mockFetchIpInfo).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "DeepSeek" })).not.toBeInTheDocument()
  })

  it("keeps global providers when region detection has no usable signal", async () => {
    mockFetchIpInfo.mockResolvedValue({ ok: false, error: "offline" })
    render(<ProviderOnboardingBanner />)
    await waitFor(() => expect(mockFetchIpInfo).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("button", { name: "OpenAI" })).toBeInTheDocument()
  })

  it("does not tell a user with a connected external agent to get started", () => {
    render(<ProviderOnboardingBanner externalRuntimeReady />)
    expect(screen.getByText("externalRuntimes.bannerTitle")).toBeInTheDocument()
    expect(screen.getByText("externalRuntimes.bannerDescription")).toBeInTheDocument()
    expect(screen.queryByText("Get started")).toBeNull()
    // The quick-setup chips and catalog refresh stay: a provider can still be added.
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
  })

  it("keeps the get-started copy by default", () => {
    render(<ProviderOnboardingBanner />)
    expect(screen.getByText("Get started")).toBeInTheDocument()
    expect(screen.queryByText("externalRuntimes.bannerTitle")).toBeNull()
  })

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
    expect(mockFetchIpInfo).not.toHaveBeenCalled()
  })

  it("steps aside once the built-in agent can reach a model", () => {
    // "Get started by configuring a provider" is wrong the moment one is.
    access.builtIn = true
    const { container } = render(<ProviderOnboardingBanner />)
    expect(container.firstChild).toBeNull()
    expect(mockFetchIpInfo).not.toHaveBeenCalled()
  })

  it("stays up while access is still being probed, so it never flashes in late", () => {
    access.builtIn = null
    render(<ProviderOnboardingBanner />)
    expect(screen.getByText("Get started")).toBeInTheDocument()
  })

  it("renders as the shared guide callout", () => {
    render(<ProviderOnboardingBanner />)
    expect(screen.getByRole("region", { name: "Get started" })).toHaveAttribute(
      "data-testid",
      "provider-onboarding-guide"
    )
  })

  it("marks the quick-setup target with the shared guide highlight, then clears it", () => {
    jest.useFakeTimers()
    try {
      const row = document.createElement("div")
      row.id = "provider-google"
      row.scrollIntoView = jest.fn()
      document.body.appendChild(row)
      render(<ProviderOnboardingBanner />)
      fireEvent.click(screen.getByRole("button", { name: "Google" }))
      expect(row.scrollIntoView).toHaveBeenCalled()
      expect(row).toHaveAttribute("data-guide-highlight", "true")
      jest.advanceTimersByTime(2000)
      expect(row).not.toHaveAttribute("data-guide-highlight")
      row.remove()
    } finally {
      jest.useRealTimers()
    }
  })

  it("persists dismissal when the close button is clicked", () => {
    render(<ProviderOnboardingBanner />)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
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
