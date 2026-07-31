/**
 * Wire protocol between a plugin webview and the host's `ctx.editor` API.
 *
 * Deliberately its own channel rather than more methods on
 * `cognia.contextPanel`: that channel is attached for the `context-panel`
 * capability, so folding editor methods into it would hand editor access —
 * including writes into the file the user is editing — to every plugin that
 * merely renders a panel. Separate channel, separate capability, separate
 * permission checks.
 *
 * Envelopes ride the same generic webview transport as the context-panel
 * channel: iframe→host via `acquireCogniaWebviewApi().postMessage(<envelope>)`,
 * host→iframe via `postMessageToWebview(fullId, <envelope>)`.
 */

export const EDITOR_WEBVIEW_CHANNEL = "cognia.editor"

/** iframe → host: invoke one editor API method. */
export interface EditorWebviewRequest {
  channel: typeof EDITOR_WEBVIEW_CHANNEL
  kind: "request"
  id: number
  method: string
  /** Positional arguments matching the mirrored method's signature. */
  params?: unknown[]
}

/**
 * iframe → host: the in-frame client attached its listener. The host replies
 * with nothing to snapshot — unlike the context-panel channel, the editor
 * events carry no payload — but the handshake still tells the host a frame is
 * listening before it starts pushing.
 */
export interface EditorWebviewReady {
  channel: typeof EDITOR_WEBVIEW_CHANNEL
  kind: "ready"
}

export type EditorWebviewInbound = EditorWebviewRequest | EditorWebviewReady

/** host → iframe: outcome of one request. */
export interface EditorWebviewResponse {
  channel: typeof EDITOR_WEBVIEW_CHANNEL
  kind: "response"
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * The only pushed event. Payload-free on purpose: the host would otherwise be
 * shipping an un-screened editor snapshot into the frame on every caret move,
 * and the frame must go back through `readActive` — which is where the PII gate
 * and the `editor:read` re-check live.
 */
export type EditorWebviewEventName = "activeEditorChanged"

/** host → iframe: pushed change signal. */
export interface EditorWebviewEvent {
  channel: typeof EDITOR_WEBVIEW_CHANNEL
  kind: "event"
  event: EditorWebviewEventName
}

function isEnvelope(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { channel?: unknown }).channel === EDITOR_WEBVIEW_CHANNEL
  )
}

export function isEditorWebviewInbound(data: unknown): data is EditorWebviewInbound {
  if (!isEnvelope(data)) return false
  const kind = (data as { kind?: unknown }).kind
  if (kind === "ready") return true
  if (kind !== "request") return false
  const request = data as Partial<EditorWebviewRequest>
  return (
    typeof request.id === "number" &&
    typeof request.method === "string" &&
    (request.params === undefined || Array.isArray(request.params))
  )
}

export function editorWebviewEvent(event: EditorWebviewEventName): EditorWebviewEvent {
  return { channel: EDITOR_WEBVIEW_CHANNEL, kind: "event", event }
}

export function editorWebviewResponse(
  id: number,
  outcome: { ok: true; result: unknown } | { ok: false; error: string }
): EditorWebviewResponse {
  return outcome.ok
    ? { channel: EDITOR_WEBVIEW_CHANNEL, kind: "response", id, ok: true, result: outcome.result }
    : { channel: EDITOR_WEBVIEW_CHANNEL, kind: "response", id, ok: false, error: outcome.error }
}
