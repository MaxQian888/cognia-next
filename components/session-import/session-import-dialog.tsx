"use client"

// Import external coding-agent session histories (Claude Code / Codex /
// OpenCode) into Cognia as continuable conversations. Desktop auto-scans every
// installed agent; the web fallback picks session files manually. See ADR-0062.

import { useMemo, useState } from "react"
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
import {
  buildExternalSessionSupportMatrix,
  getSessionSource,
  type SessionImportDetail,
  type SessionSummary,
} from "@/lib/session-import"

/** Rows shown before the first "show more", and each page-step increment. */
const INITIAL_VISIBLE = 50
const PAGE_STEP = 50

function relationshipTree(details: SessionImportDetail[]): Array<{
  detail: SessionImportDetail
  depth: number
}> {
  const byId = new Map(details.map((detail) => [detail.canonicalSessionId, detail]))
  const children = new Map<string, SessionImportDetail[]>()
  for (const detail of details) {
    const parentId = detail.lineage?.parentCanonicalSessionId
    if (!parentId || !byId.has(parentId) || parentId === detail.canonicalSessionId) continue
    const bucket = children.get(parentId) ?? []
    bucket.push(detail)
    children.set(parentId, bucket)
  }
  const rows: Array<{ detail: SessionImportDetail; depth: number }> = []
  const visited = new Set<string>()
  const visit = (detail: SessionImportDetail, depth: number) => {
    if (visited.has(detail.canonicalSessionId)) return
    visited.add(detail.canonicalSessionId)
    rows.push({ detail, depth })
    for (const child of children.get(detail.canonicalSessionId) ?? []) visit(child, depth + 1)
  }
  for (const detail of details) {
    const parentId = detail.lineage?.parentCanonicalSessionId
    if (!parentId || !byId.has(parentId)) visit(detail, 0)
  }
  for (const detail of details) visit(detail, 0)
  return rows
}

export interface SessionImportDialogProps {
  trigger: React.ReactNode
  /**
   * Restrict the picker to one source instead of auto-detecting.
   *
   * `useSessionImport().pickFiles` has always accepted a source id and no
   * caller passed one, because the dialog had no way to express it — so a
   * surface that already knows which agent it is talking about (the fleet
   * history panel, a per-agent entry point) could not narrow the pick, and a
   * file that two sources both claim would be listed by both.
   */
  sourceId?: string
}

export function SessionImportDialog({ trigger, sourceId }: SessionImportDialogProps) {
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
  // The switch only writes the persisted preference; the watch itself is owned
  // for the app's lifetime by `SessionImportWatchInitializer` (ADR-0062). That
  // is what makes it survive this dialog closing — and a restart.
  const { enabled: watching, toggle: toggleWatch } = useSessionImportWatch()

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

  // Sources that can only ever be reached through the picker, named so an empty
  // scan is not mistaken for "this agent isn't installed".
  const pickerOnly = useMemo(
    () =>
      buildExternalSessionSupportMatrix()
        .importSources.filter((source) => source.pickerOnly)
        .map((source) => sourceLabel(source.sourceId)),
    // `sourceLabel` closes over `t`, which next-intl keeps stable per namespace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Surface a terminal error/done toast is left to inline rendering below.

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="flex max-h-[85dvh] w-[95vw] flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="-mx-1 min-h-0 flex-1 px-1">
          {state.status === "idle" && (
            <div className="space-y-3">
              {!desktop && <p className="text-xs text-muted-foreground">{t("webHint")}</p>}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                  onClick={() => void pickFiles(sourceId)}
                >
                  <FilesIcon className="size-5" />
                  <span className="text-sm font-medium">{t("pickButton")}</span>
                </Button>
              </div>
              {/* A source that declares `pickerOnly` has no machine-wide history
                location, so "Scan installed agents" can never surface it. Aider
                keeps `.aider.chat.history.md` per repository. Saying so is the
                difference between a documented limitation and a scan that looks
                broken — the fact was previously inferable only from an adapter
                returning an empty `scanRoots()`. */}
              {desktop && pickerOnly.length > 0 && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="session-import-picker-only"
                >
                  {t("pickerOnly", { sources: pickerOnly.join(", ") })}
                </p>
              )}
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
                onPickFiles={() => void pickFiles(sourceId)}
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
              {state.details && state.details.length > 0 ? (
                <div className="w-full space-y-3 pt-2 text-left">
                  {relationshipTree(state.details).map(({ detail, depth }) => (
                    <div
                      key={detail.canonicalSessionId}
                      className="rounded-md border p-2"
                      data-testid={`session-import-detail-${detail.canonicalSessionId}`}
                      data-depth={depth}
                      style={{ marginInlineStart: `${depth * 12}px` }}
                    >
                      <p className="truncate pb-1 text-xs font-medium">
                        {detail.title ?? sourceLabel(detail.sourceId)}
                      </p>
                      <FidelityReport
                        loss={detail.loss}
                        reverseFidelity={
                          getSessionSource(detail.sourceId)?.codec?.materialize?.fidelity
                        }
                        sessionHeader={{
                          source: {
                            ...(detail.sourceVersion ? { version: detail.sourceVersion } : {}),
                            ...(detail.sourceRevision ? { revision: detail.sourceRevision } : {}),
                          },
                          ...(detail.runtimeBinding
                            ? { runtimeBinding: detail.runtimeBinding }
                            : {}),
                          ...(detail.lineage ? { lineage: detail.lineage } : {}),
                          ...(detail.lifecycle ? { lifecycle: detail.lifecycle } : {}),
                        }}
                      />
                    </div>
                  ))}
                </div>
              ) : state.lossBySource ? (
                <div className="w-full space-y-3 pt-2 text-left">
                  {Object.entries(state.lossBySource).map(([sourceId, loss]) => (
                    <div key={sourceId} className="rounded-md border p-2">
                      <p className="pb-1 text-xs font-medium">{sourceLabel(sourceId)}</p>
                      <FidelityReport
                        loss={loss}
                        reverseFidelity={getSessionSource(sourceId)?.codec?.materialize?.fidelity}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
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
        </ScrollArea>

        <DialogFooter className="shrink-0">
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
                // An earlier version toasted "Importing…" as a SUCCESS toast
                // after the run had already finished. The completion copy is
                // what belongs on a completion toast.
                onClick={() => void onImport().then(() => toast.success(t("doneTitle")))}
              >
                {t("importSelected", { count: selectedCount })}
              </Button>
            </>
          )}
          {state.status === "error" && (
            // `sessionImport.retry` shipped in both message catalogs with no
            // consumer: the error state offered nothing but Close, so an
            // "unrecognized" pick — the most likely outcome of the picker path —
            // was a dead end that cost the user the whole dialog.
            <Button size="sm" variant="ghost" onClick={reset}>
              {t("retry")}
            </Button>
          )}
          {state.status === "list" && (
            <Button size="sm" variant="ghost" onClick={reset}>
              {t("back")}
            </Button>
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
  onPickFiles,
}: {
  summaries: SessionSummary[]
  selected: Set<string>
  onToggle: (key: string) => void
  sourceLabel: (id: string) => string
  messagesLabel: (n: number) => string
  onPickFiles: () => void
}) {
  const t = useTranslations("sessionImport")
  // Page the list so a history of hundreds of sessions doesn't render hundreds
  // of DOM rows at once. Selection is by key, independent of what's rendered, so
  // "select all" still covers the whole list.
  const [visible, setVisible] = useState(INITIAL_VISIBLE)
  if (summaries.length === 0) {
    // An empty scan used to render this line and nothing else — no hint, no way
    // forward but closing the dialog. `sessionImport.emptyHint` was already
    // translated in both catalogs and had no consumer, and the hint is load
    // bearing: sources with no fixed home (Aider keeps `.aider.chat.history.md`
    // per repo) can ONLY be reached through the picker.
    return (
      <div className="space-y-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
        <p className="text-xs text-muted-foreground">{t("emptyHint")}</p>
        <Button variant="outline" size="sm" onClick={onPickFiles}>
          <FilesIcon className="mr-1 size-3.5" />
          {t("pickButton")}
        </Button>
      </div>
    )
  }
  const shown = summaries.slice(0, visible)
  const remaining = summaries.length - shown.length
  return (
    <ScrollArea className="max-h-[min(18rem,40dvh)]">
      <ul className="space-y-1 pr-2">
        {shown.map((s) => {
          const key = summaryKey(s.ref)
          return (
            <li key={key}>
              <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/50">
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
