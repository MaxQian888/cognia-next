import {
  registerWebview,
  unregisterWebviewsByPlugin,
  getWebview,
  getWebviewSnapshot,
  listWebviewsForContainer,
  subscribeWebviews,
  attachWebviewPoster,
  postMessageToWebview,
  dispatchWebviewMessage,
  onWebviewMessage,
  getWebviewState,
  setWebviewState,
  __resetWebviewsForTesting,
} from "./webview-registry"
import type { ResolvedPluginWebview } from "@/types/plugin/plugin-webview"

function wv(over?: Partial<ResolvedPluginWebview>): ResolvedPluginWebview {
  return {
    pluginId: "p",
    viewId: "dash",
    containerId: "p:explorer",
    surface: "panel",
    srcDoc: "<html></html>",
    ...over,
  }
}

describe("webview-registry", () => {
  afterEach(() => __resetWebviewsForTesting())

  it("registers and lists webviews by container", () => {
    registerWebview(wv())
    expect(getWebview("p:dash")).toMatchObject({ viewId: "dash" })
    expect(listWebviewsForContainer("p:explorer").map((w) => w.viewId)).toEqual(["dash"])
    expect(listWebviewsForContainer("none")).toEqual([])
  })

  it("snapshot is identity-stable until mutation", () => {
    registerWebview(wv())
    const a = getWebviewSnapshot()
    expect(getWebviewSnapshot()).toBe(a)
    registerWebview(wv({ viewId: "other" }))
    expect(getWebviewSnapshot()).not.toBe(a)
  })

  it("disposer + bulk unregister remove webviews", () => {
    const dispose = registerWebview(wv())
    registerWebview(wv({ viewId: "two" }))
    dispose()
    expect(getWebview("p:dash")).toBeUndefined()
    registerWebview(wv({ pluginId: "q", viewId: "z", containerId: "q:c" }))
    expect(unregisterWebviewsByPlugin("p")).toBe(1)
    expect(getWebviewSnapshot().map((w) => w.pluginId)).toEqual(["q"])
  })

  it("notifies subscribers", async () => {
    let calls = 0
    const unsub = subscribeWebviews(() => calls++)
    registerWebview(wv())
    await Promise.resolve()
    unsub()
    registerWebview(wv({ viewId: "x" }))
    await Promise.resolve()
    expect(calls).toBe(1)
  })

  describe("messaging", () => {
    it("posts to a webview only when a poster is attached", () => {
      registerWebview(wv())
      expect(postMessageToWebview("p:dash", { a: 1 })).toBe(false)
      const received: unknown[] = []
      const detach = attachWebviewPoster("p:dash", (data) => {
        received.push(data)
        return true
      })
      expect(postMessageToWebview("p:dash", { a: 1 })).toBe(true)
      expect(received).toEqual([{ a: 1 }])
      detach()
      expect(postMessageToWebview("p:dash", { a: 2 })).toBe(false)
    })

    it("dispatches inbound messages to subscribers", () => {
      registerWebview(wv())
      const got: unknown[] = []
      const off = onWebviewMessage("p:dash", (m) => got.push(m.data))
      dispatchWebviewMessage("p:dash", { data: "hi" })
      off()
      dispatchWebviewMessage("p:dash", { data: "ignored" })
      expect(got).toEqual(["hi"])
    })

    it("a throwing poster is caught and returns false", () => {
      registerWebview(wv())
      attachWebviewPoster("p:dash", () => {
        throw new Error("boom")
      })
      expect(postMessageToWebview("p:dash", {})).toBe(false)
    })

    it("fans a message out to every attached poster", () => {
      // The mobile sheet force-mounts a second workbench, so the same webview
      // can have two live iframes; both must receive pushes.
      registerWebview(wv())
      const first: unknown[] = []
      const second: unknown[] = []
      const detachFirst = attachWebviewPoster("p:dash", (data) => {
        first.push(data)
        return true
      })
      attachWebviewPoster("p:dash", (data) => {
        second.push(data)
        return true
      })

      expect(postMessageToWebview("p:dash", { n: 1 })).toBe(true)
      expect(first).toEqual([{ n: 1 }])
      expect(second).toEqual([{ n: 1 }])

      detachFirst()
      expect(postMessageToWebview("p:dash", { n: 2 })).toBe(true)
      expect(first).toEqual([{ n: 1 }])
      expect(second).toEqual([{ n: 1 }, { n: 2 }])
    })

    it("keeps set-state across frame remounts but drops it with the plugin", () => {
      const dispose = registerWebview(wv())
      setWebviewState("p:dash", { draft: "hello" })
      // Posters/frames come and go; state survives them (it lives here, not on
      // the frame) …
      expect(getWebviewState("p:dash")).toEqual({ draft: "hello" })
      // … but not past the webview itself.
      dispose()
      expect(getWebviewState("p:dash")).toBeUndefined()

      registerWebview(wv())
      setWebviewState("p:dash", 1)
      unregisterWebviewsByPlugin("p")
      expect(getWebviewState("p:dash")).toBeUndefined()
    })

    it("one throwing poster does not starve the others", () => {
      registerWebview(wv())
      attachWebviewPoster("p:dash", () => {
        throw new Error("boom")
      })
      const received: unknown[] = []
      attachWebviewPoster("p:dash", (data) => {
        received.push(data)
        return true
      })
      expect(postMessageToWebview("p:dash", { ok: true })).toBe(true)
      expect(received).toEqual([{ ok: true }])
    })
  })
})
