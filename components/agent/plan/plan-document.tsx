"use client"

/**
 * Document-first plan surface. An `exit_plan_mode` plan renders its full
 * markdown body (`metadata.planText`) through `MarkdownRenderer`; the
 * executable step list is embedded in place of the document's steps list, so
 * editing a step literally edits the document — the same "the plan file is the
 * interface" model Cursor/Windsurf use.
 *
 * Two modes, one component:
 *  - `editable` (awaiting approval): rows edit inline and autosave (debounced)
 *    via `onEdit`, rewriting the steps block of the source markdown so
 *    `steps[]` and the doc can never drift. Enter adds a step below,
 *    Backspace on an empty row removes it, Alt+↑/↓ moves it. A pending save
 *    is flushed the moment focus leaves the document (and on unmount), so a
 *    decision clicked right after typing acts on the edited plan.
 *  - read-only (executing / terminal / historical): rows carry the real
 *    `PlanStep.status` icon + kind chip once the plan has started; an activity
 *    trail of `PlanEvent`s can be appended for history views.
 *
 * A leading `# H1` that restates the plan title is not printed again — every
 * host already shows the title — and renaming the plan rewrites that heading.
 * Multi-section documents get a sticky outline strip (h1–h3) with
 * click-to-jump anchors and scroll-spy; the autosave state sits at its end.
 *
 * The document paints no background of its own: the sticky strip inherits the
 * host's (`bg-inherit` down the chain), so hosts set one on `className`.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { FocusEvent, KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { HOVER_REVEAL_GROUP_CLASS } from "@/lib/ui/hover-reveal"
import { cn } from "@/lib/utils"
import {
  listItemTitle,
  planDocHeadingId,
  planDocTitle,
  rebuildPlanText,
  retitlePlanText,
  splitPlanDocument,
  stepsSectionWindow,
  withoutRestatedTitle,
} from "@/lib/agent/plan/plan-doc"
import { stepStatusIcon } from "./step-status-icon"
import type { AgentPlan, PlanEditPatch, PlanEvent } from "@/types/agent/plan"

const AUTOSAVE_MS = 700
const SAVED_FADE_MS = 1600
const KIND_LABELS: Record<string, string> = {
  agent_turn: "composer.kind.agent_turn",
  teammate_dispatch: "composer.kind.teammate_dispatch",
  tool_call: "composer.kind.tool_call",
  mcp_tool_call: "composer.kind.mcp_tool_call",
  sub_workflow: "composer.kind.sub_workflow",
  approval_gate: "composer.kind.approval_gate",
  editor_review: "composer.kind.editor_review",
}

type SaveState = "idle" | "edited" | "saving" | "saved" | "error"
type RowWindow = { start: number; end: number }

export interface PlanDocumentProps {
  plan: AgentPlan
  /** Inline editing of title + step rows (autosaved through `onEdit`). */
  editable?: boolean
  onEdit?: (patch: PlanEditPatch) => void | Promise<void>
  /** Render the editable/static title row above the document. Hosts that
   *  already show `plan.title` (the approval card) leave this off. */
  showTitle?: boolean
  /** Lifecycle events appended as a read-only trail (history views). */
  events?: PlanEvent[]
  className?: string
}

function stepTitlesOf(plan: AgentPlan): string[] {
  return [...plan.steps].sort((a, b) => a.order - b.order).map((s) => s.title)
}

/** Outline chips show heading text, not its inline markdown markers. */
function plainHeading(text: string): string {
  return text.replace(/[*_`]/g, "")
}

export function PlanDocument({
  plan,
  editable,
  onEdit,
  showTitle,
  events,
  className,
}: PlanDocumentProps) {
  const t = useTranslations("plan")
  const planMeta = plan.metadata as { planText?: unknown } | undefined
  const planText = typeof planMeta?.planText === "string" ? planMeta.planText.trim() : ""
  const isMarkdownPlan = planText.length > 0
  // What is printed: the body minus a leading H1 that restates the title. Edits
  // keep rewriting the full `planText`; only the steps list (identical in both)
  // is located through this copy.
  const split = useMemo(
    () => (isMarkdownPlan ? splitPlanDocument(withoutRestatedTitle(planText, plan.title)) : null),
    [planText, isMarkdownPlan, plan.title]
  )

  // Local editing state, resynced when a different plan arrives or when the
  // plan updates while clean. While dirty we keep the local copy — the user's
  // in-flight keystrokes must not be clobbered by our own autosave echo.
  const [title, setTitle] = useState(plan.title)
  const [titles, setTitles] = useState(() => stepTitlesOf(plan))
  const [dirty, setDirty] = useState(false)
  const [seen, setSeen] = useState({ id: plan.id, at: plan.updatedAt })
  const [saveState, setSaveState] = useState<SaveState>("idle")
  // `range` tracks user additions/removals inside the section window (null =
  // the derived section window); cleared whenever the plan resyncs.
  const [range, setRange] = useState<RowWindow | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The edit a pending autosave will write — carried with the row window it
  // was made against, so a save never slices with a window from another render.
  const pending = useRef<{ title: string; titles: string[]; win: RowWindow } | null>(null)

  if (plan.id !== seen.id || (plan.updatedAt !== seen.at && !dirty)) {
    setSeen({ id: plan.id, at: plan.updatedAt })
    setTitle(plan.title)
    setTitles(stepTitlesOf(plan))
    setDirty(false)
    setSaveState("idle")
    setRange(null)
  }

  const canEdit = Boolean(editable && onEdit && plan.status === "awaiting_approval")
  const originalTitles = useMemo(() => stepTitlesOf(plan), [plan])

  // The executable projection collects EVERY list item in the document — a
  // "## Files" checklist's bullets are steps too. The embedded editor owns only
  // the items inside the document's steps section (a contiguous run of the
  // projection); editing that slice and rebuilding just the section keeps the
  // doc and the projection one source of truth.
  const sectionTitles = useMemo(
    () => (split?.steps?.length ? split.steps.map(listItemTitle) : null),
    [split]
  )
  const viewRange = range ?? stepsSectionWindow(sectionTitles, originalTitles)
  const rowCount = viewRange.end - viewRange.start

  const emitPatch = useCallback(
    (nextTitle: string, nextTitles: string[], win: RowWindow) => {
      if (!onEdit) return
      const trimmedTitle = nextTitle.trim() || plan.title
      // A freshly added empty row is a placeholder for typing, not a step —
      // it must not persist into the draft.
      const trimmedAll = nextTitles.map((s) => s.trim())
      const clean = trimmedAll.filter(Boolean)
      if (isMarkdownPlan) {
        const origSection = sectionTitles ?? originalTitles
        const sectionClean = trimmedAll.slice(win.start, win.end).filter(Boolean)
        const sectionChanged =
          sectionClean.length !== origSection.length ||
          sectionClean.some((s, i) => s !== origSection[i])
        // A rename follows into the document's own `# H1` when that heading
        // was the plan's name, so the two cannot disagree.
        const retitled = trimmedTitle !== plan.title && planDocTitle(planText) === plan.title.trim()
        if (sectionChanged || retitled) {
          // Rewrite only the steps section inside the markdown body — other
          // lists elsewhere in the document are prose, not steps. For a doc
          // with no steps section the heading is appended in the UI locale.
          let text = planText
          if (sectionChanged) {
            text = rebuildPlanText(text, sectionClean, `## ${t("document.stepsHeading")}`)
          }
          if (retitled) text = retitlePlanText(text, trimmedTitle)
          return onEdit({ title: trimmedTitle, planText: text })
        }
      }
      return onEdit({ title: trimmedTitle, stepTitles: clean })
    },
    [onEdit, plan.title, originalTitles, sectionTitles, isMarkdownPlan, planText, t]
  )

  // The timer fires after later renders; it must write with the props of the
  // render it fires in, not the one that scheduled it.
  const emitRef = useRef(emitPatch)
  useLayoutEffect(() => {
    emitRef.current = emitPatch
  }, [emitPatch])

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const next = pending.current
    if (!next) return
    pending.current = null
    setSaveState("saving")
    void Promise.resolve(emitRef.current(next.title, next.titles, next.win))
      .then(() => {
        setSaveState("saved")
        setDirty(false)
        fadeTimer.current = setTimeout(() => setSaveState("idle"), SAVED_FADE_MS)
      })
      .catch(() => {
        // Keep `dirty` so the next keystroke reschedules a save; surface the
        // failure instead of a false "saved".
        setSaveState("error")
      })
  }, [])

  const markEdited = (nextTitle: string, nextTitles: string[], win: RowWindow) => {
    if (!canEdit) return
    setDirty(true)
    setSaveState("edited")
    pending.current = { title: nextTitle, titles: nextTitles, win }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (fadeTimer.current) clearTimeout(fadeTimer.current)
    saveTimer.current = setTimeout(flushSave, AUTOSAVE_MS)
  }

  // Leaving a plan — unmount, or the host switching to another plan (the panel's
  // history) — writes its pending edit instead of dropping it. Layout-effect
  // cleanups run before any layout setup in the same commit, so `emitRef`
  // still targets the plan being left: the edit can never land on the next one.
  useLayoutEffect(
    () => () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      flushSave()
    },
    [plan.id, flushSave]
  )

  const rootRef = useRef<HTMLDivElement | null>(null)
  // Focus leaving the document (typically to an approve button) writes the
  // pending edit right away; moving between rows does not.
  const onRootBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && rootRef.current?.contains(e.relatedTarget)) return
    flushSave()
  }

  // ── Row editing ───────────────────────────────────────────────────────
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const focusRequest = useRef<number | null>(null)
  useLayoutEffect(() => {
    const vi = focusRequest.current
    if (vi === null) return
    focusRequest.current = null
    const el = inputRefs.current[vi]
    if (!el) return
    el.focus()
    // Caret at the end, where Backspace-merging into the previous row expects it.
    el.setSelectionRange(el.value.length, el.value.length)
  }, [titles])

  const changeTitle = (v: string) => {
    setTitle(v)
    markEdited(v, titles, viewRange)
  }
  const changeStep = (i: number, v: string) => {
    const next = titles.slice()
    next[i] = v
    setTitles(next)
    markEdited(title, next, viewRange)
  }
  // `i` is a global index into `titles`; moves stay inside the section window
  // so a steps-section row can never swap with an item from another list.
  const moveStep = (i: number, dir: -1 | 1): boolean => {
    const j = i + dir
    if (j < viewRange.start || j >= viewRange.end) return false
    const next = titles.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setTitles(next)
    markEdited(title, next, viewRange)
    return true
  }
  const removeStep = (i: number) => {
    const next = titles.filter((_, k) => k !== i)
    const win = { start: viewRange.start, end: viewRange.end - 1 }
    setTitles(next)
    setRange(win)
    markEdited(title, next, win)
  }
  /** Insert an empty row at global index `at` and focus it. */
  const insertStep = (at: number) => {
    const next = [...titles.slice(0, at), "", ...titles.slice(at)]
    const win = { start: viewRange.start, end: viewRange.end + 1 }
    setTitles(next)
    setRange(win)
    focusRequest.current = at - viewRange.start
    markEdited(title, next, win)
  }
  const onStepKeyDown = (e: KeyboardEvent<HTMLInputElement>, i: number, vi: number) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "Enter") {
      e.preventDefault()
      insertStep(i + 1)
      return
    }
    if (e.key === "Backspace" && !titles[i] && rowCount > 1) {
      e.preventDefault()
      focusRequest.current = Math.max(0, vi - 1)
      removeStep(i)
      return
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault()
      const dir = e.key === "ArrowUp" ? -1 : 1
      if (moveStep(i, dir)) focusRequest.current = vi + dir
    }
  }

  // ── TOC + scroll-spy ──────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const tocRef = useRef<HTMLElement | null>(null)
  const headingEls = useRef<HTMLElement[]>([])
  const [activeHeading, setActiveHeading] = useState(0)
  // When a markdown plan has no steps heading, the executable list is appended
  // as a trailing section — that heading is part of the outline (and last in
  // DOM order), so TOC chips and DOM headings stay index-aligned.
  const headings = useMemo(() => {
    const base = split?.headings ?? []
    if (split && split.steps === null) {
      return [...base, { line: -1, level: 2, text: t("document.stepsHeading") }]
    }
    return base
  }, [split, t])
  const hasToc = headings.length > 1

  // Map the heading outline onto the DOM the MarkdownRenderer produced —
  // index-aligned, ids assigned so chips can jump to them. Scoped to the body
  // so the activity trail's own heading never joins the outline.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const els = Array.from(body.querySelectorAll("h1,h2,h3")) as HTMLElement[]
    headingEls.current = els
    const offset = (barRef.current?.offsetHeight ?? 0) + 8
    els.forEach((el, i) => {
      if (!el.id) el.id = planDocHeadingId(i)
      el.style.scrollMarginTop = `${offset}px`
    })
  }, [split, titles, canEdit])

  const updateSpy = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    const threshold = (barRef.current?.offsetHeight ?? 0) + 22
    const els = headingEls.current
    let active = 0
    for (let i = 0; i < els.length; i++) {
      if (els[i].getBoundingClientRect().top - root.getBoundingClientRect().top <= threshold)
        active = i
    }
    // Pinned to the last heading when the document is scrolled to the bottom —
    // the final section can never reach the threshold line.
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4 && els.length) {
      active = els.length - 1
    }
    setActiveHeading(active)
    const chip = tocRef.current?.children[active] as HTMLElement | undefined
    if (chip && tocRef.current) {
      const toc = tocRef.current
      if (
        chip.offsetLeft < toc.scrollLeft ||
        chip.offsetLeft + chip.offsetWidth > toc.scrollLeft + toc.clientWidth
      ) {
        toc.scrollLeft = chip.offsetLeft - 8
      }
    }
  }, [])

  const jumpTo = (i: number) => {
    const el = headingEls.current[i]
    const root = scrollRef.current
    if (!el || !root) return
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    root.scrollTo({
      top: el.offsetTop - (barRef.current?.offsetHeight ?? 0) - 8,
      behavior: reduce ? "auto" : "smooth",
    })
  }

  const sortedSteps = useMemo(() => [...plan.steps].sort((a, b) => a.order - b.order), [plan])
  // A plan that has not started reads as a numbered list; once any step moved
  // its row shows the real status instead.
  const started = sortedSteps.some((s) => s.status !== "pending" && s.status !== "ready")

  const rowSource = canEdit ? titles : sortedSteps.map((s) => s.title)
  const stepsBlock = (
    <ol className="my-3 space-y-px" data-testid="plan-doc-steps">
      {rowSource.slice(viewRange.start, viewRange.end).map((stepTitle, vi) => {
        const i = viewRange.start + vi // global index into titles/steps
        const step = sortedSteps[i]
        return (
          <li
            // Index key, not step.id — an autosave that re-materializes steps
            // gives fresh ids; id keys would remount every row and drop focus
            // from the input the user is typing into.
            key={i}
            className={cn(
              "group flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors",
              canEdit ? "hover:bg-muted/60 focus-within:bg-muted/60" : "hover:bg-muted/40"
            )}
            data-status={canEdit ? undefined : step?.status}
          >
            <span className="flex w-5 shrink-0 select-none justify-end font-mono text-[11px] text-muted-foreground tabular-nums">
              {!canEdit && started && step ? stepStatusIcon(step.status) : `${vi + 1}.`}
            </span>
            {canEdit ? (
              <input
                ref={(el) => {
                  inputRefs.current[vi] = el
                }}
                value={titles[i] ?? ""}
                onChange={(e) => changeStep(i, e.target.value)}
                onKeyDown={(e) => onStepKeyDown(e, i, vi)}
                placeholder={t("document.stepPlaceholder")}
                aria-label={t("document.stepN", { index: vi + 1 })}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                data-testid={`plan-doc-step-${vi}`}
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  step?.status === "completed" && "text-muted-foreground line-through",
                  step?.status === "in_progress" && "font-medium",
                  step?.status === "skipped" && "text-muted-foreground"
                )}
              >
                {stepTitle}
              </span>
            )}
            {step && step.kind !== "agent_turn" && (
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                {KIND_LABELS[step.kind] ? t(KIND_LABELS[step.kind]) : step.kind}
              </Badge>
            )}
            {canEdit && (
              <span className={cn("flex shrink-0 items-center", HOVER_REVEAL_GROUP_CLASS)}>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground pointer-coarse:size-8"
                  onClick={() => moveStep(i, -1)}
                  disabled={vi === 0}
                  aria-label={t("document.moveUp")}
                  data-testid={`plan-doc-up-${vi}`}
                >
                  <ArrowUpIcon className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground pointer-coarse:size-8"
                  onClick={() => moveStep(i, 1)}
                  disabled={vi === rowCount - 1}
                  aria-label={t("document.moveDown")}
                  data-testid={`plan-doc-down-${vi}`}
                >
                  <ArrowDownIcon className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-muted-foreground hover:text-destructive pointer-coarse:size-8"
                  onClick={() => removeStep(i)}
                  aria-label={t("document.deleteStep")}
                  data-testid={`plan-doc-del-${vi}`}
                >
                  <XIcon className="size-3" />
                </Button>
              </span>
            )}
          </li>
        )
      })}
      {canEdit && (
        <li>
          <button
            type="button"
            onClick={() => insertStep(viewRange.end)}
            title={t("document.addStepHint")}
            className="ml-7 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            data-testid="plan-doc-add"
          >
            <PlusIcon className="size-3" />
            {t("document.addStep")}
          </button>
        </li>
      )}
      {!canEdit && rowCount === 0 && (
        <li className="px-1.5 text-xs italic text-muted-foreground">{t("document.empty")}</li>
      )}
    </ol>
  )

  const saveIndicator = canEdit ? (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground",
        saveState === "error" && "text-destructive",
        // Without an outline strip it floats in the body's top corner.
        !hasToc && "pointer-events-none absolute right-2 top-2 z-10"
      )}
      data-testid="plan-doc-save-state"
    >
      {saveState !== "idle" && (
        <span className="inline-flex items-center gap-1 animate-in fade-in-0 duration-200">
          {saveState === "edited" && <span className="size-1.5 rounded-full bg-amber-500" />}
          {saveState === "saving" && <Loader2Icon className="size-3 motion-safe:animate-spin" />}
          {saveState === "saved" && <CheckIcon className="size-3" />}
          {saveState === "error" && <AlertCircleIcon className="size-3" />}
          {t(`document.save.${saveState}`)}
        </span>
      )}
    </span>
  ) : null

  return (
    <div
      ref={rootRef}
      onBlur={onRootBlur}
      className={cn("relative flex min-h-0 flex-1 flex-col bg-inherit", className)}
      data-testid="plan-document"
    >
      <div
        ref={scrollRef}
        onScroll={updateSpy}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-inherit"
        data-testid="plan-doc-scroll"
      >
        {/* The title heads the document; the outline strip below it is what
            sticks once the reader scrolls past. */}
        {showTitle && (
          <input
            value={title}
            onChange={(e) => changeTitle(e.target.value)}
            readOnly={!canEdit}
            aria-label={t("document.titleLabel")}
            className="w-full bg-transparent px-3 pt-1 pb-1.5 text-base font-semibold outline-none"
            data-testid="plan-doc-title"
          />
        )}
        {hasToc ? (
          <div
            ref={barRef}
            className="sticky top-0 z-10 flex items-center gap-2 border-b border-border/60 bg-inherit px-2 py-1.5"
          >
            <nav
              ref={tocRef}
              className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              aria-label={t("document.toc")}
              data-testid="plan-doc-toc"
            >
              {headings.map((h, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => jumpTo(i)}
                  aria-current={i === activeHeading ? "location" : undefined}
                  className={cn(
                    "max-w-56 shrink-0 truncate rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                    i === activeHeading && "bg-muted font-medium text-foreground"
                  )}
                  data-testid={`plan-doc-toc-${i}`}
                >
                  {plainHeading(h.text)}
                </button>
              ))}
            </nav>
            {saveIndicator}
          </div>
        ) : (
          saveIndicator
        )}

        <div className="px-3 pb-3 pt-2">
          <div ref={bodyRef} className="text-sm [&>*:first-child]:mt-0">
            {isMarkdownPlan && split ? (
              <>
                {split.before.trim() && <MarkdownRenderer content={split.before} />}
                {split.steps !== null && stepsBlock}
                {split.after.trim() && <MarkdownRenderer content={split.after} />}
                {split.steps === null && (
                  /* A markdown plan without a steps heading still carries the
                     executable projection — render it as a trailing section so
                     it stays visible (and editable) rather than hidden. Last in
                     DOM order so the appended heading stays index-aligned with
                     the outline. Sized like the typeset h2 around it. */
                  <>
                    <h2 className="mb-2 mt-5 text-[1.25em] font-semibold leading-snug">
                      {t("document.stepsHeading")}
                    </h2>
                    {stepsBlock}
                  </>
                )}
              </>
            ) : (
              stepsBlock
            )}
          </div>

          {events && events.length > 0 && (
            <section className="mt-4 border-t border-border/60 pt-2" data-testid="plan-doc-events">
              <h2 className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                {t("document.activity")}
              </h2>
              <ol className="space-y-1">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-baseline gap-2 text-xs">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 self-center rounded-full",
                        ev.kind === "approved" || ev.kind === "step_completed"
                          ? "bg-green-600"
                          : ev.kind === "step_skipped"
                            ? "bg-amber-500"
                            : ev.kind === "rejected" ||
                                ev.kind === "step_failed" ||
                                ev.kind === "cancelled"
                              ? "bg-rose-600"
                              : "bg-muted-foreground/50"
                      )}
                    />
                    <span className="shrink-0 text-muted-foreground">
                      {t(`document.eventKind.${ev.kind}`)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {"title" in ev.payload
                        ? ev.payload.title
                        : "feedback" in ev.payload
                          ? ev.payload.feedback
                          : "reason" in ev.payload
                            ? ev.payload.reason
                            : ""}
                    </span>
                    <time className="shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
                      {new Date(ev.ts).toLocaleString()}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
