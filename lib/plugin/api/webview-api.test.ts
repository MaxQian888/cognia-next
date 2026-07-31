import { createWebviewAPI } from "./webview-api"
import {
  getWebviewSnapshot,
  attachWebviewPoster,
  dispatchWebviewMessage,
  __resetWebviewsForTesting,
} from "@/lib/plugin/registries/webview-registry"

describe("createWebviewAPI", () => {
  afterEach(() => __resetWebviewsForTesting())

  it("creates a webview registered under the plugin + container", () => {
    const api = createWebviewAPI("p", { allowedDomains: ["api.example.com"] })
    const handle = api.create({ id: "dash", containerId: "explorer", html: "<h1>Hi</h1>" })
    expect(handle.id).toBe("p:dash")
    const [w] = getWebviewSnapshot()
    expect(w).toMatchObject({ pluginId: "p", viewId: "dash", containerId: "p:explorer" })
    expect(w.srcDoc).toContain("connect-src https://api.example.com")
    expect(w.srcDoc).toContain("<h1>Hi</h1>")
  })

  it("auto-generates an id when omitted", () => {
    const api = createWebviewAPI("p", undefined)
    const handle = api.create({ containerId: "c", html: "x" })
    expect(handle.id).toMatch(/^p:wv-/)
  })

  it("handle.postMessage routes through the registry poster", () => {
    const api = createWebviewAPI("p", undefined)
    const handle = api.create({ id: "d", containerId: "c", html: "x" })
    expect(handle.postMessage({ a: 1 })).toBe(false) // no frame yet
    const seen: unknown[] = []
    attachWebviewPoster("p:d", (data) => {
      seen.push(data)
      return true
    })
    expect(handle.postMessage({ a: 1 })).toBe(true)
    expect(seen).toEqual([{ a: 1 }])
  })

  it("handle.onMessage observes inbound messages", () => {
    const api = createWebviewAPI("p", undefined)
    const handle = api.create({ id: "d", containerId: "c", html: "x" })
    const got: unknown[] = []
    const off = handle.onMessage((m) => got.push(m.data))
    dispatchWebviewMessage("p:d", { data: "ping" })
    off()
    dispatchWebviewMessage("p:d", { data: "after" })
    expect(got).toEqual(["ping"])
  })

  it("handle.dispose removes the webview", () => {
    const api = createWebviewAPI("p", undefined)
    const handle = api.create({ id: "d", containerId: "c", html: "x" })
    expect(getWebviewSnapshot()).toHaveLength(1)
    handle.dispose()
    expect(getWebviewSnapshot()).toHaveLength(0)
  })
})
