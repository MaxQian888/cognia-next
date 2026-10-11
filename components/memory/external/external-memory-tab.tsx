"use client"

/**
 * `/memory` → "External agent memory" tab. Discovers and (guardedly) edits the
 * on-disk memory / instruction files that external coding agents keep on this
 * machine. Desktop-only — the files live on disk.
 *
 * Two things were wrong here and are fixed:
 *
 *  - The tab grouped by a *local* `AGENT_ORDER` naming only `claude-code` and
 *    `codex`, while `discoverExternalMemory` has enumerated four agents for a
 *    while. OpenCode and Pi files were read off disk and then silently dropped
 *    before render. It now groups by the discovery module's own exported order,
 *    so the two lists cannot drift again.
 *  - Four gradient `StatCard`s (violet / emerald / sky / amber) counted files
 *    above a list that usually holds fewer rows than the tiles counted. The
 *    counts are one line of text now, matching the app-memory tab's density.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon, LockIcon, RefreshCwIcon } from "lucide-react"

import type { ExternalAgentId, ExternalMemoryFile } from "@/lib/memory/external/types"
import { EXTERNAL_AGENT_ORDER } from "@/lib/memory/external/discover"
import { useExternalMemory } from "@/hooks/memory/use-external-memory"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ExternalMemoryRow } from "./external-memory-row"
import { ExternalMemoryEditor } from "./external-memory-editor"

export interface ExternalMemoryTabProps {
  /**
   * This device is a paired client: the files are on the host's disk, not on
   * a desktop this device could become, so the empty state says where to go.
   */
  onHost?: boolean
}

export function ExternalMemoryTab({ onHost = false }: ExternalMemoryTabProps) {
  // A paired client — including a desktop driving a remote host — would read
  // THIS machine's agent files while the rest of the page shows the host's
  // memory, so it does not read them at all.
  if (onHost) return <ExternalMemoryUnavailable onHost />
  return <LocalExternalMemory />
}

function ExternalMemoryUnavailable({ onHost }: { onHost: boolean }) {
  const t = useTranslations("memory.external")
  return (
    <Empty className="h-full" data-testid="external-memory-unsupported">
      <EmptyMedia variant="icon">
        <LockIcon />
      </EmptyMedia>
      <EmptyTitle>{onHost ? t("hostOnly.title") : t("desktopOnly.title")}</EmptyTitle>
      <EmptyDescription>
        {onHost ? t("hostOnly.description") : t("desktopOnly.description")}
      </EmptyDescription>
    </Empty>
  )
}

function LocalExternalMemory() {
  const t = useTranslations("memory.external")
  const { files, loading, unsupported, allowedRoots, refresh } = useExternalMemory()
  const [selected, setSelected] = useState<ExternalMemoryFile | null>(null)
  const [open, setOpen] = useState(false)

  const grouped = useMemo(() => {
    const map = new Map<ExternalAgentId, ExternalMemoryFile[]>()
    for (const file of files) {
      const list = map.get(file.agent) ?? []
      list.push(file)
      map.set(file.agent, list)
    }
    return map
  }, [files])

  const editableCount = useMemo(
    () => files.filter((file) => file.editable && file.exists).length,
    [files]
  )
  const presentCount = useMemo(() => files.filter((file) => file.exists).length, [files])

  if (unsupported) return <ExternalMemoryUnavailable onHost={false} />

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="external-memory-tab">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t("subtitle")}</p>
        <Badge
          variant="outline"
          className="font-normal tabular-nums"
          data-testid="external-stat-total"
        >
          {t("stats.total")}: {presentCount}
        </Badge>
        <Badge variant="outline" className="font-normal tabular-nums">
          {t("stats.editable")}: {editableCount}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={refresh}
          disabled={loading}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon className="size-4" />
          {t("refresh")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <Empty className="h-full">
            <EmptyMedia variant="icon">
              <BrainIcon />
            </EmptyMedia>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
          </Empty>
        ) : (
          EXTERNAL_AGENT_ORDER.filter((agent) => grouped.has(agent)).map((agent) => (
            <section key={agent} className="flex flex-col">
              <h2 className="sticky top-0 z-10 bg-background/95 px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {t(`agents.${agent}`)}
              </h2>
              {(grouped.get(agent) ?? []).map((file) => (
                <ExternalMemoryRow
                  key={file.id}
                  file={file}
                  onOpen={(target) => {
                    setSelected(target)
                    setOpen(true)
                  }}
                />
              ))}
            </section>
          ))
        )}
      </div>

      <ExternalMemoryEditor
        file={selected}
        open={open}
        onOpenChange={setOpen}
        allowedRoots={allowedRoots}
        onSaved={refresh}
      />
    </div>
  )
}
