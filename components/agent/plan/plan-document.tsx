"use client"

/**
 * Document-first plan surface — the production counterpart of the
 * `e-docnav` prototype direction (prototype/plan-preview/). An
 * `exit_plan_mode` plan renders its full markdown body (`metadata.planText`)
 * through `MarkdownRenderer`; the executable step list is embedded in place of
 * the document's steps list so editing a step literally edits the document —
 * the same "the plan file is the interface" model Cursor/Windsurf use.
 *
 * Two modes, one component:
 *  - `editable` (awaiting approval): numbered rows edit inline and autosave
 *    (debounced) via `onEdit`; the steps block is rewritten in the source
 *    markdown so `steps[]` and the doc can never drift.
 *  - read-only (executing / terminal / historical): rows carry the real
 *    `PlanStep.status` icon + kind chip; an activity trail of `PlanEvent`s can
 *    be appended at the bottom for history views.
 *
 * Long documents get a sticky single-row TOC strip (h1–h3) with click-to-jump
 * anchors and scroll-spy — conventional markdown-reader navigation, no extra
 * chrome.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react"
import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  listItemTitle,
  planDocHeadingId,
  rebuildPlanText,
  splitPlanDocument,
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

/** The contiguous run of `section` titles inside the projection — the window
 *  the embedded editor owns. Items are projected in document order, so the
 *  steps section is always one contiguous slice of `plan.steps`. */
function findSectionWindow(
  section: string[] | null,
  titles: string[]
): { start: number; end: number } {
  if (!section?.length) return { start: 0, end: titles.length }
  for (let i = 0; i + section.length <= titles.length; i++) {
    if (section.every((s, k) => s === titles[i + k])) {
      return { start: i, end: i + section.length }
    }
  }
  // Projection and document drifted (e.g. a refinement touched one side) —
  // anchor at the top and show at most the section's row count.
  return { start: 0, end: Math.min(section.length, titles.length) }
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
  const split = useMemo(
    () => (isMarkdownPlan ? splitPlanDocument(planText) : null),
    [planText, isMarkdownPlan]
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
  // the derived `sectionRange`); cleared whenever the plan resyncs.
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // The executable projection (`parsePlanText`) collects EVERY list item in
  // the document — a "## Files" checklist's bullets are steps too. The
  // embedded editor must own only the items inside the document's steps
  // section (a contiguous run in the projection, since items are projected in
  // document order); editing that slice and rebuilding just the section keeps
  // the doc and the projection one source of truth without duplicating other
  // lists into the steps section.
  const sectionTitles = useMemo(
    () => (split?.steps?.length ? split.steps.map(listItemTitle) : null),
    [split]
  )
  const sectionRange = findSectionWindow(sectionTitles, originalTitles)

  const viewRange = range ?? sectionRange

  const emitPatch = useCallback(
    (nextTitle: string, nextTitles: string[]) => {
      if (!onEdit) return
      const trimmedTitle = nextTitle.trim() || plan.title
      // A freshly added empty row is a placeholder for typing, not a step —
      // it must not persist into the draft.
      const trimmedAll = nextTitles.map((s) => s.trim())
      const clean = trimmedAll.filter(Boolean)
      if (isMarkdownPlan) {
        // Compare against the document's own section titles — the projection
        // slice can shift when rows are added/removed inside the window.
        const origSection = split?.steps ? split.steps.map((l) => listItemTitle(l)) : originalTitles
        const sectionClean = trimmedAll.slice(viewRange.start, viewRange.end).filter(Boolean)
        const sectionChanged =
          sectionClean.length !== origSection.length ||
          sectionClean.some((s, i) => s !== origSection[i])
        if (sectionChanged) {
          // Rewrite only the steps section inside the markdown body — other
          // lists elsewhere in the document are prose, not steps. For a doc
          // with no steps section the heading is appended in the UI locale.
          return onEdit({
            title: trimmedTitle,
            planText: rebuildPlanText(planText, sectionClean, `## ${t("document.stepsHeading")}`),
          })
        }
      }
      return onEdit({ title: trimmedTitle, stepTitles: clean })
    },
    [onEdit, plan.title, originalTitles, viewRange, isMarkdownPlan, planText, split, t]
  )

  const markEdited = useCallback(
    (nextTitle: string, nextTitles: string[]) => {
      if (!canEdit) return
      setDirty(true)
      setSaveState("edited")
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      saveTimer.current = setTimeout(() => {
        setSaveState("saving")
        void Promise.resolve(emitPatch(nextTitle, nextTitles))
          .then(() => {
            setSaveState("saved")
            setDirty(false)
            fadeTimer.current = setTimeout(() => setSaveState("idle"), SAVED_FADE_MS)
          })
          .catch(() => {
            // Keep `dirty` so the next keystroke reschedules a save; surface
            // the failure instead of a false "saved".
            setSaveState("error")
          })
      }, AUTOSAVE_MS)
    },
    [canEdit, emitPatch]
  )

  // Cancel pending autosave/fade timers on unmount.
  useLayoutEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
    },
    []
  )

  const changeTitle = (v: string) => {
    setTitle(v)
    markEdited(v, titles)
  }
  const changeStep = (i: number, v: string) => {
    const next = titles.slice()
    next[i] = v
    setTitles(next)
    markEdited(title, next)
  }
  // `i` is a global index into `titles`; moves stay inside the section window
  // so a steps-section row can never swap with an item from another list.
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < viewRange.start || j >= viewRange.end) return
    const next = titles.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setTitles(next)
    markEdited(title, next)
  }
  const removeStep = (i: number) => {
    const next = titles.filter((_, k) => k !== i)
    setTitles(next)
    setRange({ start: viewRange.start, end: viewRange.end - 1 })
    markEdited(title, next)
  }
  const addStep = () => {
    // Insert at the section's end so the new row lands inside the steps
    // section — appending to `titles` would put it past the window.
    const next = [...titles.slice(0, viewRange.end), "", ...titles.slice(viewRange.end)]
    setTitles(next)
    setRange({ start: viewRange.start, end: viewRange.end + 1 })
    markEdited(title, next)
  }

  // ── TOC + scroll-spy ──────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement | null>(null)
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

  // Map the heading outline onto the DOM the MarkdownRenderer produced —
  // index-aligned, ids assigned so chips can jump to them.
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const els = Array.from(root.querySelectorAll("h1,h2,h3")) as HTMLElement[]
    headingEls.current = els
    els.forEach((el, i) => {
      if (!el.id) el.id = planDocHeadingId(i)
      el.style.scrollMarginTop = `${(tocRef.current?.offsetHeight ?? 0) + 10}px`
    })
  }, [split, titles, canEdit])

  const updateSpy = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    const threshold = (tocRef.current?.offsetHeight ?? 0) + 22
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
    if (!el) return
    const root = scrollRef.current
    if (!root) return
    root.scrollTo({
      top: el.offsetTop - (tocRef.current?.offsetHeight ?? 0) - 10,
      behavior: "smooth",
    })
  }

  const readOnly = !canEdit
  const sortedSteps = useMemo(() => [...plan.steps].sort((a, b) => a.order - b.order), [plan])

  const rowSource = canEdit ? titles : sortedSteps.map((s) => s.title)
  const stepsBlock = (
    <ol className="my-2 space-y-0.5" data-testid="plan-doc-steps">
      {rowSource.slice(viewRange.start, viewRange.end).map((stepTitle, vi) => {
        const i = viewRange.start + vi // global index into titles/steps
        const step = sortedSteps[i]
        return (
          <li
            // Index key, not step.id — an autosave that re-materializes steps
            // gives fresh ids; id keys would remount every row and drop focus
            // from the input the user is typing into.
            key={i}
            className="group flex items-start gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50"
          >
            <span className="mt-0.5 w-6 shrink-0 select-none text-right font-mono text-xs text-muted-foreground tabular-nums">
              {readOnly && step
                ? stepStatusIcon(step.status)
                : `${String(vi + 1).padStart(2, "0")}.`}
            </span>
            {canEdit ? (
              <input
                value={titles[i] ?? ""}
                onChange={(e) => changeStep(i, e.target.value)}
                placeholder={t("document.stepPlaceholder")}
                aria-label={t("document.stepN", { index: vi + 1 })}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                data-testid={`plan-doc-step-${vi}`}
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 break-words",
                  step?.status === "completed" && "text-muted-foreground line-through"
                )}
              >
                {stepTitle}
              </span>
            )}
            {step && step.kind !== "agent_turn" && (
              <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px]">
                {KIND_LABELS[step.kind] ? t(KIND_LABELS[step.kind]) : step.kind}
              </Badge>
            )}
            {canEdit && (
              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-5"
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
                  className="size-5"
                  onClick={() => moveStep(i, 1)}
                  disabled={vi === viewRange.end - viewRange.start - 1}
                  aria-label={t("document.moveDown")}
                  data-testid={`plan-doc-down-${vi}`}
                >
                  <ArrowDownIcon className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-5"
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
            onClick={addStep}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            data-testid="plan-doc-add"
          >
            <PlusIcon className="size-3" />
            {t("document.addStep")}
          </button>
        </li>
      )}
      {!canEdit && viewRange.end - viewRange.start === 0 && (
        <li className="px-1 text-xs italic text-muted-foreground">{t("document.empty")}</li>
      )}
    </ol>
  )

  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      data-testid="plan-document"
    >
      {canEdit && saveState !== "idle" && (
        <span
          className="pointer-events-none absolute right-2 top-1.5 z-10 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
          data-testid="plan-doc-save-state"
        >
          {t(`document.save.${saveState}`)}
        </span>
      )}
      <div
        ref={scrollRef}
        onScroll={updateSpy}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-testid="plan-doc-scroll"
      >
        {headings.length > 1 && (
          <nav
            ref={tocRef}
            className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-border/60 bg-background/90 px-1 py-1 backdrop-blur-sm [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label={t("document.toc")}
            data-testid="plan-doc-toc"
          >
            {headings.map((h, i) => (
              <button
                key={i}
                type="button"
                onClick={() => jumpTo(i)}
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  i === activeHeading && "bg-muted text-foreground"
                )}
                data-testid={`plan-doc-toc-${i}`}
              >
                {h.text}
              </button>
            ))}
          </nav>
        )}

        {showTitle && (
          <input
            value={title}
            onChange={(e) => changeTitle(e.target.value)}
            readOnly={!canEdit}
            aria-label={t("document.titleLabel")}
            className="mb-1 w-full bg-transparent text-base font-semibold outline-none"
            data-testid="plan-doc-title"
          />
        )}

        {isMarkdownPlan && split ? (
          <div className="text-sm [&>*:first-child]:mt-0">
            {split.before.trim() && <MarkdownRenderer content={split.before} />}
            {split.steps !== null && stepsBlock}
            {split.after.trim() && <MarkdownRenderer content={split.after} />}
            {split.steps === null && (
              /* A markdown plan without a steps heading still carries the
                 executable projection — render it as a trailing section so it
                 stays visible (and editable) rather than hidden. Rendered last
                 so the appended heading stays index-aligned with the TOC. */
              <>
                <h2 className="mb-1 mt-4 text-sm font-semibold">{t("document.stepsHeading")}</h2>
                {stepsBlock}
              </>
            )}
          </div>
        ) : (
          <div className="text-sm">
            <h2 className="mb-1 text-sm font-semibold">{t("document.stepsHeading")}</h2>
            {stepsBlock}
          </div>
        )}

        {events && events.length > 0 && (
          <section className="mt-4 border-t border-border/60 pt-2" data-testid="plan-doc-events">
            <h2 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
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
                        : ev.kind === "rejected" ||
                            ev.kind === "step_failed" ||
                            ev.kind === "cancelled"
                          ? "bg-rose-600"
                          : "bg-muted-foreground/50"
                    )}
                  />
                  <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
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
  )
}
