"use client"

/**
 * Workspace settings → Memory section.
 *
 * Full operator CRUD over a team's shared memory: author entries, filter by
 * writer/tag/text, inspect/edit/delete individual entries, configure a
 * plugin-supplied backing adapter, and sync from it. Reads are ACL-filtered
 * through the operator reader id (which sees everything); a confirm gate
 * guards "clear all".
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2, PlusIcon } from "lucide-react"
import { useShallow } from "zustand/react/shallow"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  selectSharedMemoryEntriesForReader,
  OPERATOR_READER_ID,
} from "@/stores/agent/agent-team-store/selectors"
import { clearTeamMemory } from "@/lib/ai/agent/team/shared-memory-orchestrator"
import type { AgentTeam, SharedMemoryEntry } from "@/types/agent/agent-team"
import { MemoryComposer } from "./memory-composer"
import { MemoryEntryDetail } from "./memory-entry-detail"
import { MemoryAdapterStrip } from "./memory-adapter-strip"
import {
  MemoryFilterToolbar,
  applyMemoryFilter,
  EMPTY_MEMORY_FILTER,
  type MemoryFilter,
} from "./memory-filter-toolbar"
import { ConfirmActionDialog } from "./confirm-action-dialog"
import { markSettingsSaved } from "./settings-save-indicator"

export interface MemorySectionProps {
  team: AgentTeam
}

function valueExcerpt(value: unknown, max = 200): string {
  let text: string
  if (typeof value === "string") text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function MemorySection({ team }: MemorySectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.memory")
  const tConfirm = useTranslations("agentTeamsWorkspace.settings.confirm")
  // Operator view: sees every entry regardless of `readableBy`.
  const entries = useAgentTeamStore(
    useShallow(selectSharedMemoryEntriesForReader(team.id, OPERATOR_READER_ID))
  )

  const [filter, setFilter] = useState<MemoryFilter>(EMPTY_MEMORY_FILTER)
  const [composerOpen, setComposerOpen] = useState(false)
  const [editing, setEditing] = useState<SharedMemoryEntry | null>(null)
  const [detail, setDetail] = useState<SharedMemoryEntry | null>(null)
  const [clearOpen, setClearOpen] = useState(false)

  const writers = useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of entries) seen.set(e.writtenBy, e.writerName ?? e.writtenBy)
    return Array.from(seen, ([id, name]) => ({ id, name }))
  }, [entries])

  const availableTags = useMemo(() => {
    const tags = new Set<string>()
    for (const e of entries) for (const tag of e.tags ?? []) tags.add(tag)
    return Array.from(tags).sort()
  }, [entries])

  const filtered = useMemo(() => {
    const sorted = [...entries].sort(
      (a, b) => new Date(b.writtenAt).getTime() - new Date(a.writtenAt).getTime()
    )
    return applyMemoryFilter(sorted, filter)
  }, [entries, filter])

  const openCreate = () => {
    setEditing(null)
    setComposerOpen(true)
  }

  const openEdit = (entry: SharedMemoryEntry) => {
    setDetail(null)
    setEditing(entry)
    setComposerOpen(true)
  }

  return (
    <Card className="space-y-3 p-4">
      <MemoryAdapterStrip team={team} />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{t("title")}</p>
          <Badge variant="outline" className="text-[10px]">
            {t("acl.operatorBadge")}
          </Badge>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={openCreate}>
          <PlusIcon className="size-3.5" />
          {t("addEntry")}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">{t("acl.aclHint")}</p>

      <MemoryFilterToolbar
        filter={filter}
        onChange={setFilter}
        writers={writers}
        availableTags={availableTags}
      />

      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("filter.empty")}</p>
      ) : (
        <ScrollArea className="max-h-[400px] pr-1">
          <div className="space-y-2">
            {filtered.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setDetail(entry)}
                className="block w-full space-y-1 rounded-md border p-2 text-left text-xs hover:bg-muted/40"
                data-testid={`memory-row-${entry.key}`}
              >
                <div className="flex items-center gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{entry.key}</code>
                  <Badge variant="outline" className="text-[10px]">
                    v{entry.version}
                  </Badge>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {t("writtenBy", {
                    name: entry.writerName ?? entry.writtenBy,
                    when: new Date(entry.writtenAt).toLocaleString(),
                  })}
                </div>
                {entry.tags && entry.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {entry.tags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="font-mono text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <p className="break-words text-xs">{valueExcerpt(entry.value)}</p>
              </button>
            ))}
          </div>
        </ScrollArea>
      )}

      {entries.length > 0 ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="gap-1 text-xs text-destructive"
            onClick={() => setClearOpen(true)}
          >
            <Trash2 className="size-3" />
            {t("clearAll")}
          </Button>
        </div>
      ) : null}

      <MemoryComposer
        open={composerOpen}
        onOpenChange={setComposerOpen}
        team={team}
        mode={editing ? "edit" : "create"}
        initial={editing ?? undefined}
      />
      <MemoryEntryDetail
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
        teamId={team.id}
        entry={detail}
        onEdit={openEdit}
      />
      <ConfirmActionDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={tConfirm("clearMemory.title")}
        description={tConfirm("clearMemory.description")}
        confirmLabel={tConfirm("confirmLabel")}
        cancelLabel={tConfirm("cancelLabel")}
        onConfirm={() => {
          clearTeamMemory(team.id)
          markSettingsSaved()
          setClearOpen(false)
        }}
      />
    </Card>
  )
}
