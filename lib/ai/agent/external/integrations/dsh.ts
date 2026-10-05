/**
 * Host wiring for the DeepSeek Harness integration (`@cognia/agent-dsh`).
 *
 * The package owns the protocol; this module hands it the app's process host
 * and the two managed-launch facts only the host can answer. Managed install
 * and runtime facts are local-host commands, so the process host here is the
 * `local` one: a paired browser is not offered a DSH runtime it cannot install.
 */

import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import type { ExternalAgentLifecycleFields } from "@cognia/agent-contracts/external-agent-lifecycle"
import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { DshManagedLaunchFacts, DshManagedLaunchHost } from "@cognia/agent-dsh/managed-launch"
import { DshSdkClientAdapter } from "@cognia/agent-dsh/sdk-client"
import { createDshRuntimeTransport, resolveDshLaunchFromConfig } from "@cognia/agent-dsh/transport"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { agentInvoke } from "../agent-transport"
import { createAgentTransportProcessHost } from "../host/process-host"

/** The `dsh-sdk` adapter factory the manager registers. */
export function createDshSdkAdapterFactory(
  processHost = createAgentTransportProcessHost("local")
): ProtocolAdapterFactory {
  return () =>
    new DshSdkClientAdapter({
      createTransport: (config) =>
        createDshRuntimeTransport(
          config,
          resolveDshLaunchFromConfig,
          processHost,
          hasNoLeakingPiiDeep
        ),
    })
}

/**
 * Managed-launch facts from this host: installed-runtime facts, the config's
 * own key, and the PII gate the persona must pass.
 */
export const dshManagedLaunchHost: DshManagedLaunchHost = {
  outboundGate: hasNoLeakingPiiDeep,
  readRuntimeFacts: () => agentInvoke<DshManagedLaunchFacts>("dsh_runtime_facts", {}),
  readApiKey: async (config: ExternalAgentConfig) => {
    const { getExternalAgentLifecycleService } = await import("../lifecycle/service")
    const lifecycle = await getExternalAgentLifecycleService()
    const secrets = await lifecycle.readSecrets(
      config as ExternalAgentConfig & ExternalAgentLifecycleFields
    )
    return secrets.processEnv?.DEEPSEEK_API_KEY
  },
}
