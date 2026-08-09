import type { AppSettings, ChatSession, Character } from "@cognia/agent-config-types"

import { getDb, withDbReopenRetry } from "@/lib/db/schema"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings/settings-store"
import type { ProviderId } from "@/types/subscription"

import { deleteAccount, getActiveAccount, listAccounts, saveAccount } from "./transport"
import type { Account } from "@/types/subscription"
import { notifySubscriptionChanged } from "./subscription-events"

export interface ProviderAccountReferences {
  sessions: Array<{ id: string; title: string }>
  characters: Array<{ id: string; name: string }>
  isDefault: boolean
  isActive: boolean
}

export interface DeleteProviderAccountInput {
  provider: ProviderId
  accountId: string
  replacementAccountId: string | null
}

export async function persistProviderAccount(
  provider: ProviderId,
  account: Account
): Promise<Account> {
  await saveAccount(provider, account)
  return account
}

interface ReferenceJournal {
  transitionAt: number
  sessionIds: string[]
  characterIds: string[]
  previousDefaultAccountIds?: AppSettings["defaultAccountIds"]
  previousLegacyDefaultAccountId?: string
  settingsChanged: boolean
}

export async function inspectProviderAccountReferences(
  provider: ProviderId,
  accountId: string
): Promise<ProviderAccountReferences> {
  const db = getDb()
  const [sessions, characters, settings, active] = await Promise.all([
    db.sessions.filter((session) => session.accountId === accountId).toArray(),
    db.characters.filter((character) => character.accountIdOverride === accountId).toArray(),
    getSettings(),
    getActiveAccount(provider),
  ])
  return {
    sessions: sessions.map(({ id, title }) => ({ id, title })),
    characters: characters.map(({ id, name }) => ({ id, name })),
    isDefault:
      settings.defaultAccountIds?.[provider] === accountId ||
      (settings.defaultProvider === provider && settings.defaultAccountId === accountId),
    isActive: active.activeAccountId === accountId,
  }
}

export async function setProviderDefaultAccount(
  provider: ProviderId,
  accountId: string | null
): Promise<AppSettings> {
  const current = await getSettings()
  const defaultAccountIds = { ...current.defaultAccountIds }
  const legacyProvider =
    current.defaultProvider === "opencode-go"
      ? "opencode"
      : current.defaultProvider === "anthropic" ||
          current.defaultProvider === "codex" ||
          current.defaultProvider === "opencode"
        ? current.defaultProvider
        : null
  if (current.defaultAccountId && legacyProvider) {
    defaultAccountIds[legacyProvider] ??= current.defaultAccountId
  }
  if (accountId) defaultAccountIds[provider] = accountId
  else delete defaultAccountIds[provider]
  const saved = await saveSettings({ defaultAccountIds, defaultAccountId: undefined })
  publishSettings(saved)
  notifySubscriptionChanged()
  return saved
}

export async function deleteProviderAccount({
  provider,
  accountId,
  replacementAccountId,
}: DeleteProviderAccountInput): Promise<void> {
  const [accounts, references] = await Promise.all([
    listAccounts(provider),
    inspectProviderAccountReferences(provider, accountId),
  ])
  if (!accounts.some((account) => account.id === accountId)) {
    throw new Error(`Provider account ${accountId} no longer exists.`)
  }
  const remaining = accounts.filter((account) => account.id !== accountId)
  const normalizedReplacement = remaining.length === 0 ? null : replacementAccountId
  if (normalizedReplacement && !remaining.some((account) => account.id === normalizedReplacement)) {
    throw new Error(`Replacement account ${normalizedReplacement} is not available.`)
  }
  const hasReferences =
    references.sessions.length > 0 ||
    references.characters.length > 0 ||
    references.isDefault ||
    references.isActive
  if (remaining.length > 0 && hasReferences && !normalizedReplacement) {
    throw new Error("A replacement account is required while this account is still referenced.")
  }

  const journal = await rewriteReferences(provider, accountId, normalizedReplacement)
  try {
    await deleteAccount(provider, accountId, normalizedReplacement)
  } catch (deleteError) {
    try {
      await restoreReferences(provider, accountId, normalizedReplacement, journal)
    } catch (rollbackError) {
      throw new AggregateError(
        [deleteError, rollbackError],
        "Provider account deletion failed and its reference migration could not be fully rolled back."
      )
    }
    throw deleteError
  }
}

async function rewriteReferences(
  provider: ProviderId,
  accountId: string,
  replacementAccountId: string | null
): Promise<ReferenceJournal> {
  return withDbReopenRetry(async () => {
    const db = getDb()
    const transitionAt = Date.now()
    return db.transaction("rw", db.sessions, db.characters, db.settings, async () => {
      const sessions = await db.sessions
        .filter((session) => session.accountId === accountId)
        .toArray()
      const characters = await db.characters
        .filter((character) => character.accountIdOverride === accountId)
        .toArray()
      const settings = await db.settings.get("singleton")
      const settingsChanged =
        settings?.defaultAccountIds?.[provider] === accountId ||
        (settings?.defaultProvider === provider && settings.defaultAccountId === accountId)

      await db.sessions
        .filter((session) => session.accountId === accountId)
        .modify((session: ChatSession) => {
          session.accountId = replacementAccountId ?? undefined
          session.updatedAt = transitionAt
        })
      await db.characters
        .filter((character) => character.accountIdOverride === accountId)
        .modify((character: Character) => {
          character.accountIdOverride = replacementAccountId ?? undefined
          character.updatedAt = transitionAt
        })

      if (settings && settingsChanged) {
        const defaultAccountIds = { ...settings.defaultAccountIds }
        if (replacementAccountId) defaultAccountIds[provider] = replacementAccountId
        else delete defaultAccountIds[provider]
        const nextSettings: AppSettings = {
          ...settings,
          defaultAccountIds,
          defaultAccountId:
            settings.defaultProvider === provider && settings.defaultAccountId === accountId
              ? undefined
              : settings.defaultAccountId,
          updatedAt: transitionAt,
        }
        await db.settings.put(nextSettings)
        publishSettings(nextSettings)
      }

      return {
        transitionAt,
        sessionIds: sessions.map(({ id }) => id),
        characterIds: characters.map(({ id }) => id),
        previousDefaultAccountIds: settings?.defaultAccountIds,
        previousLegacyDefaultAccountId: settings?.defaultAccountId,
        settingsChanged,
      }
    })
  })
}

async function restoreReferences(
  provider: ProviderId,
  accountId: string,
  replacementAccountId: string | null,
  journal: ReferenceJournal
): Promise<void> {
  await withDbReopenRetry(async () => {
    const db = getDb()
    const rollbackAt = Date.now()
    await db.transaction("rw", db.sessions, db.characters, db.settings, async () => {
      for (const sessionId of journal.sessionIds) {
        const session = await db.sessions.get(sessionId)
        if (
          session?.updatedAt === journal.transitionAt &&
          session.accountId === (replacementAccountId ?? undefined)
        ) {
          await db.sessions.update(sessionId, { accountId, updatedAt: rollbackAt })
        }
      }
      for (const characterId of journal.characterIds) {
        const character = await db.characters.get(characterId)
        if (
          character?.updatedAt === journal.transitionAt &&
          character.accountIdOverride === (replacementAccountId ?? undefined)
        ) {
          await db.characters.update(characterId, {
            accountIdOverride: accountId,
            updatedAt: rollbackAt,
          })
        }
      }
      if (journal.settingsChanged) {
        const settings = await db.settings.get("singleton")
        const expectedDefault = replacementAccountId ?? undefined
        const transitionedLegacyDefault =
          journal.previousLegacyDefaultAccountId === accountId
            ? undefined
            : journal.previousLegacyDefaultAccountId
        if (
          settings?.updatedAt === journal.transitionAt &&
          settings.defaultAccountIds?.[provider] === expectedDefault &&
          settings.defaultAccountId === transitionedLegacyDefault
        ) {
          const restored: AppSettings = {
            ...settings,
            defaultAccountIds: journal.previousDefaultAccountIds,
            defaultAccountId: journal.previousLegacyDefaultAccountId,
            updatedAt: rollbackAt,
          }
          await db.settings.put(restored)
          publishSettings(restored)
        }
      }
    })
  })
}

function publishSettings(settings: AppSettings): void {
  const current = useSettingsStore.getState().settings
  if (!current) return
  useSettingsStore.setState({ settings: { ...current, ...settings } })
}
