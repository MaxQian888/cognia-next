/**
 * The provider operation manifest (ADR-0163), loaded once from
 * `protocol/provider-operations.json`, validated with zod against the
 * vocabulary in `@cognia/provider-types`, and frozen into a map. Same
 * pattern as `lib/tauri/command-descriptors.ts` for the companion manifest.
 */

import { z } from "zod"

import manifestJson from "@/protocol/provider-operations.json"
import {
  PROVIDER_OPERATION_BILLINGS,
  PROVIDER_OPERATION_GROUPS,
  PROVIDER_OPERATION_ID_PATTERN,
  PROVIDER_OPERATION_IDEMPOTENCIES,
  PROVIDER_OPERATION_IDS,
  PROVIDER_OPERATION_KINDS,
  PROVIDER_OPERATION_PII_GATES,
  PROVIDER_OPERATION_REMOTE_EXPOSURES,
  PROVIDER_OPERATION_RISKS,
  PROVIDER_OPERATION_SCOPES,
  PROVIDER_OPERATION_STATEFUL_HANDLES,
  PROVIDER_OPERATION_STREAMINGS,
  PROVIDER_OPERATION_SURFACES,
  type ProviderOperationDescriptor,
  type ProviderOperationId,
  type ProviderOperationManifest,
} from "@cognia/provider-types"

const descriptorSchema = z.object({
  id: z.string().regex(PROVIDER_OPERATION_ID_PATTERN),
  group: z.enum(PROVIDER_OPERATION_GROUPS),
  operation: z.enum(PROVIDER_OPERATION_KINDS),
  risk: z.enum(PROVIDER_OPERATION_RISKS),
  idempotency: z.enum(PROVIDER_OPERATION_IDEMPOTENCIES),
  billing: z.enum(PROVIDER_OPERATION_BILLINGS),
  scopes: z.array(z.enum(PROVIDER_OPERATION_SCOPES)).min(1),
  surfaces: z.array(z.enum(PROVIDER_OPERATION_SURFACES)).min(1),
  remoteExposure: z.enum(PROVIDER_OPERATION_REMOTE_EXPOSURES),
  piiGate: z.enum(PROVIDER_OPERATION_PII_GATES),
  streaming: z.enum(PROVIDER_OPERATION_STREAMINGS),
  statefulHandle: z.enum(PROVIDER_OPERATION_STATEFUL_HANDLES),
  inputSchema: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
  outputSchema: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
})

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  operations: z.array(descriptorSchema),
})

function loadManifest(raw: unknown): ProviderOperationManifest {
  const parsed = manifestSchema.parse(raw)
  const known = new Set<string>(PROVIDER_OPERATION_IDS)
  const operations: ProviderOperationDescriptor[] = parsed.operations.map((descriptor) => {
    if (!known.has(descriptor.id)) {
      throw new Error(`provider-operations.json names an unknown operation: ${descriptor.id}`)
    }
    return Object.freeze({ ...descriptor, id: descriptor.id as ProviderOperationId })
  })
  return { schemaVersion: 1, operations }
}

export const PROVIDER_OPERATION_MANIFEST: ProviderOperationManifest = loadManifest(manifestJson)

const descriptors = new Map<ProviderOperationId, ProviderOperationDescriptor>()
for (const descriptor of PROVIDER_OPERATION_MANIFEST.operations) {
  if (descriptors.has(descriptor.id)) {
    throw new Error(`Duplicate provider operation descriptor: ${descriptor.id}`)
  }
  descriptors.set(descriptor.id, descriptor)
}

export function getProviderOperationDescriptor(
  id: string
): ProviderOperationDescriptor | undefined {
  return descriptors.get(id as ProviderOperationId)
}

export function listProviderOperationDescriptors(): readonly ProviderOperationDescriptor[] {
  return PROVIDER_OPERATION_MANIFEST.operations
}

/** Descriptors of one group, in manifest order. Drives UI grouping. */
export function listProviderOperationDescriptorsByGroup(
  group: ProviderOperationDescriptor["group"]
): readonly ProviderOperationDescriptor[] {
  return PROVIDER_OPERATION_MANIFEST.operations.filter((d) => d.group === group)
}
