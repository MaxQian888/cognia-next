/**
 * Host wiring for the OpenCode integration (`@cognia/agent-opencode`).
 *
 * The package owns both OpenCode protocols, the event mapping, the
 * session-owned service launcher and the discovery contract. The app supplies
 * the streaming fetch (the Tauri/companion transport off the web), the local
 * process plane, the sandbox placement registry, the PII gate and the
 * discovery route: the desktop asks its sidecar, the standalone CLI probes
 * in-process. The legacy `opencode` server protocol (`./client`) is not
 * registered: `getUnsupportedProtocolReason` tells the user to move to V2.
 */

import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import {
  discoverOpenCodeV2InProcess,
  type OpenCodeV2Discovery,
} from "@cognia/agent-opencode/discovery"
import { OpenCodeV2ClientAdapter } from "@cognia/agent-opencode/v2-client"
import {
  canProjectOpenCodeV2Mcp,
  createOpenCodeV2Launcher,
  type OpenCodeV2Placement,
} from "@cognia/agent-opencode/v2-launcher"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { discoverOpenCodeV2ViaSidecar } from "@/lib/claude/feature-call"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { isCliHost } from "@/lib/platform/detect"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
import { runsExternalAgentProcessesLocally } from "../agent-transport"
import { createAgentTransportProcessHost } from "../host/process-host"

/** The app's sandbox placement registry, as the V2 adapter reads it. */
export const appOpenCodeV2Placement: OpenCodeV2Placement = {
  hasSelectedSandbox: (configId) => Boolean(spawnPlacementFor(configId)),
  processesLocal: () => runsExternalAgentProcessesLocally(),
}

/**
 * Locate the local OpenCode V2 service. The desktop renderer has no process
 * table, so it delegates to its sidecar; the standalone CLI owns one and has
 * no feature-call bridge, so it runs the same probe in-process.
 */
export function discoverOpenCodeV2Service(signal: AbortSignal): Promise<OpenCodeV2Discovery> {
  return isCliHost()
    ? discoverOpenCodeV2InProcess(platformStreamingFetch, signal)
    : discoverOpenCodeV2ViaSidecar(signal)
}

/** Whether this host can mount Cognia's MCP servers on an OpenCode V2 session. */
export function canProjectOpenCodeV2McpOnThisHost(config: ExternalAgentConfig): boolean {
  return canProjectOpenCodeV2Mcp(config, appOpenCodeV2Placement)
}

/** One `opencode-v2` adapter over the app's ports. */
export function createOpenCodeV2Adapter(
  processHost = createAgentTransportProcessHost("local"),
  placement: OpenCodeV2Placement = appOpenCodeV2Placement
): OpenCodeV2ClientAdapter {
  return new OpenCodeV2ClientAdapter({
    fetch: platformStreamingFetch,
    outboundGate: hasNoLeakingPiiDeep,
    placement,
    discoverService: discoverOpenCodeV2Service,
    launchService: createOpenCodeV2Launcher(processHost, placement),
  })
}

/** The `opencode-v2` adapter factory the manager registers. */
export function createOpenCodeV2AdapterFactory(
  processHost = createAgentTransportProcessHost("local"),
  placement: OpenCodeV2Placement = appOpenCodeV2Placement
): ProtocolAdapterFactory {
  return () => createOpenCodeV2Adapter(processHost, placement)
}
