/**
 * What a paired Host's version means for this app (ADR-0175, ADR-0224 A10).
 *
 * Versions stay exact: no ranges are negotiated. A Host and this app agree
 * when the Host serves exactly the command contract this app was built for.
 * When they do not, the useful thing to tell the user is which side to
 * update, not that a call was refused:
 *
 * - The Host serves an older contract, or names none (it predates
 *   contract versions): update the Host.
 * - The Host serves a newer contract: update this app.
 * - The Host's own server refuses its brain: the Host was half-updated (its
 *   server and brain come from different builds). Update the Host, whatever
 *   the contract says.
 *
 * The contract verdict in `lib/tauri/companion-contract.ts` lives in memory
 * and starts `unknown` on every launch. This is the persisted form, kept on
 * the Host record so the device console and the Host panel can say it before
 * the next handshake.
 */

import type { HostBrainRefusal, HostContractVerdict } from "@/lib/tauri/companion-contract"

export type HostVersionAdvice = "none" | "update-host" | "update-app"

export interface HostVersionState {
  advice: HostVersionAdvice
  /** The contract the Host serves; null when it named none. */
  hostContractVersion: number | null
  /** The contract this app was built for. */
  appContractVersion: number
  /** Set while the Host's server refuses its own brain. */
  brainRefusal: HostBrainRefusal | null
  /** Epoch ms of the handshake this came from. */
  observedAt: number
}

/** Which side to update, from the contract verdict and the brain report. */
export function hostVersionAdvice(
  verdict: Exclude<HostContractVerdict, { state: "unknown" }>,
  brainRefusal: HostBrainRefusal | null
): HostVersionAdvice {
  if (brainRefusal) return "update-host"
  if (verdict.state === "compatible") return "none"
  if (verdict.hostContractVersion === null) return "update-host"
  return verdict.hostContractVersion < verdict.clientContractVersion ? "update-host" : "update-app"
}

/**
 * Fold one handshake fact into the stored state. A contract verdict replaces
 * the contract half; a brain report replaces the brain half. An `unknown`
 * verdict says nothing new and keeps what was known. Returns `previous` when
 * nothing changed, so callers can skip a store write.
 */
export function nextHostVersionState(
  previous: HostVersionState | undefined,
  fact:
    | { kind: "contract"; verdict: HostContractVerdict }
    | { kind: "brain"; refusal: HostBrainRefusal | null },
  appContractVersion: number,
  now: number
): HostVersionState | undefined {
  let verdict: Exclude<HostContractVerdict, { state: "unknown" }>
  let brainRefusal = previous?.brainRefusal ?? null
  if (fact.kind === "contract") {
    if (fact.verdict.state === "unknown") return previous
    verdict = fact.verdict
  } else {
    brainRefusal = fact.refusal
    if (!previous) {
      // No contract verdict yet: the brain report alone still names the fix.
      if (!brainRefusal) return previous
      verdict = { state: "compatible", contractVersion: appContractVersion, catalogHash: null }
    } else {
      verdict = verdictOf(previous)
    }
  }
  const next: HostVersionState = {
    advice: hostVersionAdvice(verdict, brainRefusal),
    hostContractVersion:
      verdict.state === "compatible" ? verdict.contractVersion : verdict.hostContractVersion,
    appContractVersion,
    brainRefusal,
    observedAt: now,
  }
  if (
    previous &&
    previous.advice === next.advice &&
    previous.hostContractVersion === next.hostContractVersion &&
    previous.appContractVersion === next.appContractVersion &&
    sameRefusal(previous.brainRefusal, next.brainRefusal)
  ) {
    return previous
  }
  return next
}

function verdictOf(state: HostVersionState): Exclude<HostContractVerdict, { state: "unknown" }> {
  return state.hostContractVersion === state.appContractVersion
    ? { state: "compatible", contractVersion: state.appContractVersion, catalogHash: null }
    : {
        state: "incompatible",
        hostContractVersion: state.hostContractVersion,
        clientContractVersion: state.appContractVersion,
      }
}

function sameRefusal(left: HostBrainRefusal | null, right: HostBrainRefusal | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
