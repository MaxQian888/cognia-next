/**
 * Swappable inbound-event seam for connector transports (ADR-0059 T-A5).
 *
 * Webhook transports subscribe to `connectors://webhook/<adapterId>`. On
 * desktop those events are Tauri events emitted by `AppHandleEmitter`
 * (src-tauri/src/connectors/axum_app.rs); on the headless brain the SAME
 * topic strings arrive as `/ws/events` frames from `BusEventEmitter`, so
 * the headless connector runtime swaps this seam for a
 * `CompanionTransport.subscribe`-backed listener. One transport
 * implementation, two event sources.
 *
 * Default: Tauri `listen`, with the returned disposer routed through
 * `safeUnlisten`. Tauri's disposer is async and can reject with
 * `listeners[eventId].handlerId` when a transport tears down before its
 * registration eval ran; every transport calls the disposer fire-and-forget,
 * so the rejection would otherwise surface as an unhandled promise rejection.
 */

import { listen as tauriListen } from "@tauri-apps/api/event"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/** Envelope shape shared by Tauri events and the headless adapter. */
export interface ConnectorEvent<T> {
  payload: T
}

export type ConnectorUnlistenFn = () => void

export type ConnectorListenFn = <T>(
  event: string,
  handler: (event: ConnectorEvent<T>) => void
) => Promise<ConnectorUnlistenFn>

const defaultListen: ConnectorListenFn = async (event, handler) => {
  const unlisten = await tauriListen(event, handler)
  return () => safeUnlisten(unlisten)
}

let listenImpl: ConnectorListenFn = defaultListen

/**
 * Swap the event source behind `connectorListen`. Pass `null` to restore
 * the default Tauri `listen`. Returns the previously-active listener so
 * callers can restore it on teardown.
 */
export function setConnectorListen(fn: ConnectorListenFn | null): ConnectorListenFn {
  const previous = listenImpl
  listenImpl = fn ?? defaultListen
  return previous
}

/**
 * Subscribe to a connector event topic through the active seam. Stable
 * function identity — transports can import it once; swaps take effect on
 * the next call.
 */
export const connectorListen: ConnectorListenFn = (event, handler) => listenImpl(event, handler)
