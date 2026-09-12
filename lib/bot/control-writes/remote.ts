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
 *  * `bot_trigger_set_armed` uses a DERIVED key naming the VALUE it sets, so
 *    arm, disarm and arm again enqueue three distinct rows, and replaying the
 *    first still leaves the Host armed. A `bot_trigger_toggle` command could
 *    not be made safe at any key, which is why the write is absolute.
 *  * `bot_run_manual` uses a FRESH key per press, because two presses are two
 *    runs and only a fresh key can tell that from a retry of one. The Host arm
 *    derives the envelope's event id from it, so a retry folds back onto the
 *    same delivery through `botDeliveryDedupKey`.
 *  * `bot_delivery_replay` uses a derived key AND the Host arm is guarded on
 *    the row still being dead-lettered, so a duplicate finds nothing to do.
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
export function botWriteIdempotencyKey(
  command: BotWriteCommand,
  payload: Record<string, unknown>,
  freshId: () => string
): string {
  switch (command) {
    case BOT_WRITE_COMMANDS.setTriggerArmed:
      return `bot-arm:${String(payload.installationId)}:${String(payload.triggerId)}:${payload.armed ? 1 : 0}`
    case BOT_WRITE_COMMANDS.replayDelivery:
      return `bot-replay:${String(payload.deliveryId)}`
    case BOT_WRITE_COMMANDS.mutateInstallation:
    case BOT_WRITE_COMMANDS.runManual:
      // Minted once, here, not derived. Two manual runs ARE two runs, and a
      // derived key would fold the second press onto the first.
      return freshId()
  }
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
      idempotencyKey: botWriteIdempotencyKey(BOT_WRITE_COMMANDS.setTriggerArmed, payload, () =>
        crypto.randomUUID()
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
    idempotencyKey: botWriteIdempotencyKey(BOT_WRITE_COMMANDS.replayDelivery, payload, () =>
      crypto.randomUUID()
    ),
    ...(options.label ? { label: options.label } : {}),
    payload,
  })
}
