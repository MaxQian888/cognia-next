/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

// Every production host is stubbed to nothing: this suite pins the *harness's*
// own contract — which surfaces it mounts, in what order, and how it behaves
// before the real plugin manager has enabled the plugin. What each host renders
// is the business of that host's own suite, and of the Playwright spec.
jest.mock("@/components/chat/message-renderer", () => ({ MessageRenderer: () => null }))
jest.mock("@/components/chat/message-parts/mcp-tool-card", () => ({ MCPToolCard: () => null }))
jest.mock("@/components/chat/composer/plugin-quick-actions-menu", () => ({
  PluginQuickActionsMenu: () => null,
}))
jest.mock("@/components/context-workbench/context-workbench", () => ({
  PluginContextPanelSurface: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))
// The one host stubbed with a live control rather than `null`: the harness
// hands it an `onClose`, and nothing else can prove what that callback does.
jest.mock("@/components/plugins/detail/plugin-config-form", () => ({
  PluginConfigFormBody: ({ onClose }: { onClose: () => void }) => (
    <button type="button" data-testid="config-close" onClick={onClose} />
  ),
}))
jest.mock("@/components/plugins/dialogs/plugin-modal-root", () => ({ PluginModalRoot: () => null }))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))
jest.mock("@/components/plugins/plugin-extension-slot-with-overflow", () => ({
  PluginExtensionSlotWithOverflow: () => null,
}))
jest.mock("@/components/shell/plugin-view-container-panel", () => ({
  PluginViewContainerPanel: ({ containerId }: { containerId: string }) => (
    <div data-testid="production-view-container">{containerId}</div>
  ),
}))

let plugins: Record<string, { status: string; manifest?: unknown }> = {}
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: (selector: (state: { plugins: Record<string, unknown> }) => unknown) =>
    selector({ plugins }),
}))

let panels: Array<{ id: string; renderer: () => React.ReactElement }> = []
jest.mock("@/lib/context-workbench/panel-registry", () => ({
  contextPanelRegistry: {
    subscribe: () => () => {},
    getRevision: () => 0,
    resolve: () => panels,
  },
}))

let modalId: string | null = "reference-modal"
const closeAll = jest.fn()
jest.mock("@/stores/plugin-runtime/plugin-modal-store", () => ({
  openDeclaredModal: jest.fn(async () => modalId),
  usePluginModalStore: { getState: () => ({ closeAll }) },
}))

const enablePlugin = jest.fn(async () => undefined)
let managerInitialized = true
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => ({ enablePlugin, isInitialized: () => managerInitialized }),
}))

const setLanguage = jest.fn(async () => undefined)
let mockSettingsLoaded = true
jest.mock("@/stores/settings", () => ({
  useSettingsStore: Object.assign(
    (selector: (state: { loaded: boolean }) => unknown) => selector({ loaded: mockSettingsLoaded }),
    {
      getState: () => ({ setLanguage }),
    }
  ),
}))

import { PluginSurfaceReferenceHarness } from "./plugin-surface-reference-harness"
import { registerView, __resetViewsForTesting } from "@/lib/plugin/registries/tree-view-registry"
import {
  registerWebview,
  __resetWebviewsForTesting,
} from "@/lib/plugin/registries/webview-registry"

const PLUGIN_ID = "ui-surface-reference"

function Badge() {
  return <span className="ref-badge" />
}

function renderHarness(props: { force?: boolean } = { force: true }) {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <PluginSurfaceReferenceHarness {...props} />
    </NextIntlClientProvider>
  )
}

/** Populate the registries the harness reads its surfaces out of. */
function seedRegistries() {
  act(() => {
    registerView({
      kind: "tree",
      pluginId: PLUGIN_ID,
      viewId: "reference-tree",
      containerId: `${PLUGIN_ID}:reference`,
      provider: { getChildren: () => [] },
    })
    registerView({
      kind: "react",
      pluginId: PLUGIN_ID,
      viewId: "reference-custom",
      containerId: `${PLUGIN_ID}:reference`,
      component: Badge,
    })
    registerWebview({
      pluginId: PLUGIN_ID,
      viewId: "reference-webview",
      containerId: `${PLUGIN_ID}:reference`,
      surface: "panel",
      srcDoc: "<main/>",
    })
  })
  panels = [
    { id: `${PLUGIN_ID}:reference-panel`, renderer: Badge },
    { id: `${PLUGIN_ID}:reference-webview-panel`, renderer: Badge },
  ]
}

beforeEach(() => {
  plugins = {}
  panels = []
  modalId = "reference-modal"
  managerInitialized = true
  window.history.replaceState({}, "", "/")
  jest.clearAllMocks()
})

afterEach(() => {
  __resetViewsForTesting()
  __resetWebviewsForTesting()
})

describe("PluginSurfaceReferenceHarness", () => {
  it("waits for the real plugin manager instead of synthesizing surfaces", () => {
    const { container } = renderHarness()
    expect(screen.getByTestId("plugin-surface-reference-loading")).toBeInTheDocument()
    expect(container.querySelector("[data-plugin-surface]")).toBeNull()
  })

  it("renders nothing off its own route", () => {
    const { container } = renderHarness({ force: false })
    expect(container).toBeEmptyDOMElement()
  })

  it("activates on its own route without the force prop", () => {
    window.history.replaceState({}, "", "/e2e/plugin-ui-surfaces")
    renderHarness({ force: false })
    expect(screen.getByTestId("plugin-surface-reference-loading")).toBeInTheDocument()
  })

  it("asks the manager to enable the plugin once it knows about it", async () => {
    plugins = { [PLUGIN_ID]: { status: "disabled" } }
    renderHarness()
    await waitFor(() => expect(enablePlugin).toHaveBeenCalledWith(PLUGIN_ID, "e2e-reference"))
  })

  it("waits for plugin-manager initialization before enabling", async () => {
    plugins = { [PLUGIN_ID]: { status: "disabled" } }
    managerInitialized = false
    renderHarness()

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 75))
    })
    expect(enablePlugin).not.toHaveBeenCalled()

    managerInitialized = true
    mockSettingsLoaded = true
    await waitFor(() => expect(enablePlugin).toHaveBeenCalledWith(PLUGIN_ID, "e2e-reference"))
  })

  it("waits for the manager lifecycle even when the store is already enabled", async () => {
    plugins = { [PLUGIN_ID]: { status: "enabled" } }
    seedRegistries()
    renderHarness()
    await waitFor(() =>
      expect(screen.getByTestId("plugin-surface-reference-harness")).toBeVisible()
    )
    expect(enablePlugin).toHaveBeenCalledWith(PLUGIN_ID, "e2e-reference")
  })

  it("mounts every reference surface once the plugin is enabled", async () => {
    plugins = { [PLUGIN_ID]: { status: "enabled" } }
    seedRegistries()
    const { container } = renderHarness()

    await waitFor(() =>
      expect(screen.getByTestId("plugin-surface-reference-harness")).toBeVisible()
    )
    const cases = [...container.querySelectorAll("[data-reference-case]")].map((el) =>
      el.getAttribute("data-reference-case")
    )
    expect(cases).toEqual([
      "composer-action",
      "composer-menu",
      "context-panel",
      "context-webview",
      "modal",
      "view-container",
      "message-renderer",
      "tool-renderer",
      "quick-action",
      "config",
    ])
    expect(screen.getByTestId("production-view-container")).toHaveTextContent(
      `${PLUGIN_ID}:reference`
    )
    // The style-containment control: host DOM wearing the plugin's class name.
    expect(screen.getByTestId("host-ref-badge")).toHaveClass("ref-badge")
  })

  // Nothing in the harness can be dismissed — every surface stays mounted for
  // the whole spec run — so the config form's close is deliberately inert.
  it("keeps the config surface mounted when its form asks to close", async () => {
    plugins = { [PLUGIN_ID]: { status: "enabled" } }
    seedRegistries()
    const { container } = renderHarness()

    const close = await screen.findByTestId("config-close")
    await act(async () => {
      close.click()
    })
    expect(container.querySelector('[data-reference-case="config"]')).not.toBeNull()
  })

  it("omits the surfaces whose registry entries are absent", async () => {
    plugins = { [PLUGIN_ID]: { status: "enabled" } }
    const { container } = renderHarness()

    await waitFor(() =>
      expect(screen.getByTestId("plugin-surface-reference-harness")).toBeVisible()
    )
    for (const id of ["context-panel", "context-webview"]) {
      expect(container.querySelector(`[data-reference-case="${id}"]`)).toBeNull()
    }
    // The registry-independent hosts still mount.
    expect(container.querySelector('[data-reference-case="modal"]')).not.toBeNull()
    expect(container.querySelector('[data-reference-case="view-container"]')).not.toBeNull()
  })

  it("opens the declared modal exactly once and closes it on unmount", async () => {
    plugins = { [PLUGIN_ID]: { status: "enabled" } }
    seedRegistries()
    const { rerender, unmount } = renderHarness()

    const { openDeclaredModal } = jest.requireMock<{ openDeclaredModal: jest.Mock }>(
      "@/stores/plugin-runtime/plugin-modal-store"
    )
    await waitFor(() => expect(openDeclaredModal).toHaveBeenCalledTimes(1))
    rerender(
      <NextIntlClientProvider locale="en" messages={{}}>
        <PluginSurfaceReferenceHarness force />
      </NextIntlClientProvider>
    )
    expect(openDeclaredModal).toHaveBeenCalledTimes(1)
    unmount()
    expect(closeAll).toHaveBeenCalled()
  })

  it("surfaces a boot failure when the modal never registers", async () => {
    plugins = { [PLUGIN_ID]: { status: "enabled" } }
    modalId = null
    seedRegistries()
    renderHarness()
    expect(await screen.findByTestId("plugin-surface-reference-error")).toHaveTextContent(
      "Reference modal did not register"
    )
  })

  it("applies the locale the query string asks for", async () => {
    window.history.replaceState({}, "", "/e2e/plugin-ui-surfaces?pluginSurfaceLocale=zh-CN")
    renderHarness()
    await waitFor(() => expect(setLanguage).toHaveBeenCalledWith("zh-CN"))
  })

  it("waits for settings hydration before applying the requested locale", async () => {
    mockSettingsLoaded = false
    const view = renderHarness()
    expect(setLanguage).not.toHaveBeenCalled()

    mockSettingsLoaded = true
    view.rerender(
      <NextIntlClientProvider locale="en" messages={{}}>
        <PluginSurfaceReferenceHarness force />
      </NextIntlClientProvider>
    )

    await waitFor(() => expect(setLanguage).toHaveBeenCalledWith("en"))
  })

  it("defaults to English when no locale is requested", async () => {
    renderHarness()
    await waitFor(() => expect(setLanguage).toHaveBeenCalledWith("en"))
  })

  it("reports a locale failure instead of rendering a half-booted harness", async () => {
    setLanguage.mockRejectedValueOnce(new Error("locale boom"))
    renderHarness()
    expect(await screen.findByTestId("plugin-surface-reference-error")).toHaveTextContent(
      "locale boom"
    )
  })

  it("reports a failure to enable the plugin", async () => {
    plugins = { [PLUGIN_ID]: { status: "disabled" } }
    enablePlugin.mockRejectedValueOnce(new Error("enable boom"))
    renderHarness()
    expect(await screen.findByTestId("plugin-surface-reference-error")).toHaveTextContent(
      "enable boom"
    )
  })
})
