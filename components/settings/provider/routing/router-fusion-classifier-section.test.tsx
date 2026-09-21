import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_AUTO_ROUTER_SETTINGS } from "@cognia/provider-types/auto-router"
import {
  normalizeRouterFusionSettings,
  type RouterFusionSettings,
} from "@cognia/router-fusion/settings/settings"

type State = { settings: Record<string, unknown> }
const mockState: { current: State } = { current: { settings: {} } }

jest.mock("@/stores/settings", () => {
  const useSettingsStore = (selector: (state: State) => unknown) => selector(mockState.current)
  useSettingsStore.getState = () => mockState.current
  return { useSettingsStore }
})

import { RouterFusionClassifierSection } from "./router-fusion-classifier-section"

type Patch =
  Partial<RouterFusionSettings> | ((current: RouterFusionSettings) => Partial<RouterFusionSettings>)

/** The section's host: applies each patch the way `saveRouterFusionSettings` does. */
function harness(initial: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  let saved = normalizeRouterFusionSettings(initial)
  mockState.current = {
    settings: {
      providerSettings: {
        openai: {
          providerId: "openai",
          enabled: true,
          defaultModel: "gpt-5-mini",
          enabledModels: ["gpt-5-mini", "gpt-5"],
        },
      },
      customProviders: [],
      ...extra,
    },
  }
  const persist = jest.fn((patch: Patch) => {
    const changes = typeof patch === "function" ? patch(saved) : patch
    saved = normalizeRouterFusionSettings({ ...saved, ...changes })
  })
  const view = render(<RouterFusionClassifierSection settings={saved} persist={persist} />)
  return {
    persist,
    saved: () => saved,
    rerender: () =>
      view.rerender(<RouterFusionClassifierSection settings={saved} persist={persist} />),
  }
}

const toggle = () => screen.getByRole("switch", { name: "Classify Auto requests with a model" })

describe("RouterFusionClassifierSection", () => {
  it("[ACC:OFF-01] starts off, says what the classifier costs, and that it needs the master switch", () => {
    harness()
    expect(toggle()).not.toBeChecked()
    expect(screen.getByTestId("router-fusion-classifier-cost")).toHaveTextContent(
      "Costs one small call per routed turn."
    )
    expect(
      screen.getByText("Takes effect once Router + Fusion and the surface are on.")
    ).toBeInTheDocument()
    expect(screen.queryByTestId("router-fusion-classifier-migrated")).toBeNull()
  })

  it("carries the difficulty judge's settings over on the first enable and says what came across", async () => {
    const user = userEvent.setup()
    const autoRouting = {
      ...DEFAULT_AUTO_ROUTER_SETTINGS,
      routerModel: { provider: "openai", model: "gpt-5", priority: 0 },
      cacheTTL: 90,
      judge: { enabled: true, timeoutMs: 400 },
    }
    const { saved, rerender } = harness({ enabled: true }, { autoRouting })
    await user.click(toggle())
    await waitFor(() => expect(saved().llmClassifier.enabled).toBe(true))
    expect(saved().llmClassifier).toMatchObject({
      routerProviderId: "openai",
      routerModelId: "gpt-5",
      timeoutMs: 1_500,
      cacheTtlSeconds: 90,
      judgeMigration: { carried: ["routerModel", "cacheTtlSeconds"] },
    })
    // The legacy settings themselves are untouched.
    expect(autoRouting.routerModel).toEqual({ provider: "openai", model: "gpt-5", priority: 0 })
    rerender()
    expect(screen.getByTestId("router-fusion-classifier-migrated")).toHaveTextContent(
      "Carried over from the difficulty judge: router model, cache lifetime."
    )
    expect(screen.getByRole("button", { name: "Provider and model" })).toHaveTextContent(
      "openai / gpt-5"
    )
  })

  it("switches off without forgetting its settings", async () => {
    const user = userEvent.setup()
    const { saved } = harness({
      llmClassifier: {
        enabled: true,
        routerProviderId: "openai",
        routerModelId: "gpt-5-mini",
        judgeMigration: { capturedAt: 1, judge: null, carried: [] },
      },
    })
    expect(toggle()).toBeChecked()
    await user.click(toggle())
    await waitFor(() => expect(saved().llmClassifier.enabled).toBe(false))
    expect(saved().llmClassifier).toMatchObject({
      routerProviderId: "openai",
      routerModelId: "gpt-5-mini",
      judgeMigration: { capturedAt: 1 },
    })
  })

  it("asks for a router model while none is set, and picks and clears one with the provider picker", async () => {
    const user = userEvent.setup()
    const { saved, rerender } = harness({ llmClassifier: { enabled: true } })
    expect(screen.getByTestId("router-fusion-classifier-model-hint")).toHaveTextContent(
      "Pick a router model. Until then every request is labelled by the rules classifier."
    )
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Provider and model" }))
    await user.click(await screen.findByText("gpt-5-mini"))
    await waitFor(() =>
      expect(saved().llmClassifier).toMatchObject({
        routerProviderId: "openai",
        routerModelId: "gpt-5-mini",
      })
    )
    rerender()
    expect(screen.getByTestId("router-fusion-classifier-model-hint")).toHaveTextContent(
      "A small, fast model. It only labels the request; it never answers it."
    )
    await user.click(screen.getByRole("button", { name: "Clear" }))
    await waitFor(() => expect(saved().llmClassifier.routerModelId).toBeUndefined())
    expect(saved().llmClassifier.routerProviderId).toBeUndefined()
  })

  it("saves a timeout and a cache lifetime in range on blur, and explains one out of range", async () => {
    const user = userEvent.setup()
    const { saved, persist } = harness()
    const timeout = screen.getByLabelText("Timeout (ms)")
    await user.clear(timeout)
    await user.type(timeout, "99999")
    expect(screen.getByText("Enter a whole number from 100 to 60000.")).toBeInTheDocument()
    await user.tab()
    expect(persist).not.toHaveBeenCalled()
    await user.clear(timeout)
    await user.type(timeout, "2500")
    await user.tab()
    await waitFor(() => expect(saved().llmClassifier.timeoutMs).toBe(2_500))

    const ttl = screen.getByLabelText("Cache lifetime (seconds)")
    await user.clear(ttl)
    await user.type(ttl, "0")
    await user.tab()
    // Zero is a real choice: no cache at all.
    await waitFor(() => expect(saved().llmClassifier.cacheTtlSeconds).toBe(0))
    await user.clear(ttl)
    await user.type(ttl, "1.5")
    expect(screen.getByText("Enter a whole number from 0 to 86400.")).toBeInTheDocument()
  })
})
