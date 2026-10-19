/**
 * The checks a pairing runs while its one-shot invitation is still
 * redeemable, shared by every caller that redeems one: `PairStep` (scanned,
 * pasted or linked invitations) and the Host installer (ADR-0235 P5), whose
 * invitation comes from `cognia-server pair --json` on the machine it just
 * installed.
 *
 * Both checks exist because the Host burns the invitation at registration.
 * A transport this client can never complete, or a credential store that
 * will refuse the device key, is known before anything is sent; found after,
 * the only way forward needs an invitation that no longer exists.
 */

import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { usesBrowserVault } from "@/stores/account/account-store"

import { diagnoseTransport, type PairFailure } from "./pair-failure"

/**
 * Can this client keep a device key?
 *
 * Only the web answers "not yet": `getActiveBrowserVault()` is null until
 * someone unlocks the account with its password, and every credential write
 * through it throws `BrowserVaultLockedError`.
 */
export function credentialStoreReady(): boolean {
  return !usesBrowserVault() || getActiveBrowserVault() !== null
}

export interface PairPreflightInput {
  /** The invitation's direct address, when it decoded. */
  baseUrl: string | undefined
  /** It carries a relay room (ADR-0170), redeemable whatever `baseUrl` is. */
  hasRelay: boolean
  webMode: boolean
  credentialStoreReady: boolean
  /** The locked-vault explanation, already translated. */
  vaultLockedText: string
}

/** The first check that would make the pairing fail, or `null`. */
export function preflightPairing(input: PairPreflightInput): PairFailure | null {
  // Cheapest first: a transport this browser can never complete. A relay room
  // makes the direct address no reason to refuse.
  if (input.baseUrl && !input.hasRelay) {
    const transportFailure = diagnoseTransport(input.baseUrl, input.webMode)
    if (transportFailure) return transportFailure
  }
  if (!input.credentialStoreReady) {
    return {
      stage: "persist",
      kind: "vault_locked",
      detail: input.vaultLockedText,
      bodyText: input.vaultLockedText,
      remedies: ["unlockAccount"],
      retryable: true,
      invitationSpent: false,
      baseUrl: input.baseUrl,
    }
  }
  return null
}
