/**
 * Wire protocol between a webview-backed context panel's iframe and the host.
 *
 * Envelopes ride inside the existing generic webview transport — iframe→host
 * as `acquireCogniaWebviewApi().postMessage(<envelope>)` (surfacing here as
 * `PluginWebviewMessage.data`) and host→iframe as
 * `postMessageToWebview(fullId, <envelope>)` (arriving in the frame as
 * `{ __cogniaWebview: "host", data: <envelope> }`). The `channel` field keeps
 * this traffic distinguishable from whatever else the plugin sends over the
 * same pipe.
 *
 * Lives in its own module because both ends of the host code need it — the
 * RPC server (`context-panel-webview-rpc.ts`) and the panel renderer
 * (`components/plugins/plugin-context-panel-webview.tsx`) — and importing one
 * from the other would be a cycle.
 */

export const CONTEXT_PANEL_WEBVIEW_CHANNEL = "cognia.contextPanel"

/** iframe → host: invoke one context-panel API method. */
export interface ContextPanelWebviewRequest {
  channel: typeof CONTEXT_PANEL_WEBVIEW_CHANNEL
  kind: "request"
  id: number
  method: string
  /** Positional arguments matching the mirrored method's signature. */
  params?: unknown[]
}

/**
 * iframe → host: the in-frame client finished attaching its message listener.
 * The host replies with a snapshot of every pushed event so the frame never
 * misses state that changed before it was listening.
 */
export interface ContextPanelWebviewReady {
  channel: typeof CONTEXT_PANEL_WEBVIEW_CHANNEL
  kind: "ready"
}

export type ContextPanelWebviewInbound = ContextPanelWebviewRequest | ContextPanelWebviewReady

/** host → iframe: outcome of one request. */
export interface ContextPanelWebviewResponse {
  channel: typeof CONTEXT_PANEL_WEBVIEW_CHANNEL
  kind: "response"
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

export type ContextPanelWebviewEventName = "activeContext" | "workbenchState" | "visibility"

/** host → iframe: pushed state change. */
export interface ContextPanelWebviewEvent {
  channel: typeof CONTEXT_PANEL_WEBVIEW_CHANNEL
  kind: "event"
  event: ContextPanelWebviewEventName
  payload: unknown
}

function isEnvelope(data: unknown): data is { channel: unknown; kind: unknown } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { channel?: unknown }).channel === CONTEXT_PANEL_WEBVIEW_CHANNEL
  )
}

export function isContextPanelWebviewInbound(data: unknown): data is ContextPanelWebviewInbound {
  if (!isEnvelope(data)) return false
  const kind = (data as { kind?: unknown }).kind
  if (kind === "ready") return true
  if (kind !== "request") return false
  const request = data as Partial<ContextPanelWebviewRequest>
  return (
    typeof request.id === "number" &&
    typeof request.method === "string" &&
    (request.params === undefined || Array.isArray(request.params))
  )
}

export function contextPanelWebviewEvent(
  event: ContextPanelWebviewEventName,
  payload: unknown
): ContextPanelWebviewEvent {
  return { channel: CONTEXT_PANEL_WEBVIEW_CHANNEL, kind: "event", event, payload }
}

export function contextPanelWebviewResponse(
  id: number,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): ContextPanelWebviewResponse {
  return outcome.ok
    ? {
        channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
        kind: "response",
        id,
        ok: true,
        result: outcome.result,
      }
    : {
        channel: CONTEXT_PANEL_WEBVIEW_CHANNEL,
        kind: "response",
        id,
        ok: false,
        error: outcome.error,
      }
}
