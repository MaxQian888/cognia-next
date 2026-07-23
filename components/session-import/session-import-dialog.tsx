"use client"

// Import external coding-agent session histories (Claude Code / Codex /
// OpenCode) into Cognia as continuable conversations. Desktop auto-scans every
// installed agent; the web fallback picks session files manually. See ADR-0062.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { FolderSearchIcon, FilesIcon, Loader2Icon, CheckCircle2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { FidelityReport } from "@/components/session-import/fidelity-report"
import { isTauri } from "@/lib/tauri"
import { useProjectStore } from "@/stores/project/project-store"
import { useSessionImport, summaryKey } from "@/hooks/session-import/use-session-import"
import { useSessionImportWatch } from "@/hooks/session-import/use-session-import-watch"
import { getSessionSource, type SessionSummary } from "@/lib/session-import"

/** Rows shown before the first "show more", and each page-step increment. */
const INITIAL_VISIBLE = 50
const PAGE_STEP = 50

export interface SessionImportDialogProps {
  trigger: React.ReactNode
}

export function SessionImportDialog({ trigger }: SessionImportDialogProps) {
  const t = useTranslations("sessionImport")
  const [open, setOpen] = useState(false)
  const desktop = isTauri()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const {
    state,
    selected,
    selectedCount,
    scan,
    pickFiles,
    toggle,
    setAll,
    importSelected,
    cancelImport,
    reset,
  } = useSessionImport()
  const { enabled: watching, toggle: toggleWatch } = useSessionImportWatch({
    projectId: activeProjectId ?? undefined,
  })

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) reset()
  }

  const onImport = async () => {
    await importSelected(activeProjectId ?? undefined)
  }

  /**
   * Built-in sources translate under `sources.<id>`; a plugin source is keyed
   * `${pluginId}:${id}` and has no catalog entry, so translating it would print
   * the raw key path in the badge. Adapters already declare a `displayName` —
   * it just had no consumer.
   */
  const sourceLabel = (id: string): string => {
    if (id.includes(":")) return getSessionSource(id)?.displayName ?? id
    return t(`sources.${id}` as never)
  }

  // Surface a terminal error/done toast is left to inline rendering below.

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {state.status === "idle" && (
          <div className="space-y-3">
            {!desktop && <p className="text-xs text-muted-foreground">{t("webHint")}</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              {desktop && (
                <Button
                  variant="outline"
                  className="h-auto flex-col items-start gap-1 p-3"
                  onClick={() => void scan()}
                >
                  <FolderSearchIcon className="size-5" />
                  <span className="text-sm font-medium">{t("scanButton")}</span>
                </Button>
              )}
              <Button
                variant="outline"
                className="h-auto flex-col items-start gap-1 p-3"
                onClick={() => void pickFiles()}
              >
                <FilesIcon className="size-5" />
                <span className="text-sm font-medium">{t("pickButton")}</span>
              </Button>
            </div>
            {desktop && (
              <label className="flex items-start justify-between gap-3 rounded-md border p-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t("liveSync")}</span>
                  <span className="block text-xs text-muted-foreground">{t("liveSyncHint")}</span>
                </span>
                <Switch
                  checked={watching}
                  onCheckedChange={(on) => void toggleWatch(on)}
                  aria-label={t("liveSync")}
                />
              </label>
            )}
          </div>
        )}

        {state.status === "scanning" && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            {t("scanning")}
          </div>
        )}

        {state.status === "importing" && (
          <div className="space-y-3 py-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              {t(state.phase === "writing" ? "writingProgress" : "parsingProgress", {
                done: state.done,
                total: state.total,
              })}
            </div>
            <Progress value={state.total > 0 ? (state.done / state.total) * 100 : 0} />
          </div>
        )}

        {state.status === "list" && (
          <div className="space-y-2">
            {state.warnings && state.warnings.length > 0 && (
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                {t("someSourcesFailed", {
                  sources: state.warnings.map((w) => w.sourceId).join(", "),
                })}
              </p>
            )}
            <SessionList
              summaries={state.summaries}
              selected={selected}
              onToggle={toggle}
              sourceLabel={sourceLabel}
              messagesLabel={(n) => t("messagesLabel", { count: n })}
            />
          </div>
        )}

        {state.status === "done" && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <CheckCircle2Icon className="size-8 text-primary" />
            <p className="text-sm font-medium">
              {t(state.cancelled ? "cancelledTitle" : "doneTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("doneBody", { sessions: state.sessionsAdded, messages: state.messagesAdded })}
            </p>
            {state.lossBySource && (
              <div className="w-full space-y-3 pt-2 text-left">
                {Object.entries(state.lossBySource).map(([sourceId, loss]) => (
                  <div key={sourceId} className="rounded-md border p-2">
                    <p className="pb-1 text-xs font-medium">{sourceLabel(sourceId)}</p>
                    <FidelityReport loss={loss} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {state.status === "error" && (
          <div className="space-y-2 py-6 text-center">
            <p className="text-sm font-medium text-destructive">{t("errorTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {state.message === "unrecognized" ? t("unrecognized") : state.message}
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {state.status === "importing" && (
            <Button variant="outline" size="sm" onClick={cancelImport}>
              {t("cancel")}
            </Button>
          )}
          {state.status === "list" && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setAll(selectedCount === 0)}>
                {selectedCount === 0 ? t("selectAll") : t("deselectAll")}
              </Button>
              <Button
                size="sm"
                disabled={selectedCount === 0}
                // `t("importing")` here announced "Importing…" as a SUCCESS
                // toast after the run had already finished. The completion
                // copy is what belongs on a completion toast.
                onClick={() => void onImport().then(() => toast.success(t("doneTitle")))}
              >
                {t("importSelected", { count: selectedCount })}
              </Button>
            </>
          )}
          {(state.status === "done" || state.status === "error") && (
            <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SessionList({
  summaries,
  selected,
  onToggle,
  sourceLabel,
  messagesLabel,
}: {
  summaries: SessionSummary[]
  selected: Set<string>
  onToggle: (key: string) => void
  sourceLabel: (id: string) => string
  messagesLabel: (n: number) => string
}) {
  const t = useTranslations("sessionImport")
  // Page the list so a history of hundreds of sessions doesn't render hundreds
  // of DOM rows at once. Selection is by key, independent of what's rendered, so
  // "select all" still covers the whole list.
  const [visible, setVisible] = useState(INITIAL_VISIBLE)
  if (summaries.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
  }
  const shown = summaries.slice(0, visible)
  const remaining = summaries.length - shown.length
  return (
    <ScrollArea className="max-h-72">
      <ul className="space-y-1 pr-2">
        {shown.map((s) => {
          const key = summaryKey(s.ref)
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/50">
                <Checkbox
                  checked={selected.has(key)}
                  onCheckedChange={() => onToggle(key)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.title}</span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {sourceLabel(s.sourceId)}
                    </Badge>
                  </div>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {messagesLabel(s.messageCount)}
                    {s.cwd ? ` · ${s.cwd}` : ""}
                  </p>
                </div>
              </label>
            </li>
          )
        })}
      </ul>
      {remaining > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full text-xs"
          onClick={() => setVisible((v) => v + PAGE_STEP)}
        >
          {t("loadMore", { count: Math.min(remaining, PAGE_STEP) })}
        </Button>
      )}
    </ScrollArea>
  )
}
