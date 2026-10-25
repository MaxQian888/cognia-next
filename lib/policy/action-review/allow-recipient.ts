/**
 * "Allow this recipient" from the shadow report (ADR-0239): append one
 * recipient to the list the report chose, as a person's own edit.
 *
 * The list is re-read at the moment of the click rather than taken from the
 * report, so an entry someone added since the report was built is kept, and a
 * recipient already on the list is not added twice.
 *
 * A repository goes on a Bot's list (for the Bot's own writes) or on a GitHub
 * integration account's list (ADR-0239 phase 2), the one the hub edits. A
 * site goes on a Bot's list or the global site list (phase 2b), the one the
 * Security card edits.
 */

import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

import { listsRecipient, readOutboundSiteGrants, recipientGrant } from "./configured-grants"
import type { OutboundTarget } from "./outbound-targets"
import type { ShadowAllowInto } from "./shadow-report"

export interface AllowRecipientDeps {
  readBotList?: (installationId: string) => Promise<readonly OutboundRecipientGrant[] | undefined>
  writeBotList?: (installationId: string, next: OutboundRecipientGrant[]) => Promise<unknown>
  readAdapterList?: (adapterId: string) => Promise<readonly OutboundRecipientGrant[] | undefined>
  writeAdapterList?: (adapterId: string, next: OutboundRecipientGrant[]) => Promise<unknown>
  readAccountList?: (
    pluginId: string,
    accountId: string
  ) => Promise<readonly OutboundRecipientGrant[] | undefined>
  writeAccountList?: (
    pluginId: string,
    accountId: string,
    next: OutboundRecipientGrant[]
  ) => Promise<unknown>
  readSiteList?: () => Promise<readonly OutboundRecipientGrant[]>
  writeSiteList?: (next: OutboundRecipientGrant[]) => Promise<unknown>
  now?: () => number
}

export class AllowRecipientTargetMissingError extends Error {
  constructor(readonly into: ShadowAllowInto) {
    super(
      into.kind === "bot"
        ? `Bot installation ${into.installationId} no longer exists`
        : into.kind === "adapter"
          ? `Connection ${into.adapterId} no longer exists`
          : into.kind === "integration-account"
            ? `Integration account ${into.accountId} no longer exists`
            : "The site list is not available"
    )
    this.name = "AllowRecipientTargetMissingError"
  }
}

/** Resolves `false` when the list already held the recipient. */
export async function allowShadowRecipient(
  into: ShadowAllowInto,
  target: OutboundTarget,
  deps: AllowRecipientDeps = {}
): Promise<boolean> {
  const grant = recipientGrant(target, deps.now?.() ?? Date.now())
  if (!grant) throw new Error(`A ${target.kind} recipient cannot be listed`)

  if (into.kind === "bot") {
    const read = deps.readBotList ?? defaultReadBotList
    const current = await read(into.installationId)
    if (!current) throw new AllowRecipientTargetMissingError(into)
    if (listsRecipient(current, target)) return false
    await (deps.writeBotList ?? defaultWriteBotList)(into.installationId, [...current, grant])
    return true
  }

  if (into.kind === "integration-account") {
    const read = deps.readAccountList ?? defaultReadAccountList
    const current = await read(into.pluginId, into.accountId)
    if (!current) throw new AllowRecipientTargetMissingError(into)
    if (listsRecipient(current, target)) return false
    await (deps.writeAccountList ?? defaultWriteAccountList)(into.pluginId, into.accountId, [
      ...current,
      grant,
    ])
    return true
  }

  if (into.kind === "sites") {
    const current = await (deps.readSiteList ?? defaultReadSiteList)()
    if (listsRecipient(current, target)) return false
    await (deps.writeSiteList ?? defaultWriteSiteList)([...current, grant])
    return true
  }

  const read = deps.readAdapterList ?? defaultReadAdapterList
  const current = await read(into.adapterId)
  if (!current) throw new AllowRecipientTargetMissingError(into)
  if (listsRecipient(current, target)) return false
  await (deps.writeAdapterList ?? defaultWriteAdapterList)(into.adapterId, [...current, grant])
  return true
}

async function defaultReadBotList(
  installationId: string
): Promise<readonly OutboundRecipientGrant[] | undefined> {
  const { getBotInstallation } = await import("@/lib/db/bot-installations")
  const row = await getBotInstallation(installationId)
  return row ? (row.outboundRecipients ?? []) : undefined
}

async function defaultWriteBotList(
  installationId: string,
  next: OutboundRecipientGrant[]
): Promise<unknown> {
  const { setBotOutboundRecipients } = await import("@/lib/bot/control-writes")
  return setBotOutboundRecipients(installationId, next)
}

async function defaultReadAdapterList(
  adapterId: string
): Promise<readonly OutboundRecipientGrant[] | undefined> {
  const { getAdapterInstance } = await import("@/lib/db/adapter-instances")
  const row = await getAdapterInstance(adapterId)
  return row ? (row.outboundRecipients ?? []) : undefined
}

async function defaultWriteAdapterList(
  adapterId: string,
  next: OutboundRecipientGrant[]
): Promise<unknown> {
  const { setAdapterOutboundRecipients } = await import("@/lib/db/adapter-instances")
  return setAdapterOutboundRecipients(adapterId, next)
}

async function defaultReadAccountList(
  pluginId: string,
  accountId: string
): Promise<readonly OutboundRecipientGrant[] | undefined> {
  const { getIntegrationAccount } = await import("@/lib/db/integrations")
  const row = await getIntegrationAccount(pluginId, accountId)
  return row ? (row.outboundRecipients ?? []) : undefined
}

async function defaultWriteAccountList(
  pluginId: string,
  accountId: string,
  next: OutboundRecipientGrant[]
): Promise<unknown> {
  const { setIntegrationAccountOutboundRecipients } = await import("@/lib/db/integrations")
  return setIntegrationAccountOutboundRecipients(pluginId, accountId, next)
}

async function defaultReadSiteList(): Promise<readonly OutboundRecipientGrant[]> {
  const { useSettingsStore } = await import("@/stores/settings")
  return readOutboundSiteGrants(useSettingsStore.getState().settings)
}

async function defaultWriteSiteList(next: OutboundRecipientGrant[]): Promise<unknown> {
  const { useSettingsStore } = await import("@/stores/settings")
  const store = useSettingsStore.getState()
  // The latest permissions, so a mode switch saved meanwhile is kept.
  const permissions = store.settings?.agentPermissions ?? {}
  return store.save({ agentPermissions: { ...permissions, outboundSites: next } })
}
