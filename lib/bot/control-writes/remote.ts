/**
 * The relayed half of the Bot control writes.
 *
 * A phone, a browser companion, or a desktop driving a remote Host does not
 * run a delivery runner. Each of the three controls is shipped to the paired
 * Host through the durable `mobileOutboundQueue` and dispatched as an RPC with
 * the row's idempotency key as the `Idempotency-Key` header, exactly as the
 * Inbox relay does.
 *
 * ## The keys are the design
 *
 * Each command's key is chosen for what a REPLAY after a reconnect must do,
 * which is the one thing nobody exercises by hand:
 *
 *  * Arming uses a fresh UUID per explicit command. Queue retries preserve it,
 *    while arm/disarm/arm cannot reuse a cached response from the first arm.
 *  * Manual runs use a fresh UUID per press and carry it in their event payload.
 *  * Retry presses also use fresh UUIDs so a completed transient failure is
 *    not replayed forever. The Host deduplicates the successor by delivery.
 *
 * ## What is optimistic and what is not
 *
 * Arming writes the local mirror straight away and holds a pending marker, so
 * the switch does not flip back while the write is in flight
 * (`pending-installations.ts`, read by the sync handler). Running and replaying
 * do NOT: both create or move a delivery row the Host owns, and a mirror
 * inventing one would put a delivery on screen that no queue anywhere holds.
 */

import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { sha256Hex } from "@/lib/share/hash"
import type { MobileOutboundJobRow } from "@/lib/db/mobile-outbound-types"
import { getBotInstallation, updateBotInstallation } from "@/lib/db/bot-installations"

import { markPendingBotInstallationMutation } from "./pending-installations"
import { BOT_WRITE_COMMANDS, type BotWriteCommand } from "./route"

export interface RemoteBotWriteOptions {
  /** Human label rendered in the offline-queue UI. */
  label?: string
}

/**
 * The idempotency key one relayed command travels under.
 *
 * Kept as a pure function taking its id source, so the replay semantics can be
 * tested without a queue and without a clock.
 */
export async function botWriteIdempotencyKey(
  command: BotWriteCommand,
  _payload: Record<string, unknown>,
  freshId: () => string
): Promise<string> {
  switch (command) {
    case BOT_WRITE_COMMANDS.replayDelivery:
    case BOT_WRITE_COMMANDS.setTriggerArmed:
    case BOT_WRITE_COMMANDS.mutateInstallation:
    case BOT_WRITE_COMMANDS.runManual:
      // Minted once, here, not derived. Two manual runs ARE two runs, and a
      // derived key would fold the second press onto the first.
      return freshId()
  }
}

/** UUID v8: a namespaced digest, with the complete delivery identity included. */
async function botControlUuid(key: string): Promise<string> {
  const hex = await sha256Hex(`cognia:bot-control:${key}`)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Upgrade only the two exact legacy Bot key formats at dispatch, without rewriting audit rows. */
export async function normalizeLegacyBotWriteKey(
  row: Pick<MobileOutboundJobRow, "id" | "command" | "payload" | "idempotencyKey">
): Promise<string> {
  if (
    row.command === BOT_WRITE_COMMANDS.replayDelivery &&
    typeof row.payload.deliveryId === "string" &&
    row.idempotencyKey === `bot-replay:${row.payload.deliveryId}`
  ) {
    return botControlUuid(`legacy-replay:${row.id}`)
  }
  if (
    row.command === BOT_WRITE_COMMANDS.setTriggerArmed &&
    typeof row.payload.installationId === "string" &&
    typeof row.payload.triggerId === "string" &&
    typeof row.payload.armed === "boolean" &&
    row.idempotencyKey ===
      `bot-arm:${row.payload.installationId}:${row.payload.triggerId}:${row.payload.armed ? 1 : 0}`
  ) {
    return botControlUuid(`legacy-arm:${row.id}`)
  }
  return row.idempotencyKey
}

export interface SetTriggerArmedRemotelyInput {
  installationId: string
  triggerId: string
  armed: boolean
}

/**
 * Relay an arm, then flip the local mirror so the switch settles immediately.
 *
 * The pending marker is taken BEFORE the enqueue and released after the local
 * write, which is the window a `sync_pull` landing in between would otherwise
 * use to hand back the pre-mutation row.
 */
export async function setBotTriggerArmedRemotely(
  input: SetTriggerArmedRemotelyInput,
  options: RemoteBotWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  const release = markPendingBotInstallationMutation(input.installationId)
  try {
    const payload = {
      installationId: input.installationId,
      triggerId: input.triggerId,
      armed: input.armed,
    }
    const queueRow = await enqueue({
      command: BOT_WRITE_COMMANDS.setTriggerArmed,
      idempotencyKey: await botWriteIdempotencyKey(
        BOT_WRITE_COMMANDS.setTriggerArmed,
        payload,
        () => crypto.randomUUID()
      ),
      ...(options.label ? { label: options.label } : {}),
      payload,
    })
    const installation = await getBotInstallation(input.installationId)
    if (installation) {
      // The override only. Status is re-derived from the credential slots, and
      // this client has none of them: `credentialBindings` is emptied by the
      // projection, so deriving here would answer `enabled` for a Bot the Host
      // knows is `needs_setup`.
      await updateBotInstallation(input.installationId, {
        triggerOverrides: {
          ...(installation.triggerOverrides ?? {}),
          [input.triggerId]: input.armed,
        },
      })
    }
    return queueRow
  } finally {
    release()
  }
}

export interface RunBotManuallyRemotelyInput {
  installationId: string
  triggerId?: string
  /**
   * Free-form, and typed as it is on the local leg rather than narrowed to an
   * object. The handler decides what its payload means, and narrowing here
   * would make the two legs take different inputs for the same button.
   */
  input?: unknown
  /** Minted once by the caller and reused on every retry of this press. */
  idempotencyKey: string
}

/** Relay a manual run. No optimistic row: the delivery is the Host's to mint. */
export async function runBotManuallyRemotely(
  input: RunBotManuallyRemotelyInput,
  options: RemoteBotWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  return enqueue({
    command: BOT_WRITE_COMMANDS.runManual,
    idempotencyKey: input.idempotencyKey,
    ...(options.label ? { label: options.label } : {}),
    payload: {
      installationId: input.installationId,
      ...(input.triggerId ? { triggerId: input.triggerId } : {}),
      ...(input.input !== undefined ? { input: input.input } : {}),
      idempotencyKey: input.idempotencyKey,
    },
  })
}

/** Relay a dead-letter replay. The Host arm refuses a row that is not one. */
export async function replayBotDeliveryRemotely(
  deliveryId: string,
  options: RemoteBotWriteOptions = {}
): Promise<MobileOutboundJobRow> {
  const payload = { deliveryId }
  return enqueue({
    command: BOT_WRITE_COMMANDS.replayDelivery,
    idempotencyKey: await botWriteIdempotencyKey(BOT_WRITE_COMMANDS.replayDelivery, payload, () =>
      crypto.randomUUID()
    ),
    ...(options.label ? { label: options.label } : {}),
    payload,
  })
}
