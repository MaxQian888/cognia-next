"use client"

/**
 * Conversations tab in the Connections settings section.
 *
 * Lists all conversationOverrides rows. Each row shows:
 *   - conversationKey
 *   - mode override
 *   - character override
 *   - pinned / archived flags
 *   - Edit / Delete actions
 *   - Click row → navigate to /inbox/c/<conversationKey>
 */

import { useRouter } from "next/navigation"
import { useLiveQuery } from "dexie-react-hooks"
import { PinIcon, ArchiveIcon, Trash2Icon, ExternalLinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { setArchived, setPinned, upsertByConversationKey } from "@/lib/db/conversation-overrides"

export function ConversationsTab() {
  const router = useRouter()

  const overrides = useLiveQuery<ConversationOverrideRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb().conversationOverrides.orderBy("updatedAt").reverse().toArray(),
    []
  )

  const handleDelete = async (id: string) => {
    await getDb().conversationOverrides.delete(id)
  }

  const handleTogglePin = async (row: ConversationOverrideRow) => {
    await setPinned(row.id, !row.pinned)
  }

  const handleToggleArchive = async (row: ConversationOverrideRow) => {
    await setArchived(row.id, !row.archived)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Conversation overrides</CardTitle>
      </CardHeader>
      <CardContent>
        {!overrides || overrides.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No conversation overrides yet. Platform conversations appear here once you interact with
            them.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="conversations-list">
            {overrides.map((row) => (
              <li
                key={row.id}
                className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
                data-testid={`conversation-row-${row.id}`}
              >
                <div className="flex-1 min-w-0 space-y-0.5">
                  <button
                    type="button"
                    className="font-mono text-xs truncate hover:underline text-left"
                    onClick={() =>
                      router.push(`/inbox/c/${encodeURIComponent(row.conversationKey)}`)
                    }
                    data-testid={`conv-link-${row.id}`}
                  >
                    {row.conversationKey}
                  </button>
                  <div className="flex flex-wrap gap-1">
                    {row.mode && (
                      <Badge variant="outline" className="text-xs">
                        {row.mode}
                      </Badge>
                    )}
                    {row.characterId && (
                      <Badge variant="secondary" className="text-xs">
                        char:{row.characterId.slice(0, 8)}
                      </Badge>
                    )}
                    {row.pinned && (
                      <Badge variant="default" className="text-xs">
                        <PinIcon className="h-2.5 w-2.5 mr-0.5" />
                        pinned
                      </Badge>
                    )}
                    {row.archived && (
                      <Badge variant="secondary" className="text-xs">
                        <ArchiveIcon className="h-2.5 w-2.5 mr-0.5" />
                        archived
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="flex gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void handleTogglePin(row)}
                    aria-label="Toggle pin"
                    data-testid={`pin-btn-${row.id}`}
                  >
                    <PinIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void handleToggleArchive(row)}
                    aria-label="Toggle archive"
                    data-testid={`archive-btn-${row.id}`}
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
                    aria-label="Open conversation"
                    data-testid={`open-btn-${row.id}`}
                  >
                    <ExternalLinkIcon className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => void handleDelete(row.id)}
                    aria-label="Delete override"
                    data-testid={`delete-btn-${row.id}`}
                  >
                    <Trash2Icon className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
