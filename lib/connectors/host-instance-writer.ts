/**
 * Connector instances written on the Host a phone or paired browser drives
 * (ADR-0224). Installed into `lib/db/adapter-instances` by
 * `ConnectorHostWritesInitializer`.
 *
 * Such a shell runs no connector runtime, and its keychain is already the
 * Host's (`connectorCommandsNeedTransport`). Until this, its connection forms
 * wrote the instance row into a local mirror the Host never reads, while the
 * secrets went to the Host: a bot that could never start. Each write now goes
 * through the Host's `adapter_instance_mutate`, the same command a desktop
 * uses to move an instance there, under the one admin lease that also covers
 * the keychain writes, so a form asks for consent once.
 *
 * A new instance is created stopped and started by
 * {@link HostAdapterInstanceWriter.completeCreate} once its credentials are
 * stored: the Host's runtime starts whatever is enabled, and would otherwise
 * try before the form has written the secrets.
 */

import type { AdapterInstanceRemoteWriter } from "@/lib/db/adapter-instance-remote-writer"
import type { AdapterInstancePatch } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import {
  credentialConsentCode,
  ensureCredentialLease,
  type CredentialLeaseState,
} from "@/lib/connectors/credential-lease"
import { connectorCommandsNeedTransport, connectorDeviceLease } from "@/lib/connectors/device-plane"
import { PORTABLE_ADAPTER_FIELDS, instanceCreatePayload } from "@/lib/connectors/instance-transfer"

/** The Host command every write travels as. */
export const ADAPTER_INSTANCE_MUTATE = "adapter_instance_mutate"

/** The Host refused, or is waiting for someone to approve this device's lease. */
export class HostConnectorWriteRefusedError extends Error {
  constructor(readonly consentCode: string | null) {
    super(
      consentCode
        ? `The Host is waiting for approval of this device (code ${consentCode}). Approve it, then save again.`
        : "The Host did not allow this device to change its connections."
    )
    this.name = "HostConnectorWriteRefusedError"
  }
}

export interface HostAdapterInstanceWriterDeps {
  applies: () => boolean
  call: <T>(command: string, args: Record<string, unknown>) => Promise<T>
  ensureLease: () => Promise<CredentialLeaseState>
  leaseToken: () => string | null
  consentCode: () => string | null
  newOperationId: () => string
  /** Mark the mirror's copy started once the Host has started it. */
  markStarted: (id: string) => Promise<void>
}

export interface HostAdapterInstanceWriter extends AdapterInstanceRemoteWriter {
  /** Ids created stopped and not yet started. */
  pendingStarts(): ReadonlySet<string>
}

const PORTABLE = new Set<string>(PORTABLE_ADAPTER_FIELDS)

function portablePatch(patch: AdapterInstancePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (PORTABLE.has(key) && value !== undefined) out[key] = value
  }
  return out
}

async function defaultCall<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { transport } = await import("@/lib/tauri")
  return transport.call<T>(command, args)
}

const defaultDeps: HostAdapterInstanceWriterDeps = {
  applies: () => connectorCommandsNeedTransport(),
  call: defaultCall,
  ensureLease: ensureCredentialLease,
  leaseToken: connectorDeviceLease,
  consentCode: credentialConsentCode,
  newOperationId: () => crypto.randomUUID(),
  markStarted: async (id) => {
    await getDb().adapterInstances.update(id, { enabled: true, updatedAt: Date.now() })
  },
}

export function createHostAdapterInstanceWriter(
  overrides: Partial<HostAdapterInstanceWriterDeps> = {}
): HostAdapterInstanceWriter {
  const deps = { ...defaultDeps, ...overrides }
  const pending = new Set<string>()

  const lease = async (): Promise<string> => {
    const state = await deps.ensureLease()
    const token = deps.leaseToken()
    if (state !== "held" || !token) throw new HostConnectorWriteRefusedError(deps.consentCode())
    return token
  }

  const mutate = async <T>(args: Record<string, unknown>): Promise<T> =>
    deps.call<T>(ADAPTER_INSTANCE_MUTATE, {
      ...args,
      operationId: deps.newOperationId(),
      adminLease: await lease(),
    })

  return {
    applies: () => deps.applies(),

    async create(row: AdapterInstanceRow) {
      const { instance, remainder } = instanceCreatePayload(row, { enabled: false })
      const stored = await mutate<Partial<AdapterInstanceRow>>({
        operation: "create",
        id: row.id,
        instance,
      })
      // The create's contract admits only the core; the rest follows here.
      if (remainder) await mutate({ operation: "configure", id: row.id, patch: remainder })
      if (row.enabled) pending.add(row.id)
      return { ...stored, id: row.id, enabled: false }
    },

    async configure(id, patch) {
      const portable = portablePatch(patch)
      if (Object.keys(portable).length === 0) return
      // Starting it is the form's to decide only after its credentials land.
      if (pending.has(id) && portable.enabled === true) delete portable.enabled
      if (Object.keys(portable).length === 0) return
      await mutate({ operation: "configure", id, patch: portable })
    },

    async remove(id) {
      pending.delete(id)
      await mutate({ operation: "remove", id })
    },

    async completeCreate(id) {
      if (!pending.has(id)) return
      await mutate({ operation: "configure", id, patch: { enabled: true } })
      pending.delete(id)
      await deps.markStarted(id)
    },

    pendingStarts: () => pending,
  }
}
