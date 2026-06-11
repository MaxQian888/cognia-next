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
import { getByPlatformUser, unmergeIdentity } from "@/lib/db/platform-identities"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import { parseConversationKey } from "@/types/connectors/event"

interface ContactGroup {
  primary: PlatformIdentityRow
  merged: PlatformIdentityRow[]
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
      return { primary, merged: primary.mergedSnapshots ?? [] }
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

  const handleUnmerge = async (secondaryId: string) => {
    if (!contact) return
    try {
      await unmergeIdentity(contact.primary.id, secondaryId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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
          <p
            className="px-4 py-6 text-center text-sm text-muted-foreground"
            data-testid="contact-profile-empty"
          >
            {t("empty")}
          </p>
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
                <ul className="divide-y rounded-md border">
                  {contact.merged.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <span className="flex-1 truncate">
                        {m.displayName ?? m.remoteUserId}
                        <span className="ml-1 text-muted-foreground">({m.platform})</span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => void handleUnmerge(m.id)}
                      >
                        {t("unmerge")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
