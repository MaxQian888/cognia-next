"use client"

/**
 * Workspace settings → Memory section.
 *
 * Read-only listing of the team's shared-memory KV with per-entry delete
 * and a "clear all" affordance. Entries arrive through the orchestrator
 * (`publishEntry` / `autoPublishTaskResult`); writes from this UI are not
 * supported — operators inspect/clear, they don't compose values here.
 *
 * Each row shows: key, writer name, written-at timestamp, version, tags,
 * and an excerpt of the value (truncated). The full value is available
 * via a "Copy" affordance.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Trash2 } from "lucide-react"
import { useShallow } from "zustand/react/shallow"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { selectActiveTeamSharedMemoryEntries } from "@/stores/agent/agent-team-store/selectors"
import type { AgentTeam, SharedMemoryEntry } from "@/types/agent/agent-team"
import { deleteEntry, clearTeamMemory } from "@/lib/ai/agent/team/shared-memory-orchestrator"

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
  if (text.length > max) return `${text.slice(0, max)}…`
  return text
}

export function MemorySection({ team }: MemorySectionProps) {
  const t = useTranslations("agentTeamsWorkspace.settings.memory")
  // `selectActiveTeamSharedMemoryEntries` materialises a new array each call;
  // useShallow keeps the subscription stable across unrelated store updates.
  const entries = useAgentTeamStore(useShallow(selectActiveTeamSharedMemoryEntries))

  const sorted = useMemo(
    () =>
      [...entries].sort(
        (a: SharedMemoryEntry, b: SharedMemoryEntry) =>
          new Date(b.writtenAt).getTime() - new Date(a.writtenAt).getTime()
      ),
    [entries]
  )

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{t("title")}</p>
        {sorted.length > 0 ? (
          <Button size="sm" variant="outline" onClick={() => clearTeamMemory(team.id)}>
            {t("clearAll")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ScrollArea className="max-h-[400px] pr-1">
          <div className="space-y-2">
            {sorted.map((entry) => (
              <div key={entry.key} className="space-y-1 rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{entry.key}</code>
                    <Badge variant="outline" className="text-[10px]">
                      v{entry.version}
                    </Badge>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => deleteEntry(team.id, entry.key)}
                    aria-label={t("deleteEntry", { key: entry.key })}
                    className="h-6 w-6"
                  >
                    <Trash2 className="size-3" />
                  </Button>
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
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  )
}
