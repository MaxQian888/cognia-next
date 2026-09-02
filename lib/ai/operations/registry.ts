/**
 * Handler registry for provider operations (ADR-0163).
 *
 * A handler binds one operation id to a provider match. Resolution order is
 * provider, then protocol, then any. There is deliberately no
 * `switch (providerId)` anywhere in this dispatcher: vendor-specific
 * behaviour is a registration keyed by provider id, and protocol-generic
 * behaviour is a registration keyed by protocol. The vendor-neutrality gate
 * (`check:provider-name-branches`) scans this directory.
 */

import type {
  ProviderOperationDescriptor,
  ProviderOperationId,
  ProviderOperationRequest,
  ProviderOperationSupport,
  ResolverProtocol,
} from "@cognia/provider-types"

import type { ProviderSettingsSnapshot, ResolvedProvider } from "@/lib/ai/provider-consumption"

export type ProviderOperationProviderMatch =
  | { kind: "provider"; providerId: string }
  | { kind: "protocol"; protocol: ResolverProtocol }
  | { kind: "any" }

export interface ProviderOperationHandlerContext<TInput = unknown> {
  descriptor: ProviderOperationDescriptor
  provider: ResolvedProvider
  request: ProviderOperationRequest<TInput>
  /** The settings snapshot the provider was resolved from. */
  settings: ProviderSettingsSnapshot
  signal?: AbortSignal
}

export type ProviderOperationHandler<TInput = unknown, TOutput = unknown> = (
  context: ProviderOperationHandlerContext<TInput>
) => Promise<TOutput>

export interface ProviderOperationHandlerRegistration<TInput = unknown, TOutput = unknown> {
  operationId: ProviderOperationId
  providerMatch: ProviderOperationProviderMatch
  support: Exclude<ProviderOperationSupport, "unsupported" | "unknown">
  /** `<pluginId>:<adapterId>` for plugin-served handlers. */
  via?: string
  handler: ProviderOperationHandler<TInput, TOutput>
}

const MATCH_RANK: Record<ProviderOperationProviderMatch["kind"], number> = {
  provider: 0,
  protocol: 1,
  any: 2,
}

export class ProviderOperationHandlerRegistry {
  private readonly byOperation = new Map<
    ProviderOperationId,
    ProviderOperationHandlerRegistration[]
  >()

  register<TInput, TOutput>(
    registration: ProviderOperationHandlerRegistration<TInput, TOutput>
  ): () => void {
    const list = this.byOperation.get(registration.operationId) ?? []
    const entry = registration as ProviderOperationHandlerRegistration
    list.push(entry)
    // Keep provider before protocol before any, so resolution is a scan.
    list.sort((a, b) => MATCH_RANK[a.providerMatch.kind] - MATCH_RANK[b.providerMatch.kind])
    this.byOperation.set(registration.operationId, list)
    return () => {
      const current = this.byOperation.get(registration.operationId) ?? []
      this.byOperation.set(
        registration.operationId,
        current.filter((candidate) => candidate !== entry)
      )
    }
  }

  /** Provider match first, then protocol, then any. */
  resolve(
    operationId: ProviderOperationId,
    providerId: string,
    protocol: ResolverProtocol
  ): ProviderOperationHandlerRegistration | undefined {
    const list = this.byOperation.get(operationId)
    if (!list) return undefined
    return list.find((registration) => {
      const match = registration.providerMatch
      switch (match.kind) {
        case "provider":
          return match.providerId === providerId
        case "protocol":
          return match.protocol === protocol
        case "any":
          return true
      }
    })
  }

  list(): readonly ProviderOperationHandlerRegistration[] {
    return [...this.byOperation.values()].flat()
  }

  /** Every registration bound to `operationId`, in resolution order. */
  listFor(operationId: ProviderOperationId): readonly ProviderOperationHandlerRegistration[] {
    return this.byOperation.get(operationId) ?? []
  }

  clear(): void {
    this.byOperation.clear()
  }
}

/** The process-wide registry the executor uses by default. */
export const providerOperationHandlerRegistry = new ProviderOperationHandlerRegistry()

export function registerProviderOperationHandler<TInput, TOutput>(
  registration: ProviderOperationHandlerRegistration<TInput, TOutput>
): () => void {
  return providerOperationHandlerRegistry.register(registration)
}
