/**
 * The plugin contract's share of `lib/ai/operations/registry.ts`, which re-exports these.
 */
import type { ProviderOperationDescriptor, ProviderOperationRequest } from "@cognia/provider-types"
import type { ProviderSettingsSnapshot, ResolvedProvider } from "../provider-consumption"

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
