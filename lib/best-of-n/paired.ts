import type { BestOfNGroup } from "@/types/best-of-n"
import { createBestOfNHost, type BestOfNHost } from "./host"

/**
 * A device that does not execute the run (a paired phone or browser) asks the
 * executing Host's owner to stop it. The Host accepts the request without a
 * lease and the owner settles each attempt; nothing here can select, publish
 * or archive. Retries a stale view of the ledger version, never a refusal.
 */
export async function requestBestOfNCancel(
  groupId: string,
  host: Pick<BestOfNHost, "get" | "cancel"> = createBestOfNHost()
): Promise<BestOfNGroup> {
  // Never an owner id the executing Host could hold, so this cannot take its lease.
  const ownerId = `paired-request:${crypto.randomUUID()}`
  for (let attempt = 0; ; attempt++) {
    const group = await host.get(groupId)
    try {
      return await host.cancel({
        groupId,
        expectedVersion: group.version,
        ownerId,
        leaseDurationMs: 30_000,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt >= 2 || !message.includes("best-of-N version conflict")) throw error
    }
  }
}
