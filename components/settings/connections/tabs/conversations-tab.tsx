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

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  PinIcon,
  ArchiveIcon,
  Trash2Icon,
  ExternalLinkIcon,
  Settings2Icon,
  MousePointerClickIcon,
  SearchIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ConversationOverrideDialog } from "@/components/inbox/overrides/conversation-override-dialog"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { parseConversationKey } from "@/types/connectors/event"

export function ConversationsTab() {
  const t = useTranslations("settings.connections.conversations")
  const router = useRouter()
  const [editingRow, setEditingRow] = useState<ConversationOverrideRow | null>(null)
  const [search, setSearch] = useState("")

  const overrides = useLiveQuery<ConversationOverrideRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb().conversationOverrides.orderBy("updatedAt").reverse().toArray(),
    []
  )

  // Substring search across conversationKey + characterId. Case-insensitive.
  // Pure derivation — the underlying live-query is untouched so writes/reads
  // remain reactive even while the filter is non-empty.
  const trimmedSearch = search.trim().toLowerCase()
  const filteredOverrides = (overrides ?? []).filter((row) => {
    if (!trimmedSearch) return true
    const haystack = `${row.conversationKey ?? ""} ${row.characterId ?? ""}`.toLowerCase()
    return haystack.includes(trimmedSearch)
  })

  // ADR-0131: address rows by conversation KEY, not id — a thin client only
  // knows the key, and the key is the unique index the host resolves against.
  const handleDelete = async (row: ConversationOverrideRow) => {
    await mutateConversationOverride({
      kind: "delete",
      conversationKey: row.conversationKey,
    })
  }

  const handleTogglePin = async (row: ConversationOverrideRow) => {
    await mutateConversationOverride({
      kind: "setPinned",
      conversationKey: row.conversationKey,
      pinned: !row.pinned,
      sessionId: row.sessionId,
    })
  }

  const handleToggleArchive = async (row: ConversationOverrideRow) => {
    await mutateConversationOverride({
      kind: "setArchived",
      conversationKey: row.conversationKey,
      archived: !row.archived,
      sessionId: row.sessionId,
    })
  }

  const editingAdapterId = (() => {
    if (!editingRow) return ""
    try {
      return parseConversationKey(editingRow.conversationKey).adapterId
    } catch {
      return ""
    }
  })()

  // Cross-cutting safety overview — count of conversations with
  // Computer-Use opt-ins, HITL off, or custom skill allowlists. Surfaced
  // above the list so operators see the blast-radius footprint without
  // scrolling row by row.
  const safetyCounts = {
    computerUse: (overrides ?? []).filter((r) => r.allowComputerUse === true).length,
    hitlOff: (overrides ?? []).filter((r) => r.requireHitlForWrites === false).length,
    skillAllowlist: (overrides ?? []).filter(
      (r) => Array.isArray(r.allowedBuiltInSkillIds) || r.allowedBuiltInSkillIds === "all"
    ).length,
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("heading")}</CardTitle>
      </CardHeader>
      <CardContent>
        {overrides && overrides.length > 0 && (
          <div
            className="mb-3 flex flex-wrap gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs"
            data-testid="conversations-safety-summary"
          >
            <span className="inline-flex items-center gap-1" data-testid="conversations-summary-cu">
              <Badge
                variant="outline"
                className={
                  safetyCounts.computerUse > 0 ? "border-destructive/40 text-destructive" : ""
                }
              >
                <MousePointerClickIcon className="mr-1 h-3 w-3" aria-hidden />
                {t("summary.computerUse", { count: safetyCounts.computerUse })}
              </Badge>
            </span>
            <span
              className="inline-flex items-center gap-1"
              data-testid="conversations-summary-hitl"
            >
              <Badge
                variant="outline"
                className={
                  safetyCounts.hitlOff > 0
                    ? "border-amber-400 text-amber-700 dark:text-amber-300"
                    : ""
                }
              >
                {t("summary.hitlOff", { count: safetyCounts.hitlOff })}
              </Badge>
            </span>
            <span
              className="inline-flex items-center gap-1"
              data-testid="conversations-summary-skills"
            >
              <Badge variant="outline">
                {t("summary.customSkillAllowlist", { count: safetyCounts.skillAllowlist })}
              </Badge>
            </span>
          </div>
        )}
        {!overrides || overrides.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            {overrides.length > 5 && (
              <div className="mb-3 space-y-1">
                <Label htmlFor="conversations-search" className="sr-only">
                  {t("searchPlaceholder")}
                </Label>
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="conversations-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t("searchPlaceholder")}
                    className="h-9 pl-7 text-xs"
                    data-testid="conversations-search"
                  />
                </div>
                {trimmedSearch && filteredOverrides.length === 0 && (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="conversations-search-empty"
                  >
                    {t("searchNoResults", { query: trimmedSearch })}
                  </p>
                )}
              </div>
            )}
            <ul className="space-y-2" data-testid="conversations-list">
              {filteredOverrides.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
                  data-testid={`conversation-row-${row.id}`}
                >
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto max-w-full justify-start truncate p-0 text-left font-mono text-xs"
                      onClick={() =>
                        router.push(`/inbox/c?key=${encodeURIComponent(row.conversationKey)}`)
                      }
                      data-testid={`conv-link-${row.id}`}
                    >
                      {row.conversationKey}
                    </Button>
                    <div className="flex flex-wrap gap-1">
                      {row.mode && (
                        <Badge variant="outline" className="text-xs">
                          {row.mode}
                        </Badge>
                      )}
                      {row.characterId && (
                        <Badge variant="secondary" className="text-xs">
                          {t("characterPrefix", { id: row.characterId.slice(0, 8) })}
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
                      {row.allowComputerUse === true && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className="text-xs border-amber-400 text-amber-700 dark:text-amber-300"
                              data-testid={`cu-badge-${row.id}`}
                            >
                              <MousePointerClickIcon className="h-2.5 w-2.5 mr-0.5" />
                              {t("computerUseBadge")}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-xs">
                            {t("computerUseTooltip")}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setEditingRow(row)}
                      aria-label={t("editAria") ?? "Edit override"}
                      data-testid={`edit-btn-${row.id}`}
                    >
                      <Settings2Icon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void handleTogglePin(row)}
                      aria-label={t("togglePin")}
                      data-testid={`pin-btn-${row.id}`}
                    >
                      <PinIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void handleToggleArchive(row)}
                      aria-label={t("toggleArchive")}
                      data-testid={`archive-btn-${row.id}`}
                    >
                      <ArchiveIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() =>
                        router.push(`/inbox/c?key=${encodeURIComponent(row.conversationKey)}`)
                      }
                      aria-label={t("openConversation")}
                      data-testid={`open-btn-${row.id}`}
                    >
                      <ExternalLinkIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => void handleDelete(row)}
                      aria-label={t("deleteOverride")}
                      data-testid={`delete-btn-${row.id}`}
                    >
                      <Trash2Icon className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
      {editingRow && (
        <ConversationOverrideDialog
          open={editingRow !== null}
          onOpenChange={(open) => {
            if (!open) setEditingRow(null)
          }}
          adapterId={editingAdapterId}
          conversationKey={editingRow.conversationKey}
          sessionId={editingRow.sessionId}
          initialRow={editingRow}
        />
      )}
    </Card>
  )
}
