import { act, render, screen } from "@testing-library/react"

import { LOADING_DELAY_MS } from "@/hooks/ui/use-deferred-loading"
import {
  __resetPluginActivationProgressStoreForTesting,
  advancePluginActivationProgress,
  beginPluginActivationProgress,
  completePluginActivationProgress,
  failPluginActivationProgress,
} from "@/stores/plugin-runtime/plugin-activation-progress-store"

import { PluginActivationProgress } from "./plugin-activation-progress"

jest.mock("@/hooks/use-network-status", () => ({
  useNetworkStatus: () => ({ loading: false, status: { connected: true, connectionType: "wifi" } }),
}))

jest.mock("@/hooks/ui/use-loading-i18n", () => ({
  useLoadingI18n: () => ({
    thinking: "thinking",
    pageLoading: "pageLoading",
    inlineLoading: "Loading…",
    loading: "Loading…",
    stillWorking: (s: number) => `Still working… (${s}s)`,
    offline: "You're offline",
    cancel: "Cancel",
  }),
}))

const PHASE_LABELS: Record<string, string> = {
  "phase.preflight": "Checking compatibility",
  "phase.dependencies": "Enabling dependencies",
  "phase.schema": "Preparing storage",
  "phase.runtime": "Starting the plugin",
  "phase.contributions": "Registering contributions",
  "phase.hooks": "Running enable hooks",
  "phase.commit": "Finishing activation",
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (key === "label") return `Activating ${vars?.name}`
    if (key === "countLabel") return `Step ${vars?.processed} of ${vars?.total}`
    return PHASE_LABELS[key] ?? key
  },
}))

const showIndicator = () =>
  act(() => {
    jest.advanceTimersByTime(LOADING_DELAY_MS + 10)
  })

beforeEach(() => {
  jest.useFakeTimers()
  __resetPluginActivationProgressStoreForTesting()
})

afterEach(() => {
  __resetPluginActivationProgressStoreForTesting()
  jest.useRealTimers()
})

describe("visibility", () => {
  it("renders nothing when no activation is in flight", () => {
    const { container } = render(<PluginActivationProgress pluginId="ghost" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing once the activation reaches a terminal state", () => {
    // The entry lingers briefly for the toast to read, but the bar is for work
    // in progress.
    beginPluginActivationProgress("p")
    completePluginActivationProgress("p")
    const { container } = render(<PluginActivationProgress pluginId="p" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing after a failure", () => {
    beginPluginActivationProgress("p")
    failPluginActivationProgress("p", new Error("boom"))
    const { container } = render(<PluginActivationProgress pluginId="p" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe("determinate semantics", () => {
  it("exposes one polite status and a valued progressbar", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "contributions")
    render(<PluginActivationProgress pluginId="p" pluginName="Alpha" variant="detail" />)
    showIndicator()

    const statuses = screen.getAllByRole("status")
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toHaveTextContent("Activating Alpha — Registering contributions — 4/7")

    const bar = screen.getByRole("progressbar")
    // 4 of 7 → 57%.
    expect(bar).toHaveAttribute("aria-valuenow", "57")
  })

  it("advances the announced count as phases progress", () => {
    beginPluginActivationProgress("p")
    const { rerender } = render(<PluginActivationProgress pluginId="p" pluginName="Alpha" />)
    showIndicator()
    expect(screen.getByRole("status")).toHaveTextContent("0/7")

    act(() => {
      advancePluginActivationProgress("p", "runtime")
    })
    rerender(<PluginActivationProgress pluginId="p" pluginName="Alpha" />)
    expect(screen.getByRole("status")).toHaveTextContent("3/7")
  })

  it("falls back to the plugin id when no name is supplied", () => {
    beginPluginActivationProgress("acme.formatter")
    render(<PluginActivationProgress pluginId="acme.formatter" />)
    showIndicator()
    expect(screen.getByRole("status")).toHaveTextContent("Activating acme.formatter")
  })
})

describe("variants", () => {
  it("row keeps the phase text out of the visual layout", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "runtime")
    render(<PluginActivationProgress pluginId="p" pluginName="Alpha" variant="row" />)
    showIndicator()

    // The status message still carries it; only the visible duplicate is gone.
    expect(screen.getByRole("status")).toHaveTextContent("Starting the plugin")
    expect(screen.queryByText("Step 3 of 7")).not.toBeInTheDocument()
  })

  it.each(["card", "detail"] as const)("%s shows the phase and count visibly", (variant) => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "hooks")
    render(<PluginActivationProgress pluginId="p" pluginName="Alpha" variant={variant} />)
    showIndicator()

    expect(screen.getByText("Running enable hooks")).toBeInTheDocument()
    expect(screen.getByText("Step 5 of 7")).toBeInTheDocument()
  })

  it("marks the visible duplicate aria-hidden so it is not announced twice", () => {
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "hooks")
    render(<PluginActivationProgress pluginId="p" pluginName="Alpha" variant="detail" />)
    showIndicator()

    expect(screen.getByText("Step 5 of 7").closest("[aria-hidden]")).toHaveAttribute(
      "aria-hidden",
      "true"
    )
  })
})

describe("localized phase labels", () => {
  it.each([
    ["preflight", "Checking compatibility"],
    ["dependencies", "Enabling dependencies"],
    ["schema", "Preparing storage"],
    ["runtime", "Starting the plugin"],
    ["contributions", "Registering contributions"],
    ["hooks", "Running enable hooks"],
    ["commit", "Finishing activation"],
  ] as const)("renders %s as %s", (phase, label) => {
    __resetPluginActivationProgressStoreForTesting()
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", phase)
    render(<PluginActivationProgress pluginId="p" pluginName="Alpha" variant="card" />)
    showIndicator()
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it("prints no phase text in the row variant, which is one line tall", () => {
    // The shared region's detail line is taller than a list row, so it either
    // pushed the row's badges around or printed over the row below it.
    __resetPluginActivationProgressStoreForTesting()
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "runtime")
    render(<PluginActivationProgress pluginId="p" pluginName="Alpha" variant="row" />)
    showIndicator()

    const visible = screen
      .queryAllByText(/Starting the plugin/)
      .filter((el) => !el.closest('[role="status"]'))
    expect(visible).toHaveLength(0)
    // The bar itself still renders, and the announcement still carries both.
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Starting the plugin")
  })

  it("thins and tints the bar in the row variant so it is not read as a divider", () => {
    __resetPluginActivationProgressStoreForTesting()
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "runtime")
    const { container } = render(<PluginActivationProgress pluginId="p" variant="row" />)
    showIndicator()

    const region = container.querySelector("[data-slot='loading-region']")
    // The shared 4px solid-primary bar at a dense row's edge reads as a heavy
    // black rule sitting on the row divider rather than as progress.
    expect(region?.className).toContain("[&_[data-slot=progress]]:h-0.5")
    expect(region?.className).toContain("[&_[data-slot=progress-indicator]]:bg-primary/60")
  })

  it("keeps the full-size bar and the phase text in the detail variant", () => {
    __resetPluginActivationProgressStoreForTesting()
    beginPluginActivationProgress("p")
    advancePluginActivationProgress("p", "runtime")
    const { container } = render(<PluginActivationProgress pluginId="p" variant="detail" />)
    showIndicator()

    const region = container.querySelector("[data-slot='loading-region']")
    expect(region?.className ?? "").not.toContain("[&_[data-slot=progress]]:h-0.5")
    expect(screen.getAllByText(/Starting the plugin/).length).toBeGreaterThan(0)
  })
})
