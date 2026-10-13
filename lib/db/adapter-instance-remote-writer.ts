/**
 * Where this shell's connector instances live when it does not run them
 * (ADR-0224): a phone or a paired browser drives a Host, whose connector
 * runtime is the only one that can start an adapter. Its local table is a
 * mirror the Host's sync fills, so a row written only here is one nothing
 * ever runs. With a writer installed (`lib/connectors/host-instance-writer`),
 * each create, edit and removal in `./adapter-instances` goes to the Host
 * first and the mirror follows what the Host answered; nothing else changes
 * for the forms that call those writers.
 *
 * `applies` is asked per write, so routing follows the shell's current Host.
 * Ownership placeholders (`setAdapterInstanceOwner`) stay local: they are the
 * desktop's record of a move, not a Host's configuration.
 *
 * A leaf with type-only imports, so the credential hook can complete a create
 * without importing the table module its callers' tests replace.
 */

import type { AdapterInstancePatch } from "./adapter-instances"
import type { AdapterInstanceRow } from "./connector-types"

export interface AdapterInstanceRemoteWriter {
  applies(): boolean
  /** Create on the Host; resolves to the row as the Host stored it. */
  create(row: AdapterInstanceRow): Promise<Partial<AdapterInstanceRow>>
  configure(id: string, patch: AdapterInstancePatch): Promise<void>
  remove(id: string): Promise<void>
  /** Called once a new instance's credentials are in place; see {@link completeAdapterInstanceCreate}. */
  completeCreate(id: string): Promise<void>
}

let remoteWriter: AdapterInstanceRemoteWriter | null = null

/** Install (or with `null`, remove) the writer. Returns a restore function. */
export function setAdapterInstanceRemoteWriter(
  writer: AdapterInstanceRemoteWriter | null
): () => void {
  const previous = remoteWriter
  remoteWriter = writer
  return () => {
    remoteWriter = previous
  }
}

/** The installed writer when it applies to this write, else null. */
export function hostAdapterInstanceWriter(): AdapterInstanceRemoteWriter | null {
  return remoteWriter?.applies() ? remoteWriter : null
}

/**
 * A new instance's credentials are stored. A Host creates an instance stopped,
 * because its runtime would otherwise try to start it before the secrets the
 * form writes next have arrived; this starts it. A no-op where instances live
 * in this process.
 */
export async function completeAdapterInstanceCreate(id: string): Promise<void> {
  await hostAdapterInstanceWriter()?.completeCreate(id)
}
