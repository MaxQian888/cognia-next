/**
 * Host-side RPC server mirroring the context-panel API into a webview-backed
 * panel's iframe. The in-frame client (`acquireCogniaContextPanelApi()`,
 * injected by `webview-csp.ts`) sends request envelopes over the generic
 * webview transport; this server executes them against
 * `createContextPanelAPI(pluginId, hasPermission)` — so every call re-runs the
 * same permission gates the plugin's logic side gets — and pushes
 * `activeContext` / `workbenchState` change events back into the frame.
 * (`visibility` is pushed by the panel renderer, which is the only place that
 * knows which iframe instance is displayed.)
 *
 * Attachment is per webview and refcounted: two panel defs referencing the
 * same webview must not double-handle its messages, and an RPC `register`
 * naming another webview attaches a nested server for that frame.
 */

import {
  createContextPanelAPI,
  type PluginContextPanelRegistration,
} from "@/lib/plugin/api/context-panel-api"
import { createContextPanelWebviewRenderer } from "@/components/plugins/plugin-context-panel-webview"
import {
  contextPanelWebviewEvent,
  contextPanelWebviewResponse,
  isContextPanelWebviewInbound,
  type ContextPanelWebviewRequest,
} from "@/lib/plugin/bridge/context-panel-webview-protocol"
import { onWebviewMessage, postMessageToWebview } from "@/lib/plugin/registries/webview-registry"
import { loggers } from "@/lib/plugin/core/logger"
import type { ContextPanelMode, ContextWorkbenchMode } from "@/types/context-workbench"

export interface ContextPanelWebviewRpcOptions {
  hasPermission: (permission: string) => boolean
}

/**
 * `register` over the wire: the imperative registration minus every function
 * field, plus a `webview` naming another of the plugin's declared webviews to
 * render the new panel's body.
 */
export type ContextPanelWebviewRpcRegistration = Omit<
  PluginContextPanelRegistration,
  "renderer" | "getBadge" | "onFirstActivate" | "onRestore"
> & { webview: string }

interface Attachment {
  refs: number
  dispose: () => void
}

const attachments = new Map<string, Attachment>()

function isRpcRegistration(value: unknown): value is ContextPanelWebviewRpcRegistration {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<ContextPanelWebviewRpcRegistration>
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.webview === "string" &&
    candidate.webview.length > 0 &&
    typeof candidate.label === "string" &&
    typeof candidate.labelKey === "string" &&
    Array.isArray(candidate.resourceKinds) &&
    typeof candidate.activity === "string"
  )
}

export function attachContextPanelWebviewRpc(
  pluginId: string,
  webviewId: string,
  options: ContextPanelWebviewRpcOptions
): () => void {
  const fullId = `${pluginId}:${webviewId}`
  const existing = attachments.get(fullId)
  if (existing) {
    existing.refs += 1
    return makeRelease(fullId)
  }

  const api = createContextPanelAPI(pluginId, options.hasPermission)
  // Registrations and nested attachments created FROM this frame; torn down
  // with it so a disabled plugin cannot leave RPC-registered panels behind.
  const ownedDisposers = new Map<string, () => void>()
  let registrationCounter = 0

  const pushEvent = (event: "activeContext" | "workbenchState", payload: unknown) => {
    postMessageToWebview(fullId, contextPanelWebviewEvent(event, payload))
  }
  const unsubscribeContext = api.onDidChangeActiveContext((context) =>
    pushEvent("activeContext", context)
  )
  const unsubscribeWorkbench = api.onDidChangeWorkbenchState((state) =>
    pushEvent("workbenchState", state)
  )

  const handleRequest = (request: ContextPanelWebviewRequest): unknown => {
    const params = request.params ?? []
    switch (request.method) {
      case "reveal":
        return api.reveal(String(params[0]), params[1] as ContextPanelMode | undefined)
      case "setBadge":
        return api.setBadge(String(params[0]), Number(params[1]))
      case "getActiveContext":
        return api.getActiveContext()
      case "getWorkbenchState":
        return api.getWorkbenchState()
      case "setMode":
        return api.setMode(params[0] as ContextWorkbenchMode)
      case "setPinned":
        return api.setPinned(Boolean(params[0]))
      case "register": {
        const registration = params[0]
        if (!isRpcRegistration(registration)) {
          throw new Error(
            `register requires { id, webview, label, labelKey, resourceKinds, activity }`
          )
        }
        const { webview, ...rest } = registration
        // The new panel's frame gets its own mirrored API; tied to this
        // registration so dispose tears both down.
        const releaseNested = attachContextPanelWebviewRpc(pluginId, webview, options)
        let unregister: () => void
        try {
          unregister = api.register({
            ...rest,
            renderer: createContextPanelWebviewRenderer(pluginId, webview, registration.label),
          })
        } catch (error) {
          releaseNested()
          throw error
        }
        registrationCounter += 1
        const registrationId = `${fullId}#${registrationCounter}`
        ownedDisposers.set(registrationId, () => {
          unregister()
          releaseNested()
        })
        return registrationId
      }
      case "dispose": {
        const registrationId = String(params[0])
        const dispose = ownedDisposers.get(registrationId)
        if (!dispose) return false
        ownedDisposers.delete(registrationId)
        dispose()
        return true
      }
      default:
        throw new Error(`Unknown context-panel method "${request.method}"`)
    }
  }

  const detachInbound = onWebviewMessage(fullId, (message) => {
    const data = message.data
    if (!isContextPanelWebviewInbound(data)) return
    if (data.kind === "ready") {
      // Snapshot both pushed events so the frame never misses state that
      // changed before its listener attached.
      pushEvent("activeContext", api.getActiveContext())
      pushEvent("workbenchState", api.getWorkbenchState())
      return
    }
    try {
      const result = handleRequest(data)
      postMessageToWebview(
        fullId,
        contextPanelWebviewResponse(data.id, { ok: true, result: result ?? null })
      )
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      loggers.manager.warn(
        `[context-panel-webview-rpc] ${fullId} ${data.method} failed: ${messageText}`
      )
      postMessageToWebview(
        fullId,
        contextPanelWebviewResponse(data.id, { ok: false, error: messageText })
      )
    }
  })

  attachments.set(fullId, {
    refs: 1,
    dispose: () => {
      detachInbound()
      unsubscribeContext()
      unsubscribeWorkbench()
      for (const dispose of ownedDisposers.values()) dispose()
      ownedDisposers.clear()
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

export function __resetContextPanelWebviewRpcForTesting(): void {
  for (const attachment of attachments.values()) attachment.dispose()
  attachments.clear()
}
