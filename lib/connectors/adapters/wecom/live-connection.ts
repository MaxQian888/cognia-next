/**
 * Registry of WeCom bots holding a live `aibot_subscribe` socket.
 *
 * WeCom allows exactly ONE long connection per bot. The settings form's "test
 * connection" used to open a second one with the same credentials, which meant
 * pressing it while the bot was running could kick the live socket (or be
 * kicked by it) and drop an in-flight conversation — the probe's own comment
 * admitted as much.
 *
 * A running adapter has already proven those credentials: the socket exists
 * because `aibot_subscribe` returned `errcode: 0`. So for the credentials that
 * are already connected there is nothing to test — the answer is the live
 * adapter's health, and no socket needs opening. For DIFFERENT credentials on
 * the same bot id there is no safe answer while the bot is connected, and the
 * probe says so instead of racing for the slot.
 *
 * The registry is keyed by bot id because the platform's limit is per bot:
 * probing bot B never disturbs bot A, so a second bot's live socket must not
 * block it.
 *
 * Only the credential FINGERPRINT is held — a salted-by-bot-id SHA-256 of the
 * secret. The registry lives in renderer memory next to a settings form; the
 * secret itself stays in the keyring.
 */

import type { AdapterHealth } from "@/types/connectors/adapter"
import { sha256Hex } from "@/lib/share/hash"

export interface WeComLiveConnection {
  /** The adapter instance that owns the socket. */
  adapterId: string
  /** The WeCom bot id the socket is subscribed as. */
  botId: string
  /** {@link weComCredentialFingerprint} of the credentials it subscribed with. */
  credentialFingerprint: string
  /** Read live, so a degraded or reconnecting socket is reported as such. */
  health: () => AdapterHealth
}

/** botId → the connection currently subscribed as that bot. */
const live = new Map<string, WeComLiveConnection>()

/**
 * Stable, non-reversible id for one (botId, secret) pair.
 *
 * The bot id is length-prefixed so the encoding is injective: plain
 * `botId + ":" + secret` lets `("a", ":b")` and `("a:", "b")` hash the same,
 * which would make one bot's fingerprint match another's and hand a probe the
 * wrong verdict about whose connection it is looking at.
 */
export async function weComCredentialFingerprint(botId: string, secret: string): Promise<string> {
  return sha256Hex(`wecom:${botId.length}:${botId}:${secret}`)
}

/**
 * Record that `connection` owns this bot's connection slot. Called after a
 * successful subscribe, so it is re-run on every reconnect; the last writer
 * wins, which is correct because only one socket can exist.
 *
 * Returns an unregister function that clears the slot only if it still holds
 * THIS connection — a restart that re-registered before the old adapter's
 * teardown ran must not have its entry deleted by that teardown.
 */
export function registerWeComLiveConnection(connection: WeComLiveConnection): () => void {
  live.set(connection.botId, connection)
  return () => {
    if (live.get(connection.botId) === connection) live.delete(connection.botId)
  }
}

/** The connection currently subscribed as `botId`, if any. */
export function findWeComLiveConnection(botId: string): WeComLiveConnection | undefined {
  return live.get(botId)
}

/** Test-only reset of the module slot. */
export function __resetWeComLiveConnectionsForTests(): void {
  live.clear()
}
