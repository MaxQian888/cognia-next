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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { isTauri } from "@/lib/tauri"
import { useProjectStore } from "@/stores/project/project-store"
import { useSessionImport, summaryKey } from "@/hooks/session-import/use-session-import"
import type { SessionSummary } from "@/lib/session-import"

export interface SessionImportDialogProps {
  trigger: React.ReactNode
}

export function SessionImportDialog({ trigger }: SessionImportDialogProps) {
  const t = useTranslations("sessionImport")
  const [open, setOpen] = useState(false)
  const desktop = isTauri()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const { state, selected, selectedCount, scan, pickFiles, toggle, setAll, importSelected, reset } =
    useSessionImport()

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) reset()
  }

  const onImport = async () => {
    await importSelected(activeProjectId ?? undefined)
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
          </div>
        )}

        {(state.status === "scanning" || state.status === "importing") && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            {t(state.status === "scanning" ? "scanning" : "importing")}
          </div>
        )}

        {state.status === "list" && (
          <SessionList
            summaries={state.summaries}
            selected={selected}
            onToggle={toggle}
            sourceLabel={(id) => t(`sources.${id}` as never)}
            messagesLabel={(n) => t("messagesLabel", { count: n })}
          />
        )}

        {state.status === "done" && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <CheckCircle2Icon className="size-8 text-primary" />
            <p className="text-sm font-medium">{t("doneTitle")}</p>
            <p className="text-xs text-muted-foreground">
              {t("doneBody", { sessions: state.sessionsAdded, messages: state.messagesAdded })}
            </p>
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
          {state.status === "list" && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setAll(selectedCount === 0)}>
                {selectedCount === 0 ? t("selectAll") : t("deselectAll")}
              </Button>
              <Button
                size="sm"
                disabled={selectedCount === 0}
                onClick={() => {
                  void onImport().then(() => {
                    if (selectedCount > 0) toast.success(t("importing"))
                  })
                }}
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
  if (summaries.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
  }
  return (
    <ScrollArea className="max-h-72">
      <ul className="space-y-1 pr-2">
        {summaries.map((s) => {
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
    </ScrollArea>
  )
}
