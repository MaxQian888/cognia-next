/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.count === "number") return `${key}:${vars.count}`
    if (key === "versionChange" && vars) return `v${vars.from} → v${vars.to}`
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

import { PluginUpdateDialog, __resetPluginUpdateClientForTests } from "./plugin-update-dialog"

beforeEach(() => {
  __resetPluginUpdateClientForTests(null)
})

function makeClient(
  updates: Array<{
    pluginId: string
    currentVersion: string
    latestVersion: string
  }> = []
) {
  return {
    checkForUpdates: jest.fn(async () => updates),
    installUpdate: jest.fn(async () => undefined),
    cancelUpdate: jest.fn(),
    onProgress: jest.fn(() => () => undefined),
  }
}

describe("PluginUpdateDialog", () => {
  it("shows the up-to-date message when no updates are available", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalled())
    expect(screen.getByText("upToDate")).toBeInTheDocument()
  })

  it("renders update entries returned by the client", async () => {
    const client = makeClient([
      { pluginId: "alpha", currentVersion: "1.0.0", latestVersion: "1.1.0" },
      { pluginId: "beta", currentVersion: "0.5.0", latestVersion: "0.6.0" },
    ])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument())
    expect(screen.getByText("beta")).toBeInTheDocument()
    expect(screen.getByText("availableCount:2")).toBeInTheDocument()
    // The version delta renders from currentVersion → latestVersion (an earlier
    // fromVersion/toVersion mismatch showed "v undefined → v undefined").
    expect(screen.getByText("v1.0.0 → v1.1.0")).toBeInTheDocument()
  })

  it("install-all calls installUpdate with the latest version for every entry", async () => {
    const client = makeClient([
      { pluginId: "alpha", currentVersion: "1.0.0", latestVersion: "1.1.0" },
    ])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("alpha")).toBeInTheDocument())
    fireEvent.click(screen.getByText("installAll"))
    await waitFor(() => expect(client.installUpdate).toHaveBeenCalledWith("alpha", "1.1.0"))
  })

  it("close button invokes onClose", () => {
    __resetPluginUpdateClientForTests(makeClient([]))
    const onClose = jest.fn()
    render(<PluginUpdateDialog open onClose={onClose} />)
    fireEvent.click(screen.getByText("close"))
    expect(onClose).toHaveBeenCalled()
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    __resetPluginUpdateClientForTests(makeClient([]))
    render(<PluginUpdateDialog open onClose={() => {}} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })

  // `dvh`, not `vh`: on a phone `vh` is measured with the browser chrome
  // retracted, so a `vh` cap can still run under the toolbar.
  it("caps DialogContent at the dynamic viewport with a fixed header and footer", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalled())
    const dialog = screen.getByRole("dialog")
    expect(dialog).toHaveClass("flex", "flex-col", "max-h-[85dvh]")
    expect(dialog).not.toHaveClass("max-h-[85vh]")
    expect(dialog.querySelector("[data-slot='dialog-header']")).toHaveClass("shrink-0")
    expect(dialog.querySelector("[data-slot='dialog-footer']")).toHaveClass("shrink-0")
    // The list keeps its own `min-h-0 flex-1` scroller, the one that flexes.
    expect(dialog.querySelector("[data-slot='scroll-area']")).toHaveClass("min-h-0", "flex-1")
  })

  it("names each update by the plugin's display name, falling back to its id", async () => {
    const { usePluginStore } = await import("@/stores/plugin-runtime/plugin-store")
    usePluginStore.setState((state) => ({
      ...state,
      plugins: {
        ...state.plugins,
        alpha: { manifest: { id: "alpha", name: "Alpha Tools", version: "1.0.0" } },
      } as never,
    }))
    const client = makeClient([
      { pluginId: "alpha", currentVersion: "1.0.0", latestVersion: "1.1.0" },
      { pluginId: "beta", currentVersion: "2.0.0", latestVersion: "2.1.0" },
    ])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText("Alpha Tools")).toBeInTheDocument())
    expect(screen.getByText("beta")).toBeInTheDocument()
  })

  it("scopes the check to one plugin when opened from its detail view", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open pluginId="gamma" onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledWith("gamma"))
    expect(screen.getByText("titleSingle:gamma")).toBeInTheDocument()
    expect(screen.getByText("descriptionSingle")).toBeInTheDocument()
    expect(screen.getByText("upToDateSingle")).toBeInTheDocument()
  })

  it("checks every plugin when no plugin is given", async () => {
    const client = makeClient([])
    __resetPluginUpdateClientForTests(client)
    render(<PluginUpdateDialog open onClose={() => {}} />)
    await waitFor(() => expect(client.checkForUpdates).toHaveBeenCalledWith(undefined))
    expect(screen.getByText("title")).toBeInTheDocument()
  })
})
