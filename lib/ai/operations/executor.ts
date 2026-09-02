/**
 * The unified provider operation executor (ADR-0163).
 *
 * One pipeline for all 50 operations, explicit dependency injection (no
 * singleton seam), and a result that never throws:
 *   1. descriptor lookup, an unknown id is `capability-unsupported`,
 *   2. scope check, a missing scope is `permission`,
 *   3. surface check, an unreachable surface is `transport` + `needs-host`,
 *   4. provider resolution through `resolveFeatureProvider`, so the
 *      operation plane and the chat plane pick providers the same way,
 *   5. the PII gate, once, when the descriptor says `outbound-text`,
 *   6. handler dispatch with every throw mapped to a typed failure.
 *
 * Provider-pinned operations addressed through a resource handle resolve
 * ONLY the handle's provider with no fallback, and refuse a credential whose
 * affinity differs from the one the resource was created under.
 */

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type {
  ProviderOperationAvailability,
  ProviderOperationDescriptor,
  ProviderOperationFailure,
  ProviderOperationGroup,
  ProviderOperationRequest,
  ProviderOperationResult,
  ProviderOperationSurface,
} from "@cognia/provider-types"

import {
  resolveFeatureProvider,
  type FeatureRouteProfile,
  type ProviderResolution,
  type ProviderSettingsSnapshot,
  type ResolveFeatureProviderArgs,
  type ResolvedProvider,
  type ResolutionFailureNextAction,
} from "@/lib/ai/provider-consumption"

import { credentialAffinityOf } from "./credential-affinity"
import { availabilityForFailure, toProviderDiagnosticFailure } from "./failure"
import { getProviderOperationDescriptor } from "./manifest"
import { ProviderOperationHandlerRegistry, providerOperationHandlerRegistry } from "./registry"

export interface ProviderOperationExecutorDeps {
  /** Settings the resolver reads. Called per execution so edits are live. */
  getSettingsSnapshot: () => ProviderSettingsSnapshot
  /** Surfaces this process can execute on (`detectHostSurfaces()`). */
  hostSurfaces: readonly ProviderOperationSurface[]
  registry?: ProviderOperationHandlerRegistry
  getDescriptor?: (id: string) => ProviderOperationDescriptor | undefined
  resolveProvider?: (
    args: ResolveFeatureProviderArgs,
    snapshot: ProviderSettingsSnapshot
  ) => ProviderResolution
  /** Returns true when the value carries no leaking PII. */
  piiGate?: (value: unknown) => boolean
  credentialAffinity?: (provider: ResolvedProvider) => string
  now?: () => number
}

export interface ProviderOperationExecuteOptions {
  signal?: AbortSignal
}

export interface ProviderOperationExecutor {
  execute<TInput, TOutput = unknown>(
    request: ProviderOperationRequest<TInput>,
    options?: ProviderOperationExecuteOptions
  ): Promise<ProviderOperationResult<TOutput>>
}

/** Group → the route profile the feature resolver understands. */
export function routeProfileForGroup(group: ProviderOperationGroup): FeatureRouteProfile {
  switch (group) {
    case "language":
      return "general-text"
    case "retrieval":
      return "embedding"
    default:
      return "capability-bound"
  }
}

function availabilityForNextAction(
  nextAction: ResolutionFailureNextAction | undefined
): ProviderOperationAvailability {
  switch (nextAction) {
    case "add_api_key":
      return "needs-auth"
    case "configure_base_url":
    case "select_default_model":
    case "enable_provider":
      return "needs-config"
    default:
      return "unavailable"
  }
}

export function createProviderOperationExecutor(
  deps: ProviderOperationExecutorDeps
): ProviderOperationExecutor {
  const registry = deps.registry ?? providerOperationHandlerRegistry
  const getDescriptor = deps.getDescriptor ?? getProviderOperationDescriptor
  const resolveProvider = deps.resolveProvider ?? resolveFeatureProvider
  const piiGate = deps.piiGate ?? hasNoLeakingPiiDeep
  const affinityOf =
    deps.credentialAffinity ??
    ((provider: ResolvedProvider) => credentialAffinityOf(provider.apiKey))

  return {
    async execute<TInput, TOutput = unknown>(
      request: ProviderOperationRequest<TInput>,
      options: ProviderOperationExecuteOptions = {}
    ): Promise<ProviderOperationResult<TOutput>> {
      const fail = (
        failure: ProviderOperationFailure["failure"],
        availability: ProviderOperationAvailability,
        extra: Partial<ProviderOperationFailure> = {}
      ): ProviderOperationFailure => ({
        ok: false,
        operationId: request.operationId,
        availability,
        failure,
        ...(request.providerId ? { providerId: request.providerId } : {}),
        ...extra,
      })

      // 1. descriptor
      const descriptor = getDescriptor(request.operationId)
      if (!descriptor) {
        return fail(
          {
            code: "capability-unsupported",
            retryable: false,
            message: `unknown provider operation "${request.operationId}"`,
          },
          "unavailable"
        )
      }

      // 2. scopes
      const missingScopes = descriptor.scopes.filter((scope) => !request.scopes.includes(scope))
      if (missingScopes.length > 0) {
        return fail(
          {
            code: "permission",
            retryable: false,
            message: `missing scope${missingScopes.length > 1 ? "s" : ""}: ${missingScopes.join(", ")}`,
          },
          "unavailable"
        )
      }

      // 3. surface
      if (
        !descriptor.surfaces.includes(request.surface) ||
        !deps.hostSurfaces.includes(request.surface)
      ) {
        return fail(
          {
            code: "transport",
            retryable: false,
            message: `operation ${descriptor.id} cannot execute on surface "${request.surface}" (allowed: ${descriptor.surfaces.join(", ")}; host: ${deps.hostSurfaces.join(", ")})`,
          },
          "needs-host"
        )
      }

      // 4. provider
      const pinned = descriptor.statefulHandle === "provider-pinned" && request.handle
      const providerId = pinned ? request.handle!.providerId : request.providerId
      if (pinned && request.providerId && request.providerId !== request.handle!.providerId) {
        return fail(
          {
            code: "permission",
            retryable: false,
            message: `resource handle belongs to provider "${request.handle!.providerId}", not "${request.providerId}"`,
          },
          "unavailable"
        )
      }
      const resolution = resolveProvider(
        {
          featureId: descriptor.id,
          routeProfile: routeProfileForGroup(descriptor.group),
          selectionMode: providerId ? "explicit-provider" : "any",
          ...(providerId ? { providerId } : {}),
          fallbackMode: pinned || providerId ? "none" : "first-eligible",
        },
        deps.getSettingsSnapshot()
      )
      if (resolution.kind !== "resolved") {
        return fail(
          {
            code: resolution.nextAction === "add_api_key" ? "authentication" : "unknown",
            retryable: resolution.nextAction !== "add_api_key",
            message: resolution.reason,
          },
          availabilityForNextAction(resolution.nextAction),
          { attemptedProviderIds: resolution.attemptedProviderIds }
        )
      }
      const provider = resolution
      if (pinned) {
        const affinity = affinityOf(provider)
        if (affinity !== request.handle!.credentialAffinity) {
          return fail(
            {
              code: "authentication",
              retryable: false,
              message: `resource handle was created under a different credential (${request.handle!.credentialAffinity}); the current one is ${affinity}`,
            },
            "needs-auth",
            { providerId: provider.providerId }
          )
        }
      }

      // 5. PII gate
      if (descriptor.piiGate === "outbound-text" && !piiGate(request.input)) {
        return fail(
          {
            code: "permission",
            retryable: false,
            message: "outbound text did not pass the PII gate",
          },
          "unavailable",
          { providerId: provider.providerId }
        )
      }

      // 6. handler
      const registration = registry.resolve(descriptor.id, provider.providerId, provider.protocol)
      if (!registration) {
        return fail(
          {
            code: "capability-unsupported",
            retryable: false,
            message: `no handler bound for ${descriptor.id} on ${provider.providerId} (${provider.protocol})`,
          },
          "needs-host",
          { providerId: provider.providerId }
        )
      }
      try {
        const output = (await registration.handler({
          descriptor,
          provider,
          request,
          signal: options.signal,
        })) as TOutput
        return {
          ok: true,
          operationId: descriptor.id,
          providerId: provider.providerId,
          ...(request.deploymentRef ? { deploymentRef: request.deploymentRef } : {}),
          support: registration.support,
          ...(registration.via ? { via: registration.via } : {}),
          output,
        }
      } catch (error) {
        const failure = toProviderDiagnosticFailure(error)
        return fail(failure, availabilityForFailure(failure), { providerId: provider.providerId })
      }
    },
  }
}
