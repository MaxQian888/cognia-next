/**
 * Whether a pulled op really comes from a device of this space (protocol §9,
 * client side). The server checks the same before storing; a client checks
 * again because it trusts nothing the server says beyond ordering.
 *
 * - The signer must be in the verified device list, and the signature valid.
 * - A removed device's ops count only if sealed under an epoch before its
 *   removal: it never held a later key. (Its older keys remain, so a server
 *   colluding with a removed device could still replay old-epoch writes; the
 *   protocol accepts that residual risk, §4.2.)
 * - A device's epochs never go backwards along its own sequence.
 *
 * An op under an epoch newer than the list this device verified is not an
 * origin failure: another device rotated meanwhile. The applier parks it until
 * the list and key chain are refreshed, then checks it.
 */

import {
  fromBase64Url,
  importEcdsaPublicKey,
  verifyOpSignature,
  type FoldedRegistry,
  type Op,
} from "@cognia/sync-protocol"

export class OpOriginError extends Error {
  constructor(
    readonly op: Pick<Op, "deviceId" | "deviceSeq" | "epoch">,
    message: string
  ) {
    super(message)
    this.name = "OpOriginError"
  }
}

export interface OpOriginChecker {
  check(op: Op): Promise<void>
}

/** The epoch a device's removal started, by device id. */
function removalEpochs(registry: FoldedRegistry): Map<string, number> {
  const epochs = new Map<string, number>()
  for (const { signed } of registry.entries) {
    const entry = signed.entry
    if (entry.type === "revoke-device") epochs.set(entry.deviceId, entry.epoch.epoch)
  }
  return epochs
}

export function createOpOriginChecker(registry: FoldedRegistry): OpOriginChecker {
  const removed = removalEpochs(registry)
  const keys = new Map<string, Promise<CryptoKey>>()
  const lastEpoch = new Map<string, number>()
  return {
    async check(op) {
      const device = registry.state.devices[op.deviceId]
      if (!device) throw new OpOriginError(op, "the op's device is not in this space")
      const removedAt = removed.get(op.deviceId)
      if (removedAt !== undefined && op.epoch >= removedAt)
        throw new OpOriginError(op, "the op is sealed under a key its removed device never held")
      if (op.epoch < (lastEpoch.get(op.deviceId) ?? 0))
        throw new OpOriginError(op, "the device's epochs went backwards")
      let key = keys.get(op.deviceId)
      if (!key) {
        key = importEcdsaPublicKey(fromBase64Url(device.signPub))
        keys.set(op.deviceId, key)
      }
      if (!(await verifyOpSignature(await key, registry.state.spaceId, op)))
        throw new OpOriginError(op, "the op's signature does not verify")
      lastEpoch.set(op.deviceId, op.epoch)
    },
  }
}
