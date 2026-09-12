/**
 * Installing, configuring, binding and uninstalling: the writes that create
 * and shape an installation rather than drive one.
 *
 * Paired clients send these through the existing host control bridge. The
 * local entry points keep the host ownership gate and the same domain writes.
 *
 * Every one of them goes through the domain's own mutators, never Dexie. Those
 * mutators re-derive the installation status and reconcile the scheduler rows,
 * and a raw `botInstallations.put` here would leave a Bot with a cron trigger
 * armed and nothing scheduled to fire it.
 *
 * ## The status trap
 *
 * `updateBotInstallation` re-derives status whenever `credentialBindings` or
 * `status` is in the patch, and it does that against whatever
 * `requiredCredentials` it was handed. Handed nothing, `unboundCredentialSlots`
 * sees an empty requirement list, concludes nothing is unbound, and promotes a
 * `needs_setup` installation to `enabled` while its slots are still empty.
 *
 * So every mutator below resolves the definition first and passes the slots
 * through, and refuses outright when the definition is gone, because there is
 * no third answer that leaves the row honest. That is the whole reason these
 * are not one-line wrappers.
 */

import { resolveInstalledBot } from "@/lib/bot/installed-bot"
import {
  getBotInstallation,
  installBot,
  uninstallBot,
  updateBotInstallation,
} from "@/lib/db/bot-installations"
import type {
  BotCredentialBinding,
  BotInstallationRow,
  BotInstallationScope,
} from "@/lib/db/bot-types"
import type { OperationAvailability } from "@/lib/runtime/operation-availability"
import type { PluginBotCredentialSlot } from "@/types/plugin/plugin-bot"

import type { BotCatalogEntry } from "@/lib/bot/console/catalog"
import { BotControlTargetMissingError } from "./local"
import {
  BOT_WRITE_COMMANDS,
  resolveBotWriteRoute,
  resolveBotLifecycleWriteAvailability,
} from "./route"
import { transport } from "@/lib/tauri"
import type { BotLifecycleMutation } from "./lifecycle-host"

export class BotLifecycleUnavailableError extends Error {
  readonly code = "bot_lifecycle_unavailable"
  constructor(readonly availability: OperationAvailability) {
    super(
      `bot installation lifecycle is unavailable here (${availability.state}: ${availability.reason})`
    )
    this.name = "BotLifecycleUnavailableError"
  }
}

/**
 * The installation's definition is gone, so there is nothing to configure.
 *
 * Distinct from a missing installation because the remedy is different:
 * reinstall the plugin that owned the definition, or uninstall the row. It is
 * also the guard against a real trap in `updateBotInstallation`, which
 * re-derives status whenever `credentialBindings` changes and, handed no
 * requirement list, concludes nothing is unbound. Writing a binding onto an
 * orphan would therefore flip it from `needs_setup` to `enabled` while it
 * still cannot run at all.
 */
export class BotDefinitionMissingError extends Error {
  readonly code = "bot_definition_missing"
  constructor(
    readonly installationId: string,
    readonly definitionId: string
  ) {
    super(`bot definition "${definitionId}" is gone, so installation "${installationId}" is inert`)
    this.name = "BotDefinitionMissingError"
  }
}

/** Refuses a definition that could never produce a runnable Bot. */
export class BotNotInstallableError extends Error {
  readonly code = "bot_not_installable"
  constructor(readonly definitionId: string) {
    super(`bot definition "${definitionId}" cannot be installed: its handler did not resolve`)
    this.name = "BotNotInstallableError"
  }
}

function assertAvailable(): void {
  if (resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation) !== "local") {
    throw new BotLifecycleUnavailableError({ state: "unsupported", reason: "requires-companion" })
  }
  const availability = resolveBotLifecycleWriteAvailability()
  if (availability.state !== "available") throw new BotLifecycleUnavailableError(availability)
}

/**
 * The slots this installation's definition declares.
 *
 * Throws for an orphan rather than answering `[]` or `undefined`. Neither is
 * safe: `[]` says "this Bot needs no credentials" and would promote the row to
 * `enabled`, and omitting the argument does not help either, because
 * `updateBotInstallation` re-derives status whenever `credentialBindings` or
 * `status` is in the patch regardless of whether a requirement list came with
 * it. Refusing is the only answer that leaves the row telling the truth.
 */
async function requiredSlotsFor(
  installation: BotInstallationRow
): Promise<readonly PluginBotCredentialSlot[]> {
  const resolved = await resolveInstalledBot(installation)
  if (!resolved) {
    throw new BotDefinitionMissingError(installation.id, installation.definitionId)
  }
  return resolved.definition.requires?.credentials ?? []
}

export interface InstallBotFromCatalogInput {
  entry: BotCatalogEntry
  scope: BotInstallationScope
  config?: Record<string, unknown>
  credentialBindings?: Record<string, BotCredentialBinding>
}

/**
 * Install one catalogue entry.
 *
 * The version is pinned from the entry rather than looked up again, so what a
 * user saw in the picker is what the installation records. A plugin that
 * updates underneath produces `version_drift`, which the detail pane reports,
 * rather than a silent change to an armed Bot.
 */
export async function installBotFromCatalogLocally(
  input: InstallBotFromCatalogInput,
  id?: string
): Promise<BotInstallationRow> {
  assertAvailable()
  if (input.entry.unresolvedHandler) throw new BotNotInstallableError(input.entry.definitionId)
  return installBot({
    ...(id ? { id } : {}),
    definitionId: input.entry.definitionId,
    definitionSource: input.entry.source,
    pinnedVersion: input.entry.version,
    scope: input.scope,
    requiredCredentials: input.entry.slots,
    ...(input.config ? { config: input.config } : {}),
    ...(input.credentialBindings ? { credentialBindings: input.credentialBindings } : {}),
  })
}

/**
 * Replace an installation's configuration blob.
 *
 * Replace rather than merge. The form submits every field it rendered, and a
 * merge would make a cleared value indistinguishable from an untouched one, so
 * a user could never unset anything.
 */
export async function updateBotConfigLocally(
  installationId: string,
  config: Record<string, unknown>
): Promise<BotInstallationRow> {
  assertAvailable()
  const installation = await getBotInstallation(installationId)
  if (!installation) throw new BotControlTargetMissingError("installation", installationId)
  if (installation.syncedFromHost)
    throw new BotLifecycleUnavailableError({ state: "unsupported", reason: "requires-companion" })
  const requiredCredentials = await requiredSlotsFor(installation)
  const updated = await updateBotInstallation(installationId, { config, requiredCredentials })
  if (!updated) throw new BotControlTargetMissingError("installation", installationId)
  return updated
}

/**
 * Bind one credential slot, or clear it with `null`.
 *
 * Only an integration account or a connector adapter, never an auth session on
 * its own. A session is a property of an account, and a binding naming a
 * session with no account is a pair the broker cannot resolve. The session is
 * deliberately not copied off the account either: it rotates, and a copy would
 * go stale while continuing to look bound.
 */
export async function bindBotCredentialLocally(
  installationId: string,
  slotId: string,
  binding: Pick<BotCredentialBinding, "integrationAccountId" | "adapterId"> | null
): Promise<BotInstallationRow> {
  assertAvailable()
  const installation = await getBotInstallation(installationId)
  if (!installation) throw new BotControlTargetMissingError("installation", installationId)
  if (installation.syncedFromHost)
    throw new BotLifecycleUnavailableError({ state: "unsupported", reason: "requires-companion" })

  const next = { ...installation.credentialBindings }
  if (binding && (binding.integrationAccountId || binding.adapterId)) {
    next[slotId] = {
      ...(binding.integrationAccountId
        ? { integrationAccountId: binding.integrationAccountId }
        : {}),
      ...(binding.adapterId ? { adapterId: binding.adapterId } : {}),
    }
  } else {
    // Deleted rather than set to `{}`. An empty object under a slot id is what
    // `unboundCredentialSlots` had to be written to see through, and leaving
    // one behind makes the row lie about what a reader can find in it.
    delete next[slotId]
  }

  const requiredCredentials = await requiredSlotsFor(installation)
  const updated = await updateBotInstallation(installationId, {
    credentialBindings: next,
    requiredCredentials,
  })
  if (!updated) throw new BotControlTargetMissingError("installation", installationId)
  return updated
}

/**
 * Enable or disable an installation by hand.
 *
 * `enabled` is a REQUEST, not a result: `resolveInstallationStatus` answers
 * `needs_setup` instead when a required slot is still unbound, so this can
 * never switch a half-configured Bot on.
 */
export async function setBotInstallationEnabledLocally(
  installationId: string,
  enabled: boolean
): Promise<BotInstallationRow> {
  assertAvailable()
  const installation = await getBotInstallation(installationId)
  if (!installation) throw new BotControlTargetMissingError("installation", installationId)
  if (installation.syncedFromHost)
    throw new BotLifecycleUnavailableError({ state: "unsupported", reason: "requires-companion" })
  const requiredCredentials = await requiredSlotsFor(installation)
  const updated = await updateBotInstallation(installationId, {
    status: enabled ? "enabled" : "disabled",
    requiredCredentials,
  })
  if (!updated) throw new BotControlTargetMissingError("installation", installationId)
  return updated
}

/**
 * Remove an installation and everything it had armed.
 *
 * An orphan is removable. It is the one state where removal is the ONLY thing
 * left to do, and gating it on a definition that no longer exists would strand
 * the row along with whatever scheduler tasks it still owns.
 */
export async function uninstallBotInstallationLocally(installationId: string): Promise<void> {
  assertAvailable()
  const installation = await getBotInstallation(installationId)
  if (!installation) throw new BotControlTargetMissingError("installation", installationId)
  if (installation.syncedFromHost)
    throw new BotLifecycleUnavailableError({ state: "unsupported", reason: "requires-companion" })
  await uninstallBot(installationId)
}

/** The host is authoritative; do not optimistically install into the companion mirror. */
async function relayLifecycle(input: BotLifecycleMutation): Promise<BotInstallationRow> {
  const availability = resolveBotLifecycleWriteAvailability()
  if (availability.state !== "available") throw new BotLifecycleUnavailableError(availability)
  return transport.call<BotInstallationRow>(BOT_WRITE_COMMANDS.mutateInstallation, input, {
    idempotencyKey: input.operationId,
  })
}

export async function installBotFromCatalog(
  input: InstallBotFromCatalogInput
): Promise<BotInstallationRow> {
  if (resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation) === "local")
    return installBotFromCatalogLocally(input)
  return relayLifecycle({
    operation: "install",
    operationId: crypto.randomUUID(),
    definitionId: input.entry.definitionId,
    version: input.entry.version,
    scope: input.scope,
    config: input.config,
    credentialBindings: input.credentialBindings
      ? Object.fromEntries(
          Object.entries(input.credentialBindings).map(([slot, binding]) => {
            if (binding.integrationAccountId && !binding.adapterId)
              return [slot, { integrationAccountId: binding.integrationAccountId }]
            if (binding.adapterId && !binding.integrationAccountId)
              return [slot, { adapterId: binding.adapterId }]
            throw new Error("Bot credential binding must identify one account or adapter")
          })
        )
      : undefined,
  })
}
export async function updateBotConfig(
  installationId: string,
  config: Record<string, unknown>
): Promise<BotInstallationRow> {
  if (resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation) === "local")
    return updateBotConfigLocally(installationId, config)
  return relayLifecycle({
    operation: "config",
    operationId: crypto.randomUUID(),
    installationId,
    config,
  })
}
export async function bindBotCredential(
  installationId: string,
  slotId: string,
  binding: Pick<BotCredentialBinding, "integrationAccountId" | "adapterId"> | null
): Promise<BotInstallationRow> {
  if (resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation) === "local")
    return bindBotCredentialLocally(installationId, slotId, binding)
  if (binding?.integrationAccountId && binding.adapterId)
    throw new Error("Bot credential binding must identify one account or adapter")
  return relayLifecycle({
    operation: "bind",
    operationId: crypto.randomUUID(),
    installationId,
    slotId,
    binding: binding?.integrationAccountId
      ? { integrationAccountId: binding.integrationAccountId }
      : binding?.adapterId
        ? { adapterId: binding.adapterId }
        : null,
  })
}
export async function setBotInstallationEnabled(
  installationId: string,
  enabled: boolean
): Promise<BotInstallationRow> {
  if (resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation) === "local")
    return setBotInstallationEnabledLocally(installationId, enabled)
  return relayLifecycle({
    operation: "set_enabled",
    operationId: crypto.randomUUID(),
    installationId,
    enabled,
  })
}
export async function uninstallBotInstallation(installationId: string): Promise<void> {
  if (resolveBotWriteRoute(BOT_WRITE_COMMANDS.mutateInstallation) === "local")
    return uninstallBotInstallationLocally(installationId)
  await relayLifecycle({ operation: "uninstall", operationId: crypto.randomUUID(), installationId })
}
