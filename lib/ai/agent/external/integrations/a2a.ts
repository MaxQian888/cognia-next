/**
 * Host wiring for the A2A integration (`@cognia/agent-a2a`).
 *
 * The package owns the A2A protocol. The app supplies the streaming fetch
 * (the Tauri/companion transport, so a renderer request to an operator-run
 * agent host is neither blocked by `connect-src` nor routed around the
 * configured proxy) and the PII gate.
 */

import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { AgentFetch } from "@cognia/agent-contracts/host"
import { A2aClientAdapter } from "@cognia/agent-a2a/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"

/** The `a2a` adapter factory the manager registers. */
export function createA2aAdapterFactory(
  fetch: AgentFetch = platformStreamingFetch
): ProtocolAdapterFactory {
  return () => new A2aClientAdapter({ fetch, outboundGate: hasNoLeakingPiiDeep })
}
