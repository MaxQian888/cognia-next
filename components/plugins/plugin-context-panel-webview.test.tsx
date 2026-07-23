import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import {
  CONTEXT_PANEL_WEBVIEW_CHANNEL,
  contextPanelWebviewEvent,
} from "@/lib/plugin/bridge/context-panel-webview-protocol"
import {
  __resetWebviewsForTesting,
  dispatchWebviewMessage,
  registerWebview,
} from "@/lib/plugin/registries/webview-registry"
import type { ContextResource } from "@/types/context-workbench"
import { createContextPanelWebviewRenderer } from "./plugin-context-panel-webview"

const messages = {
  contextWorkbench: {
    webviewPanelPending: "This panel's webview has not loaded yet.",
  },
}

const resource: ContextResource = {
  kind: "session",
  sessionId: "session-1",
  capabilities: [],
}

function renderPanel(active: boolean) {
  const Renderer = createContextPanelWebviewRenderer("demo", "inspector", "Inspector")
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Renderer workbenchInstanceId="window-a" resource={resource} active={active} />
    </NextIntlClientProvider>
  )
  const rerender = (nextActive: boolean) =>
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Renderer workbenchInstanceId="window-a" resource={resource} active={nextActive} />
      </NextIntlClientProvider>
    )
  return { ...view, rerenderActive: rerender }
}

function registerInspectorWebview() {
  registerWebview({
    pluginId: "demo",
    viewId: "inspector",
    title: "Inspector",
    surface: "panel",
    srcDoc: "<!doctype html><html><body>inspector</body></html>",
  })
}

describe("createContextPanelWebviewRenderer", () => {
  beforeEach(() => {
    __resetWebviewsForTesting()
  })

  it("renders a pending placeholder until the referenced webview resolves", async () => {
    const { container } = renderPanel(true)
    expect(screen.getByText("This panel's webview has not loaded yet.")).toBeInTheDocument()
    expect(container.querySelector("iframe")).toBeNull()

    // Registration lands later (context-panel bridge runs before the webview
    // bridge); the panel must pick it up from the registry subscription.
    await act(async () => {
      registerInspectorWebview()
      await Promise.resolve()
    })

    const iframe = container.querySelector("iframe")
    expect(iframe).not.toBeNull()
    expect(iframe).toHaveAttribute("data-plugin-webview", "demo:inspector")
  })

  it("pushes visibility into its own frame when active flips", async () => {
    await act(async () => {
      registerInspectorWebview()
      await Promise.resolve()
    })
    const { container, rerenderActive } = renderPanel(true)
    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    const postSpy = jest.spyOn(iframe.contentWindow as Window, "postMessage")

    rerenderActive(false)

    expect(postSpy).toHaveBeenCalledWith(
      { __cogniaWebview: "host", data: contextPanelWebviewEvent("visibility", { visible: false }) },
      "*"
    )
  })

  it("pushes visibility:false from its effect cleanup — the only signal under Activity-hidden", async () => {
    // React `<Activity mode="hidden">` tears effects down while keeping the
    // DOM, so a stateful panel leaving the screen is observed as this
    // component's effect CLEANUP, never as an `active={false}` render.
    await act(async () => {
      registerInspectorWebview()
      await Promise.resolve()
    })
    const { container, unmount } = renderPanel(true)
    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    const postSpy = jest.spyOn(iframe.contentWindow as Window, "postMessage")

    unmount()

    expect(postSpy).toHaveBeenCalledWith(
      { __cogniaWebview: "host", data: contextPanelWebviewEvent("visibility", { visible: false }) },
      "*"
    )
  })

  it("re-sends current visibility when the frame reports ready", async () => {
    await act(async () => {
      registerInspectorWebview()
      await Promise.resolve()
    })
    const { container } = renderPanel(true)
    const iframe = container.querySelector("iframe") as HTMLIFrameElement
    const postSpy = jest.spyOn(iframe.contentWindow as Window, "postMessage")

    act(() => {
      dispatchWebviewMessage("demo:inspector", {
        data: { channel: CONTEXT_PANEL_WEBVIEW_CHANNEL, kind: "ready" },
      })
    })

    expect(postSpy).toHaveBeenCalledWith(
      { __cogniaWebview: "host", data: contextPanelWebviewEvent("visibility", { visible: true }) },
      "*"
    )
  })
})
