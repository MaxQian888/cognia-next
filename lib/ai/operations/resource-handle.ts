/**
 * Resource handles for the provider-pinned operations (ADR-0163, Batch 14).
 *
 * A handle names a provider-side resource together with WHO owns it:
 * provider, deployment, account and the fingerprint of the credential it
 * was created under. The executor pins resolution to the handle's provider
 * and refuses another credential. These helpers give the handlers the two
 * remaining checks: the handle is present and of the expected kind, and it
 * names the provider the handler is running for.
 */

import type { ProviderResourceHandle, ProviderResourceHandleKind } from "@cognia/provider-types"

import { credentialAffinityOf } from "./credential-affinity"
import { ProviderOperationFailureError } from "./failure"

export interface HandleOwner {
  providerId: string
  apiKey: string | undefined
}

/** The ownership tuple of a resource created under `owner` on `deploymentRef`. */
export function handleFor(input: {
  kind: ProviderResourceHandleKind
  id: string
  owner: HandleOwner
  deploymentRef?: string
  createdAt?: number
}): ProviderResourceHandle {
  const deploymentRef = input.deploymentRef ?? input.owner.providerId
  return {
    kind: input.kind,
    id: input.id,
    providerId: input.owner.providerId,
    deploymentRef,
    accountRef: credentialAffinityOf(input.owner.apiKey),
    credentialAffinity: credentialAffinityOf(input.owner.apiKey),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  }
}

/** The handle a request carries, checked for kind and provider. */
export function requireHandle(
  input: { handle?: ProviderResourceHandle } | undefined,
  kind: ProviderResourceHandleKind,
  owner: HandleOwner
): ProviderResourceHandle {
  const handle = input?.handle
  if (!handle) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: `this operation needs a ${kind} handle`,
    })
  }
  if (handle.kind !== kind) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: `expected a ${kind} handle, got ${handle.kind}`,
    })
  }
  if (handle.providerId !== owner.providerId) {
    throw new ProviderOperationFailureError({
      code: "permission",
      retryable: false,
      message: `handle belongs to provider "${handle.providerId}", not "${owner.providerId}"`,
    })
  }
  if (handle.credentialAffinity !== credentialAffinityOf(owner.apiKey)) {
    throw new ProviderOperationFailureError({
      code: "authentication",
      retryable: false,
      message: "handle was created under a different credential",
    })
  }
  return handle
}

/** Epoch seconds from a vendor, to epoch milliseconds. */
export function epochMs(seconds: unknown): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? Math.round(seconds * 1000)
    : undefined
}
