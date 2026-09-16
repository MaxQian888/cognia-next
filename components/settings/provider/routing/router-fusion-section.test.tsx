import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_AUTO_ROUTER_SETTINGS } from "@cognia/provider-types/auto-router"
import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

type State = { settings: Record<string, unknown> }
const mockState: { current: State } = { current: { settings: {} } }
const mockStoreSave = jest.fn(async (patch: Record<string, unknown>) => {
  mockState.current = { settings: { ...mockState.current.settings, ...patch } }
})
const mockSaveRouterFusion = jest.fn(
  async (
    patch:
      | Partial<RouterFusionSettings>
      | ((current: RouterFusionSettings) => Partial<RouterFusionSettings>)
  ) => {
    const current = normalizeRouterFusionSettings(mockState.current.settings.routerFusion)
    const next = normalizeRouterFusionSettings({
      ...current,
      ...(typeof patch === "function" ? patch(current) : patch),
    })
    mockState.current = { settings: { ...mockState.current.settings, routerFusion: next } }
    return next
  }
)
const mockToast = { success: jest.fn(), error: jest.fn() }

jest.mock("@/stores/settings", () => {
  const useSettingsStore = (selector: (state: State) => unknown) => selector(mockState.current)
  useSettingsStore.getState = () => ({ ...mockState.current, save: mockStoreSave })
  return { useSettingsStore }
})
jest.mock("@/lib/router-fusion/settings/save-router-fusion-settings", () => ({
  saveRouterFusionSettings: (...args: Parameters<typeof mockSaveRouterFusion>) =>
    mockSaveRouterFusion(...args),
}))
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}))

import {
  __resetBreakerForTesting,
  getBreakerSnapshot,
  recordFusionFault,
} from "@/lib/router-fusion/gate/breaker"

import { RouterFusionSection } from "./router-fusion-section"

function withSettings(settings: Record<string, unknown>) {
  mockState.current = { settings }
}

const saved = () => normalizeRouterFusionSettings(mockState.current.settings.routerFusion)

beforeEach(() => {
  jest.clearAllMocks()
  __resetBreakerForTesting()
  withSettings({ providerSettings: {}, customProviders: [] })
})

describe("RouterFusionSection", () => {
  it("[ACC:OFF-01] starts with everything off and every surface switch disabled", () => {
    render(<RouterFusionSection />)
    expect(screen.getByRole("switch", { name: "Enable Router + Fusion" })).not.toBeChecked()
    expect(screen.getByText("Turn on the master switch first.")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Chat" })).toBeDisabled()
    expect(screen.getByRole("switch", { name: "Chat" })).not.toBeChecked()
  })

  it("labels every surface this build does not wire as a later release, disabled even with the master on", () => {
    withSettings({ routerFusion: { enabled: true, surfaces: { companion: true } } })
    render(<RouterFusionSection />)
    for (const surface of ["companion"]) {
      const row = screen.getByTestId(`router-fusion-surface-${surface}`)
      expect(row).toHaveAttribute("data-dormant", "true")
      expect(row).toHaveTextContent("Later release")
      expect(row.querySelector('[role="switch"]')).toBeDisabled()
      // A stored "on" for a dormant surface is not presented as on.
      expect(row.querySelector('[role="switch"]')).not.toBeChecked()
    }
    // Wired in this build (ADR-0188 B1 chat; B2 both gateway lanes, utilities
    // and agents/workflows).
    for (const surface of [
      "chat",
      "gatewayRuns",
      "gatewayPassthroughLedger",
      "utilityLedger",
      "agentsWorkflows",
    ]) {
      const row = screen.getByTestId(`router-fusion-surface-${surface}`)
      expect(row).not.toHaveAttribute("data-dormant")
      expect(row.querySelector('[role="switch"]')).toBeEnabled()
    }
  })

  it("migrates a legacy Auto user on the first enable and offers a one-click restore", async () => {
    const user = userEvent.setup()
    const autoRouting = { ...DEFAULT_AUTO_ROUTER_SETTINGS, enabled: true, maxCostPerRequest: 25 }
    withSettings({ autoRouting, providerSettings: {}, customProviders: [] })
    const { rerender } = render(<RouterFusionSection />)
    await user.click(screen.getByRole("switch", { name: "Enable Router + Fusion" }))
    await waitFor(() => expect(saved().enabled).toBe(true))
    expect(saved().approvedRuleRows).toEqual(["economy_simple"])
    expect(saved().runCapUsdByMode.direct).toBe("0.250000")

    rerender(<RouterFusionSection />)
    expect(screen.getByTestId("router-fusion-migration-notice")).toBeInTheDocument()
    expect(screen.getByTestId("router-fusion-rule-economy_simple")).toHaveTextContent(
      "Migrated from legacy Auto"
    )

    await user.click(screen.getByRole("button", { name: /Restore legacy Auto/ }))
    await waitFor(() => expect(mockStoreSave).toHaveBeenCalled())
    const restored = mockStoreSave.mock.calls[0][0] as {
      routerFusion: RouterFusionSettings
      autoRouting: unknown
    }
    expect(restored.routerFusion.enabled).toBe(false)
    expect(restored.routerFusion.approvedRuleRows).toEqual([])
    expect(restored.autoRouting).toEqual(autoRouting)
    expect(mockToast.success).toHaveBeenCalledWith(
      "Legacy Auto restored and Router + Fusion switched off."
    )
  })

  it("turns chat on once the master is on", async () => {
    const user = userEvent.setup()
    withSettings({
      routerFusion: { enabled: true, legacyAutoSnapshot: { capturedAt: 1, autoRouting: null } },
    })
    render(<RouterFusionSection />)
    await user.click(screen.getByRole("switch", { name: "Chat" }))
    await waitFor(() => expect(saved().surfaces.chat).toBe(true))
  })

  it("[ACC:ISO-02] shows a tripped surface and re-arms it", async () => {
    const user = userEvent.setup()
    withSettings({
      routerFusion: {
        enabled: true,
        surfaces: { chat: true },
        trippedSurfaces: {
          chat: { trippedAt: Date.UTC(2026, 8, 16, 8, 0), reason: "db_unavailable" },
        },
      },
    })
    const { rerender } = render(<RouterFusionSection />)
    const trip = screen.getByTestId("router-fusion-trip-chat")
    expect(trip).toHaveTextContent("db_unavailable")
    await user.click(screen.getByRole("button", { name: "Re-arm" }))
    await waitFor(() => expect(saved().trippedSurfaces).toEqual({}))
    rerender(<RouterFusionSection />)
    expect(screen.queryByTestId("router-fusion-trip-chat")).toBeNull()
  })

  it("shows a trip that happened in this window before it was persisted", () => {
    withSettings({ routerFusion: { enabled: true, surfaces: { chat: true } } })
    render(<RouterFusionSection />)
    expect(screen.queryByTestId("router-fusion-trip-chat")).toBeNull()
    act(() => {
      recordFusionFault("chat", "import_failed", 1, Date.UTC(2026, 8, 16))
    })
    expect(getBreakerSnapshot("chat").trip).not.toBeNull()
    expect(screen.getByTestId("router-fusion-trip-chat")).toHaveTextContent("import_failed")
  })

  it("rejects a malformed amount and saves a valid run cap on blur", async () => {
    const user = userEvent.setup()
    render(<RouterFusionSection />)
    const cap = screen.getByLabelText("Run cap per chat turn (USD)")
    await user.clear(cap)
    await user.type(cap, "0.1234567")
    expect(
      screen.getByText("Enter a dollar amount with at most six decimal places.")
    ).toBeInTheDocument()
    await user.tab()
    expect(mockSaveRouterFusion).not.toHaveBeenCalled()
    await user.clear(cap)
    await user.type(cap, "1.25")
    await user.tab()
    await waitFor(() => expect(saved().runCapUsdByMode.direct).toBe("1.25"))
  })

  it("labels the delegate rule row as a later release, and approves the running rows as the user's", async () => {
    const user = userEvent.setup()
    const view = render(<RouterFusionSection />)
    const delegate = screen.getByTestId("router-fusion-rule-delegate_multifile")
    expect(delegate).toHaveAttribute("data-dormant", "true")
    expect(delegate.querySelector('[role="switch"]')).toBeDisabled()
    for (const row of ["economy_simple", "cascade_verifiable", "panel_research"]) {
      expect(screen.getByTestId(`router-fusion-rule-${row}`)).not.toHaveAttribute("data-dormant")
    }
    await user.click(screen.getByRole("switch", { name: "Economy model for simple text work" }))
    await waitFor(() => expect(saved().approvedRuleRows).toEqual(["economy_simple"]))
    await user.click(screen.getByRole("switch", { name: "Panel for research synthesis" }))
    await waitFor(() =>
      expect(saved().approvedRuleRows).toEqual(["economy_simple", "panel_research"])
    )
    expect(saved().ruleRowProvenance).toEqual({ economy_simple: "user", panel_research: "user" })
    // The mocked store does not re-render on save.
    view.rerender(<RouterFusionSection />)
    expect(screen.getByTestId("router-fusion-rule-panel_research")).toHaveTextContent(
      "User-approved, not eval-proven"
    )
  })

  it("sets a run cap for each running mode", async () => {
    const user = userEvent.setup()
    render(<RouterFusionSection />)
    for (const [label, mode, value] of [
      ["Run cap per cascade (USD)", "cascade", "0.75"],
      ["Run cap per panel (USD)", "panel", "3"],
    ] as const) {
      const field = screen.getByLabelText(label)
      await user.clear(field)
      await user.type(field, value)
      await user.tab()
      await waitFor(() => expect(saved().runCapUsdByMode[mode]).toBe(value))
    }
  })

  it("mounts the action catalog with the enabled model-mapping aliases", () => {
    withSettings({
      providerSettings: {},
      customProviders: [],
      modelMappings: [
        { id: "m1", alias: "code-tier", enabled: true, providers: [] },
        { id: "m2", alias: "off-tier", enabled: false, providers: [] },
      ],
    })
    render(<RouterFusionSection />)
    expect(screen.getByTestId("router-fusion-actions")).toBeInTheDocument()
    expect(screen.getByTestId("router-fusion-action-delegate_code")).toHaveAttribute(
      "data-dormant",
      "true"
    )
  })

  it("grants restricted data per configured provider", async () => {
    const user = userEvent.setup()
    withSettings({
      providerSettings: { openai: { enabled: true, apiKey: "k", defaultModel: "gpt-5" } },
      customProviders: [],
    })
    const { unmount } = render(<RouterFusionSection />)
    await user.click(screen.getByLabelText("openai"))
    await waitFor(() => expect(saved().restrictedGrantProviderIds).toEqual(["openai"]))
    unmount()

    withSettings({ providerSettings: { anthropic: { enabled: false } }, customProviders: [] })
    render(<RouterFusionSection />)
    expect(screen.getByText("No providers are configured.")).toBeInTheDocument()
  })

  it("reports a failed save", async () => {
    const user = userEvent.setup()
    mockSaveRouterFusion.mockRejectedValueOnce(new Error("quota"))
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    render(<RouterFusionSection />)
    await user.click(screen.getByRole("switch", { name: "Enable Router + Fusion" }))
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith("Could not save the Router + Fusion settings.")
    )
    error.mockRestore()
  })
})
