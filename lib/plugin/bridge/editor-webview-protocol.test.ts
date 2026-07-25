import {
  EDITOR_WEBVIEW_CHANNEL,
  editorWebviewEvent,
  editorWebviewResponse,
  isEditorWebviewInbound,
} from "./editor-webview-protocol"

const request = (over: Record<string, unknown> = {}) => ({
  channel: EDITOR_WEBVIEW_CHANNEL,
  kind: "request",
  id: 1,
  method: "readActive",
  ...over,
})

describe("isEditorWebviewInbound", () => {
  it("accepts a well-formed request", () => {
    expect(isEditorWebviewInbound(request())).toBe(true)
    expect(isEditorWebviewInbound(request({ params: ["/a.ts"] }))).toBe(true)
  })

  it("accepts the ready handshake", () => {
    expect(isEditorWebviewInbound({ channel: EDITOR_WEBVIEW_CHANNEL, kind: "ready" })).toBe(true)
  })

  it("rejects traffic on the context-panel channel", () => {
    // The two channels are deliberately separate so panel-rendering plugins do
    // not inherit editor access; a server that accepted the other channel's
    // envelopes would erase that boundary.
    expect(isEditorWebviewInbound({ ...request(), channel: "cognia.contextPanel" })).toBe(false)
  })

  it("rejects anything that is not an envelope", () => {
    expect(isEditorWebviewInbound(null)).toBe(false)
    expect(isEditorWebviewInbound("readActive")).toBe(false)
    expect(isEditorWebviewInbound({})).toBe(false)
  })

  it("rejects malformed requests", () => {
    expect(isEditorWebviewInbound(request({ id: "1" }))).toBe(false)
    expect(isEditorWebviewInbound(request({ method: 7 }))).toBe(false)
    expect(isEditorWebviewInbound(request({ params: "not-an-array" }))).toBe(false)
    expect(isEditorWebviewInbound(request({ kind: "response" }))).toBe(false)
  })
})

describe("envelopes", () => {
  it("builds a payload-free change event", () => {
    // Payload-free on purpose: a snapshot pushed here would reach the frame
    // without the host's PII screen or an `editor:read` re-check.
    expect(editorWebviewEvent("activeEditorChanged")).toEqual({
      channel: EDITOR_WEBVIEW_CHANNEL,
      kind: "event",
      event: "activeEditorChanged",
    })
  })

  it("builds success and failure responses", () => {
    expect(editorWebviewResponse(3, { ok: true, result: "opened" })).toEqual({
      channel: EDITOR_WEBVIEW_CHANNEL,
      kind: "response",
      id: 3,
      ok: true,
      result: "opened",
    })
    expect(editorWebviewResponse(4, { ok: false, error: "denied" })).toEqual({
      channel: EDITOR_WEBVIEW_CHANNEL,
      kind: "response",
      id: 4,
      ok: false,
      error: "denied",
    })
  })
})
