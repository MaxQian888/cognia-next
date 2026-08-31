/**
 * @jest-environment jsdom
 */

// The mock factories create their own `jest.fn()`s rather than closing over a
// module-scope const. Importing this card pulls in `file-watch` → the plugin
// manager → the keyring store, which calls `isTauri()` at import time, before
// a `const` initializer at the top of this file has run.
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))

jest.mock("@/lib/plugin/devtools/file-watch", () => {
  const actual = jest.requireActual("@/lib/plugin/devtools/file-watch")
  return { ...actual, startPluginFileWatch: jest.fn() }
})

jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { Plugin } from "@/types/plugin"

import { toast } from "sonner"
import { isTauri } from "@/lib/tauri"
import { startPluginFileWatch } from "@/lib/plugin/devtools/file-watch"

import { PluginWatchCard, WATCH_INELIGIBILITY_REASONS } from "./plugin-watch-card"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockStart = startPluginFileWatch as jest.MockedFunction<typeof startPluginFileWatch>
const mockToastError = toast.error as jest.MockedFunction<typeof toast.error>

function plugin(overrides: {
  id: string
  source?: Plugin["source"]
  type?: Plugin["manifest"]["type"]
}): Plugin {
  return {
    manifest: {
      id: overrides.id,
      name: `Plugin ${overrides.id}`,
      version: "1.0.0",
      type: overrides.type ?? "frontend",
    },
    status: "enabled",
    source: overrides.source ?? "dev",
    path: `/plugins/${overrides.id}`,
    config: {},
  } as unknown as Plugin
}

function seed(...list: Plugin[]) {
  usePluginStore.setState({
    plugins: Object.fromEntries(list.map((p) => [p.manifest.id, p])),
  } as never)
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PluginWatchCard />
    </NextIntlClientProvider>
  )
}

const stopHandle = jest.fn(async () => {})

beforeEach(() => {
  mockIsTauri.mockReturnValue(true)
  mockToastError.mockReset()
  stopHandle.mockClear()
  mockStart.mockReset().mockResolvedValue({ watchedPluginIds: ["ok"], stop: stopHandle })
  seed()
})

describe("PluginWatchCard", () => {
  it("every ineligibility reason has a translation", () => {
    // `t(\`reason.${...}\`)` is a dynamic key, which `lint:i18n` skips. Without
    // this the card can render a raw key string for a reason nobody added.
    for (const reason of WATCH_INELIGIBILITY_REASONS) {
      expect(enMessages.plugins.devtools.watch.reason[reason]).toBeTruthy()
    }
  })

  it("says the feature is desktop-only off Tauri", () => {
    mockIsTauri.mockReturnValue(false)
    seed(plugin({ id: "ok" }))
    renderCard()
    expect(screen.getByTestId("plugin-watch-desktop-only")).toBeInTheDocument()
    expect(screen.getByRole("switch")).toBeDisabled()
  })

  it("shows an empty state and a disabled switch when nothing is eligible", () => {
    seed(plugin({ id: "built", type: "wasm" }))
    renderCard()
    expect(screen.getByTestId("plugin-watch-empty")).toBeInTheDocument()
    expect(screen.getByRole("switch")).toBeDisabled()
  })

  it("names why each skipped plugin is not watched", () => {
    // Listing only the watched ones would make "needs a build" look the same
    // as a broken watcher.
    seed(
      plugin({ id: "ok" }),
      plugin({ id: "built", type: "wasm" }),
      plugin({ id: "store", source: "marketplace" })
    )
    renderCard()
    expect(screen.getByTestId("plugin-watch-skipped-built")).toHaveAttribute(
      "data-reason",
      "needs-build"
    )
    expect(screen.getByTestId("plugin-watch-skipped-store")).toHaveAttribute(
      "data-reason",
      "not-local-source"
    )
    expect(screen.queryByTestId("plugin-watch-skipped-ok")).not.toBeInTheDocument()
    expect(
      screen.getByText(enMessages.plugins.devtools.watch.reason["needs-build"])
    ).toBeInTheDocument()
  })

  it("starts watching on toggle and reports how many are watched", async () => {
    seed(plugin({ id: "ok" }))
    renderCard()
    expect(screen.getByTestId("plugin-watch-status")).toHaveTextContent(
      enMessages.plugins.devtools.watch.idle
    )
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    expect(screen.getByTestId("plugin-watch-status")).toHaveTextContent("1 plugin")
  })

  it("stops the native watcher when toggled back off", async () => {
    seed(plugin({ id: "ok" }))
    renderCard()
    const toggle = screen.getByRole("switch")
    await userEvent.click(toggle)
    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    await userEvent.click(toggle)
    await waitFor(() => expect(stopHandle).toHaveBeenCalled())
    expect(screen.getByTestId("plugin-watch-status")).toHaveTextContent(
      enMessages.plugins.devtools.watch.idle
    )
  })

  it("releases the native watcher on unmount", async () => {
    seed(plugin({ id: "ok" }))
    const { unmount } = renderCard()
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() => expect(mockStart).toHaveBeenCalled())
    unmount()
    expect(stopHandle).toHaveBeenCalled()
  })

  it("reverts the switch and reports the failure when watching cannot start", async () => {
    mockStart.mockRejectedValue(new Error("watcher unavailable"))
    seed(plugin({ id: "ok" }))
    renderCard()
    await userEvent.click(screen.getByRole("switch"))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(screen.getByRole("switch")).not.toBeChecked()
  })
})
