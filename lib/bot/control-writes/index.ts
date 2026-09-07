/**
 * Shell-agnostic Bot control write facade.
 *
 * Components never branch on the shell. They call one of the three writes
 * below, and {@link resolveBotWriteRoute} picks the executor, the same seam
 * `lib/connectors/inbox-writes` uses for the Inbox:
 *
 *   - `"local"`  -> `local.ts`, against this process's database
 *   - `"remote"` -> `remote.ts`, the durable relay to a paired Host
 *   - `"unavailable"` -> throws {@link BotWriteUnavailableError}
 *
 * The local leg calls the domain's own mutators rather than Dexie, so the
 * governance side effects a desktop click triggers (status re-derivation,
 * scheduler reconciliation, the delivery queue's lease and concurrency key)
 * happen for a remote caller too.
 */

import type { OperationAvailability } from "@/lib/runtime/operation-availability"
import type { BotInstallationRow } from "@/lib/db/bot-types"

import {
  replayBotDeliveryLocally,
  runBotManuallyLocally,
  setBotTriggerArmedLocally,
  type RunBotManuallyInput,
  type RunBotManuallyResult,
  type SetTriggerArmedInput,
} from "./local"
import {
  replayBotDeliveryRemotely,
  runBotManuallyRemotely,
  setBotTriggerArmedRemotely,
} from "./remote"
import {
  BOT_WRITE_COMMANDS,
  canEnqueueBotWrite,
  resolveBotWriteAvailability,
  resolveBotWriteRoute,
  type BotWriteCommand,
  type BotWriteRoute,
} from "./route"

export class BotWriteUnavailableError extends Error {
  readonly code = "bot_write_unavailable"
  constructor(
    readonly command: BotWriteCommand,
    readonly route: BotWriteRoute,
    readonly availability: OperationAvailability
  ) {
    super(
      `bot write "${command}" is unavailable on route "${route}" (${availability.state}: ${availability.reason})`
    )
    this.name = "BotWriteUnavailableError"
  }
}

function resolveRouteOrThrow(command: BotWriteCommand): Exclude<BotWriteRoute, "unavailable"> {
  const route = resolveBotWriteRoute(command)
  const availability = resolveBotWriteAvailability(command)
  if (route === "unavailable" || (route === "remote" && !canEnqueueBotWrite(availability))) {
    throw new BotWriteUnavailableError(command, route, availability)
  }
  return route
}

export async function setBotTriggerArmed(
  input: SetTriggerArmedInput
): Promise<BotInstallationRow | undefined> {
  const route = resolveRouteOrThrow(BOT_WRITE_COMMANDS.setTriggerArmed)
  if (route === "local") return setBotTriggerArmedLocally(input)
  // The relay answers with a queue row, not an installation. The caller reads
  // the switch from the mirror the relay just wrote, so `undefined` here means
  // "in flight" rather than "nothing happened".
  await setBotTriggerArmedRemotely(input)
  return undefined
}

export async function runBotManually(
  input: RunBotManuallyInput
): Promise<RunBotManuallyResult | undefined> {
  const route = resolveRouteOrThrow(BOT_WRITE_COMMANDS.runManual)
  if (route === "local") return runBotManuallyLocally(input)
  // No delivery id yet: the Host mints it from the idempotency key. Reporting
  // one here would name a row this device cannot see.
  await runBotManuallyRemotely(input)
  return undefined
}

export async function replayBotDeliveryWrite(deliveryId: string): Promise<boolean | undefined> {
  const route = resolveRouteOrThrow(BOT_WRITE_COMMANDS.replayDelivery)
  if (route === "local") return replayBotDeliveryLocally(deliveryId)
  // Whether the row was still dead-lettered is the Host's answer, and it comes
  // back through sync rather than through the queue.
  await replayBotDeliveryRemotely(deliveryId)
  return undefined
}

export {
  BOT_WRITE_COMMANDS,
  canEnqueueBotWrite,
  resolveBotWriteAvailability,
  resolveBotWriteRoute,
  type BotWriteCommand,
  type BotWriteRoute,
}
export { BotControlTargetMissingError, MANUAL_RUN_EVENT_TYPE } from "./local"
export type { RunBotManuallyInput, RunBotManuallyResult, SetTriggerArmedInput } from "./local"
export { botWriteIdempotencyKey } from "./remote"

/**
 * The installation lifecycle, re-exported through the same door.
 *
 * It routes on a different question (see `resolveBotLifecycleWriteAvailability`)
 * but a component should not have to know that there are two doors.
 */
export {
  BotDefinitionMissingError,
  BotLifecycleUnavailableError,
  BotNotInstallableError,
  bindBotCredential,
  installBotFromCatalog,
  setBotInstallationEnabled,
  uninstallBotInstallation,
  updateBotConfig,
} from "./lifecycle"
export type { InstallBotFromCatalogInput } from "./lifecycle"
export { canWriteBotLifecycle, resolveBotLifecycleWriteAvailability } from "./route"
