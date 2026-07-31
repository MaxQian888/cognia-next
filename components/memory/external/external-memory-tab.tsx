"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon, FileTextIcon, LockIcon, RefreshCwIcon } from "lucide-react"
import type { ExternalAgentId, ExternalMemoryFile } from "@/lib/memory/external/types"
import { useExternalMemory } from "@/hooks/memory/use-external-memory"
import { Button } from "@/components/ui/button"
import { StatCard } from "@/components/scheduler/stat-card"
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { ExternalMemoryRow } from "./external-memory-row"
import { ExternalMemoryEditor } from "./external-memory-editor"

const AGENT_ORDER: ExternalAgentId[] = ["claude-code", "codex"]

/**
 * `/memory` → "外部 Agent 记忆" tab. Discovers and (guardedly) edits the on-disk
 * memory files of Claude Code and Codex. Desktop-only; reuses `StatCard`, the
 * translucent row styling, and the shared editor dialog.
 */
export function ExternalMemoryTab() {
  const t = useTranslations("memory.external")
  const { files, loading, unsupported, allowedRoots, refresh } = useExternalMemory()
  const [selected, setSelected] = useState<ExternalMemoryFile | null>(null)
  const [open, setOpen] = useState(false)

  const grouped = useMemo(() => {
    const map = new Map<ExternalAgentId, ExternalMemoryFile[]>()
    for (const f of files) {
      const list = map.get(f.agent) ?? []
      list.push(f)
      map.set(f.agent, list)
    }
    return map
  }, [files])

  const editableCount = useMemo(() => files.filter((f) => f.editable && f.exists).length, [files])
  const presentCount = useMemo(() => files.filter((f) => f.exists).length, [files])

  if (unsupported) {
    return (
      <Empty data-testid="external-memory-unsupported">
        <EmptyMedia variant="icon">
          <LockIcon className="size-6" />
        </EmptyMedia>
        <EmptyTitle>{t("desktopOnly.title")}</EmptyTitle>
        <EmptyDescription>{t("desktopOnly.description")}</EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={loading}
          aria-label={t("refresh")}
        >
          <RefreshCwIcon className="size-4" />
          {t("refresh")}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label={t("stats.total")}
          value={presentCount}
          icon={<FileTextIcon className="size-4" />}
          accentGradient="from-violet-500 to-purple-400"
          iconBgClassName="bg-violet-500/15 text-violet-500"
          testid="external-stat-total"
        />
        <StatCard
          label={t("stats.editable")}
          value={editableCount}
          icon={<BrainIcon className="size-4" />}
          accentGradient="from-emerald-500 to-green-400"
          iconBgClassName="bg-emerald-500/15 text-emerald-500"
        />
        <StatCard
          label={t("agents.claude-code")}
          value={(grouped.get("claude-code") ?? []).filter((f) => f.exists).length}
          icon={<FileTextIcon className="size-4" />}
          accentGradient="from-sky-500 to-cyan-400"
          iconBgClassName="bg-sky-500/15 text-sky-500"
        />
        <StatCard
          label={t("agents.codex")}
          value={(grouped.get("codex") ?? []).filter((f) => f.exists).length}
          icon={<FileTextIcon className="size-4" />}
          accentGradient="from-amber-500 to-orange-400"
          iconBgClassName="bg-amber-500/15 text-amber-500"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {files.length === 0 ? (
          <Empty>
            <EmptyMedia variant="icon">
              <BrainIcon className="size-6" />
            </EmptyMedia>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.description")}</EmptyDescription>
          </Empty>
        ) : (
          AGENT_ORDER.filter((a) => grouped.has(a)).map((agent) => (
            <section key={agent} className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t(`agents.${agent}`)}
              </h2>
              {(grouped.get(agent) ?? []).map((file) => (
                <ExternalMemoryRow
                  key={file.id}
                  file={file}
                  onOpen={(f) => {
                    setSelected(f)
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
