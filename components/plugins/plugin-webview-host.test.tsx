/**
 * @jest-environment jsdom
 */

import { render, act } from "@testing-library/react"
import { PluginWebviewHost } from "./plugin-webview-host"
import {
  postMessageToWebview,
  onWebviewMessage,
  __resetWebviewsForTesting,
} from "@/lib/plugin/registries/webview-registry"

afterEach(() => __resetWebviewsForTesting())

describe("PluginWebviewHost", () => {
  it("renders a sandboxed iframe WITHOUT allow-same-origin", () => {
    const { container } = render(
      <PluginWebviewHost fullId="p:dash" srcDoc="<h1>Hi</h1>" title="Dash" />
    )
    const iframe = container.querySelector("iframe")!
    expect(iframe).not.toBeNull()
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    // The critical security property: opaque origin (no same-origin escape).
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>Hi</h1>")
    expect(iframe.getAttribute("data-plugin-webview")).toBe("p:dash")
  })

  it("installs a poster so the plugin can post into the iframe", () => {
    render(<PluginWebviewHost fullId="p:dash" srcDoc="x" />)
    // contentWindow.postMessage is a no-op in jsdom but the poster returns true.
    expect(postMessageToWebview("p:dash", { hello: 1 })).toBe(true)
  })

  it("forwards iframe→host messages from this frame to registry listeners", () => {
    const { container } = render(<PluginWebviewHost fullId="p:dash" srcDoc="x" />)
    const iframe = container.querySelector("iframe")!
    const got: unknown[] = []
    onWebviewMessage("p:dash", (m) => got.push(m.data))

    act(() => {
      const evt = new MessageEvent("message", {
        data: { __cogniaWebview: "post", data: { ok: true } },
        source: iframe.contentWindow,
      })
      window.dispatchEvent(evt)
    })
    expect(got).toEqual([{ ok: true }])
  })

  it("ignores messages whose source is not this iframe (anti-spoof)", () => {
    render(<PluginWebviewHost fullId="p:dash" srcDoc="x" />)
    const got: unknown[] = []
    onWebviewMessage("p:dash", (m) => got.push(m.data))
    act(() => {
      // source defaults to null (not the iframe) → must be ignored.
      window.dispatchEvent(
        new MessageEvent("message", { data: { __cogniaWebview: "post", data: "spoof" } })
      )
    })
    expect(got).toEqual([])
  })

  it("detaches the poster on unmount", () => {
    const { unmount } = render(<PluginWebviewHost fullId="p:dash" srcDoc="x" />)
    expect(postMessageToWebview("p:dash", {})).toBe(true)
    unmount()
    expect(postMessageToWebview("p:dash", {})).toBe(false)
  })
})
