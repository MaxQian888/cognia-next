/**
 * The contract verdict for a paired Host (ADR-0175).
 *
 * A Host names the command contract it serves in `GET /api/whoami`, in the
 * device token it issues, and in `GET /api/catalog`. The client was built
 * against exactly one contract version. When the two differ the names, the
 * request shapes, or the error document have changed underneath this client,
 * and every command would fail in its own confusing way. So the device
 * handshake decides once, and `CompanionTransport.call` refuses with one
 * named reason instead.
 *
 * The verdict is keyed by the paired device id, which identifies the pairing
 * (and therefore the Host) the config points at. It is a tri-state on purpose:
 * `unknown` (no handshake has answered yet) is not `compatible`, and a
 * transport that has never heard from the Host still dispatches, because the
 * handshake that produces the verdict is the same request that would refuse.
 */

import { COMPANION_CONTRACT_VERSION } from "./command-descriptors"

export type HostContractVerdict =
  | { state: "unknown" }
  | { state: "compatible"; contractVersion: number; catalogHash: string | null }
  | {
      state: "incompatible"
      /** What the Host said, or null when it named no contract at all. */
      hostContractVersion: number | null
      clientContractVersion: number
    }

/** The fields a Host answer may carry. Anything else is ignored. */
export interface HostContractIdentity {
  contractVersion?: unknown
  catalogHash?: unknown
}

export type HostContractListener = (deviceId: string, verdict: HostContractVerdict) => void

const verdicts = new Map<string, HostContractVerdict>()
const listeners = new Set<HostContractListener>()

/**
 * Judge one Host answer against this client's contract. A Host that names
 * no version is an older Host, and older is incompatible: the hard cut means
 * there is no contract this client shares with it.
 */
export function judgeHostContract(
  identity: HostContractIdentity | null | undefined,
  clientContractVersion: number = COMPANION_CONTRACT_VERSION
): HostContractVerdict {
  const version =
    typeof identity?.contractVersion === "number" && Number.isInteger(identity.contractVersion)
      ? identity.contractVersion
      : null
  if (version !== null && version === clientContractVersion) {
    return {
      state: "compatible",
      contractVersion: version,
      catalogHash: typeof identity?.catalogHash === "string" ? identity.catalogHash : null,
    }
  }
  return { state: "incompatible", hostContractVersion: version, clientContractVersion }
}

/** Record what a Host answered for the pairing `deviceId` belongs to. */
export function recordHostContract(
  deviceId: string,
  identity: HostContractIdentity | null | undefined
): HostContractVerdict {
  const verdict = judgeHostContract(identity)
  const previous = verdicts.get(deviceId)
  verdicts.set(deviceId, verdict)
  if (!previous || !sameVerdict(previous, verdict)) {
    for (const listener of listeners) {
      try {
        listener(deviceId, verdict)
      } catch (error) {
        console.warn("companion-contract: listener threw", error)
      }
    }
  }
  return verdict
}

export function hostContractVerdict(deviceId: string): HostContractVerdict {
  return verdicts.get(deviceId) ?? { state: "unknown" }
}

/** Forget a pairing's verdict, for example when it is unpaired. */
export function forgetHostContract(deviceId: string): void {
  if (verdicts.delete(deviceId)) {
    for (const listener of listeners) listener(deviceId, { state: "unknown" })
  }
}

export function onHostContractChange(listener: HostContractListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The refusal `CompanionTransport.call` raises for an incompatible Host. */
export function contractIncompatibleError(
  verdict: Extract<HostContractVerdict, { state: "incompatible" }>
): { code: "contract_incompatible"; message: string; retryable: false } {
  const host =
    verdict.hostContractVersion === null
      ? "names no command contract version"
      : `serves command contract v${verdict.hostContractVersion}`
  return {
    code: "contract_incompatible",
    message: `the paired host ${host}, and this app was built for v${verdict.clientContractVersion}. Update the host and the app to matching versions`,
    retryable: false,
  }
}

function sameVerdict(left: HostContractVerdict, right: HostContractVerdict): boolean {
  if (left.state !== right.state) return false
  if (left.state === "compatible" && right.state === "compatible") {
    return left.contractVersion === right.contractVersion && left.catalogHash === right.catalogHash
  }
  if (left.state === "incompatible" && right.state === "incompatible") {
    return left.hostContractVersion === right.hostContractVersion
  }
  return true
}

export function __resetHostContractsForTests(): void {
  verdicts.clear()
  listeners.clear()
}
