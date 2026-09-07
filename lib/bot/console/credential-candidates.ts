/**
 * What a credential slot can be bound to, shaped for a picker.
 *
 * Two sources, and which one a slot draws from is derived rather than
 * declared, because `PluginBotCredentialSlot` has no field that says so:
 *
 *  * A slot whose `integration` names a connector platform (`slack`,
 *    `telegram`) is asking for an IM account, so the candidates are connector
 *    adapter instances of that type.
 *  * A slot whose `integration` names anything else is asking for an
 *    integration account of that integration, whichever plugin created it.
 *  * A slot that names nothing has nothing to narrow by, so both are offered
 *    and the label carries the kind.
 *
 * Only ever an id, never a secret and never an auth session on its own. A
 * session is a property of an account: the broker resolves it at call time,
 * and a binding that named one directly would go stale the first time it
 * rotated while continuing to look bound.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { isPlatformKind } from "@/types/connectors/platform-kind"
import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import type { PluginBotCredentialSlot } from "@/types/plugin/plugin-bot"

/** One thing a slot may be bound to. */
export interface BotCredentialCandidate {
  /** The id written into the binding. Unique within one slot's list. */
  value: string
  kind: "integration-account" | "adapter"
  label: string
  /** The integration or platform it belongs to, shown beside the label. */
  detail?: string
  /**
   * The account or adapter is switched off. It stays selectable: binding to a
   * disabled account is a legitimate way to prepare a Bot before turning the
   * account back on, and removing it from the list would leave a user unable
   * to reproduce a binding they can plainly see on another installation.
   */
  disabled: boolean
}

/**
 * Which source a slot draws from.
 *
 * Exported because the picker's empty state says different things for each:
 * "connect an account" and "add a connector" are different buttons.
 */
export type BotCredentialSourceKind = "integration" | "adapter" | "either"

/**
 * `knownAdapterTypes` is what makes this right for a PLUGIN-owned connector
 * kind. Those are not in `ALL_PLATFORM_KINDS` (that is the whole point of the
 * open string branch on `PlatformKind`), so `isPlatformKind` alone would send
 * a slot naming one to the integration accounts and quietly offer the wrong
 * list. Asking the connector registry instead would drag its module graph into
 * a pure builder, and the adapter rows the caller already holds answer the
 * same question for every kind that actually exists on this device.
 */
export function credentialSourceForSlot(
  slot: Pick<PluginBotCredentialSlot, "integration">,
  knownAdapterTypes: readonly string[] = []
): BotCredentialSourceKind {
  if (!slot.integration) return "either"
  if (isPlatformKind(slot.integration)) return "adapter"
  return knownAdapterTypes.includes(slot.integration) ? "adapter" : "integration"
}

export interface CredentialCandidateInput {
  slot: Pick<PluginBotCredentialSlot, "id" | "integration">
  /** `listAllIntegrationAccounts()`, unnarrowed. */
  accounts: readonly IntegrationAccount[]
  /** `listAdapterInstances()`, unnarrowed. */
  adapters: readonly AdapterInstanceRow[]
}

function accountCandidate(account: IntegrationAccount): BotCredentialCandidate {
  return {
    value: account.id,
    kind: "integration-account",
    // The label a user gave it, falling back to the remote identity, falling
    // back to the id. A blank row in a picker is unselectable in practice.
    label: account.label || account.remoteAccountId || account.id,
    detail: account.integrationId,
    disabled: !account.enabled,
  }
}

function adapterCandidate(adapter: AdapterInstanceRow): BotCredentialCandidate {
  return {
    value: adapter.id,
    kind: "adapter",
    label: adapter.displayName || adapter.id,
    detail: adapter.type,
    disabled: !adapter.enabled,
  }
}

/**
 * The candidates for one slot, enabled ones first and each half alphabetical.
 *
 * Enabled first because a picker's job is to make the working choice the easy
 * one, and a list ordered purely by name buries the only usable account under
 * three revoked ones.
 */
export function buildCredentialCandidates(
  input: CredentialCandidateInput
): BotCredentialCandidate[] {
  const source = credentialSourceForSlot(
    input.slot,
    input.adapters.map((adapter) => adapter.type)
  )
  const integration = input.slot.integration

  const fromAccounts =
    source === "adapter"
      ? []
      : input.accounts
          .filter((account) => !integration || account.integrationId === integration)
          .map(accountCandidate)

  const fromAdapters =
    source === "integration"
      ? []
      : input.adapters
          .filter((adapter) => source !== "adapter" || adapter.type === integration)
          .map(adapterCandidate)

  return [...fromAccounts, ...fromAdapters].sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1
    return a.label.localeCompare(b.label)
  })
}

/**
 * The value a slot's picker should show as selected.
 *
 * One field or the other, never both: `bindBotCredential` writes exactly one,
 * and reading a row that somehow carries both would render a select with a
 * value matching no option, which renders EMPTY rather than falling back.
 */
export function selectedCandidateValue(
  binding: { integrationAccountId?: string; adapterId?: string } | undefined
): string | undefined {
  return binding?.integrationAccountId ?? binding?.adapterId
}

/** Turn a picked candidate back into the binding shape the write takes. */
export function bindingForCandidate(
  candidate: BotCredentialCandidate
): { integrationAccountId: string } | { adapterId: string } {
  return candidate.kind === "adapter"
    ? { adapterId: candidate.value }
    : { integrationAccountId: candidate.value }
}
