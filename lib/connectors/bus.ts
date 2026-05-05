/**
 * ConnectorBus singleton — Task 25.
 *
 * Registry + fan-in / fan-out spine for the Platform Connectors subsystem.
 * Tasks 26-28 wire the full pipeline into `dispatchInbound`; until then the
 * bus calls the registered inbound handler directly.
 */

import type {
  NormalizedInboundEvent,
  PlatformAdapter,
  OutboundRequest,
  OutboundResult,
} from "@/types/connectors"

export interface BusInboundHandler {
  (event: NormalizedInboundEvent): Promise<void>
}

class ConnectorBus {
  private adapters = new Map<string, PlatformAdapter>()
  private inboundHandler: BusInboundHandler | null = null

  registerAdapter(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  unregisterAdapter(adapterId: string): void {
    this.adapters.delete(adapterId)
  }

  setInboundHandler(handler: BusInboundHandler): void {
    this.inboundHandler = handler
  }

  async dispatchInbound(event: NormalizedInboundEvent): Promise<void> {
    if (!this.inboundHandler) throw new Error("ConnectorBus: inbound handler not set")
    await this.inboundHandler(event)
  }

  async sendOutbound(adapterId: string, req: OutboundRequest): Promise<OutboundResult> {
    const a = this.adapters.get(adapterId)
    if (!a) {
      return {
        ok: false,
        error: { code: "adapter_not_found", message: adapterId, retryable: false },
      }
    }
    return a.send(req)
  }

  listAdapters(): PlatformAdapter[] {
    return Array.from(this.adapters.values())
  }
}

let _bus: ConnectorBus | null = null

export function getBus(): ConnectorBus {
  if (!_bus) _bus = new ConnectorBus()
  return _bus
}

/** Test-only reset. */
export function __resetBusForTesting(): void {
  _bus = null
}
