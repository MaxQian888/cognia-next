"use client"

/**
 * Renderer half of the WASM capability bridge.
 *
 * The Rust host (`crates/cognia-plugin-runtime/src/wasm/bridge.rs`) emits one
 * `plugin-wasm://renderer-request` event per capability call, this module runs
 * the matching operation, and the result goes back through the
 * `plugin_wasm_renderer_response` Tauri command. A second event,
 * `plugin-wasm://renderer-cancel`, aborts in-flight work.
 *
 * Modeled on `lib/cli-bridge/renderer-request-source.ts` — same install guard,
 * same injectable bridge for tests, same lazy handler imports so mounting the
 * listener costs nothing until a WASM plugin actually calls out.
 *
 * # Degradation
 *
 * Browser, mobile (Capacitor), and headless hosts never mount this: the only
 * caller is `DesktopMessageSourceProvider`, which returns early unless the
 * platform is Tauri. WASM plugins running under those hosts get
 * `HOST_UNAVAILABLE` for AI and workflow from the Rust side, which is the
 * intended behaviour — those runtimes do not emulate the provider chain.
 *
 * # One response per request
 *
 * The renderer always sends exactly one response per `requestId`, *including*
 * for cancel-initiated aborts. That means Rust must tolerate a response for a
 * request it already resolved on its own timeout — it does; `resolve()` treats
 * an unknown id as a no-op. The alternative (staying silent after a cancel)
 * would hang the guest whenever a cancel frame was lost.
 */

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import { toBridgeError, WasmBridgeError } from "./errors"
import {
  abortAll,
  abortReasonFor,
  beginRequest,
  cancelRequest,
  DuplicateRequestError,
  settleRequest,
} from "./request-registry"
import {
  parseRendererRequest,
  WASM_RENDERER_CANCEL_EVENT,
  WASM_RENDERER_REQUEST_EVENT,
  WASM_RENDERER_RESPONSE_COMMAND,
  type WasmRendererCancel,
  type WasmRendererRequest,
  type WasmRendererResponse,
} from "./protocol"

/** Tiny Tauri shape so the file type-checks (and tests run) in pure node. */
interface TauriBridge {
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>
  invoke(name: string, args: Record<string, unknown>): Promise<unknown>
}

let installed = false

export interface InstallWasmRendererOptions {
  bridge?: TauriBridge
  forceReinstall?: boolean
}

export async function installWasmRendererRequestSource(
  opts: InstallWasmRendererOptions = {}
): Promise<() => void> {
  if (installed && !opts.forceReinstall) return () => {}
  installed = true

  let bridge: TauriBridge
  if (opts.bridge) {
    bridge = opts.bridge
  } else {
    try {
      bridge = { listen, invoke }
    } catch {
      installed = false
      return () => {}
    }
  }

  const unlistenRequest = await bridge.listen<unknown>(WASM_RENDERER_REQUEST_EVENT, (event) => {
    void handleRequest(event.payload, bridge)
  })

  const unlistenCancel = await bridge.listen<WasmRendererCancel>(
    WASM_RENDERER_CANCEL_EVENT,
    (event) => {
      const frame = event.payload
      if (!frame || typeof frame.requestId !== "string") return
      cancelRequest(frame.requestId, frame.reason ?? "caller")
    }
  )

  return () => {
    installed = false
    // Guarded because this teardown runs inside a shared cleanup chain: the
    // provider disposes several sources in sequence, so one throwing here
    // would skip every teardown after it. A `listen` implementation that
    // resolves to something other than a function (an older Tauri, a partial
    // test double) is not worth taking the rest of the chain down for.
    for (const unlisten of [unlistenRequest, unlistenCancel]) {
      if (typeof unlisten === "function") unlisten()
    }
    // Anything still running belongs to a host that is going away. Settle as
    // well as abort: the listeners are gone, so a handler that ignores its
    // signal must not be able to emit a response through a dead bridge.
    abortAll("unload", { settle: true })
  }
}

async function sendResponse(bridge: TauriBridge, response: WasmRendererResponse): Promise<void> {
  try {
    await bridge.invoke(WASM_RENDERER_RESPONSE_COMMAND, { response })
  } catch {
    // The host is gone or the command is unregistered. Nothing useful remains:
    // the request will expire on the Rust timeout, and throwing here would only
    // produce an unhandled rejection inside an event listener.
  }
}

async function handleRequest(raw: unknown, bridge: TauriBridge): Promise<void> {
  const parsed = parseRendererRequest(raw)
  if (!parsed.ok) {
    // Answer malformed frames when we can identify them, so the guest fails
    // fast instead of waiting out the host timeout. With no requestId there is
    // nothing to answer to.
    if (parsed.requestId && parsed.pluginId) {
      await sendResponse(bridge, {
        requestId: parsed.requestId,
        pluginId: parsed.pluginId,
        error: { code: "INVALID_REQUEST", message: parsed.reason },
      })
    }
    return
  }

  const request = parsed.request
  let signal: AbortSignal
  try {
    signal = beginRequest(request, () => {
      // The local timer is a backstop for a lost cancel frame; the abort it
      // raises surfaces through the handler's rejection below.
    })
  } catch (err) {
    if (err instanceof DuplicateRequestError) {
      await sendResponse(bridge, {
        requestId: request.requestId,
        pluginId: request.pluginId,
        error: { code: "INVALID_REQUEST", message: err.message },
      })
    }
    return
  }

  try {
    const result = await dispatchWasmOperation(request, signal)
    if (!settleRequest(request.requestId)) return // late — discard
    await sendResponse(bridge, {
      requestId: request.requestId,
      pluginId: request.pluginId,
      result,
    })
  } catch (err) {
    // Read the abort reason BEFORE settling: settling removes the entry.
    const abortReason = abortReasonFor(request.requestId)
    if (!settleRequest(request.requestId)) return // late — discard
    await sendResponse(bridge, {
      requestId: request.requestId,
      pluginId: request.pluginId,
      error: toBridgeError(err, { abortReason }),
    })
  }
}

/** Exposed for tests — production goes through the listener above. */
export async function dispatchWasmOperation(
  request: WasmRendererRequest,
  signal: AbortSignal
): Promise<unknown> {
  switch (request.operation) {
    case "ai.generate-text": {
      const { aiGenerateText } = await import("./handlers/ai-generate-text")
      return aiGenerateText(request.pluginId, request.payload, signal)
    }
    case "workflow.emit-event": {
      const { workflowEmitEvent } = await import("./handlers/workflow-emit-event")
      return workflowEmitEvent(request.pluginId, request.payload, signal)
    }
    default: {
      // `parseRendererRequest` already rejected unknown operations, so this is
      // only reachable if the operation union and the parser drift apart.
      const exhaustive: never = request.operation
      throw new WasmBridgeError(
        "INVALID_REQUEST",
        `unknown wasm bridge operation: ${String(exhaustive)}`
      )
    }
  }
}
