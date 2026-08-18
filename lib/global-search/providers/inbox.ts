/**
 * Inbox (ADR-0129 + IM ↔ chat cross-links): the two IM-shaped kinds.
 *
 *   - `inbox-conversation` — platform-bound sessions, from the session list the
 *     dialog already holds. Lives in the *chats* tab beside plain conversations
 *     (they ARE conversations, just ones that arrive over an IM connector) and
 *     opens the Inbox route rather than the main chat.
 *   - `inbox-contact` — people the connectors have seen (`platformIdentities`,
 *     merged CRM groups). Lives in the *people* tab beside characters and teams.
 *     Choosing one opens the contact's DM conversation when a bound session
 *     exists, else the adapter's inbox so the operator can find them there.
 *
 * Two providers, not one, because the engine keys a group by its provider's
 * single `kind` and only runs providers whose kind is in the active scope —
 * a single provider could not answer *chats* and *people* at once.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { InboxIcon } from "lucide-react"

import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import { listMergedGroups, type ContactGroup } from "@/lib/db/platform-identities"
import { parseConversationKey } from "@/types/connectors/event"
import { matchTitles } from "./helpers"
import { createListProvider } from "./list-provider"
import type { GlobalSearchAction, GlobalSearchProvider } from "../types"

export const INBOX_PROVIDER_ID = "builtin.inbox"
export const INBOX_CONTACTS_PROVIDER_ID = "builtin.inbox-contacts"

type BoundSession = ChatSession & { platformBinding: NonNullable<ChatSession["platformBinding"]> }

function isBound(session: ChatSession): session is BoundSession {
  return session.platformBinding != null
}

export interface InboxProviderDeps {
  listContacts: () => Promise<ContactGroup[]>
}

/** Platform-bound conversations, from the session list the dialog already holds. */
export const inboxProvider: GlobalSearchProvider = {
  id: INBOX_PROVIDER_ID,
  kind: "inbox-conversation",
  search({ query, ctx, limit }) {
    const bound = ctx.sessions.filter(isBound)
    const { hits, total, truncated } = matchTitles(bound, query.needle, {
      getTitle: (s) => s.title || s.platformBinding.conversationKey,
      getKeywords: (s) => [s.platformBinding.platform, s.platformBinding.conversationKey],
      getTimestamp: (s) => s.updatedAt,
      now: ctx.now,
      limit,
    })
    return {
      items: hits.map(({ row, match }) => ({
        id: `inbox-conversation:${row.id}`,
        kind: "inbox-conversation" as const,
        title: row.title || row.platformBinding.conversationKey,
        titlePositions: match.positions,
        subtitle: row.platformBinding.conversationKey,
        meta: row.platformBinding.platform,
        icon: { lucide: InboxIcon },
        score: match.score,
        timestamp: row.updatedAt,
        extra: { current: ctx.activeSessionId === row.id },
        action: {
          type: "open-inbox-conversation" as const,
          conversationKey: row.platformBinding.conversationKey,
        },
      })),
      total,
      truncated,
    }
  },
}

/** Every identity in a merged group: the surviving primary plus what it absorbed. */
function identitiesOf(group: ContactGroup): PlatformIdentityRow[] {
  return [group.primary, ...group.merged]
}

function contactName(group: ContactGroup): string {
  return (
    identitiesOf(group)
      .map((identity) => identity.displayName?.trim())
      .find((name): name is string => Boolean(name)) ?? group.primary.remoteUserId
  )
}

/**
 * The DM conversation a bound session represents, if its key parses. Group
 * chats never match a contact: their `remoteChatId` is a channel, not a user.
 */
function dmTargetOf(session: BoundSession): { remoteChatId: string; adapterId: string } | null {
  try {
    const parsed = parseConversationKey(session.platformBinding.conversationKey)
    if (parsed.threadId) return null
    return { remoteChatId: parsed.remoteChatId, adapterId: parsed.adapterId }
  } catch {
    return null
  }
}

/**
 * The bound session whose conversation is a DM with one of the contact's
 * identities. Prefers the identity's own adapter, then any adapter on the same
 * platform (a re-created adapter keeps the platform user id); newest wins.
 */
export function findContactDmSession(
  group: ContactGroup,
  sessions: readonly ChatSession[]
): BoundSession | undefined {
  const identities = identitiesOf(group)
  const bound = sessions.filter(isBound).sort((a, b) => b.updatedAt - a.updatedAt)
  const matches = (session: BoundSession, sameAdapter: boolean) => {
    const target = dmTargetOf(session)
    if (!target) return false
    return identities.some(
      (identity) =>
        identity.platform === session.platformBinding.platform &&
        identity.remoteUserId === target.remoteChatId &&
        (!sameAdapter || identity.adapterId === target.adapterId)
    )
  }
  return bound.find((s) => matches(s, true)) ?? bound.find((s) => matches(s, false))
}

/** What choosing a contact does: its DM when one is bound, else the adapter's inbox. */
export function contactAction(
  group: ContactGroup,
  sessions: readonly ChatSession[]
): GlobalSearchAction {
  const dm = findContactDmSession(group, sessions)
  if (dm) {
    return {
      type: "open-inbox-conversation",
      conversationKey: dm.platformBinding.conversationKey,
    }
  }
  return {
    type: "navigate",
    href: `/inbox/adapter?adapterId=${encodeURIComponent(group.primary.adapterId)}`,
  }
}

export function createInboxContactsProvider(deps: InboxProviderDeps) {
  return createListProvider<ContactGroup>({
    id: INBOX_CONTACTS_PROVIDER_ID,
    kind: "inbox-contact",
    load: () => deps.listContacts(),
    getTitle: contactName,
    getSecondary: (group) => group.primary.remoteUserId,
    getKeywords: (group) =>
      identitiesOf(group).flatMap((identity) => [
        identity.platform,
        identity.remoteUserId,
        identity.adapterId,
        identity.displayName ?? "",
      ]),
    getTimestamp: (group) => group.primary.lastSeenAt,
    toItem: ({ row, match }, ctx) => {
      const name = contactName(row)
      const platforms = [...new Set(identitiesOf(row).map((identity) => identity.platform))]
      const dm = findContactDmSession(row, ctx.sessions)
      return {
        id: `inbox-contact:${row.primary.id}`,
        kind: "inbox-contact",
        title: name,
        titlePositions: match.positions,
        subtitle: platforms.join(" · "),
        meta: dm
          ? ctx.t("globalSearch.inbox.openConversation")
          : ctx.t("globalSearch.inbox.openAdapter"),
        icon: {
          avatar: {
            name,
            ...(row.primary.avatarUrl ? { avatarImageUrl: row.primary.avatarUrl } : {}),
          },
        },
        score: match.score,
        timestamp: row.primary.lastSeenAt,
        action: contactAction(row, ctx.sessions),
      }
    },
  })
}

/** Both inbox providers, in registration order. */
export function createInboxProviders(deps: InboxProviderDeps): GlobalSearchProvider[] {
  return [inboxProvider, createInboxContactsProvider(deps)]
}

export const inboxContactsProvider = createInboxContactsProvider({
  listContacts: listMergedGroups,
})
