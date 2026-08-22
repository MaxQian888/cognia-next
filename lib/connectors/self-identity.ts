/**
 * The bot's own confirmed identity on its platform.
 *
 * Every anti-loop decision rests on one question — "did one of my own bots
 * send this?" — and that question is unanswerable without a platform account
 * id we have actually observed. The identity used to be inferred from
 * `lastWhoamiResult.openId` (a Lark-shaped cache that other platforms
 * populated inconsistently) or from an operator-typed `settings.selfBotOpenId`,
 * so "no identity" and "not one of ours" were indistinguishable and the guard
 * silently failed open.
 *
 * `AdapterSelfIdentitySnapshot` is the explicit answer. It is written by three
 * kinds of probe, all equally authoritative:
 *
 *   - `startup_probe`  — the adapter confirmed itself while starting.
 *   - `gateway_ready`  — a gateway handshake announced the identity
 *                        (Discord READY, Lark WS ready).
 *   - `whoami`         — an on-demand identity call from the settings panel.
 *
 * See `lib/connectors/sibling-bots.ts` for how absence is handled: it fails
 * closed rather than guessing.
 */

import type { AdapterSelfIdentitySnapshot } from "@/lib/db/connector-types"
import { getAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"

export interface SelfIdentityInput {
  /** The platform's id for the account this instance authenticates as. */
  platformAccountId: string
  /** Bot-scoped id where the platform separates it from the account id. */
  platformBotId?: string
  source: AdapterSelfIdentitySnapshot["source"]
}

/**
 * Build a snapshot, or `undefined` when the probe produced no usable account
 * id. Returning `undefined` rather than a snapshot with an empty id is the
 * point: an empty id would match nothing while still claiming the identity is
 * confirmed, which is exactly the failure mode this replaces.
 */
export function buildSelfIdentity(
  input: SelfIdentityInput,
  now: () => number = Date.now
): AdapterSelfIdentitySnapshot | undefined {
  const platformAccountId = input.platformAccountId?.trim()
  if (!platformAccountId) return undefined
  const platformBotId = input.platformBotId?.trim()
  return {
    platformAccountId,
    ...(platformBotId ? { platformBotId } : {}),
    source: input.source,
    confirmedAt: now(),
  }
}

/**
 * Persist a confirmed identity for `adapterId`.
 *
 * Best-effort by contract: a failure here must never take down an adapter
 * start or a whoami call. The cost of failing is that the sibling guard stays
 * closed for that instance's peers, which is the safe direction, and the next
 * probe retries.
 *
 * Returns the snapshot that was written, or `undefined` when there was nothing
 * to write or the write failed.
 */
export async function recordSelfIdentity(
  adapterId: string,
  input: SelfIdentityInput,
  now: () => number = Date.now
): Promise<AdapterSelfIdentitySnapshot | undefined> {
  const identity = buildSelfIdentity(input, now)
  if (!identity) return undefined
  try {
    const existing = await getAdapterInstance(adapterId)
    // Re-confirming the same id on every reconnect would rewrite the row for
    // no reason; only the timestamp would move, and nothing reads it as a
    // liveness signal.
    if (
      existing?.selfIdentity?.platformAccountId === identity.platformAccountId &&
      existing.selfIdentity.platformBotId === identity.platformBotId
    ) {
      return existing.selfIdentity
    }
    await updateAdapterInstance(adapterId, { selfIdentity: identity })
    return identity
  } catch {
    return undefined
  }
}

/**
 * Platforms whose adapters can confirm their own identity, and the probe that
 * does it. Single source of truth for both {@link confirmSelfIdentityOnStart}
 * and {@link hasIdentityProbe} — if those two disagreed, the sibling guard
 * would draw the wrong conclusion from a missing identity.
 */
const IDENTITY_PROBES: Record<string, () => Promise<(id: string, o: object) => Promise<unknown>>> =
  {
    telegram: async () =>
      (await import("@/lib/connectors/whoami/telegram-whoami")).probeTelegramIdentity,
    discord: async () =>
      (await import("@/lib/connectors/whoami/discord-whoami")).probeDiscordIdentity,
    slack: async () => (await import("@/lib/connectors/whoami/slack-whoami")).probeSlackIdentity,
    matrix: async () => (await import("@/lib/connectors/whoami/matrix-whoami")).probeMatrixIdentity,
    "qq-official": async () =>
      (await import("@/lib/connectors/whoami/qq-official-whoami")).probeQQOfficialIdentity,
    lark: async () => (await import("@/lib/connectors/adapters/lark/whoami")).probeBotIdentity,
  }

/**
 * Whether this platform's adapter confirms its own identity when it starts.
 *
 * The sibling-bot guard reads this to interpret a MISSING identity, and the
 * two possible meanings are opposites:
 *
 *   - probe-capable platform, no identity → the instance has never started
 *     successfully, so it cannot have authored the message being classified.
 *     Not a sibling; do not fail closed over it.
 *   - platform with no probe, no identity → the instance may well be running
 *     and posting, and we have no way to recognise its messages. This is the
 *     genuinely unknowable case the guard must fail closed on.
 *
 * Adding a probe for a platform therefore also removes its instances from the
 * fail-closed set, which is the right incentive.
 */
export function hasIdentityProbe(type: string): boolean {
  return type in IDENTITY_PROBES
}

/**
 * Confirm `adapterId`'s own platform identity as part of starting it.
 *
 * The sibling-bot guard fails closed on an unconfirmed instance, which is only
 * a safe design if identity lands reliably without an operator visiting the
 * settings panel. That is this function's job: the supervisor calls it after a
 * successful start, and the platform probe writes `selfIdentity` with
 * `source: "startup_probe"`.
 *
 * Best-effort and never throwing — a bot whose identity probe fails is still a
 * working bot; it just keeps its peers conservative until the probe succeeds,
 * and `inbound.sibling_identity_unknown` names it when that costs something.
 *
 * Platforms absent from the switch have no identity probe yet. They are
 * skipped rather than faked: an instance with no confirmed identity is a fact
 * the guard already knows how to handle.
 */
export async function confirmSelfIdentityOnStart(
  adapterId: string,
  type: string
): Promise<AdapterSelfIdentitySnapshot | undefined> {
  const load = IDENTITY_PROBES[type]
  if (!load) return undefined
  try {
    const probe = await load()
    await probe(adapterId, { source: "startup_probe" })
  } catch {
    return undefined
  }
  const row = await getAdapterInstance(adapterId).catch(() => undefined)
  return row?.selfIdentity
}
