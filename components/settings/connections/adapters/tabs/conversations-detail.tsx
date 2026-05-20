"use client"

/**
 * Per-adapter Conversations detail tab (im-refactored-crayon).
 *
 * Lists the conversation overrides scoped to this adapter — same data
 * model as the top-level Conversations tab but filtered. Edit / Delete
 * actions reuse `ConversationOverrideDialog`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArchiveIcon, ExternalLinkIcon, PinIcon, Settings2Icon, Trash2Icon } from "lucide-react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useConversationOverrides } from "@/hooks/connectors/use-conversation-overrides"
import { ConversationOverrideDialog } from "@/components/inbox/overrides/conversation-override-dialog"
import { setArchived, setPinned } from "@/lib/db/conversation-overrides"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

export interface ConversationsDetailProps {
  adapterId: string
}

export function ConversationsDetail({ adapterId }: ConversationsDetailProps) {
  const t = useTranslations("settings.connections.conversations")
  const router = useRouter()
  const [editing, setEditing] = useState<ConversationOverrideRow | null>(null)
  const overrides = useConversationOverrides(adapterId)

  return (
    <Card data-testid="conversations-detail">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("heading")}</CardTitle>
      </CardHeader>
      <CardContent>
        {overrides.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-2" data-testid="conversations-detail-list">
            {overrides.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
                data-testid={`conv-detail-${row.id}`}
              >
                <div className="flex-1 min-w-0 space-y-0.5">
                  <button
                    type="button"
                    className="font-mono text-xs truncate hover:underline text-left"
                    onClick={() =>
                      router.push(`/inbox/c/${encodeURIComponent(row.conversationKey)}`)
                    }
                    data-testid={`conv-detail-open-${row.id}`}
                  >
                    {row.conversationKey}
                  </button>
                  <div className="flex flex-wrap gap-1">
                    {row.mode && (
                      <Badge variant="outline" className="text-xs">
                        {row.mode}
                      </Badge>
                    )}
                    {row.allowComputerUse && (
                      <Badge
                        variant="destructive"
                        className="text-xs"
                        data-testid={`conv-detail-cu-${row.id}`}
                      >
                        Computer Use
                      </Badge>
                    )}
                    {row.providerOverride && (
                      <Badge variant="secondary" className="text-xs">
                        {row.providerOverride}
                      </Badge>
                    )}
                    {row.modelOverride && (
                      <Badge variant="secondary" className="text-xs">
                        {row.modelOverride}
                      </Badge>
                    )}
                    {row.pinned && (
                      <Badge variant="default" className="text-xs">
                        <PinIcon className="h-2.5 w-2.5 mr-0.5" />
                        {t("pinnedBadge")}
                      </Badge>
                    )}
                    {row.archived && (
                      <Badge variant="secondary" className="text-xs">
                        <ArchiveIcon className="h-2.5 w-2.5 mr-0.5" />
                        {t("archivedBadge")}
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setEditing(row)}
                    aria-label={t("editAria")}
                    data-testid={`conv-detail-edit-${row.id}`}
                  >
                    <Settings2Icon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void setPinned(row.id, !row.pinned)}
                    aria-label={t("togglePin")}
                  >
                    <PinIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void setArchived(row.id, !row.archived)}
                    aria-label={t("toggleArchive")}
                  >
                    <ArchiveIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() =>
                      router.push(`/inbox/c/${encodeURIComponent(row.conversationKey)}`)
                    }
                    aria-label={t("openConversation")}
                  >
                    <ExternalLinkIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => void getDb().conversationOverrides.delete(row.id)}
                    aria-label={t("deleteOverride")}
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && (
        <ConversationOverrideDialog
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          adapterId={adapterId}
          conversationKey={editing.conversationKey}
          sessionId={editing.sessionId}
          initialRow={editing}
        />
      )}
    </Card>
  )
}
