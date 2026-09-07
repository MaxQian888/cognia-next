/**
 * The relayed half of the Bot control writes.
 *
 * Deliberately dormant this round, and dormant in the shape the working leg
 * will take rather than as a missing function. The three commands and their
 * idempotency keys are decided here because the KEY is the design, not the
 * transport, and getting it wrong is not visible until a queued command is
 * replayed after a reconnect:
 *
 *  * `bot_trigger_set_armed` uses a DERIVED key naming the value it sets, so
 *    an arm/disarm/arm sequence enqueues three distinct rows and a replay of
 *    the first still leaves the Host armed. A `bot_trigger_toggle` command
 *    could not be made safe at any key.
 *  * `bot_run_manual` uses a FRESH key per press, because two presses are two
 *    runs and only a fresh key can tell that from a retry of one. The host arm
 *    derives the envelope's event id from it, so a retry folds onto one row.
 *  * `bot_delivery_replay` uses a derived key and is guarded on the row still
 *    being dead-lettered, so a duplicate finds nothing to do.
 *
 * What is missing is the queue leg and the host arm, which is a registration
 * across the companion command manifest, the Rust dispatch and the generated
 * clients. Until that lands, {@link relayBotWrite} refuses with a typed error
 * and `resolveBotWriteAvailability` reports it, so a phone shows a disabled
 * control with a reason rather than a button that silently does nothing.
 */

import { BOT_WRITE_COMMANDS, type BotWriteCommand } from "./route"

export class BotRelayNotImplementedError extends Error {
  readonly code = "bot_relay_not_implemented"
  constructor(readonly command: BotWriteCommand) {
    super(`bot control command "${command}" cannot be relayed yet`)
    this.name = "BotRelayNotImplementedError"
  }
}

/**
 * The idempotency key one relayed command travels under.
 *
 * Exported and tested now even though nothing enqueues yet, because it is the
 * part that cannot be fixed after the fact: a wrong key is only wrong on the
 * replay path, which is the path nobody exercises by hand.
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
    case BOT_WRITE_COMMANDS.runManual:
      // Minted once, here, not derived. Two manual runs ARE two runs, and a
      // derived key would fold the second press onto the first.
      return freshId()
  }
}

export async function relayBotWrite(command: BotWriteCommand): Promise<never> {
  throw new BotRelayNotImplementedError(command)
}
