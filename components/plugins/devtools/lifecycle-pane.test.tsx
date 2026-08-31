/**
 * @jest-environment jsdom
 */

const getPluginLifecycleSnapshots = jest.fn()
const subscribePluginLifecycleSnapshots = jest.fn()
const getPluginManager = jest.fn()
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => getPluginManager(),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { LifecyclePane } from "./lifecycle-pane"

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    managerId: "mgr-1",
    pluginId: "demo.plugin",
    generation: 3,
    intent: "enabled",
    actual: "active",
    stateSince: 0,
    requiredServices: [],
    providedServices: ["demo.service"],
    currentProviders: [],
    effects: { active: 2, pending: 1, failed: 0 },
    ...overrides,
  }
}

function renderPane() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <LifecyclePane />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  getPluginLifecycleSnapshots.mockReset().mockReturnValue([])
  subscribePluginLifecycleSnapshots.mockReset().mockReturnValue(() => {})
  getPluginManager.mockReset().mockReturnValue({
    getPluginLifecycleSnapshots,
    subscribePluginLifecycleSnapshots,
  })
})

describe("LifecyclePane", () => {
  it("shows the empty state when nothing has activated", async () => {
    renderPane()
    await waitFor(() => expect(screen.getByTestId("lifecycle-empty")).toBeInTheDocument())
    expect(screen.getByText(enMessages.plugins.devtools.lifecycle.empty)).toBeInTheDocument()
  })

  it("renders generation, intent/actual, services and effect counts", async () => {
    getPluginLifecycleSnapshots.mockReturnValue([snapshot()])
    renderPane()
    await waitFor(() => expect(screen.getByTestId("lifecycle-pane")).toBeInTheDocument())
    expect(screen.getByText("demo.plugin")).toBeInTheDocument()
    expect(screen.getByText("g3 · enabled / active")).toBeInTheDocument()
    expect(screen.getByText("demo.service")).toBeInTheDocument()
    expect(screen.getByText("2 / 1 / 0")).toBeInTheDocument()
  })

  it("re-renders when the coordinator pushes a new snapshot list", async () => {
    let push: ((next: unknown[]) => void) | undefined
    subscribePluginLifecycleSnapshots.mockImplementation((listener: (next: unknown[]) => void) => {
      push = listener
      return () => {}
    })
    renderPane()
    await waitFor(() => expect(screen.getByTestId("lifecycle-empty")).toBeInTheDocument())
    await waitFor(() => expect(push).toBeDefined())
    act(() => push!([snapshot({ pluginId: "later.plugin" })]))
    await waitFor(() => expect(screen.getByText("later.plugin")).toBeInTheDocument())
  })

  it("unsubscribes on unmount so a closed tab stops receiving pushes", async () => {
    const unsubscribe = jest.fn()
    subscribePluginLifecycleSnapshots.mockReturnValue(unsubscribe)
    const { unmount } = renderPane()
    await waitFor(() => expect(subscribePluginLifecycleSnapshots).toHaveBeenCalled())
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it("falls back to the empty state when there is no plugin manager", async () => {
    // Web and Capacitor shells have no manager. Throwing out of the effect
    // would blank the whole Advanced tab instead of this one card.
    getPluginManager.mockImplementation(() => {
      throw new Error("no manager in this shell")
    })
    renderPane()
    await waitFor(() => expect(screen.getByTestId("lifecycle-empty")).toBeInTheDocument())
  })
})
