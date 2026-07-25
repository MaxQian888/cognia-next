/**
 * Host-side RPC server mirroring `ctx.editor` into a plugin webview's iframe.
 *
 * The in-frame client (`acquireCogniaEditorApi()`, injected by `webview-csp.ts`
 * for plugins declaring the `editor` capability) sends request envelopes over
 * the generic webview transport; this server executes them against
 * `createEditorAPI(pluginId, hasPermission)` — so every call re-runs the same
 * `editor:read` / `editor:write` gates and the same PII screen the module side
 * gets. Nothing is re-implemented here; a divergent second gate is exactly how
 * a sandboxed surface ends up more privileged than the surface it mirrors.
 *
 * Attachment is per webview and refcounted, matching
 * `context-panel-webview-rpc`: two panel defs on the same webview must not
 * double-handle its messages.
 */

import { createEditorAPI } from "@/lib/plugin/api/editor-api"
import {
  editorWebviewEvent,
  editorWebviewResponse,
  isEditorWebviewInbound,
  type EditorWebviewRequest,
} from "@/lib/plugin/bridge/editor-webview-protocol"
import { onWebviewMessage, postMessageToWebview } from "@/lib/plugin/registries/webview-registry"
import { loggers } from "@/lib/plugin/core/logger"
import type { PluginEditorOpenOptions } from "@/lib/plugin/api/editor-api"

export interface EditorWebviewRpcOptions {
  hasPermission: (permission: string) => boolean
}

interface Attachment {
  refs: number
  dispose: () => void
}

const attachments = new Map<string, Attachment>()

/** Narrow the wire's `unknown` into the options the API accepts. */
function toOpenOptions(value: unknown): PluginEditorOpenOptions | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as Record<string, unknown>
  return {
    line: typeof candidate.line === "number" ? candidate.line : undefined,
    column: typeof candidate.column === "number" ? candidate.column : undefined,
    reveal: candidate.reveal === true,
  }
}

export function attachEditorWebviewRpc(
  pluginId: string,
  webviewId: string,
  options: EditorWebviewRpcOptions
): () => void {
  const fullId = `${pluginId}:${webviewId}`
  const existing = attachments.get(fullId)
  if (existing) {
    existing.refs += 1
    return makeRelease(fullId)
  }

  const api = createEditorAPI(pluginId, options.hasPermission)

  // Payload-free by design (see the protocol module): the frame re-reads
  // through `readActive`, which is where the PII screen lives. Pushing a
  // snapshot here would route around it.
  const unsubscribe = api.onDidChangeActiveEditor(() => {
    postMessageToWebview(fullId, editorWebviewEvent("activeEditorChanged"))
  })

  const handleRequest = async (request: EditorWebviewRequest): Promise<unknown> => {
    const params = request.params ?? []
    switch (request.method) {
      case "openFile":
        return api.openFile(String(params[0]), toOpenOptions(params[1]))
      case "reflectEdit":
        return api.reflectEdit(String(params[0]), toOpenOptions(params[1]))
      case "readActive":
        return api.readActive()
      default:
        throw new Error(`Unknown editor method: ${request.method}`)
    }
  }

  const detachInbound = onWebviewMessage(fullId, (message) => {
    const data = message.data
    if (!isEditorWebviewInbound(data)) return
    if (data.kind === "ready") {
      // Nothing to snapshot — the only event carries no payload, so a frame
      // that attaches late simply reads on its next fire.
      return
    }
    void handleRequest(data).then(
      (result) =>
        postMessageToWebview(
          fullId,
          editorWebviewResponse(data.id, { ok: true, result: result ?? null })
        ),
      (error: unknown) => {
        const messageText = error instanceof Error ? error.message : String(error)
        loggers.manager.warn(`[editor-webview-rpc] ${fullId} ${data.method} failed: ${messageText}`)
        postMessageToWebview(
          fullId,
          editorWebviewResponse(data.id, { ok: false, error: messageText })
        )
      }
    )
  })

  attachments.set(fullId, {
    refs: 1,
    dispose: () => {
      detachInbound()
      unsubscribe()
    },
  })
  return makeRelease(fullId)
}

function makeRelease(fullId: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const attachment = attachments.get(fullId)
    if (!attachment) return
    attachment.refs -= 1
    if (attachment.refs > 0) return
    attachments.delete(fullId)
    attachment.dispose()
  }
}

export function __resetEditorWebviewRpcForTesting(): void {
  for (const attachment of attachments.values()) attachment.dispose()
  attachments.clear()
}
