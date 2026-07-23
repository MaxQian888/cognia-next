import {
  __resetContextPanelWebviewRpcForTesting,
  attachContextPanelWebviewRpc,
} from "@/lib/plugin/bridge/context-panel-webview-rpc"
import {
  CONTEXT_PANEL_WEBVIEW_CHANNEL,
  type ContextPanelWebviewEvent,
  type ContextPanelWebviewResponse,
} from "@/lib/plugin/bridge/context-panel-webview-protocol"
import {
  __resetWebviewsForTesting,
  attachWebviewPoster,
  dispatchWebviewMessage,
} from "@/lib/plugin/registries/webview-registry"
import {
  resetActiveContextForTesting,
  setActiveContextForHost,
} from "@/lib/context-workbench/active-context"
import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import type { ContextResource } from "@/types/context-workbench"

const FULL_ID = "demo:inspector"

const sessionResource: ContextResource = {
  kind: "session",
  sessionId: "session-1",
  capabilities: [],
}

function request(id: number, method: string, params?: unknown[]) {
  dispatchWebviewMessage(FULL_ID, {
    data: { channel: CONTEXT_PANEL_WEBVIEW_CHANNEL, kind: "request", id, method, params },
  })
}

describe("attachContextPanelWebviewRpc", () => {
  let outbound: Array<ContextPanelWebviewResponse | ContextPanelWebviewEvent>
  let detachPoster: () => void

  const responses = () =>
    outbound.filter((m): m is ContextPanelWebviewResponse => m.kind === "response")
  const events = () => outbound.filter((m): m is ContextPanelWebviewEvent => m.kind === "event")

  beforeEach(() => {
    outbound = []
    detachPoster = attachWebviewPoster(FULL_ID, (data) => {
      outbound.push(data as ContextPanelWebviewResponse | ContextPanelWebviewEvent)
      return true
    })
  })

  afterEach(() => {
    detachPoster()
    __resetContextPanelWebviewRpcForTesting()
    __resetWebviewsForTesting()
    resetActiveContextForTesting()
    contextPanelRegistry.unregisterPlugin("demo")
  })

  it("answers requests with response envelopes", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    request(1, "getActiveContext")
    expect(responses()).toEqual([expect.objectContaining({ id: 1, ok: true, result: null })])
    release()
  })

  it("mirrors every data method through the dispatch table", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    const releaseHost = setActiveContextForHost("scope-a", sessionResource)
    outbound = []

    request(1, "reveal", ["missing-panel", "wide"])
    request(2, "setBadge", ["missing-panel", 3])
    request(3, "getWorkbenchState")
    request(4, "setMode", ["wide"])
    request(5, "setPinned", [true])
    // No params at all — the `params ?? []` arm.
    request(6, "getActiveContext")
    request(7, "dispose", ["never-registered"])

    expect(responses()).toEqual([
      // No such panel is registered, so the writes answer `false` — but they
      // answered, which is what the dispatch table owes each method.
      expect.objectContaining({ id: 1, ok: true, result: false }),
      expect.objectContaining({ id: 2, ok: true, result: false }),
      expect.objectContaining({ id: 3, ok: true, result: null }),
      expect.objectContaining({ id: 4, ok: true, result: false }),
      expect.objectContaining({ id: 5, ok: true, result: false }),
      expect.objectContaining({
        id: 6,
        ok: true,
        result: expect.objectContaining({ kind: "session" }),
      }),
      expect.objectContaining({ id: 7, ok: true, result: false }),
    ])

    releaseHost()
    release()
  })

  it("rejects a malformed register payload without registering anything", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    request(1, "register", [{ id: "extra" }])
    request(2, "register", ["not-an-object"])
    expect(responses()).toEqual([
      expect.objectContaining({ id: 1, ok: false, error: expect.stringContaining("register") }),
      expect.objectContaining({ id: 2, ok: false, error: expect.stringContaining("register") }),
    ])
    expect(contextPanelRegistry.get("demo:extra")).toBeUndefined()
    release()
  })

  it("registers a webview-backed panel over RPC and disposes it", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })

    request(1, "register", [
      {
        id: "extra",
        webview: "extra-view",
        label: "Extra",
        labelKey: "panels.extra",
        resourceKinds: ["session"],
        activity: "inspect",
      },
    ])

    const [response] = responses()
    expect(response).toEqual(expect.objectContaining({ id: 1, ok: true }))
    const registrationId = response.ok ? (response.result as string) : ""
    expect(contextPanelRegistry.get("demo:extra")).toBeDefined()

    request(2, "dispose", [registrationId])
    expect(responses()[1]).toEqual(expect.objectContaining({ id: 2, ok: true, result: true }))
    expect(contextPanelRegistry.get("demo:extra")).toBeUndefined()
    release()
  })

  it("surfaces permission denial as an error response", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => false,
    })
    request(1, "register", [
      {
        id: "extra",
        webview: "extra-view",
        label: "Extra",
        labelKey: "panels.extra",
        resourceKinds: ["session"],
        activity: "inspect",
      },
    ])
    expect(responses()).toEqual([
      expect.objectContaining({ id: 1, ok: false, error: expect.stringContaining("Permission") }),
    ])
    expect(contextPanelRegistry.get("demo:extra")).toBeUndefined()
    release()
  })

  it("rejects unknown methods without crashing the channel", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    request(1, "explode")
    request(2, "getActiveContext")
    expect(responses()).toEqual([
      expect.objectContaining({ id: 1, ok: false, error: expect.stringContaining("explode") }),
      expect.objectContaining({ id: 2, ok: true }),
    ])
    release()
  })

  it("pushes activeContext changes and replays a snapshot on ready", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })

    const releaseHost = setActiveContextForHost("scope-a", sessionResource)
    expect(events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "activeContext",
          payload: expect.objectContaining({ kind: "session", sessionId: "session-1" }),
        }),
      ])
    )

    outbound = []
    dispatchWebviewMessage(FULL_ID, {
      data: { channel: CONTEXT_PANEL_WEBVIEW_CHANNEL, kind: "ready" },
    })
    expect(events().map((e) => e.event)).toEqual(["activeContext", "workbenchState"])

    releaseHost()
    release()
  })

  it("is refcounted per webview and stops answering after the last release", () => {
    const releaseFirst = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    const releaseSecond = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })

    request(1, "getActiveContext")
    // One server despite two attachments — exactly one response.
    expect(responses()).toHaveLength(1)

    releaseFirst()
    request(2, "getActiveContext")
    expect(responses()).toHaveLength(2)

    releaseSecond()
    request(3, "getActiveContext")
    expect(responses()).toHaveLength(2)
  })

  it("a release is idempotent — double-release cannot steal a later attachment", () => {
    const releaseFirst = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    releaseFirst()
    releaseFirst()

    const releaseSecond = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    request(1, "getActiveContext")
    expect(responses()).toHaveLength(1)
    releaseSecond()
  })

  it("stringifies non-Error throws into the error response", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    request(1, "register", [
      {
        get id(): string {
          throw "string-boom"
        },
      },
    ])
    expect(responses()).toEqual([
      expect.objectContaining({ id: 1, ok: false, error: "string-boom" }),
    ])
    release()
  })

  it("ignores traffic from other channels", () => {
    const release = attachContextPanelWebviewRpc("demo", "inspector", {
      hasPermission: () => true,
    })
    dispatchWebviewMessage(FULL_ID, { data: { channel: "other", kind: "request", id: 1 } })
    dispatchWebviewMessage(FULL_ID, { data: "not an envelope" })
    expect(outbound).toHaveLength(0)
    release()
  })
})
