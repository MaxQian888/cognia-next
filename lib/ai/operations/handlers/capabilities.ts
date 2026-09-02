/**
 * `capabilities.read`: the provider's operation profile, computed from the
 * pure matrix in `@cognia/provider-core` plus this host's surfaces. Bound
 * with `{ kind: "any" }` because the answer exists for every provider,
 * built-in or custom.
 */

import type { ProviderOperationProfile } from "@cognia/provider-types"
import { buildProviderOperationProfile } from "@cognia/provider-core/operations/capability-matrix"

import { detectHostSurfaces } from "../host-surfaces"
import { listProviderOperationDescriptors } from "../manifest"
import type { ProviderOperationHandlerRegistration } from "../registry"

export interface CapabilitiesReadInput {
  deploymentRef?: string
}

export const capabilitiesReadHandler: ProviderOperationHandlerRegistration<
  CapabilitiesReadInput,
  ProviderOperationProfile
> = {
  operationId: "capabilities.read",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ provider, request }) {
    return buildProviderOperationProfile({
      providerId: provider.providerId,
      deploymentRef: request.input?.deploymentRef ?? request.deploymentRef,
      descriptors: listProviderOperationDescriptors(),
      hostSurfaces: detectHostSurfaces(),
      contract: provider.isCustomProvider
        ? {
            id: provider.providerId,
            kind: "custom",
            protocol: provider.protocol,
            credentials: "keyless",
            modelSources: ["discovered", "manual"],
            parameterSchema: { fields: [] } as never,
            persistenceTarget: "customProviders",
            runtimeAdapter: provider.protocol,
          }
        : undefined,
    })
  },
}
