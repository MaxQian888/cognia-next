/**
 * Headless registration of the connector runtime (ADR-0059 T-A5).
 *
 * Runs the SAME `installConnectorRuntime` bootstrap the desktop
 * `ConnectorBusProvider` uses, with the two Tauri seams remapped onto the
 * companion server:
 *
 *   - Commands: `setConnectorCommandInvoker` routes the `connectors_*`
 *     wrappers over `transport.call()` (`POST /api/v1/_rpc/<name>`, service
 *     scope). The two legacy R12 arm names differ from their Tauri commands
 *     (`connectors_register[_adapter]`) — the invoker owns that mapping.
 *     Desktop-lifecycle commands are host no-ops here: cognia-server always
 *     mounts the `/connectors` webhook ingress (no local axum server to
 *     start/stop) and the brain holds no local WS handles to reap.
 *   - Inbound events: `setConnectorListen` routes every connector topic over
 *     `transport.subscribe()` (`/ws/v1/events`). The Rust command plane uses
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

import { registerHeadlessRuntime } from "../registry"

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
 * `/ws/v1/events`-backed listener with the Tauri `listen` envelope shape.
 * Exported for tests.
 */
export const headlessConnectorListen: ConnectorListenFn = async (event, handler) =>
  transport.subscribe(event, (payload) => handler({ payload: payload as never }))

registerHeadlessRuntime({
  name: "connector-runtime",
  hosts: ["brain"],
  start: (ctx) => {
    const prevInvoker = setConnectorCommandInvoker(headlessConnectorInvoker)
    const prevListen = setConnectorListen(headlessConnectorListen)
    const dispose = installConnectorRuntime({
      skipHostGate: true,
      log: (level, message) => ctx.log(level, message),
    })
    // Lark entry surface intents (plan 2026-07-24 P3): the companion front
    // door parks surface resolves / consumption reports on the event bus;
    // this brain-side handler answers them (membership checks + ledger).
    const disposeLarkIntents = installLarkIntentHandler(headlessConnectorListen)
    return () => {
      disposeLarkIntents()
      dispose()
      setConnectorCommandInvoker(prevInvoker)
      setConnectorListen(prevListen)
    }
  },
})
