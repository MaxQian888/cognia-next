import {
  __resetWebviewBridgeForTesting,
  acquireVsCodeApiPolyfillSource,
  asWebviewUri,
  attachHostFrame,
  createWebviewPanel,
  detachHostFrame,
  disposeWebviewPanel,
  disposeWebviewPanelsByExtension,
  getCspSource,
  getPanel,
  getState,
  listPanels,
  listPanelsByExtension,
  notifyViewStateChange,
  onDidChangeViewState,
  onDidDispose,
  onDidReceiveMessage,
  postMessageToWebview,
  setHtml,
  setResourceUriRoot,
  setState,
  setTitle,
  type HostFrame,
  type WebviewMessage,
} from "./webview-bridge"

function makeFakeFrame(panelId: string): HostFrame & {
  setDocs: string[]
  posts: WebviewMessage[]
  fire: (msg: WebviewMessage) => void
  destroyed: boolean
} {
  const setDocs: string[] = []
  const posts: WebviewMessage[] = []
  const listeners: Array<(msg: WebviewMessage) => void> = []
  let destroyed = false
  const fire = (msg: WebviewMessage) => listeners.forEach((l) => l(msg))
  return {
    panelId,
    setDocs,
    posts,
    fire,
    get destroyed() {
      return destroyed
    },
    setSrcDoc: (html) => {
      setDocs.push(html)
    },
    post: (msg) => {
      posts.push(msg)
    },
    onMessage: (listener) => {
      listeners.push(listener)
      return () => {
        const idx = listeners.indexOf(listener)
        if (idx >= 0) listeners.splice(idx, 1)
      }
    },
    destroy: () => {
      destroyed = true
    },
  }
}

describe("webview-bridge", () => {
  beforeEach(() => __resetWebviewBridgeForTesting())

  describe("panel CRUD", () => {
    it("creates a panel with default state", () => {
      const panel = createWebviewPanel({
        extensionId: "ext.a",
        viewType: "ext.a.sidebar",
        title: "Cline",
        type: "view",
        hostSlot: "sidebar.left",
        options: { enableScripts: true },
        initialHtml: "<p>hi</p>",
      })
      expect(panel.panelId).toBeDefined()
      expect(panel.visible).toBe(true)
      expect(panel.active).toBe(true)
      expect(panel.disposed).toBe(false)
      expect(getPanel(panel.panelId)).toBe(panel)
    })

    it("lists panels and filters by extension", () => {
      const a1 = createWebviewPanel({
        extensionId: "ext.a",
        viewType: "v1",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      const a2 = createWebviewPanel({
        extensionId: "ext.a",
        viewType: "v2",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      createWebviewPanel({
        extensionId: "ext.b",
        viewType: "v3",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      expect(listPanels()).toHaveLength(3)
      expect(
        listPanelsByExtension("ext.a")
          .map((p) => p.panelId)
          .sort()
      ).toEqual([a1.panelId, a2.panelId].sort())
    })

    it("disposes panels and fires onDidDispose synchronously", () => {
      const panel = createWebviewPanel({
        extensionId: "ext.a",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      const disposed = jest.fn()
      onDidDispose(panel.panelId, disposed)
      expect(disposeWebviewPanel(panel.panelId)).toBe(true)
      expect(disposed).toHaveBeenCalledTimes(1)
      expect(getPanel(panel.panelId)).toBeUndefined()
      // Second dispose is idempotent.
      expect(disposeWebviewPanel(panel.panelId)).toBe(false)
    })

    it("bulk-disposes by extension id", () => {
      createWebviewPanel({
        extensionId: "ext.a",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      createWebviewPanel({
        extensionId: "ext.a",
        viewType: "v2",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      createWebviewPanel({
        extensionId: "ext.b",
        viewType: "v3",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      expect(disposeWebviewPanelsByExtension("ext.a")).toBe(2)
    })

    it("survives a dispose listener that throws", () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const panel = createWebviewPanel({
          extensionId: "x",
          viewType: "v",
          title: "T",
          type: "panel",
          options: {},
          initialHtml: "",
        })
        onDidDispose(panel.panelId, () => {
          throw new Error("listener boom")
        })
        disposeWebviewPanel(panel.panelId)
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe("frame attachment", () => {
    it("replays the html on attach", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "<p>hi</p>",
      })
      const frame = makeFakeFrame(panel.panelId)
      attachHostFrame(panel.panelId, frame)
      expect(frame.setDocs).toEqual(["<p>hi</p>"])
    })

    it("setHtml retransmits to the attached frame", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "v1",
      })
      const frame = makeFakeFrame(panel.panelId)
      attachHostFrame(panel.panelId, frame)
      setHtml(panel.panelId, "v2")
      expect(frame.setDocs).toEqual(["v1", "v2"])
    })

    it("postMessageToWebview forwards via the frame", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      const frame = makeFakeFrame(panel.panelId)
      attachHostFrame(panel.panelId, frame)
      expect(postMessageToWebview(panel.panelId, { hi: 1 })).toBe(true)
      expect(frame.posts).toEqual([{ data: { hi: 1 } }])
    })

    it("postMessageToWebview returns false when no frame is attached", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      expect(postMessageToWebview(panel.panelId, { x: 1 })).toBe(false)
    })

    it("onDidReceiveMessage hears messages from the frame", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      const frame = makeFakeFrame(panel.panelId)
      attachHostFrame(panel.panelId, frame)
      const received: WebviewMessage[] = []
      onDidReceiveMessage(panel.panelId, (msg) => received.push(msg))
      frame.fire({ data: { kind: "hello" } })
      expect(received).toEqual([{ data: { kind: "hello" } }])
    })

    it("detachHostFrame stops further deliveries", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      const frame = makeFakeFrame(panel.panelId)
      attachHostFrame(panel.panelId, frame)
      detachHostFrame(panel.panelId)
      expect(postMessageToWebview(panel.panelId, { x: 1 })).toBe(false)
    })

    it("attachHostFrame on a disposed panel destroys the frame immediately", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      disposeWebviewPanel(panel.panelId)
      const frame = makeFakeFrame(panel.panelId)
      attachHostFrame(panel.panelId, frame)
      expect(frame.destroyed).toBe(true)
    })

    it("replaces an existing frame on reattach", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "v1",
      })
      const first = makeFakeFrame(panel.panelId)
      const second = makeFakeFrame(panel.panelId)
      attachHostFrame(panel.panelId, first)
      attachHostFrame(panel.panelId, second)
      expect(second.setDocs).toEqual(["v1"])
    })
  })

  describe("state retention", () => {
    it("round-trips webview-side state through setState / getState", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: { retainContextWhenHidden: true },
        initialHtml: "",
      })
      expect(getState(panel.panelId)).toBeUndefined()
      setState(panel.panelId, { cursor: 7 })
      expect(getState(panel.panelId)).toEqual({ cursor: 7 })
    })

    it("ignores state writes against a disposed panel", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      disposeWebviewPanel(panel.panelId)
      setState(panel.panelId, { a: 1 })
      expect(getState(panel.panelId)).toBeUndefined()
    })
  })

  describe("title + view state events", () => {
    it("setTitle updates the record", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "old",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      setTitle(panel.panelId, "new")
      expect(getPanel(panel.panelId)?.title).toBe("new")
    })

    it("notifyViewStateChange fires listeners", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      const events: Array<{ visible: boolean; active: boolean }> = []
      onDidChangeViewState(panel.panelId, (e) =>
        events.push({ visible: e.visible, active: e.active })
      )
      notifyViewStateChange(panel.panelId, false, false)
      notifyViewStateChange(panel.panelId, true, true)
      expect(events).toEqual([
        { visible: false, active: false },
        { visible: true, active: true },
      ])
    })

    it("no-ops when the state didn't actually change", () => {
      const panel = createWebviewPanel({
        extensionId: "x",
        viewType: "v",
        title: "T",
        type: "panel",
        options: {},
        initialHtml: "",
      })
      const events: number[] = []
      onDidChangeViewState(panel.panelId, () => events.push(1))
      notifyViewStateChange(panel.panelId, true, true)
      expect(events).toHaveLength(0)
    })
  })

  describe("uri / csp helpers", () => {
    it("asWebviewUri prefixes the resource scheme", () => {
      expect(asWebviewUri("file:///etc/passwd")).toContain("cognia-webview://")
    })

    it("asWebviewUri is idempotent for already-prefixed URIs", () => {
      expect(asWebviewUri("cognia-webview://x")).toBe("cognia-webview://x")
    })

    it("setResourceUriRoot reconfigures the scheme", () => {
      setResourceUriRoot("https://cdn.cognia/")
      expect(asWebviewUri("file:///x")).toContain("https://cdn.cognia/")
      expect(getCspSource()).toBe("https://cdn.cognia/")
    })

    it("acquireVsCodeApiPolyfillSource emits valid JS", () => {
      const src = acquireVsCodeApiPolyfillSource()
      expect(src).toContain("window.acquireVsCodeApi")
      expect(src).toContain("postMessage")
      expect(src).toContain("setState")
    })
  })
})
