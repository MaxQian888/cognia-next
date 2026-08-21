/**
 * Headless registration of the connector runtime (ADR-0059 T-A5).
 *
 * Runs the SAME `installConnectorRuntime` bootstrap the desktop
 * `ConnectorBusProvider` uses, with the two Tauri seams remapped onto the
 * companion server:
 *
 *   - Commands: `setConnectorCommandInvoker` routes the `connectors_*`
 *     wrappers over `transport.call()` (`POST /api/_rpc/<name>`, service
 *     scope). The two legacy R12 arm names differ from their Tauri commands
 *     (`connectors_register[_adapter]`) — the invoker owns that mapping.
 *     Desktop-lifecycle commands are host no-ops here: cognia-server always
 *     mounts the `/connectors` webhook ingress (no local axum server to
 *     start/stop) and the brain holds no local WS handles to reap.
 *   - Inbound events: `setConnectorListen` routes every connector topic over
 *     `transport.subscribe()` (`/ws/events`). The Rust command plane uses
 *     `ConnectorEventEmitter` for webhook, generic WS, Lark long-connection,
 *     and reverse-WS topics, preserving the byte-identical names emitted by
 *     the desktop `AppHandleEmitter`.
 */

import { transport } from "@/lib/tauri"
import {
  setConnectorCommandInvoker,
  type ConnectorCommandInvoker,
} from "@/lib/connectors/tauri/commands"
import { setConnectorListen, type ConnectorListenFn } from "@/lib/connectors/events"
import { installConnectorRuntime } from "@/lib/connectors/bootstrap/install-connector-runtime"
import { installLarkIntentHandler } from "@/lib/connectors/entry/consumed-handler"

import {
  createConnectorRuntimeLease,
  type RuntimeLeaseAcquireResult,
} from "@/lib/connectors/runtime-lease"
import { registerHeadlessRuntime } from "../registry"

const LARK_OAUTH_CALLBACK_TOPIC = "connectors://lark-oauth/callback"

interface LarkOAuthCallbackPayload {
  code?: unknown
  state?: unknown
  error?: unknown
  error_description?: unknown
}

/**
 * Complete OAuth callbacks delivered by the headless connector front door.
 * The platform handler re-validates the durable state and PKCE verifier before
 * exchanging the code, so the event bus is only transport — never an auth bypass.
 */
async function completeLarkOAuthCallback(
  payload: LarkOAuthCallbackPayload,
  log: (level: "info" | "warn" | "error", message: string) => void
): Promise<void> {
  if (typeof payload.error === "string" && payload.error.trim()) {
    log("error", `[connector-bus] Lark OAuth rejected: ${payload.error.trim()}`)
    return
  }
  if (
    typeof payload.code !== "string" ||
    !payload.code.trim() ||
    typeof payload.state !== "string" ||
    !payload.state.trim()
  ) {
    log("error", "[connector-bus] Lark OAuth callback is missing code or state")
    return
  }
  try {
    const { handleLarkOAuth } = await import("@/lib/connectors/adapters/lark/oauth-handler")
    await handleLarkOAuth(payload.code, { state: payload.state })
    log("info", "[connector-bus] Lark OAuth completed")
  } catch (error) {
    log(
      "error",
      `[connector-bus] Lark OAuth completion failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/**
 * Generic connector OAuth relay topic (`oauth_connector_callback` in
 * `axum_app.rs`). Carries `kind` so one subscription serves every platform;
 * Lark keeps its own topic because its relay path predates this one and is
 * registered byte-for-byte in existing Feishu consoles.
 */
const CONNECTOR_OAUTH_CALLBACK_TOPIC = "connectors://connector-oauth/callback"

interface ConnectorOAuthCallbackPayload extends LarkOAuthCallbackPayload {
  kind?: unknown
}

/**
 * Complete a platform-connector OAuth callback delivered by the headless
 * connector front door.
 *
 * Routes through `oauthRegistry` rather than a per-platform import, so a
 * platform that registers a handler is authorizable headless with no change
 * here. The handler re-validates the durable pending state before exchanging
 * the code, so the event bus is only transport — never an auth bypass.
 */
async function completeConnectorOAuthCallback(
  payload: ConnectorOAuthCallbackPayload,
  log: (level: "info" | "warn" | "error", message: string) => void
): Promise<void> {
  const kind = typeof payload.kind === "string" ? payload.kind.trim() : ""
  if (!kind) {
    log("error", "[connector-bus] connector OAuth callback is missing its kind")
    return
  }
  if (typeof payload.error === "string" && payload.error.trim()) {
    log("error", `[connector-bus] ${kind} OAuth rejected: ${payload.error.trim()}`)
    return
  }
  if (
    typeof payload.code !== "string" ||
    !payload.code.trim() ||
    typeof payload.state !== "string" ||
    !payload.state.trim()
  ) {
    log("error", `[connector-bus] ${kind} OAuth callback is missing code or state`)
    return
  }
  try {
    const { oauthRegistry } = await import("@/lib/connectors/oauth-registry")
    const handler = oauthRegistry.get(kind)
    if (!handler) {
      log("error", `[connector-bus] no OAuth handler registered for ${kind}`)
      return
    }
    await handler(payload.code, payload.state)
    log("info", `[connector-bus] ${kind} OAuth completed`)
  } catch (error) {
    log(
      "error",
      `[connector-bus] ${kind} OAuth completion failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function installConnectorOAuthCallbackHandler(
  listen: ConnectorListenFn,
  log: (level: "info" | "warn" | "error", message: string) => void
): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<ConnectorOAuthCallbackPayload>(CONNECTOR_OAUTH_CALLBACK_TOPIC, ({ payload }) => {
    void completeConnectorOAuthCallback(payload, log)
  })
    .then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    .catch((error) => {
      log(
        "error",
        `[connector-bus] connector OAuth listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}

function installLarkOAuthCallbackHandler(
  listen: ConnectorListenFn,
  log: (level: "info" | "warn" | "error", message: string) => void
): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<LarkOAuthCallbackPayload>(LARK_OAUTH_CALLBACK_TOPIC, ({ payload }) => {
    void completeLarkOAuthCallback(payload, log)
  })
    .then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    .catch((error) => {
      log(
        "error",
        `[connector-bus] Lark OAuth listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/**
 * Map a Tauri command invocation onto the companion RPC surface.
 * Exported for tests.
 */
export const headlessConnectorInvoker: ConnectorCommandInvoker = async <T>(
  name: string,
  args?: Record<string, unknown>
): Promise<T> => {
  switch (name) {
    // Legacy R12 arm names + snake_case params (frozen wire shape).
    case "connectors_register_adapter": {
      const reg = args?.reg as { adapterId: string; adapterType: string }
      return transport.call<T>("connectors_register", {
        adapter_id: reg.adapterId,
        adapter_type: reg.adapterType,
      })
    }
    case "connectors_unregister_adapter":
      return transport.call<T>("connectors_unregister", {
        adapter_id: args?.adapterId,
      })
    // Desktop-lifecycle no-ops: the companion server's `/connectors` ingress
    // is always mounted, and the brain owns no local WS handles.
    case "connectors_start_server":
      return "companion:/connectors" as T
    case "connectors_stop_server":
      return undefined as T
    // Everything else passes through same-name with the wrapper args
    // verbatim (the Rust arms deserialize the same camelCase payloads the
    // Tauri commands take).
    default:
      return transport.call<T>(name, args)
  }
}

/**
 * `/ws/events`-backed listener with the Tauri `listen` envelope shape.
 * Exported for tests.
 */
export const headlessConnectorListen: ConnectorListenFn = async (event, handler) =>
  transport.subscribe(event, (payload) => handler({ payload: payload as never }))

/**
 * Build the server-backed singleton guard used by a brain process.
 *
 * Delegates to the shared lease (`lib/connectors/runtime-lease.ts`) so the
 * brain and the desktop contend on one implementation and one Rust slot. The
 * brain declines to boot when the lease is unreachable: it talks to its
 * companion for everything else, so a failure there means it would be an
 * unarbitrated second owner.
 */
export function createHeadlessConnectorRuntimeLease(
  log: (level: "info" | "warn" | "error", message: string) => void,
  onLeaseLost: () => void | Promise<void>,
  onLeaseAcquired: () => void
): (signal: AbortSignal) => Promise<boolean> {
  return createConnectorRuntimeLease({
    ownerClass: "brain",
    ports: {
      acquire: (ownerId, ttlMs) =>
        headlessConnectorInvoker<RuntimeLeaseAcquireResult | boolean>(
          "connectors_runtime_lease_acquire",
          { ownerId, ttlMs, handoffAware: true }
        ),
      renew: (ownerId, ttlMs) =>
        headlessConnectorInvoker<boolean>("connectors_runtime_lease_renew", { ownerId, ttlMs }),
      release: (ownerId) =>
        headlessConnectorInvoker<boolean>("connectors_runtime_lease_release", { ownerId }),
    },
    log,
    onLeaseLost,
    onLeaseAcquired,
    onUnavailable: "block",
  })
}

registerHeadlessRuntime({
  name: "connector-runtime",
  hosts: ["brain"],
  start: (ctx) => {
    const prevInvoker = setConnectorCommandInvoker(headlessConnectorInvoker)
    const prevListen = setConnectorListen(headlessConnectorListen)
    let dispose: () => Promise<void> = async () => undefined
    let disposeLarkOAuth: () => void = () => undefined
    let disposeConnectorOAuth: () => void = () => undefined
    const acquireRuntimeLock = createHeadlessConnectorRuntimeLease(
      ctx.log,
      () => dispose(),
      () => {
        disposeLarkOAuth()
        disposeLarkOAuth = installLarkOAuthCallbackHandler(headlessConnectorListen, ctx.log)
        disposeConnectorOAuth()
        disposeConnectorOAuth = installConnectorOAuthCallbackHandler(
          headlessConnectorListen,
          ctx.log
        )
      }
    )
    dispose = installConnectorRuntime({
      skipHostGate: true,
      log: (level, message) => ctx.log(level, message),
      acquireRuntimeLock,
    })
    // Lark entry surface intents (plan 2026-07-24 P3): the companion front
    // door parks surface resolves / consumption reports on the event bus;
    // this brain-side handler answers them (membership checks + ledger).
    const disposeLarkIntents = installLarkIntentHandler(headlessConnectorListen)
    return async () => {
      disposeLarkOAuth()
      disposeConnectorOAuth()
      disposeLarkIntents()
      await dispose()
      setConnectorCommandInvoker(prevInvoker)
      setConnectorListen(prevListen)
    }
  },
})
