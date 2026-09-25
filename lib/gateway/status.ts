/**
 * Pure readings of `GatewayStatus` shared by more than one settings surface.
 */

import type { GatewayStatus } from "@/types/gateway"

/**
 * An account-scoped gateway with no unlocked local account. Rust then lists no
 * keys, refuses to mint one and authorizes no request, so every surface that
 * would otherwise say "no keys" or "create a key" must say "locked" instead.
 */
export function isGatewayAccountLocked(status: GatewayStatus | null): boolean {
  return Boolean(status?.accountRequired && !status.ownerAccountId)
}
