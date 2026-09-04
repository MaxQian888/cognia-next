"use client"

/**
 * Settings → Automation → Inspector.
 *
 * This surface is a direct consumer of the canonical app-session API. It does
 * not translate legacy element refs, actions, or coordinate contracts.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, MousePointerClickIcon, RefreshCwIcon, SearchIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { desktop, type CallContext } from "@/lib/automation/client"
import type {
  ActionResult,
  AppLocator,
  Capabilities,
  ExpandedElements,
  ResolvedApplication,
  UiStateRevision,
  UiTreeNode,
} from "@/lib/automation/types"
import { isTauri } from "@/lib/tauri"
import { AutomationUnavailableNotice } from "./automation-unavailable-notice"

const INSPECTOR_SESSION_ID = "settings:automation-inspector"
const INSPECTOR_CONTEXT: CallContext = {
  surface: "workflow",
  sessionKey: INSPECTOR_SESSION_ID,
  turnKey: INSPECTOR_SESSION_ID,
}
const PAGE_SIZE = 250

type InspectorView = "compact" | "raw" | "diff" | "events" | "evidence"

interface InspectorEvent {
  id: number
  kind: "capture" | "query" | "expand" | "action"
  message: string
  revision: number | null
}

interface RevisionHistory {
  initial: UiStateRevision | null
  previous: UiStateRevision | null
  current: UiStateRevision | null
}

function appKey(app: ResolvedApplication): string {
  return JSON.stringify([app.bundleId, app.path, app.displayName, app.processId])
}

function appLocator(app: ResolvedApplication): AppLocator {
  if (app.bundleId) return { kind: "bundleId", bundleId: app.bundleId }
  if (app.path) return { kind: "path", path: app.path }
  return { kind: "displayName", displayName: app.displayName }
}

function nodeLabel(node: UiTreeNode, unnamed: string): string {
  return node.element.name ?? node.element.automationId ?? node.element.controlType ?? unnamed
}

function overlayStyle(state: UiStateRevision, node: UiTreeNode): CSSProperties | undefined {
  const rect = node.element.boundingRect
  const bounds = state.surface.logicalBounds
  if (!rect || bounds.width <= 0 || bounds.height <= 0) return undefined
  return {
    left: `${((rect.x - bounds.x) / bounds.width) * 100}%`,
    top: `${((rect.y - bounds.y) / bounds.height) * 100}%`,
    width: `${(rect.width / bounds.width) * 100}%`,
    height: `${(rect.height / bounds.height) * 100}%`,
  }
}

export function InspectorTab() {
  const t = useTranslations("automation.inspector")
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [apps, setApps] = useState<ResolvedApplication[]>([])
  const [selectedAppKey, setSelectedAppKey] = useState("")
  const [history, setHistory] = useState<RevisionHistory>({
    initial: null,
    previous: null,
    current: null,
  })
  const [selected, setSelected] = useState<UiTreeNode | null>(null)
  const [query, setQuery] = useState("")
  const [queryResults, setQueryResults] = useState<UiTreeNode[] | null>(null)
  const [expanded, setExpanded] = useState<ExpandedElements | null>(null)
  const [page, setPage] = useState(0)
  const [view, setView] = useState<InspectorView>("compact")
  const [events, setEvents] = useState<InspectorEvent[]>([])
  const [actionResult, setActionResult] = useState<ActionResult | null>(null)
  const [loadingApps, setLoadingApps] = useState(true)
  const [loadingState, setLoadingState] = useState(false)
  const [busy, setBusy] = useState<"query" | "expand" | "action" | null>(null)

  const pushEvent = useCallback(
    (kind: InspectorEvent["kind"], message: string, revision: number | null) => {
      setEvents((current) =>
        [{ id: Date.now() + Math.random(), kind, message, revision }, ...current].slice(0, 100)
      )
    },
    []
  )

  const loadApps = useCallback(async () => {
    setLoadingApps(true)
    try {
      const next = await desktop.listApps(INSPECTOR_CONTEXT)
      setApps(next)
      setSelectedAppKey((current) => {
        if (next.some((app) => appKey(app) === current)) return current
        return next[0] ? appKey(next[0]) : ""
      })
    } catch (error) {
      toast.error(t("appsFailed"), { description: String(error) })
    } finally {
      setLoadingApps(false)
    }
  }, [t])

  useEffect(() => {
    if (!isTauri()) return
    desktop
      .capabilities()
      .then(setCaps)
      .catch((error) => toast.error(t("capabilitiesFailed"), { description: String(error) }))
    desktop
      .listApps(INSPECTOR_CONTEXT)
      .then((next) => {
        setApps(next)
        setSelectedAppKey(next[0] ? appKey(next[0]) : "")
      })
      .catch((error) => toast.error(t("appsFailed"), { description: String(error) }))
      .finally(() => setLoadingApps(false))
  }, [t])

  const selectedApp = useMemo(
    () => apps.find((app) => appKey(app) === selectedAppKey) ?? null,
    [apps, selectedAppKey]
  )

  const captureState = useCallback(async () => {
    if (!selectedApp) return null
    setLoadingState(true)
    try {
      const next = await desktop.getAppState(
        INSPECTOR_SESSION_ID,
        appLocator(selectedApp),
        {
          projection: "inspector",
          maxNodes: 25_000,
        },
        INSPECTOR_CONTEXT
      )
      setHistory((current) => ({
        initial: current.initial ?? next,
        previous: current.current,
        current: next,
      }))
      setQueryResults(null)
      setExpanded(null)
      setPage(0)
      pushEvent("capture", t("events.capture", { revision: next.revision }), next.revision)
      return next
    } catch (error) {
      toast.error(t("stateFailed"), { description: String(error) })
      return null
    } finally {
      setLoadingState(false)
    }
  }, [pushEvent, selectedApp, t])

  const currentState = history.current

  const runQuery = useCallback(async () => {
    const state = currentState
    if (!state || !query.trim()) return
    setBusy("query")
    try {
      const nodes = await desktop.queryElements(
        {
          sessionId: state.sessionId,
          lineageId: state.lineageId,
          revision: state.revision,
        },
        { nameContains: query.trim() },
        1_000,
        INSPECTOR_CONTEXT
      )
      setQueryResults(nodes)
      setExpanded(null)
      setPage(0)
      pushEvent("query", t("events.query", { count: nodes.length }), state.revision)
    } catch (error) {
      toast.error(t("queryFailed"), { description: String(error) })
    } finally {
      setBusy(null)
    }
  }, [currentState, pushEvent, query, t])

  const expandSelected = useCallback(async () => {
    if (!selected) return
    setBusy("expand")
    try {
      const result = await desktop.expandElement(
        selected.handle,
        expanded?.continuationToken ?? null,
        PAGE_SIZE,
        INSPECTOR_CONTEXT
      )
      setExpanded((current) => ({
        nodes: [...(current?.nodes ?? []), ...result.nodes],
        continuationToken: result.continuationToken,
      }))
      pushEvent(
        "expand",
        t("events.expand", { count: result.nodes.length }),
        selected.handle.revision
      )
    } catch (error) {
      toast.error(t("expandFailed"), { description: String(error) })
    } finally {
      setBusy(null)
    }
  }, [expanded, pushEvent, selected, t])

  const performSemanticClick = useCallback(async () => {
    const state = currentState
    if (!state || !selected || selected.handle.revision !== state.revision) return
    setBusy("action")
    try {
      const result = await desktop.performAction(
        {
          turnToken: state.turnToken,
          target: { kind: "element", handle: selected.handle },
          action: { kind: "click" },
          strategy: "semantic",
        },
        INSPECTOR_CONTEXT
      )
      setActionResult(result)
      pushEvent("action", t("events.action", { status: result.status }), state.revision)
      await captureState()
    } catch (error) {
      toast.error(t("actionFailed"), { description: String(error) })
    } finally {
      setBusy(null)
    }
  }, [captureState, currentState, pushEvent, selected, t])

  if (!isTauri()) return <AutomationUnavailableNotice />

  if (!caps) return <Skeleton className="h-72 w-full" />

  if (!(caps.hasUia || caps.hasA11yTree)) {
    return (
      <Alert>
        <AlertDescription>{t("unavailable", { platform: caps.platform })}</AlertDescription>
      </Alert>
    )
  }

  const state = history.current
  const sourceNodes = expanded?.nodes ?? queryResults ?? state?.tree.nodes ?? []
  const depthByIndex = new Map<number, number>()
  for (const node of sourceNodes) {
    depthByIndex.set(
      node.handle.index,
      node.parentIndex == null ? 0 : (depthByIndex.get(node.parentIndex) ?? 0) + 1
    )
  }
  const pageCount = Math.max(1, Math.ceil(sourceNodes.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visibleNodes = sourceNodes.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  const selectedIsFresh = Boolean(
    state &&
    selected &&
    selected.handle.sessionId === state.sessionId &&
    selected.handle.lineageId === state.lineageId &&
    selected.handle.revision === state.revision
  )
  // A frame with no bytes is not a frame: `<img src="data:image/png;base64,">`
  // renders as a broken image rather than as "no screenshot". An app-state read
  // can legitimately come back empty — a capture the platform refused, or (on a
  // model-facing surface, which the Inspector is not) a frame `screenshotDedup`
  // withheld as unchanged.
  const screenshot = state?.screenshot?.bytes ? state.screenshot : null
  const overlay = state && selected ? overlayStyle(state, selected) : undefined

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("session.title")}</CardTitle>
          <CardDescription>{t("session.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1 space-y-1">
            <Label>{t("app")}</Label>
            <Select
              value={selectedAppKey}
              onValueChange={(value) => {
                setSelectedAppKey(value)
                setHistory({ initial: null, previous: null, current: null })
                setSelected(null)
              }}
            >
              <SelectTrigger aria-label={t("app")}>
                <SelectValue placeholder={t("selectApp")} />
              </SelectTrigger>
              <SelectContent>
                {apps.map((app) => (
                  <SelectItem key={appKey(app)} value={appKey(app)}>
                    {t("appOption", { name: app.displayName, pid: app.processId })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" onClick={loadApps} disabled={loadingApps}>
            <RefreshCwIcon className="mr-1 size-4" />
            {t("refreshApps")}
          </Button>
          <Button onClick={() => void captureState()} disabled={!selectedApp || loadingState}>
            <RefreshCwIcon className="mr-1 size-4" />
            {loadingState ? t("reading") : t("captureState")}
          </Button>
        </CardContent>
      </Card>

      {state && (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr),minmax(360px,0.9fr)]">
            <Card>
              <CardHeader>
                <CardTitle>{t("tree")}</CardTitle>
                <CardDescription>
                  {t("treeSummary", {
                    revision: state.revision,
                    count: state.tree.nodes.length,
                    total: state.tree.totalNodes,
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {(["compact", "raw", "diff", "events", "evidence"] as InspectorView[]).map(
                    (item) => (
                      <Button
                        key={item}
                        size="sm"
                        variant={view === item ? "default" : "outline"}
                        onClick={() => setView(item)}
                      >
                        {t(`views.${item}`)}
                      </Button>
                    )
                  )}
                </div>

                {view === "compact" && (
                  <>
                    <div className="flex gap-2">
                      <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void runQuery()
                        }}
                        placeholder={t("queryPlaceholder")}
                      />
                      <Button
                        variant="secondary"
                        onClick={() => void runQuery()}
                        disabled={!query.trim() || busy === "query"}
                        aria-label={t("query")}
                      >
                        <SearchIcon className="size-4" />
                      </Button>
                      {queryResults && (
                        <Button variant="ghost" onClick={() => setQueryResults(null)}>
                          {t("clearQuery")}
                        </Button>
                      )}
                    </div>
                    <ScrollArea className="h-[440px] rounded-md border">
                      {visibleNodes.length === 0 ? (
                        <p className="p-3 text-xs text-muted-foreground">{t("emptyResult")}</p>
                      ) : (
                        <div className="divide-y">
                          {visibleNodes.map((node) => (
                            <Button
                              key={`${node.handle.revision}:${node.handle.index}`}
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setSelected(node)
                                setExpanded(null)
                              }}
                              className={
                                "h-auto w-full justify-start whitespace-normal rounded-none px-3 py-2 text-left text-xs font-normal hover:bg-muted/40 " +
                                (selected?.handle.index === node.handle.index ? "bg-muted" : "")
                              }
                            >
                              <span
                                className="inline-block"
                                style={{
                                  marginLeft: `${(depthByIndex.get(node.handle.index) ?? 0) * 12}px`,
                                }}
                              >
                                <span className="font-mono text-muted-foreground">
                                  #{node.handle.index}
                                </span>
                                <span className="ml-2 font-medium">
                                  {nodeLabel(node, t("unnamed"))}
                                </span>
                                {node.element.controlType && (
                                  <span className="ml-2 text-muted-foreground">
                                    [{node.element.controlType}]
                                  </span>
                                )}
                              </span>
                            </Button>
                          ))}
                        </div>
                      )}
                    </ScrollArea>
                    <Pagination
                      page={safePage}
                      pageCount={pageCount}
                      onPage={setPage}
                      previous={t("previousPage")}
                      next={t("nextPage")}
                      summary={t("pageSummary", { page: safePage + 1, pages: pageCount })}
                    />
                  </>
                )}

                {view === "raw" && (
                  <>
                    <pre className="max-h-[480px] overflow-auto rounded-md border bg-muted/30 p-3 text-[11px]">
                      {JSON.stringify(visibleNodes, null, 2)}
                    </pre>
                    <Pagination
                      page={safePage}
                      pageCount={pageCount}
                      onPage={setPage}
                      previous={t("previousPage")}
                      next={t("nextPage")}
                      summary={t("pageSummary", { page: safePage + 1, pages: pageCount })}
                    />
                  </>
                )}

                {view === "diff" && <RevisionDiff history={history} empty={t("noDiff")} />}

                {view === "events" && <EventList events={events} empty={t("noEvents")} />}

                {view === "evidence" && (
                  <pre className="max-h-[480px] overflow-auto rounded-md border bg-muted/30 p-3 text-[11px]">
                    {actionResult ? JSON.stringify(actionResult, null, 2) : t("noEvidence")}
                  </pre>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>{t("screenshot")}</CardTitle>
                  <CardDescription>{t("screenshotDescription")}</CardDescription>
                </CardHeader>
                <CardContent>
                  {screenshot ? (
                    <div className="relative overflow-hidden rounded-md border bg-black">
                      {/* eslint-disable-next-line @next/next/no-img-element -- runtime base64 artifact */}
                      <img
                        src={`data:image/${screenshot.format};base64,${screenshot.bytes}`}
                        alt={t("screenshotAlt")}
                        className="h-auto w-full"
                      />
                      {overlay && (
                        <div
                          className="pointer-events-none absolute border-2 border-red-500 bg-red-500/15"
                          style={overlay}
                          aria-label={t("selectedOverlay")}
                        />
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("noScreenshot")}</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t("elementDetails")}</CardTitle>
                  <CardDescription>{t("elementDetailsDescription")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!selected ? (
                    <p className="text-xs text-muted-foreground">{t("selectRow")}</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={selectedIsFresh ? "default" : "destructive"}>
                          {selectedIsFresh ? t("handleFresh") : t("handleStale")}
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === "expand" || !selectedIsFresh}
                          onClick={() => void expandSelected()}
                        >
                          <ChevronRightIcon className="mr-1 size-4" />
                          {expanded?.continuationToken ? t("expandMore") : t("expand")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy === "action" || !selectedIsFresh}
                          onClick={() => void performSemanticClick()}
                        >
                          <MousePointerClickIcon className="mr-1 size-4" />
                          {t("semanticClick")}
                        </Button>
                      </div>
                      <div className="space-y-1.5 text-xs">
                        <Detail
                          label={t("details.name")}
                          value={selected.element.name}
                          none={t("none")}
                        />
                        <Detail
                          label={t("details.role")}
                          value={selected.element.controlType}
                          none={t("none")}
                        />
                        <Detail
                          label={t("details.automationId")}
                          value={selected.element.automationId}
                          none={t("none")}
                        />
                        <Detail
                          label={t("details.className")}
                          value={selected.element.className}
                          none={t("none")}
                        />
                        <Detail
                          label={t("details.fingerprint")}
                          value={selected.handle.fingerprint}
                          none={t("none")}
                          mono
                        />
                        <Detail
                          label={t("details.revision")}
                          value={String(selected.handle.revision)}
                          none={t("none")}
                        />
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>{t("coordinates")}</CardTitle>
                  <CardDescription>{t("coordinatesDescription")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-1.5 text-xs">
                  <Detail
                    label={t("details.windowId")}
                    value={state.surface.windowId == null ? null : String(state.surface.windowId)}
                    none={t("none")}
                  />
                  <Detail
                    label={t("details.displayId")}
                    value={state.surface.displayId}
                    none={t("none")}
                  />
                  <Detail
                    label={t("details.logicalBounds")}
                    value={JSON.stringify(state.surface.logicalBounds)}
                    none={t("none")}
                    mono
                  />
                  <Detail
                    label={t("details.sourcePixels")}
                    value={`${screenshot?.sourceWidth ?? state.surface.pixelWidth}×${screenshot?.sourceHeight ?? state.surface.pixelHeight}`}
                    none={t("none")}
                  />
                  <Detail
                    label={t("details.modelPixels")}
                    value={`${screenshot?.width ?? state.surface.pixelWidth}×${screenshot?.height ?? state.surface.pixelHeight}`}
                    none={t("none")}
                  />
                  <Detail
                    label={t("details.scaleFactor")}
                    value={String(state.surface.scaleFactor)}
                    none={t("none")}
                  />
                  <Detail
                    label={t("details.coordinateSpace")}
                    value={state.surface.coordinateSpace}
                    none={t("none")}
                  />
                </CardContent>
              </Card>

              {state.truncation.length > 0 && (
                <Alert>
                  <AlertDescription>
                    {state.truncation
                      .map((item) =>
                        t("truncation", {
                          reason: item.reason,
                          materialized: item.materializedNodes,
                          omitted: item.omittedNodes,
                        })
                      )
                      .join(" ")}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Pagination({
  page,
  pageCount,
  onPage,
  previous,
  next,
  summary,
}: {
  page: number
  pageCount: number
  onPage: (page: number) => void
  previous: string
  next: string
  summary: string
}) {
  return (
    <div className="flex items-center justify-between">
      <Button size="sm" variant="outline" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {previous}
      </Button>
      <span className="text-xs text-muted-foreground">{summary}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={page + 1 >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        {next}
      </Button>
    </div>
  )
}

function RevisionDiff({ history, empty }: { history: RevisionHistory; empty: string }) {
  if (!history.current?.diff) {
    return <p className="text-xs text-muted-foreground">{empty}</p>
  }
  return (
    <pre className="max-h-[480px] overflow-auto rounded-md border bg-muted/30 p-3 text-[11px]">
      {JSON.stringify(
        {
          initialRevision: history.initial?.revision ?? null,
          previousRevision: history.previous?.revision ?? null,
          currentRevision: history.current.revision,
          diff: history.current.diff,
        },
        null,
        2
      )}
    </pre>
  )
}

function EventList({ events, empty }: { events: InspectorEvent[]; empty: string }) {
  if (events.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>
  }
  return (
    <div className="max-h-[480px] space-y-2 overflow-auto">
      {events.map((event) => (
        <div key={event.id} className="rounded-md border px-3 py-2 text-xs">
          <span>{event.message}</span>
        </div>
      ))}
    </div>
  )
}

function Detail({
  label,
  value,
  none,
  mono,
}: {
  label: string
  value: string | null | undefined
  none: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span
        className={(mono ? "break-all font-mono text-[11px] " : "") + "min-w-0 truncate"}
        title={value ?? undefined}
      >
        {value ?? (
          <Badge variant="outline" className="text-[10px]">
            {none}
          </Badge>
        )}
      </span>
    </div>
  )
}
