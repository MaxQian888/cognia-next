/**
 * Provider job registry for asynchronous operations (videos, batches,
 * fine-tuning). A handle is a provider-side id together with WHO owns it
 * (provider, deployment, account, credential affinity), so later calls pin
 * to the same account and never fail over.
 *
 * Two kinds of job live here:
 *   - remote jobs, whose truth is the provider's API (the registry only
 *     remembers the ownership tuple so `get` / `cancel` can be pinned),
 *   - locally completed jobs, where the SDK call ran to completion in this
 *     process (AI SDK video generation is synchronous). Their content is held
 *     in memory for the process lifetime and reported as `succeeded`. Nothing
 *     here ever fabricates a status the provider did not produce.
 */

import type { ProviderResourceHandle, ProviderResourceHandleKind } from "@cognia/provider-types"

import { credentialAffinityOf } from "./credential-affinity"

export type ProviderJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export interface LocalJobContent {
  bytes?: Uint8Array
  base64?: string
  mimeType?: string
  url?: string
}

export interface ProviderJobRecord {
  handle: ProviderResourceHandle
  status: ProviderJobStatus
  /** Present only for locally completed jobs. */
  content?: LocalJobContent
  error?: string
  createdAt: number
  updatedAt: number
}

export class ProviderJobRegistry {
  private readonly jobs = new Map<string, ProviderJobRecord>()

  private key(handle: Pick<ProviderResourceHandle, "kind" | "id" | "providerId">): string {
    return `${handle.kind}:${handle.providerId}:${handle.id}`
  }

  register(
    record: Omit<ProviderJobRecord, "createdAt" | "updatedAt">,
    now = Date.now()
  ): ProviderJobRecord {
    const stored: ProviderJobRecord = { ...record, createdAt: now, updatedAt: now }
    this.jobs.set(this.key(record.handle), stored)
    return stored
  }

  get(
    handle: Pick<ProviderResourceHandle, "kind" | "id" | "providerId">
  ): ProviderJobRecord | undefined {
    return this.jobs.get(this.key(handle))
  }

  update(
    handle: Pick<ProviderResourceHandle, "kind" | "id" | "providerId">,
    patch: Partial<Pick<ProviderJobRecord, "status" | "content" | "error">>,
    now = Date.now()
  ): ProviderJobRecord | undefined {
    const current = this.get(handle)
    if (!current) return undefined
    const next = { ...current, ...patch, updatedAt: now }
    this.jobs.set(this.key(handle), next)
    return next
  }

  list(kind?: ProviderResourceHandleKind): ProviderJobRecord[] {
    return [...this.jobs.values()].filter((job) => !kind || job.handle.kind === kind)
  }

  clear(): void {
    this.jobs.clear()
  }
}

export const providerJobRegistry = new ProviderJobRegistry()

/** Build the ownership tuple for a resource created under `provider`. */
export function makeResourceHandle(input: {
  kind: ProviderResourceHandleKind
  id: string
  providerId: string
  deploymentRef?: string
  accountRef?: string
  apiKey?: string
  createdAt?: number
}): ProviderResourceHandle {
  return {
    kind: input.kind,
    id: input.id,
    providerId: input.providerId,
    deploymentRef: input.deploymentRef ?? input.providerId,
    accountRef: input.accountRef ?? input.deploymentRef ?? input.providerId,
    credentialAffinity: credentialAffinityOf(input.apiKey),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  }
}

/** Refuse a handle that names a different provider than the one resolved. */
export function assertHandleOwner(handle: ProviderResourceHandle, providerId: string): void {
  if (handle.providerId !== providerId) {
    throw new Error(
      `resource handle belongs to provider "${handle.providerId}", not "${providerId}"`
    )
  }
}
