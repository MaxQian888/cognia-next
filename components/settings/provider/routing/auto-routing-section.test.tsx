/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const saveMock = jest.fn(async () => undefined)
let settingsState: Record<string, unknown> = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ settings: settingsState, save: saveMock }),
}))

import { AutoRoutingSection } from "./auto-routing-section"

const ENABLED_AUTO = {
  enabled: true,
  candidateAliases: ["fast", "balanced", "powerful"],
}

const TWO_PROVIDERS = {
  anthropic: { providerId: "anthropic", enabled: true, enabledModels: ["claude"] },
  openai: { providerId: "openai", enabled: true, enabledModels: ["gpt-4o"] },
}

beforeEach(() => {
  saveMock.mockClear()
  settingsState = {}
})

describe("AutoRoutingSection", () => {
  it("renders default OFF and toggles enabled via a save patch", () => {
    render(<AutoRoutingSection />)
    const toggle = screen.getByRole("switch", { name: "enabled" })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        enabled: true,
        candidateAliases: ["fast", "balanced", "powerful"],
      }),
    })
  })

  it("persists in-range thresholds and ignores out-of-range values", () => {
    settingsState = {
      autoRouting: {
        enabled: true,
        thresholds: { balanced: 0.34, powerful: 0.67 },
        candidateAliases: ["fast", "balanced", "powerful"],
      },
    }
    render(<AutoRoutingSection />)
    fireEvent.change(screen.getByLabelText("thresholdBalanced"), { target: { value: "0.4" } })
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ thresholds: { balanced: 0.4, powerful: 0.67 } }),
    })
    fireEvent.change(screen.getByLabelText("thresholdPowerful"), { target: { value: "0.8" } })
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ thresholds: { balanced: 0.34, powerful: 0.8 } }),
    })
    // Out-of-range is dropped.
    saveMock.mockClear()
    fireEvent.change(screen.getByLabelText("thresholdPowerful"), { target: { value: "5" } })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("disables the threshold inputs when auto routing is off", () => {
    render(<AutoRoutingSection />)
    expect(screen.getByLabelText("thresholdBalanced")).toBeDisabled()
    expect(screen.getByLabelText("thresholdPowerful")).toBeDisabled()
  })

  it("persists the default-selection, local-only, and shadow switches", () => {
    settingsState = { autoRouting: { ...ENABLED_AUTO, shadowMode: true } }
    render(<AutoRoutingSection />)
    fireEvent.click(screen.getByRole("switch", { name: "defaultSelection" }))
    expect(saveMock).toHaveBeenLastCalledWith({
      autoRouting: expect.objectContaining({ defaultSelection: "auto" }),
    })
    fireEvent.click(screen.getByRole("switch", { name: "localOnly" }))
    expect(saveMock).toHaveBeenLastCalledWith({
      autoRouting: expect.objectContaining({
        dataPolicy: expect.objectContaining({ locality: "local-only" }),
      }),
    })
    fireEvent.click(screen.getByRole("switch", { name: "shadowMode" }))
    expect(saveMock).toHaveBeenLastCalledWith({
      autoRouting: expect.objectContaining({ shadowMode: false }),
    })
  })

  it("persists judge.enabled and merges with the stored judge object", () => {
    settingsState = {
      autoRouting: { ...ENABLED_AUTO, judge: { enabled: false, uncertaintyBand: 0.12 } },
    }
    render(<AutoRoutingSection />)
    fireEvent.click(screen.getByRole("switch", { name: "judgeEnabled" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        judge: expect.objectContaining({ enabled: true, uncertaintyBand: 0.12 }),
      }),
    })
  })

  it("persists judge band and timeout within range and drops out-of-range values", () => {
    settingsState = {
      autoRouting: { ...ENABLED_AUTO, judge: { enabled: true, uncertaintyBand: 0.08 } },
    }
    render(<AutoRoutingSection />)
    fireEvent.change(screen.getByLabelText("judgeUncertaintyBand"), { target: { value: "0.2" } })
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        judge: expect.objectContaining({ uncertaintyBand: 0.2 }),
      }),
    })
    fireEvent.change(screen.getByLabelText("judgeTimeoutMs"), { target: { value: "900" } })
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        judge: expect.objectContaining({ timeoutMs: 900 }),
      }),
    })
    saveMock.mockClear()
    fireEvent.change(screen.getByLabelText("judgeTimeoutMs"), { target: { value: "50" } })
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("keeps the judge inputs disabled until both auto routing and the judge are on", () => {
    settingsState = { autoRouting: { ...ENABLED_AUTO, judge: { enabled: false } } }
    render(<AutoRoutingSection />)
    expect(screen.getByLabelText("judgeUncertaintyBand")).toBeDisabled()
    expect(screen.getByLabelText("judgeTimeoutMs")).toBeDisabled()
  })

  it("clears the router model back to the utility default", () => {
    settingsState = {
      autoRouting: {
        ...ENABLED_AUTO,
        judge: { enabled: true },
        routerModel: { provider: "openai", model: "gpt-4o", priority: 0 },
      },
    }
    render(<AutoRoutingSection />)
    fireEvent.click(screen.getByRole("button", { name: "routerModelClear" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ routerModel: undefined }),
    })
  })

  it("persists the cache switch and TTL, and disables TTL while caching is off", () => {
    settingsState = { autoRouting: { ...ENABLED_AUTO, enableCache: false, cacheTTL: 300 } }
    render(<AutoRoutingSection />)
    expect(screen.getByLabelText("cacheTtl")).toBeDisabled()
    fireEvent.click(screen.getByRole("switch", { name: "cacheEnabled" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ enableCache: true }),
    })
    saveMock.mockClear()
    settingsState = { autoRouting: { ...ENABLED_AUTO, enableCache: true, cacheTTL: 300 } }
    render(<AutoRoutingSection />)
    fireEvent.change(screen.getByLabelText("cacheTtl"), { target: { value: "600" } })
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ cacheTTL: 600 }),
    })
  })

  it("adds a provider to preferred and removes it from excluded in the same patch", () => {
    settingsState = {
      autoRouting: {
        ...ENABLED_AUTO,
        preferredProviders: [],
        excludedProviders: ["anthropic"],
      },
      providerSettings: TWO_PROVIDERS,
      customProviders: [],
    }
    render(<AutoRoutingSection />)
    fireEvent.click(screen.getByTestId("auto-preferred-anthropic"))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        preferredProviders: ["anthropic"],
        excludedProviders: [],
      }),
    })
  })

  it("adds a provider to excluded and removes it from preferred in the same patch", () => {
    settingsState = {
      autoRouting: {
        ...ENABLED_AUTO,
        preferredProviders: ["openai"],
        excludedProviders: [],
      },
      providerSettings: TWO_PROVIDERS,
      customProviders: [],
    }
    render(<AutoRoutingSection />)
    fireEvent.click(screen.getByTestId("auto-excluded-openai"))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({
        preferredProviders: [],
        excludedProviders: ["openai"],
      }),
    })
  })

  it("removes a provider from its list when the chip is toggled off", () => {
    settingsState = {
      autoRouting: { ...ENABLED_AUTO, preferredProviders: ["anthropic", "openai"] },
      providerSettings: TWO_PROVIDERS,
      customProviders: [],
    }
    render(<AutoRoutingSection />)
    fireEvent.click(screen.getByTestId("auto-preferred-anthropic"))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ preferredProviders: ["openai"] }),
    })
  })

  it("parses the cost cap in cents and maps an empty field back to undefined", async () => {
    const user = userEvent.setup()
    settingsState = { autoRouting: { ...ENABLED_AUTO, maxCostPerRequest: 50 } }
    render(<AutoRoutingSection />)
    const input = screen.getByLabelText("maxCostPerRequest")
    await user.clear(input)
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ maxCostPerRequest: undefined }),
    })
    saveMock.mockClear()
    fireEvent.change(input, { target: { value: "250" } })
    expect(saveMock).toHaveBeenLastCalledWith({
      autoRouting: expect.objectContaining({ maxCostPerRequest: 250 }),
    })
  })

  it("writes a category alias through the category select", async () => {
    const user = userEvent.setup()
    settingsState = {
      autoRouting: ENABLED_AUTO,
      modelMappings: [
        { id: "m1", alias: "code-tier", enabled: true, providers: [] },
        { id: "m2", alias: "off-tier", enabled: false, providers: [] },
      ],
    }
    render(<AutoRoutingSection />)
    await user.click(screen.getByRole("combobox", { name: "taskCategory.coding" }))
    await user.click(await screen.findByRole("option", { name: "code-tier" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ categoryAliases: { coding: "code-tier" } }),
    })
    // Disabled aliases are not offered.
    expect(screen.queryByRole("option", { name: "off-tier" })).not.toBeInTheDocument()
  })

  it("deletes the category key when the follow-ladder option is chosen", async () => {
    const user = userEvent.setup()
    settingsState = {
      autoRouting: { ...ENABLED_AUTO, categoryAliases: { coding: "code-tier" } },
      modelMappings: [{ id: "m1", alias: "code-tier", enabled: true, providers: [] }],
    }
    render(<AutoRoutingSection />)
    await user.click(screen.getByRole("combobox", { name: "taskCategory.coding" }))
    await user.click(await screen.findByRole("option", { name: "categoryFollowLadder" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ categoryAliases: {} }),
    })
  })

  it("persists the fallback tier alias and provider selects", async () => {
    const user = userEvent.setup()
    settingsState = {
      autoRouting: ENABLED_AUTO,
      providerSettings: TWO_PROVIDERS,
      customProviders: [],
    }
    render(<AutoRoutingSection />)
    await user.click(screen.getByRole("combobox", { name: "fallbackTier" }))
    await user.click(await screen.findByRole("option", { name: "powerful" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ fallbackTier: "powerful" }),
    })
    await user.click(screen.getByRole("combobox", { name: "fallbackProvider" }))
    await user.click(await screen.findByRole("option", { name: "openai" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ fallbackProvider: "openai" }),
    })
  })

  it("clears the fallback provider through the none option", async () => {
    const user = userEvent.setup()
    settingsState = {
      autoRouting: { ...ENABLED_AUTO, fallbackProvider: "openai" },
      providerSettings: TWO_PROVIDERS,
      customProviders: [],
    }
    render(<AutoRoutingSection />)
    await user.click(screen.getByRole("combobox", { name: "fallbackProvider" }))
    await user.click(await screen.findByRole("option", { name: "fallbackNone" }))
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ fallbackProvider: undefined }),
    })
  })

  it("persists the routing-indicator switch even while auto routing is off", () => {
    settingsState = { autoRouting: { enabled: false, showRoutingIndicator: true } }
    render(<AutoRoutingSection />)
    const toggle = screen.getByRole("switch", { name: "showIndicator" })
    expect(toggle).not.toBeDisabled()
    fireEvent.click(toggle)
    expect(saveMock).toHaveBeenCalledWith({
      autoRouting: expect.objectContaining({ showRoutingIndicator: false }),
    })
  })

  it("lists the dormant legacy fields as inactive with no controls", () => {
    render(<AutoRoutingSection />)
    const block = screen.getByTestId("auto-routing-dormant")
    expect(block).toHaveTextContent("routingMode")
    expect(block).toHaveTextContent("allowOverride")
    expect(block).toHaveTextContent("customTierModels")
    expect(block.querySelectorAll("input, select, button, [role='switch']").length).toBe(0)
  })
})
