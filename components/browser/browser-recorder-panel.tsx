"use client"

import { useLiveQuery } from "dexie-react-hooks"
import {
  ChevronDown,
  ChevronUp,
  Circle,
  Download,
  Pencil,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react"
import { toast } from "sonner"

import { useFlowRecorder, type UseFlowRecorder } from "@/hooks/browser/use-flow-recorder"
import {
  deleteRecording,
  listRecordingsForBase,
  renameRecording,
  saveRecording,
  type BrowserRecordingRow,
} from "@/lib/db/browser-recordings"
import { exportFilename, exportFlow, type ExportFormat } from "@/lib/browser/recording/exporters"
import {
  isReplayable,
  type RecordedFlow,
  type RecordedStep,
} from "@/lib/browser/recording/protocol"
import { saveFileAs } from "@/lib/files/file-bridge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"

export interface BrowserRecorderPanelProps {
  /** The pane's live URL. Recording needs a loaded page to attach to. */
  pageUrl: string | null
  /** Ship the agent-context export into chat. Absent = no chat session open. */
  onSendToChat?: (markdown: string) => void
  /**
   * Injected clock for the rename write, mirroring {@link useFlowRecorder}'s
   * option of the same name — `Date.now` is banned in this repo's own code so
   * that time is assertable from a test.
   */
  now?: () => number
  /** Re-measure the sibling native preview after this panel changes height. */
  onLayoutChange?: () => void
  /** Host-specific recorder; absent keeps the embedded desktop recorder. */
  recorder?: UseFlowRecorder
  /**
   * Draw the panel's own section wrapper, title and collapse toggle. Default
   * true keeps the standalone usage (the remote preview mounts this directly)
   * unchanged; {@link BrowserToolsDock} passes false because it owns one strip
   * of chrome for every tool.
   */
  chrome?: boolean
}

/** Render a step as one human-readable line for the step list. */
function useStepLabel() {
  const t = useTranslations("browser")
  return useCallback(
    (step: RecordedStep): string => {
      const named = (s: Extract<RecordedStep, { target: unknown }>) =>
        s.target.name || s.target.selector
      switch (step.act) {
        case "navigate":
          return t("record.step.navigate", { url: step.url })
        case "click":
          return t("record.step.click", { target: named(step) })
        case "double_click":
          return t("record.step.doubleClick", { target: named(step) })
        case "hover":
          return t("record.step.hover", { target: named(step) })
        case "scroll":
          return t("record.step.scroll", {
            direction: t(`record.step.direction.${step.direction}`),
            amount: step.amount,
          })
        case "fill":
          return step.secret
            ? t("record.step.secret", { target: named(step) })
            : t("record.step.fill", { target: named(step) })
        case "select":
          return t("record.step.select", { target: named(step), value: step.value })
        case "press_key":
          return t("record.step.pressKey", { key: step.key })
        case "wait_for":
          return t("record.step.waitFor", { text: step.text })
      }
    },
    [t]
  )
}

interface SavedFlowsProps {
  rows: BrowserRecordingRow[]
  /** Load a saved flow into the panel for replay/export — see `select` below. */
  onSelect: (row: BrowserRecordingRow) => void
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

/**
 * The flows already saved for the loaded origin. Without this the recorder can
 * only ever write to Dexie and never read back — the defect ADR-0072 shipped
 * with.
 */
function SavedFlows({ rows, onSelect, onRename, onDelete }: SavedFlowsProps) {
  const t = useTranslations("browser")
  // Which row is mid-rename, and the in-progress text. Editing one row at a
  // time keeps the draft unambiguous.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  const commit = useCallback(async () => {
    const next = draft.trim()
    if (!editingId || !next) return
    await onRename(editingId, next)
    setEditingId(null)
  }, [draft, editingId, onRename])

  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-muted-foreground text-xs font-medium">{t("record.savedTitle")}</h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-1 text-xs">
            {editingId === row.id ? (
              <>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label={t("record.renameLabel")}
                  className="h-7 text-xs"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void commit()}
                  disabled={!draft.trim()}
                >
                  {t("record.renameConfirm")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                  {t("record.renameCancel")}
                </Button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  onClick={() => onSelect(row)}
                >
                  {row.name}
                </button>
                <span className="text-muted-foreground shrink-0">
                  {t("record.savedSteps", { count: row.steps.length })}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0"
                  aria-label={t("record.rename")}
                  onClick={() => {
                    setEditingId(row.id)
                    setDraft(row.name)
                  }}
                >
                  <Pencil aria-hidden />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0"
                  aria-label={t("record.delete")}
                  onClick={() => void onDelete(row.id)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

interface FlowReviewProps {
  /**
   * The finished take. Non-null by construction: the panel renders this section
   * only once it has a flow in hand, so save/replay/export need no guard.
   */
  flow: RecordedFlow
  recorder: UseFlowRecorder
  /** Name + secrets live in the panel so a re-take doesn't lose typed secrets. */
  name: string
  setName: Dispatch<SetStateAction<string>>
  secrets: Record<string, string>
  setSecrets: Dispatch<SetStateAction<Record<string, string>>>
  onSendToChat?: (markdown: string) => void
}

/** Review a finished take: name it, then save, replay, or export it. */
function FlowReview({
  flow,
  recorder,
  name,
  setName,
  secrets,
  setSecrets,
  onSendToChat,
}: FlowReviewProps) {
  const t = useTranslations("browser")

  const save = useCallback(async () => {
    await saveRecording({ ...flow, name: name.trim() || flow.baseUrl })
    toast.success(t("record.saved"))
  }, [flow, name, t])

  const replay = useCallback(async () => {
    const ok = await recorder.replay(flow, secrets)
    if (ok) {
      toast.success(t("record.replaySucceeded", { count: flow.steps.length }))
      return
    }
    const failed = recorder.replayProgress
    if (failed && !failed.ok) {
      toast.error(t("record.replayFailed", { index: failed.index + 1, error: failed.error ?? "" }))
    }
  }, [flow, recorder, secrets, t])

  const named = useCallback(() => ({ ...flow, name: name.trim() || flow.name }), [flow, name])

  const doExport = useCallback(
    async (format: ExportFormat) => {
      const artifact = exportFlow(named(), format)
      if (format === "agent" && onSendToChat) {
        onSendToChat(artifact)
        return
      }
      await navigator.clipboard.writeText(artifact)
      toast.success(t("record.exported"))
    },
    [named, onSendToChat, t]
  )

  /**
   * Write the artifact to disk. The menu's Download icon promised this and only
   * ever delivered a clipboard copy, which is also why `exportFilename` — with
   * its per-format `.spec.ts` / `.json` / `.md` suffixes — had no caller.
   */
  const doDownload = useCallback(
    async (format: ExportFormat) => {
      const flowToSave = named()
      const saved = await saveFileAs({
        defaultName: exportFilename(flowToSave, format),
        content: exportFlow(flowToSave, format),
      })
      if (saved) toast.success(t("record.downloaded"))
    },
    [named, t]
  )

  const needed = recorder.secretsFor(flow)

  return (
    <div className="flex flex-col gap-2">
      {/* Passwords are never recorded, so replay has to be handed them. */}
      {needed.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            {t("record.secretNeeded", { names: needed.join(", ") })}
          </p>
          {needed.map((key) => (
            <Input
              key={key}
              type="password"
              value={secrets[key] ?? ""}
              onChange={(e) => setSecrets((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder={t("record.secretPlaceholder", { name: key })}
              aria-label={t("record.secretPlaceholder", { name: key })}
              className="h-8 text-xs"
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("record.name")}
          className="h-8 text-xs"
        />
        <Button size="sm" variant="ghost" onClick={() => void save()}>
          <Save aria-hidden />
          {t("record.save")}
        </Button>
        {/* A flow of nothing but assertions has no action to perform, which is
            exactly what `isReplayable` was written to reject — it just was
            never asked. */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void replay()}
          disabled={recorder.replaying || !isReplayable(flow)}
          title={isReplayable(flow) ? undefined : t("record.replayNothing")}
        >
          <Play aria-hidden />
          {recorder.replaying ? t("record.replaying") : t("record.replay")}
        </Button>
        {/* Replay locks its own button, so an aborted-but-hung replay would be
            inescapable without a separate way out. */}
        {recorder.replaying && (
          <Button size="sm" variant="ghost" onClick={() => recorder.stopReplay()}>
            <Square aria-hidden />
            {t("record.stopReplay")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost">
              <Download aria-hidden />
              {t("record.export")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void doExport("playwright")}>
              {t("record.exportPlaywright")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void doExport("json")}>
              {t("record.exportJson")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void doExport("agent")}>
              {t("record.exportAgent")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void doDownload("playwright")}>
              {t("record.downloadPlaywright")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void doDownload("json")}>
              {t("record.downloadJson")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * Record → review → replay/export, over the in-app preview. See ADR-0072.
 *
 * Three states, derived rather than stored: recording (a take is live),
 * reviewing (a finished flow is in hand), idle.
 */
export function BrowserRecorderPanel({
  pageUrl,
  onSendToChat,
  now = Date.now,
  onLayoutChange,
  recorder: providedRecorder,
  chrome = true,
}: BrowserRecorderPanelProps) {
  const t = useTranslations("browser")
  const stepLabel = useStepLabel()
  const embeddedRecorder = useFlowRecorder()
  const recorder = providedRecorder ?? embeddedRecorder
  const [flow, setFlow] = useState<RecordedFlow | null>(null)
  const [name, setName] = useState("")
  const [assertion, setAssertion] = useState("")
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  // Chrome-less means the dock decides what is visible, so the body is always
  // rendered; standalone keeps its own toggle.
  const [ownExpanded, setOwnExpanded] = useState(true)
  const expanded = chrome ? ownExpanded : true
  const previousExpandedRef = useRef(expanded)
  useLayoutEffect(() => {
    if (previousExpandedRef.current === expanded) return
    previousExpandedRef.current = expanded
    onLayoutChange?.()
  }, [expanded, onLayoutChange])
  /**
   * The flows saved for the loaded origin. `useLiveQuery` re-runs this whenever
   * `browserRecordings` is written, so saving, renaming and deleting all land in
   * the list without anyone re-reading by hand — including writes from another
   * surface. `getDb()` is client-only, and the hook defers the read to the
   * client for us.
   */
  const savedRows =
    useLiveQuery(
      () => (pageUrl ? listRecordingsForBase(pageUrl) : Promise.resolve([])),
      [pageUrl],
      []
    ) ?? []

  const start = useCallback(async () => {
    if (!pageUrl) return
    // Standalone, arming a take reveals the step list. Inside the dock the
    // surrounding strip owns visibility, so this is a no-op there.
    setOwnExpanded(true)
    setFlow(null)
    await recorder.start(pageUrl)
  }, [pageUrl, recorder])

  /** Load a saved flow into the same state `stop()` fills, so it can replay. */
  const select = useCallback((row: BrowserRecordingRow) => {
    setFlow(row)
    setName(row.name)
    // A different flow needs its own secrets; carrying them over would silently
    // feed one flow's password to another.
    setSecrets({})
  }, [])

  const rename = useCallback(
    async (id: string, next: string) => {
      if (await renameRecording(id, next, now())) toast.success(t("record.renamed"))
    },
    [now, t]
  )

  const remove = useCallback(
    async (id: string) => {
      await deleteRecording(id)
      toast.success(t("record.deleted"))
    },
    [t]
  )

  const stop = useCallback(async () => {
    const finished = await recorder.stop()
    if (finished) {
      setFlow(finished)
      setName(finished.name)
    }
  }, [recorder])

  const addAssertion = useCallback(() => {
    const text = assertion.trim()
    if (!text) return
    recorder.addAssertion(text)
    setAssertion("")
  }, [assertion, recorder])

  const steps = flow?.steps ?? recorder.steps

  const header = (
    <header className="flex items-center gap-2">
      {chrome && <h2 className="text-sm font-medium">{t("record.title")}</h2>}
      {chrome && recorder.recording && (
        <Badge variant="destructive" className="gap-1">
          <Circle className="size-2 fill-current" aria-hidden />
          {t("record.recording", { count: recorder.steps.length })}
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1">
        {chrome && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={expanded ? t("record.collapse") : t("record.expand")}
            aria-expanded={expanded}
            onClick={() => setOwnExpanded((value) => !value)}
          >
            {expanded ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
          </Button>
        )}
        {recorder.recording ? (
          <Button size="sm" variant="secondary" onClick={() => void stop()}>
            <Square aria-hidden />
            {t("record.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void start()}
            disabled={!pageUrl}
            title={pageUrl ? undefined : t("record.startHint")}
          >
            <Circle aria-hidden />
            {t("record.start")}
          </Button>
        )}
      </div>
    </header>
  )

  const body = (
    <>
      {steps.length === 0 ? (
        <p className="text-muted-foreground py-4 text-center text-xs">{t("record.empty")}</p>
      ) : (
        <ScrollArea className="max-h-48">
          <ol className="flex flex-col gap-1">
            {steps.map((step, index) => (
              <li
                key={`${step.act}-${index}-${step.at}`}
                className="flex items-center gap-2 text-xs"
              >
                <span className="text-muted-foreground w-4 shrink-0 text-right">{index + 1}</span>
                <span className="truncate">{stepLabel(step)}</span>
                {recorder.recording && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto size-6 shrink-0"
                    aria-label={t("record.removeStep")}
                    onClick={() => recorder.removeStep(index)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ol>
        </ScrollArea>
      )}

      {recorder.recording && (
        <div className="flex items-center gap-1">
          <Input
            value={assertion}
            onChange={(e) => setAssertion(e.target.value)}
            placeholder={t("record.assertionPlaceholder")}
            aria-label={t("record.addAssertion")}
            className="h-8 text-xs"
          />
          <Button size="sm" variant="ghost" onClick={addAssertion} disabled={!assertion.trim()}>
            <Plus aria-hidden />
            {t("record.addAssertion")}
          </Button>
        </div>
      )}

      {flow && (
        <FlowReview
          flow={flow}
          recorder={recorder}
          name={name}
          setName={setName}
          secrets={secrets}
          setSecrets={setSecrets}
          onSendToChat={onSendToChat}
        />
      )}

      {/* Hidden while a take is live: mid-recording, loading another flow would
          throw away the take in progress. */}
      {!recorder.recording && savedRows.length > 0 && (
        <SavedFlows rows={savedRows} onSelect={select} onRename={rename} onDelete={remove} />
      )}
    </>
  )

  if (!chrome) {
    return (
      <div className="flex flex-col gap-2" data-testid="browser-recorder-panel">
        {header}
        {body}
      </div>
    )
  }

  return (
    <section
      className="flex flex-col gap-2 border-t p-3"
      aria-label={t("record.title")}
      data-testid="browser-recorder-panel"
    >
      {header}
      {expanded && body}
    </section>
  )
}
