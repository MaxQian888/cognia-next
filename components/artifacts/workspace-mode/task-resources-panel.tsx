"use client"

/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps, @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react"
import DOMPurify from "dompurify"
import { DownloadIcon, Loader2Icon, LockKeyholeIcon, UploadIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  applyTaskWorkspace,
  downloadTaskResource,
  exportTaskResourceManifest,
  getTaskResourceSummary,
  getTaskPatchSet,
  installTaskWorkspaceEventListener,
  listTaskResources,
  listTaskResourceEvents,
  listTaskRuns,
  pinTaskWorkspace,
  readTaskResource,
  readTaskResourceDiff,
  resolveTaskWorkspaceConflict,
  undoTaskWorkspace,
  uploadTaskResource,
} from "@/lib/task-workspace/client"
import type {
  PatchSet,
  ResourceChange,
  ResourceEvent,
  TaskResourceSummary,
  TaskRun,
} from "@/lib/task-workspace/types"
import { cn } from "@/lib/utils"
import { useTaskWorkspaceStore } from "@/stores/task-workspace-store"

type ResourceTab = "source" | "preview" | "diff"
type ResourceView = "ledger" | "timeline"

export function TaskResourcesPanel({
  sessionId,
  layout,
}: {
  sessionId: string
  layout: "desktop" | "mobile"
}) {
  const t = useTranslations("artifacts.workspace.taskResources")
  const active = useTaskWorkspaceStore((state) => state.activeBySession[sessionId])
  const cachedResources = useTaskWorkspaceStore((state) =>
    active ? state.resourcesByTask[active.taskId] : undefined
  )
  const provisional = useTaskWorkspaceStore((state) =>
    active ? state.provisionalByRun[active.runId] : undefined
  )
  const reconcile = useTaskWorkspaceStore((state) => state.reconcile)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [resources, setResources] = useState<ResourceChange[]>(cachedResources ?? [])
  const [events, setEvents] = useState<ResourceEvent[]>([])
  const [summary, setSummary] = useState<TaskResourceSummary | null>(null)
  const [hasMoreEvents, setHasMoreEvents] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState(active?.runId ?? "")
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [origin, setOrigin] = useState("all")
  const [status, setStatus] = useState("all")
  const [captureClass, setCaptureClass] = useState("all")
  const [timeRange, setTimeRange] = useState("all")
  const [timeFilterNow, setTimeFilterNow] = useState(0)
  const [view, setView] = useState<ResourceView>("ledger")
  const [tab, setTab] = useState<ResourceTab>("source")
  const [content, setContent] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [patchSet, setPatchSet] = useState<PatchSet | null>(null)
  const [selectedHunks, setSelectedHunks] = useState<string[]>([])
  const [sensitiveAuthorized, setSensitiveAuthorized] = useState(false)
  const [runPreview, setRunPreview] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflicted, setConflicted] = useState(false)
  const [pinned, setPinned] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void installTaskWorkspaceEventListener().then((next) => {
      if (disposed) next()
      else unlisten = next
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (!active) return
    setSelectedRunId(active.runId)
    void Promise.all([listTaskRuns(active.taskId), listTaskResources(active.taskId)])
      .then(([nextRuns, nextResources]) => {
        setRuns(nextRuns)
        setResources(nextResources)
        reconcile(sessionId, nextResources)
      })
      .catch((reason: unknown) => setError(String(reason)))
  }, [active?.taskId, active?.runId, reconcile, sessionId, provisional?.revision])

  useEffect(() => {
    setResources(cachedResources ?? [])
  }, [cachedResources])

  useEffect(() => {
    setContent(null)
    setDiff(null)
    setError(null)
    setSensitiveAuthorized(false)
    setSelectedHunks([])
    setRunPreview(false)
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    setBlobUrl(null)
  }, [selectedPath, selectedRunId, tab])

  useEffect(() => {
    let cancelled = false
    if (!selectedRunId) {
      setPatchSet(null)
      return
    }
    void getTaskPatchSet(selectedRunId)
      .then((next) => {
        if (!cancelled) setPatchSet(next)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [selectedRunId])

  useEffect(() => {
    let cancelled = false
    if (!selectedRunId) {
      setEvents([])
      setSummary(null)
      return
    }
    void Promise.all([
      listTaskResourceEvents(selectedRunId, undefined, 1000),
      getTaskResourceSummary(selectedRunId),
    ])
      .then(([nextEvents, nextSummary]) => {
        if (cancelled) return
        setEvents(nextEvents)
        setHasMoreEvents(nextEvents.length === 1000)
        setSummary(nextSummary)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [selectedRunId, provisional?.revision])

  useEffect(
    () => () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    },
    [blobUrl]
  )

  const visibleResources = useMemo(
    () =>
      resources.filter(
        (resource) =>
          (origin === "all" || resource.origin === origin) &&
          (status === "all" || resource.kind === status) &&
          (captureClass === "all" || resource.captureClass === captureClass) &&
          (selectedRunId === "" || resource.runId === selectedRunId)
      ),
    [captureClass, origin, resources, selectedRunId, status]
  )
  const visibleEvents = useMemo(() => {
    const rangeMs =
      timeRange === "5m"
        ? 5 * 60_000
        : timeRange === "1h"
          ? 60 * 60_000
          : timeRange === "24h"
            ? 24 * 60 * 60_000
            : null
    const cutoff = rangeMs === null ? null : timeFilterNow - rangeMs
    return events.filter(
      (event) =>
        (origin === "all" || event.origin === origin) &&
        (status === "all" || event.kind === status) &&
        (captureClass === "all" || event.captureClass === captureClass) &&
        (cutoff === null || event.observedAt >= cutoff)
    )
  }, [captureClass, events, origin, status, timeFilterNow, timeRange])
  const selected = visibleResources.find((resource) => resource.path === selectedPath) ?? null

  async function loadSelected(allowSensitive = false) {
    if (!selected || !selectedRunId) return
    if (selected.captureClass === "generated" || selected.contentCaptured === false) return
    if (selected.sensitive && !allowSensitive) return
    setLoading(true)
    setError(null)
    try {
      if (tab === "diff") {
        setDiff(await readTaskResourceDiff(selectedRunId, selected.path, allowSensitive))
      } else if (selected.binary) {
        const blob = await downloadTaskResource(selectedRunId, selected.path, allowSensitive)
        setBlobUrl(URL.createObjectURL(blob))
      } else if (selected.kind !== "deleted") {
        const read = await readTaskResource(selectedRunId, selected.path, {
          maxBytes: 1024 * 1024,
          allowSensitive,
        })
        setContent(read.content)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSelected(false)
  }, [selected?.path, selected?.hash, selectedRunId, tab])

  async function refresh() {
    if (!active) return
    const [next, nextPatchSet] = await Promise.all([
      listTaskResources(active.taskId),
      selectedRunId ? getTaskPatchSet(selectedRunId) : Promise.resolve(null),
    ])
    setResources(next)
    setPatchSet(nextPatchSet)
    reconcile(sessionId, next)
  }

  async function apply(selectionPath?: string, hunkIds: string[] = []) {
    if (!selectedRunId) return
    setLoading(true)
    try {
      const selection = selectionPath ? [{ path: selectionPath, hunkIds }] : []
      let outcome
      try {
        outcome = await applyTaskWorkspace(selectedRunId, selection)
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason)
        if (
          message.includes("task workspace ledger capacity exceeded:") &&
          window.confirm(t("irreversibleApplyConfirm"))
        ) {
          outcome = await applyTaskWorkspace(selectedRunId, selection, true)
        } else {
          throw reason
        }
      }
      if (outcome.conflicts.length > 0)
        setError(outcome.conflicts.map((item) => item.reason).join("\n"))
      setConflicted(outcome.state === "conflict")
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const selectedPatchFile = patchSet?.files.find((file) => file.path === selected?.path)

  async function undo() {
    if (!selectedRunId) return
    setLoading(true)
    try {
      const outcome = await undoTaskWorkspace(selectedRunId)
      if (outcome.conflicts.length > 0)
        setError(outcome.conflicts.map((item) => item.reason).join("\n"))
      setConflicted(outcome.state === "conflict")
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  async function resolveConflict(resolution: "applyTask" | "keepCurrent") {
    if (!selectedRunId) return
    setLoading(true)
    try {
      await resolveTaskWorkspaceConflict(selectedRunId, resolution)
      setConflicted(false)
      setError(null)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  async function upload(file: File) {
    if (!selectedRunId) return
    setLoading(true)
    try {
      await uploadTaskResource(selectedRunId, file.name, file)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  async function exportManifest() {
    if (!active) return
    setLoading(true)
    setError(null)
    try {
      const manifest = await exportTaskResourceManifest(active.taskId, selectedRunId || undefined)
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `cognia-task-resources-${active.taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  async function loadMoreEvents() {
    if (!selectedRunId || events.length === 0) return
    setLoading(true)
    try {
      const next = await listTaskResourceEvents(selectedRunId, events[events.length - 1]?.seq, 1000)
      setEvents((current) => [...current, ...next])
      setHasMoreEvents(next.length === 1000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t("empty")}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="task-resources-panel">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Tabs value={view} onValueChange={(value) => setView(value as ResourceView)}>
          <TabsList>
            <TabsTrigger value="ledger">{t("ledger")}</TabsTrigger>
            <TabsTrigger value="timeline">{t("timeline")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <select
          aria-label={t("runFilter")}
          value={selectedRunId}
          onChange={(event) => setSelectedRunId(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          {runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {run.agentId} · {run.state}
            </option>
          ))}
        </select>
        <select
          aria-label={t("originFilter")}
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="all">{t("allOrigins")}</option>
          <option value="agent">{t("agent")}</option>
          <option value="user">{t("user")}</option>
          <option value="unknown">{t("unknown")}</option>
        </select>
        <select
          aria-label={t("statusFilter")}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="all">{t("allStatuses")}</option>
          <option value="created">{t("created")}</option>
          <option value="modified">{t("modified")}</option>
          <option value="deleted">{t("deleted")}</option>
          <option value="renamed">{t("renamed")}</option>
        </select>
        <select
          aria-label={t("captureFilter")}
          value={captureClass}
          onChange={(event) => setCaptureClass(event.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        >
          <option value="all">{t("allCaptureClasses")}</option>
          <option value="source">{t("sourceFiles")}</option>
          <option value="generated">{t("generatedFiles")}</option>
        </select>
        {view === "timeline" && (
          <select
            aria-label={t("timeFilter")}
            value={timeRange}
            onChange={(event) => {
              setTimeRange(event.target.value)
              setTimeFilterNow(Date.now())
            }}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="all">{t("allTime")}</option>
            <option value="5m">{t("lastFiveMinutes")}</option>
            <option value="1h">{t("lastHour")}</option>
            <option value="24h">{t("lastDay")}</option>
          </select>
        )}
        <span className="text-xs text-muted-foreground">
          {provisional ? t("provisional") : t("authoritative")}
        </span>
        <div className="ml-auto flex gap-1">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void upload(file)
            }}
          />
          {view === "ledger" && (
            <>
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                <UploadIcon className="size-3.5" />
                {t("upload")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={patchSet?.reversible === false}
                title={
                  patchSet?.reversible === false ? t("undoUnavailableIrreversible") : undefined
                }
                onClick={() => void undo()}
              >
                {t("undo")}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            aria-pressed={pinned}
            onClick={() =>
              void pinTaskWorkspace(active.taskId, !pinned)
                .then((task) => setPinned(task.pinned))
                .catch((reason: unknown) => setError(String(reason)))
            }
          >
            {pinned ? t("unpin") : t("pin")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void exportManifest()}>
            <DownloadIcon className="size-3.5" />
            {t("exportManifest")}
          </Button>
          {view === "ledger" && (
            <Button size="sm" onClick={() => void apply()}>
              {t("applyAll")}
            </Button>
          )}
        </div>
      </div>
      {view === "timeline" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {summary && (
            <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2 text-xs text-muted-foreground">
              <span>{t("eventCount", { count: summary.eventCount })}</span>
              <span>{t("sourceEventCount", { count: summary.counts.source })}</span>
              <span>{t("generatedEventCount", { count: summary.counts.generated })}</span>
              <span>{t(summary.completeness)}</span>
              {summary.overflowCount > 0 && (
                <span className="text-amber-600 dark:text-amber-400">
                  {t("overflowCount", { count: summary.overflowCount })}
                </span>
              )}
            </div>
          )}
          {visibleEvents.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              {t("timelineEmpty")}
            </div>
          ) : (
            visibleEvents.map((event) => (
              <div
                key={event.eventId}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-2 text-xs"
              >
                <span className="text-muted-foreground">#{event.seq}</span>
                <div className="min-w-0">
                  <div className="truncate font-mono">{event.path ?? t(event.kind)}</div>
                  <div className="text-muted-foreground">
                    {t(event.captureClass)} · {t(event.origin)} · {t(event.evidence)}
                  </div>
                </div>
                <div className="text-right text-muted-foreground">
                  <div>{t(event.kind)}</div>
                  <time dateTime={new Date(event.observedAt).toISOString()}>
                    {new Date(event.observedAt).toLocaleTimeString()}
                  </time>
                </div>
              </div>
            ))
          )}
          {hasMoreEvents && (
            <div className="flex justify-center p-3">
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => void loadMoreEvents()}
              >
                {t("loadMoreEvents")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div
          className={cn(
            "grid min-h-0 flex-1",
            layout === "mobile"
              ? "grid-rows-[minmax(8rem,35%)_1fr]"
              : "grid-cols-[minmax(12rem,32%)_1fr]"
          )}
        >
          <div className="min-h-0 overflow-auto border-r">
            {visibleResources.map((resource) => (
              <button
                key={`${resource.revision}:${resource.path}`}
                type="button"
                onClick={() => setSelectedPath(resource.path)}
                className={cn(
                  "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-xs",
                  selectedPath === resource.path && "bg-accent"
                )}
              >
                {resource.sensitive && (
                  <LockKeyholeIcon className="size-3.5" aria-label={t("sensitive")} />
                )}
                <span className="min-w-0 flex-1 truncate">{resource.path}</span>
                <span className="text-muted-foreground">{t(resource.kind)}</span>
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-col">
            {selected ? (
              <>
                <div className="flex items-center gap-2 border-b p-2">
                  <Tabs value={tab} onValueChange={(value) => setTab(value as ResourceTab)}>
                    <TabsList>
                      <TabsTrigger value="source">{t("source")}</TabsTrigger>
                      <TabsTrigger value="preview">{t("preview")}</TabsTrigger>
                      <TabsTrigger value="diff">{t("diff")}</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Button
                    className="ml-auto"
                    size="sm"
                    variant="outline"
                    disabled={
                      selected.captureClass === "generated" || selected.contentCaptured === false
                    }
                    onClick={() => void apply(selected.path)}
                  >
                    {t("applyFile")}
                  </Button>
                  {tab === "preview" &&
                    (selected.mediaType === "text/html" ||
                      selected.mediaType === "image/svg+xml") && (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-pressed={runPreview}
                        onClick={() => setRunPreview((current) => !current)}
                      >
                        {runPreview ? t("staticPreview") : t("runSandboxed")}
                      </Button>
                    )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  {selected.captureClass === "generated" || selected.contentCaptured === false ? (
                    <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
                      {t("generatedMetadataOnly")}
                    </div>
                  ) : loading ? (
                    <Loader2Icon
                      className="mx-auto mt-8 size-5 animate-spin"
                      aria-label={t("loading")}
                    />
                  ) : selected.sensitive &&
                    content === null &&
                    diff === null &&
                    blobUrl === null ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
                      <LockKeyholeIcon className="size-6" />
                      <p>{t("sensitiveDescription")}</p>
                      <Button
                        onClick={() => {
                          if (window.confirm(t("sensitiveConfirm"))) {
                            setSensitiveAuthorized(true)
                            void loadSelected(true)
                          }
                        }}
                      >
                        {t("authorizeOnce")}
                      </Button>
                    </div>
                  ) : error ? (
                    <div className="space-y-3">
                      <pre className="whitespace-pre-wrap text-sm text-destructive">{error}</pre>
                      {conflicted && (
                        <div className="flex gap-2">
                          <Button
                            variant="destructive"
                            onClick={() => void resolveConflict("applyTask")}
                          >
                            {t("conflictApplyTask")}
                          </Button>
                          <Button
                            variant="outline"
                            onClick={() => void resolveConflict("keepCurrent")}
                          >
                            {t("conflictKeepCurrent")}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : tab === "diff" ? (
                    <div className="space-y-3">
                      {selectedPatchFile && selectedPatchFile.hunks.length > 0 && (
                        <div className="rounded-md border p-2">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{t("selectHunks")}</span>
                            <Button
                              size="sm"
                              disabled={selectedHunks.length === 0}
                              onClick={() => void apply(selected.path, selectedHunks)}
                            >
                              {t("applySelectedHunks", { count: selectedHunks.length })}
                            </Button>
                          </div>
                          {selectedPatchFile.hunks.map((hunk) => (
                            <label key={hunk.id} className="flex items-center gap-2 py-1 text-xs">
                              <input
                                type="checkbox"
                                checked={selectedHunks.includes(hunk.id)}
                                onChange={(event) =>
                                  setSelectedHunks((current) =>
                                    event.target.checked
                                      ? [...current, hunk.id]
                                      : current.filter((id) => id !== hunk.id)
                                  )
                                }
                              />
                              <code>{hunk.header}</code>
                            </label>
                          ))}
                        </div>
                      )}
                      <pre className="whitespace-pre-wrap font-mono text-xs">
                        {diff || t("diffUnavailable")}
                      </pre>
                    </div>
                  ) : tab === "source" ? (
                    <pre className="whitespace-pre-wrap font-mono text-xs">
                      {content ?? t("binarySource")}
                    </pre>
                  ) : (
                    <ResourcePreview
                      resource={selected}
                      content={content}
                      blobUrl={blobUrl}
                      runSandboxed={runPreview}
                    />
                  )}
                </div>
                <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
                  <span>{selected.mediaType}</span>
                  <span>{t("bytes", { count: selected.size })}</span>
                  {selected.insertions !== null && (
                    <span>
                      +{selected.insertions} / -{selected.deletions}
                    </span>
                  )}
                  <Button
                    className="ml-auto"
                    size="sm"
                    variant="ghost"
                    disabled={
                      selected.captureClass === "generated" || selected.contentCaptured === false
                    }
                    onClick={() =>
                      void downloadTaskResource(
                        selectedRunId,
                        selected.path,
                        sensitiveAuthorized
                      ).then((blob) => {
                        const url = URL.createObjectURL(blob)
                        const anchor = document.createElement("a")
                        anchor.href = url
                        anchor.download = selected.path.split("/").pop() ?? "resource"
                        anchor.click()
                        URL.revokeObjectURL(url)
                      })
                    }
                  >
                    <DownloadIcon className="size-3.5" />
                    {t("download")}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {t("selectResource")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ResourcePreview({
  resource,
  content,
  blobUrl,
  runSandboxed,
}: {
  resource: ResourceChange
  content: string | null
  blobUrl: string | null
  runSandboxed: boolean
}) {
  const t = useTranslations("artifacts.workspace.taskResources")
  if (resource.mediaType === "text/markdown" && content !== null)
    return <MarkdownRenderer content={content} />
  if (
    (resource.mediaType === "text/html" || resource.mediaType === "image/svg+xml") &&
    content !== null
  ) {
    const body = runSandboxed
      ? content
      : DOMPurify.sanitize(
          content,
          resource.mediaType === "image/svg+xml"
            ? { USE_PROFILES: { svg: true, svgFilters: true } }
            : { WHOLE_DOCUMENT: true }
        )
    const scriptPolicy = runSandboxed ? "; script-src 'unsafe-inline'" : ""
    const srcDoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'${scriptPolicy}"><body>${body}</body>`
    return (
      <iframe
        title={t("preview")}
        sandbox={runSandboxed ? "allow-scripts" : ""}
        srcDoc={srcDoc}
        className="h-full min-h-80 w-full rounded-md border"
      />
    )
  }
  if (resource.mediaType === "application/json" && content !== null) {
    let formatted = content
    try {
      formatted = JSON.stringify(JSON.parse(content), null, 2)
    } catch {}
    return <pre className="whitespace-pre-wrap font-mono text-xs">{formatted}</pre>
  }
  if (resource.mediaType.startsWith("image/") && blobUrl)
    return (
      <img src={blobUrl} alt={resource.path} className="max-h-full max-w-full object-contain" />
    )
  if (resource.mediaType.startsWith("audio/") && blobUrl)
    return <audio controls src={blobUrl} className="w-full" />
  if (resource.mediaType.startsWith("video/") && blobUrl)
    return <video controls src={blobUrl} className="max-h-full max-w-full" />
  if (resource.mediaType === "application/pdf" && blobUrl)
    return (
      <iframe
        title={resource.path}
        sandbox=""
        src={blobUrl}
        className="h-full min-h-96 w-full border"
      />
    )
  if (content !== null)
    return <pre className="whitespace-pre-wrap font-mono text-xs">{content}</pre>
  return <p className="text-sm text-muted-foreground">{t("previewUnavailable")}</p>
}
