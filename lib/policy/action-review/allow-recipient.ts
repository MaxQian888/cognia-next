/**
 * "Allow this recipient" from the shadow report (ADR-0239): append one
 * recipient to the list the report chose, as a person's own edit.
 *
 * The list is re-read at the moment of the click rather than taken from the
 * report, so an entry someone added since the report was built is kept, and a
 * recipient already on the list is not added twice.
 */

import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

import { listsRecipient, recipientGrant } from "./configured-grants"
import type { OutboundTarget } from "./outbound-targets"
import type { ShadowAllowInto } from "./shadow-report"

export interface AllowRecipientDeps {
  readBotList?: (installationId: string) => Promise<readonly OutboundRecipientGrant[] | undefined>
  writeBotList?: (installationId: string, next: OutboundRecipientGrant[]) => Promise<unknown>
  readAdapterList?: (adapterId: string) => Promise<readonly OutboundRecipientGrant[] | undefined>
  writeAdapterList?: (adapterId: string, next: OutboundRecipientGrant[]) => Promise<unknown>
  now?: () => number
}

export class AllowRecipientTargetMissingError extends Error {
  constructor(readonly into: ShadowAllowInto) {
    super(
      into.kind === "bot"
        ? `Bot installation ${into.installationId} no longer exists`
        : `Connection ${into.adapterId} no longer exists`
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
