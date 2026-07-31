import {
  CONTEXT_PANEL_WEBVIEW_CHANNEL,
  contextPanelWebviewEvent,
  contextPanelWebviewResponse,
  isContextPanelWebviewInbound,
} from "@/lib/plugin/bridge/context-panel-webview-protocol"

describe("context-panel webview protocol", () => {
  it("accepts well-formed requests and ready markers", () => {
    expect(
      isContextPanelWebviewInbound({
        channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
        kind: "request",
        id: 1,
        method: "setBadge",
        params: ["panel", 3],
      })
    ).toBe(true)
    expect(
      isContextPanelWebviewInbound({ channel: CONTEXT_PANEL_WEBVIEW_CHANNEL, kind: "ready" })
    ).toBe(true)
  })

  it("rejects traffic from other channels and malformed requests", () => {
    expect(isContextPanelWebviewInbound(null)).toBe(false)
    expect(isContextPanelWebviewInbound({ channel: "other", kind: "request" })).toBe(false)
    expect(
      isContextPanelWebviewInbound({ channel: CONTEXT_PANEL_WEBVIEW_CHANNEL, kind: "request" })
    ).toBe(false)
    expect(
      isContextPanelWebviewInbound({
        channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
        kind: "request",
        id: 1,
        method: "reveal",
        params: "not-an-array",
      })
    ).toBe(false)
  })

  it("builds response envelopes for both outcomes", () => {
    expect(contextPanelWebviewResponse(7, { ok: true, result: null })).toEqual({
      channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
      kind: "response",
      id: 7,
      ok: true,
      result: null,
    })
    expect(contextPanelWebviewResponse(8, { ok: false, error: "denied" })).toEqual({
      channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
      kind: "response",
      id: 8,
      ok: false,
      error: "denied",
    })
  })

  it("builds event envelopes", () => {
    expect(contextPanelWebviewEvent("visibility", { visible: true })).toEqual({
      channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
      kind: "event",
      event: "visibility",
      payload: { visible: true },
    })
  })
})
