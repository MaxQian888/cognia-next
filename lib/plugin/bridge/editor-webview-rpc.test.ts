jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ requestReveal: jest.fn() }) },
}))

import {
  __resetEditorWebviewRpcForTesting,
  attachEditorWebviewRpc,
} from "@/lib/plugin/bridge/editor-webview-rpc"
import {
  EDITOR_WEBVIEW_CHANNEL,
  type EditorWebviewEvent,
  type EditorWebviewResponse,
} from "@/lib/plugin/bridge/editor-webview-protocol"
import {
  __resetWebviewsForTesting,
  attachWebviewPoster,
  dispatchWebviewMessage,
} from "@/lib/plugin/registries/webview-registry"
import {
  __resetProjectEditorBridgeForTesting,
  notifyActiveEditorChanged,
  registerProjectEditorOpener,
} from "@/lib/files/project-editor-bridge"
import { __setEditorPiiGateForTesting } from "@/lib/plugin/api/editor-api"

const FULL_ID = "demo:panel"
const ALL = () => true
const NONE = () => false

function request(id: number, method: string, params?: unknown[]) {
  dispatchWebviewMessage(FULL_ID, {
    data: { channel: EDITOR_WEBVIEW_CHANNEL, kind: "request", id, method, params },
  })
}

/** Let the RPC server's async handler settle. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("attachEditorWebviewRpc", () => {
  let outbound: Array<EditorWebviewResponse | EditorWebviewEvent>
  let detachPoster: () => void

  const responses = () => outbound.filter((m): m is EditorWebviewResponse => m.kind === "response")
  const events = () => outbound.filter((m): m is EditorWebviewEvent => m.kind === "event")

  beforeEach(() => {
    outbound = []
    __resetEditorWebviewRpcForTesting()
    __resetWebviewsForTesting()
    __resetProjectEditorBridgeForTesting()
    __setEditorPiiGateForTesting(ALL)
    detachPoster = attachWebviewPoster(FULL_ID, (data) => {
      outbound.push(data as EditorWebviewResponse | EditorWebviewEvent)
      // The registry treats the return as "a frame took it"; returning nothing
      // reads as an undelivered post.
      return true
    })
  })

  afterEach(() => {
    detachPoster()
    __resetEditorWebviewRpcForTesting()
    __setEditorPiiGateForTesting(null)
  })

  it("mirrors readActive through the host API", async () => {
    registerProjectEditorOpener({
      root: "/repo",
      open: jest.fn(),
      readActive: async () => ({
        path: "/repo/a.ts",
        selection: null,
        selectedText: null,
        diagnostics: [],
        openEditors: ["/repo/a.ts"],
      }),
    })
    attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })

    request(1, "readActive")
    await drain()

    expect(responses()[0]).toMatchObject({ id: 1, ok: true })
    expect((responses()[0].result as { path: string }).path).toBe("/repo/a.ts")
  })

  it("mirrors openFile and reports what actually happened", async () => {
    const open = jest.fn()
    registerProjectEditorOpener({ root: "/repo", open })
    attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })

    request(2, "openFile", ["/repo/a.ts", { line: 5 }])
    await drain()

    expect(responses()[0]).toMatchObject({ id: 2, ok: true, result: "opened" })
    expect(open).toHaveBeenCalledWith("a.ts", 5, undefined)
  })

  it("applies the host's permission gate rather than a second one of its own", async () => {
    // A sandboxed surface must never be able to out-reach the module surface it
    // mirrors, so the failure comes from `createEditorAPI` itself.
    attachEditorWebviewRpc("demo", "panel", { hasPermission: NONE })

    request(3, "readActive")
    await drain()

    expect(responses()[0]).toMatchObject({ id: 3, ok: false })
    expect(responses()[0].error).toMatch(/editor:read/)
  })

  it("fails closed when no permission resolver is wired at all", async () => {
    attachEditorWebviewRpc("demo", "panel", { hasPermission: () => false })

    request(4, "openFile", ["/repo/a.ts"])
    await drain()

    expect(responses()[0]).toMatchObject({ ok: false })
    expect(responses()[0].error).toMatch(/editor:write/)
  })

  it("rejects an unknown method instead of silently succeeding", async () => {
    attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })

    request(5, "deleteEverything")
    await drain()

    expect(responses()[0]).toMatchObject({ id: 5, ok: false })
    expect(responses()[0].error).toMatch(/Unknown editor method/)
  })

  it("pushes a payload-free change event", () => {
    attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })
    outbound.length = 0

    notifyActiveEditorChanged()

    expect(events()).toEqual([
      { channel: EDITOR_WEBVIEW_CHANNEL, kind: "event", event: "activeEditorChanged" },
    ])
  })

  it("does not push change events to a frame without editor:read", () => {
    attachEditorWebviewRpc("demo", "panel", { hasPermission: NONE })
    outbound.length = 0

    notifyActiveEditorChanged()

    expect(events()).toEqual([])
  })

  it("ignores traffic on the context-panel channel", async () => {
    attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })

    dispatchWebviewMessage(FULL_ID, {
      data: { channel: "cognia.contextPanel", kind: "request", id: 9, method: "readActive" },
    })
    await drain()

    expect(responses()).toEqual([])
  })

  it("refcounts so one release does not deafen a second attachment", () => {
    const releaseA = attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })
    attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })
    outbound.length = 0

    releaseA()
    notifyActiveEditorChanged()

    expect(events()).toHaveLength(1)
  })

  it("stops pushing once the last reference is released", () => {
    const release = attachEditorWebviewRpc("demo", "panel", { hasPermission: ALL })
    release()
    outbound.length = 0

    notifyActiveEditorChanged()

    expect(events()).toEqual([])
  })
})
