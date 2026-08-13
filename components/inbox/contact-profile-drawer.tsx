"use client"

/**
 * Contact-profile drawer (CRM, schema v83). A side sheet, opened from the
 * conversation header, that resolves the DM contact behind the open
 * conversation (platform + remoteChatId → platformIdentities) and shows its
 * directory entry plus any cross-platform identities it has absorbed, each
 * reversible via unmergeIdentity. The identity directory is populated by the
 * connector bus on every inbound; conversations whose chat id isn't a known
 * user (group chats, never-seen contacts) show an empty state.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { UserRoundXIcon } from "lucide-react"
import {
  getByPlatformUser,
  listMergeCandidates,
  unmergeIdentity,
  type IdentityUnmergeFailureReason,
} from "@/lib/db/platform-identities"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import { parseConversationKey } from "@/types/connectors/event"
import { IdentityMergeDialog } from "@/components/connectors/identity-merge-dialog"

interface ContactGroup {
  primary: PlatformIdentityRow
  merged: PlatformIdentityRow[]
  candidates: PlatformIdentityRow[]
}

export interface ContactProfileDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationKey: string
}

function useContact(conversationKey: string): ContactGroup | null {
  return (
    useLiveQuery<ContactGroup | null>(async () => {
      if (typeof window === "undefined") return null
      let parsed
      try {
        parsed = parseConversationKey(conversationKey)
      } catch {
        return null
      }
      const primary = await getByPlatformUser(parsed.platform, parsed.remoteChatId)
      if (!primary) return null
      return {
        primary,
        merged: primary.mergedSnapshots ?? [],
        candidates: await listMergeCandidates(primary.id),
      }
    }, [conversationKey]) ?? null
  )
}

export function ContactProfileDrawer({
  open,
  onOpenChange,
  conversationKey,
}: ContactProfileDrawerProps) {
  const t = useTranslations("inbox.contactProfile")
  const contact = useContact(conversationKey)
  const [mergeCandidate, setMergeCandidate] = useState<PlatformIdentityRow | null>(null)

  const unmergeError = (reason: IdentityUnmergeFailureReason) => t(`errors.${reason}`)

  const handleUnmerge = async (secondaryId: string) => {
    if (!contact) return
    try {
      const result = await unmergeIdentity(contact.primary.id, secondaryId)
      if (!result.ok) toast.error(unmergeError(result.reason))
    } catch {
      toast.error(t("errors.unexpected"))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("subtitle")}</SheetDescription>
        </SheetHeader>

        {!contact ? (
          <Empty className="rounded-none border-0 px-4 py-6" data-testid="contact-profile-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UserRoundXIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>{t("title")}</EmptyTitle>
              <EmptyDescription>{t("empty")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-4 px-4 py-2" data-testid="contact-profile">
            <div className="space-y-1">
              <p className="text-base font-semibold">
                {contact.primary.displayName ?? contact.primary.remoteUserId}
              </p>
              <dl className="space-y-0.5 text-xs text-muted-foreground">
                <div className="flex justify-between gap-2">
                  <dt>{t("platform")}</dt>
                  <dd className="font-mono">{contact.primary.platform}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>{t("remoteId")}</dt>
                  <dd className="truncate font-mono">{contact.primary.remoteUserId}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>{t("lastSeen")}</dt>
                  <dd>{new Date(contact.primary.lastSeenAt).toLocaleString()}</dd>
                </div>
              </dl>
            </div>

            {contact.merged.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("mergedTitle")}</p>
                <ItemGroup className="divide-y border-y">
                  {contact.merged.map((m) => (
                    <Item key={m.id} role="listitem" size="sm" className="rounded-none px-0">
                      <ItemContent>
                        <ItemTitle className="block max-w-full truncate text-xs">
                          {m.displayName ?? m.remoteUserId}
                          <span className="ml-1 text-muted-foreground">({m.platform})</span>
                        </ItemTitle>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => void handleUnmerge(m.id)}
                        >
                          {t("unmerge")}
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              </div>
            )}

            {contact.candidates.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("candidatesTitle")}</p>
                <ItemGroup className="divide-y border-y">
                  {contact.candidates.map((candidate) => (
                    <Item
                      key={candidate.id}
                      role="listitem"
                      size="sm"
                      className="rounded-none px-0"
                    >
                      <ItemContent>
                        <ItemTitle className="block max-w-full truncate text-xs">
                          {candidate.displayName ?? candidate.remoteUserId}
                          <span className="ml-1 text-muted-foreground">({candidate.platform})</span>
                        </ItemTitle>
                      </ItemContent>
                      <ItemActions>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() => setMergeCandidate(candidate)}
                        >
                          {t("merge")}
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              </div>
            )}
          </div>
        )}
      </SheetContent>
      {contact && mergeCandidate && (
        <IdentityMergeDialog
          key={`${contact.primary.id}:${mergeCandidate.id}`}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setMergeCandidate(null)
          }}
          identities={[contact.primary, mergeCandidate]}
          lockedPrimaryId={contact.primary.id}
          onMerged={() => setMergeCandidate(null)}
        />
      )}
    </Sheet>
  )
}
