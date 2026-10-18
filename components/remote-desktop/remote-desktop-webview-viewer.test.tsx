import { render, waitFor } from "@testing-library/react"

import {
  registerWebview,
  unregisterWebviewsByPlugin,
} from "@/lib/plugin/registries/webview-registry"

import type { RemoteDesktopRelayOptions } from "@/lib/remote-desktop/port-relay"

import { RemoteDesktopWebviewViewer } from "./remote-desktop-webview-viewer"

describe("RemoteDesktopWebviewViewer", () => {
  afterEach(() => unregisterWebviewsByPlugin("acme"))

  it("relays the session into the plugin's own webview frame", async () => {
    registerWebview({ pluginId: "acme", viewId: "viewer", srcDoc: "<p>viewer</p>" } as never)
    const stop = jest.fn()
    const startRelay = jest.fn((_options: RemoteDesktopRelayOptions) => stop)
    const onStatus = jest.fn()
    const onError = jest.fn()
    const { container, unmount } = render(
      <RemoteDesktopWebviewViewer
        pluginId="acme"
        viewId="viewer"
        title="Acme viewer"
        url="ws://127.0.0.1:4100/rd/ticket"
        mode="control"
        scaleToFit
        onStatus={onStatus}
        onError={onError}
        startRelay={startRelay}
      />
    )
    const iframe = container.querySelector("iframe")!
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("srcdoc")).not.toContain("ticket")
    await waitFor(() => expect(startRelay).toHaveBeenCalledTimes(1))
    expect(startRelay.mock.calls[0]![0]).toMatchObject({
      url: "ws://127.0.0.1:4100/rd/ticket",
      mode: "control",
    })
    const relay = startRelay.mock.calls[0]![0]
    unmount()
    expect(stop).toHaveBeenCalled()
    relay.onStatus("disconnected")
    expect(onStatus).not.toHaveBeenCalledWith("disconnected")
    expect(onError).not.toHaveBeenCalled()
  })

  it("reports a provider whose view is not registered", async () => {
    const onError = jest.fn()
    render(
      <RemoteDesktopWebviewViewer
        pluginId="acme"
        viewId="missing"
        title="x"
        url="ws://x"
        mode="view"
        scaleToFit
        onStatus={jest.fn()}
        onError={onError}
        startRelay={jest.fn()}
      />
    )
    await waitFor(() => expect(onError).toHaveBeenCalledWith("remote_desktop_viewer_invalid"))
  })
})
