"use client"

// Composer thinking-level ("reasoning effort") control.
//
// It surfaces the per-session tier, persisted by `thinkingLevelPatch` as BOTH
// `ChatSession.effort` (what every existing consumer reads) and
// `ChatSession.thinkingLevel` (the tier identity `effort` can't express — see
// `@/lib/ai/thinking-level`). `resolveSendOptions` consumes them at send time,
// so a change applies from the NEXT turn: there is no live-apply IPC here,
// unlike model switching.
//
// Mounted in exactly one place: `./effort-chip`, the composer toolbar's own
// control. It used to have a second mount at the bottom of the model popover
// (on the argument that depth qualifies a model), which meant the same tier was
// stated three times on one toolbar — chip label, model-chip suffix, and the
// slider one click away. That copy is gone, and with it the `variant` prop that
// existed only to swap this block's chrome between the two.
//
// Two presentations, chosen by `composerBehavior.effortSelectorMode`:
//   - "slider" (default) — a Faster→Smarter track, mirroring the CLI's effort
//     slider (`cli/src/tui/components/EffortSlider.tsx`) including its keyboard
//     map, so muscle memory carries between the two surfaces.
//   - "list" — a vertical menu, one row per tier with its description.
// Both drive the SAME state through the same handler; the mode only chooses how
// it is drawn. Each adapts again to its own measured width (see
// `./effort-selector-view`), so neither depends on a viewport breakpoint.
//
// Self-gates to nothing when there is no session or the active surface can't
// use effort, so it never clutters a composer where it would be a no-op. Which
// tiers that surface offers — including the external-agent rail, whose model
// the renderer never sees — is `./effort-surface`'s decision, not this file's.

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckIcon, CircleHelpIcon } from "lucide-react"

import { updateSession } from "@/lib/db/sessions"
import { useSettingsStore } from "@/stores/settings"
import {
  clampThinkingLevel,
  isUltracodeLevel,
  resolveThinkingLevel,
  thinkingLevelAtIndex,
  thinkingLevelPatch,
  type EffortTier,
  type ThinkingLevel,
} from "@/lib/ai/thinking-level"
import type { ChatSession } from "@cognia/agent-config-types"
import { useElementWidth } from "@/hooks/use-element-width"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useEffortSurface } from "./effort-surface"
import {
  DEFAULT_EFFORT_SELECTOR_MODE,
  effortIndexFromRatio,
  effortKeyAction,
  effortRatioFromPointer,
  effortSelectorLayout,
  effortTrackOffset,
  type EffortSelectorMode,
} from "./effort-selector-view"

interface EffortSelectorProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
  /**
   * Force a presentation instead of reading `composerBehavior.effortSelectorMode`.
   * Only for stories and tests — production always follows the preference.
   */
  mode?: EffortSelectorMode
}

export function EffortSelector({
  session,
  disabled,
  className,
  mode: modeProp,
}: EffortSelectorProps) {
  const t = useTranslations("chat.composer.effort")
  const preferredMode = useSettingsStore((s) => s.settings?.composerBehavior?.effortSelectorMode)
  const surface = useEffortSurface(session)

  const rootRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(rootRef)

  // Optimistic overlay so the control reflects the selection immediately, before
  // the parent re-renders with the updated session prop. `null` = no overlay.
  const [optimistic, setOptimistic] = useState<ThinkingLevel | null>(null)
  // Reset the overlay when the session changes (render-time setState — the same
  // pattern the model picker uses).
  const [prevSessionId, setPrevSessionId] = useState(session?.id)
  if (prevSessionId !== session?.id) {
    setPrevSessionId(session?.id)
    setOptimistic(null)
  }

  // While a track drag is in flight the overlay moves with the pointer but
  // nothing is written; the tier under the pointer is committed on release, so
  // one drag across six tiers is one Dexie write instead of six.
  const pendingRef = useRef<ThinkingLevel | null>(null)
  const [dragging, setDragging] = useState(false)

  const levels = surface.levels
  if (!session?.id) return null
  if (levels.length === 0) return null

  const sessionId = session.id
  // Display the tier the turn will REALLY carry: a level the active surface
  // does not offer folds to the deepest one it does. The session keeps the
  // user's actual choice, which reapplies once a capable model is active again.
  const current = clampThinkingLevel(optimistic ?? resolveThinkingLevel(session), levels)
  const currentIndex = current === "off" ? -1 : levels.indexOf(current)
  const lastIndex = levels.length - 1
  const layout = effortSelectorLayout(width)
  const mode = modeProp ?? preferredMode ?? DEFAULT_EFFORT_SELECTOR_MODE

  const levelLabel = (level: ThinkingLevel) => t(`level.${level}` as "level.off")
  const levelDescription = (level: ThinkingLevel) => t(`desc.${level}` as "desc.off")

  /** Show a tier without writing it (drag in progress). */
  const preview = (level: ThinkingLevel) => {
    pendingRef.current = level
    setOptimistic(level)
  }

  /** Show AND persist a tier. */
  const select = (level: ThinkingLevel) => {
    if (disabled) return
    preview(level)
    // Revert the optimistic overlay if the write doesn't land, so the control
    // never shows a tier the session didn't actually persist.
    void updateSession(sessionId, thinkingLevelPatch(level)).catch(() => setOptimistic(null))
  }

  // The reference framing: a quiet "Effort" caption with the live tier name as
  // the loud half, so the header reads as one phrase ("Effort · Extra") rather
  // than a label and a value in a row.
  const header = (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 text-[13px] leading-none text-muted-foreground">
          {t("title")}
        </span>
        {/* Keyed by tier so React remounts it and the rise re-fires: the value
            is the headline of this control, and a value that changes without
            moving reads as a re-render rather than a new answer. */}
        <span
          key={current}
          data-testid="effort-selector-value"
          className={cn(
            "effort-value-rise truncate text-[13px] font-semibold leading-none tracking-tight transition-colors",
            isUltracodeLevel(current) ? "text-effort-ultra" : "text-foreground"
          )}
        >
          {levelLabel(current)}
        </span>
      </span>
      {/* Own provider rather than relying on the one in `app/layout.tsx`:
          this block renders inside portalled popovers and is also mounted
          directly by tests/stories, and Radix throws outright when a Tooltip
          has no provider above it. Nesting is supported. */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("hintAria")}
              className="shrink-0 rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <CircleHelpIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[16rem] text-xs">
            {surface.external ? t("hintExternal") : t("hint")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )

  return (
    <div
      ref={rootRef}
      // Owns the whole popover surface, so it breathes rather than sitting
      // under a divider the way the popover-footer copy did.
      className={cn("flex flex-col gap-3 px-3.5 py-3", className)}
      data-testid="effort-selector-section"
      data-mode={mode}
      data-layout={layout}
    >
      {header}
      {mode === "slider" ? (
        <EffortTrack
          current={current}
          currentIndex={currentIndex}
          levels={levels}
          lastIndex={lastIndex}
          layout={layout}
          disabled={disabled}
          dragging={dragging}
          setDragging={setDragging}
          pendingRef={pendingRef}
          onPreview={preview}
          onSelect={select}
          label={t("aria")}
          fasterLabel={t("faster")}
          smarterLabel={t("smarter")}
          autoLabel={t("level.off")}
          levelLabel={levelLabel}
          levelDescription={levelDescription}
        />
      ) : (
        <EffortList
          current={current}
          levels={levels}
          layout={layout}
          disabled={disabled}
          onSelect={select}
          label={t("aria")}
          levelLabel={levelLabel}
          levelDescription={levelDescription}
        />
      )}
    </div>
  )
}

/** Shared shape of the two label resolvers the presentations need. */
interface LevelLabellers {
  levelLabel: (level: ThinkingLevel) => string
  levelDescription: (level: ThinkingLevel) => string
}

/**
 * The "slider" presentation: a Faster→Smarter track over the offered tiers,
 * with "use model default" as a separate toggle (it is not a depth, so it is not
 * a tick). Driven by pointer (click or drag anywhere on the track) and by the
 * CLI's keyboard map (←/→/↑/↓, Home/End, 1-6, 0 for off).
 */
function EffortTrack({
  current,
  currentIndex,
  levels,
  lastIndex,
  layout,
  disabled,
  dragging,
  setDragging,
  pendingRef,
  onPreview,
  onSelect,
  label,
  fasterLabel,
  smarterLabel,
  autoLabel,
  levelLabel,
  levelDescription,
}: LevelLabellers & {
  current: ThinkingLevel
  currentIndex: number
  /** The tiers this surface offers — NOT the full ladder. */
  levels: readonly EffortTier[]
  lastIndex: number
  layout: "wide" | "compact"
  disabled?: boolean
  dragging: boolean
  setDragging: (next: boolean) => void
  pendingRef: React.RefObject<ThinkingLevel | null>
  onPreview: (level: ThinkingLevel) => void
  onSelect: (level: ThinkingLevel) => void
  label: string
  fasterLabel: string
  smarterLabel: string
  autoLabel: string
}) {
  const off = current === "off"
  const ultra = isUltracodeLevel(current)
  const trackRef = useRef<HTMLDivElement>(null)

  /** Resolve the tier under a pointer position on the track. */
  const tierAt = (clientX: number): ThinkingLevel => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect) return thinkingLevelAtIndex(0, levels)
    return thinkingLevelAtIndex(
      effortIndexFromRatio(effortRatioFromPointer(clientX, rect), lastIndex),
      levels
    )
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    // Capture keeps a drag alive once the pointer leaves the track — an
    // enhancement, never a requirement. It is absent on some targets and
    // throws `NotFoundError` on others (jsdom, and WebKit when the pointer is
    // already gone), so a failure here must not swallow the click itself.
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      // Drag still works while the pointer stays over the track.
    }
    setDragging(true)
    onPreview(tierAt(e.clientX))
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || disabled) return
    onPreview(tierAt(e.clientX))
  }

  const endDrag = () => {
    if (!dragging) return
    setDragging(false)
    // Commit whatever the pointer last hovered. A plain click lands here too:
    // pointerdown previewed the tier, pointerup writes it.
    const pending = pendingRef.current
    if (pending) onSelect(pending)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const action = effortKeyAction(e.key, currentIndex, lastIndex)
    if (!action) return
    e.preventDefault()
    onSelect(action.kind === "off" ? "off" : thinkingLevelAtIndex(action.index, levels))
  }

  return (
    <>
      <div className="flex items-center justify-between text-[11px] leading-none text-muted-foreground">
        <span>{fasterLabel}</span>
        <span>{smarterLabel}</span>
      </div>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={lastIndex}
        // "off" has no position on the track; report the fast end and let
        // `aria-valuetext` carry the real state so a screen reader never
        // announces a tier the user didn't pick.
        aria-valuenow={currentIndex < 0 ? 0 : currentIndex}
        aria-valuetext={levelLabel(current)}
        aria-disabled={disabled || undefined}
        data-testid="effort-track"
        data-ultra={ultra || undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative h-7 w-full min-w-0 touch-none rounded-full bg-muted outline-none",
          "transition-opacity focus-visible:ring-2 focus-visible:ring-ring/60",
          disabled ? "pointer-events-none opacity-50" : "cursor-pointer",
          off && "opacity-60",
          // Only the top tier keeps moving once it has arrived.
          ultra && "effort-ultra-breathe"
        )}
      >
        {/* The depth itself, drawn. The track used to carry ticks and a knob
            only, which made "how deep is this" a matter of reading the knob's
            position against six identical dots; a filled span states it, and
            easing that span is what makes a tier change feel like a change in
            energy rather than a repaint. Width shares `effortTrackOffset` with
            the marker, so the fill can never disagree with the knob. */}
        {!off && (
          <span
            aria-hidden
            data-testid="effort-track-fill"
            className={cn(
              "effort-fill absolute inset-y-1 left-1 rounded-full",
              // No easing mid-drag — the fill has to sit under the pointer, and
              // an eased fill lags a knob that does not.
              dragging && "effort-fill--dragging",
              ultra ? "effort-fill--ultra bg-effort-ultra/45" : "bg-primary/25"
            )}
            style={{ width: `calc(${effortTrackOffset(currentIndex, lastIndex)} - 0.25rem)` }}
          />
        )}
        {/* Ultracode's track. A dot LATTICE that fades in left→right rather
            than a flat fill: the tier is a step change in kind (it also arms
            the dynamic-workflow tools), and a texture says that where another
            solid bar would just read as "more of the same". The mask does the
            fading, so the lattice itself stays a constant-density grid. */}
        {ultra && (
          <span
            aria-hidden
            data-testid="effort-track-ultra"
            // `rounded-full` on the lattice itself rather than `overflow-hidden`
            // on the track: clipping the track also clips the end markers,
            // which hang half their width past the last tick's centre.
            className="effort-ultra-drift absolute inset-0 rounded-full"
            style={{
              backgroundImage:
                "radial-gradient(circle at center, var(--effort-ultra) 0.9px, transparent 1px)",
              backgroundSize: "5px 5px",
              maskImage: "linear-gradient(to right, transparent 4%, black 92%)",
              WebkitMaskImage: "linear-gradient(to right, transparent 4%, black 92%)",
            }}
          />
        )}
        {/* The sweep that crosses the lattice. Its own element rather than a
            second animation on the lattice: they run at different speeds, and
            the lattice's mask must stay put while the highlight travels. */}
        {ultra && (
          <span
            aria-hidden
            data-testid="effort-track-sweep"
            // The clip is the track itself, so the highlight enters and leaves
            // behind its rounded caps instead of popping in mid-air.
            className="pointer-events-none absolute inset-0 overflow-hidden rounded-full"
          >
            {/* Width is 2/5 of the track and the keyframes translate by
                multiples of THAT, so the two have to move together — see
                `effort-ultra-sweep` in globals.css. The core stop is mixed
                toward white because at this tier the highlight crosses the
                violet fill, and violet-on-violet is not a specular. */}
            <span
              className="effort-ultra-sweep absolute inset-y-0 left-0 w-2/5"
              style={{
                backgroundImage:
                  "linear-gradient(100deg, transparent 0%, var(--effort-ultra-muted) 30%, color-mix(in oklab, var(--effort-ultra) 55%, white) 50%, var(--effort-ultra-muted) 70%, transparent 100%)",
              }}
            />
          </span>
        )}
        {/* One tick per OFFERED tier. `ultracode` keeps an accented dot even
            when inactive: it is the one tick that changes more than depth, and
            the scale reads as a plain ladder otherwise. */}
        {levels.map((level, index) => (
          <span
            key={level}
            aria-hidden
            data-testid="effort-track-tick"
            className={cn(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors",
              level === "ultracode" ? "size-1.5 bg-effort-ultra" : "size-1 bg-muted-foreground/40"
            )}
            style={{ left: effortTrackOffset(index, lastIndex) }}
          />
        ))}
        {!off && (
          <span
            aria-hidden
            data-testid="effort-track-marker"
            className={cn(
              "absolute top-1/2 h-[22px] w-7 -translate-x-1/2 -translate-y-1/2 rounded-full",
              // A knob reads as raised by being LIGHTER than its trough, which
              // means it cannot be one token: `bg-background` is the lightest
              // surface in light mode and the darkest in dark. Flipping to
              // `foreground` there is the same move `components/ui/switch.tsx`
              // makes for its thumb.
              "bg-background shadow-[0_1px_3px_rgba(0,0,0,0.18)] ring-1 ring-black/5",
              "dark:bg-foreground dark:ring-white/10",
              // No transition while dragging: the marker must track the pointer
              // exactly, and easing it turns a drag into a lag.
              !dragging && "transition-[left] duration-150 ease-out",
              // ...and for the same reason the landing pop is committed-only:
              // popping on every previewed tier during a drag is a stutter.
              !dragging && "effort-knob-pop",
              ultra && "ring-effort-ultra/60 dark:ring-effort-ultra/60"
            )}
            // Keyed by tier so the pop re-fires on each commit.
            key={dragging ? "dragging" : current}
            style={{ left: effortTrackOffset(currentIndex, lastIndex) }}
          />
        )}
      </div>

      {layout === "wide" && (
        // Full tier scale under the track. Each label is also a jump target —
        // clicking a name is easier than aiming at its tick.
        <div className="flex items-center justify-between gap-0.5">
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(level)}
              className={cn(
                "min-w-0 truncate rounded px-1 py-0.5 text-[10px] transition-colors",
                level === current
                  ? level === "ultracode"
                    ? "font-medium text-effort-ultra"
                    : "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
                disabled && "pointer-events-none opacity-50"
              )}
            >
              {levelLabel(level)}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
          {levelDescription(current)}
        </p>
        <button
          type="button"
          aria-pressed={off}
          disabled={disabled}
          onClick={() => onSelect("off")}
          data-testid="effort-auto-toggle"
          className={cn(
            "shrink-0 rounded-pill px-2 py-0.5 text-[10px] transition-colors",
            off
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            disabled && "pointer-events-none opacity-50"
          )}
        >
          {autoLabel}
        </button>
      </div>
    </>
  )
}

/**
 * The "list" presentation: one row per tier — "use model default" first, then
 * the offered depths — each with a check on the active row. Descriptions are
 * dropped in the compact band so a narrow popover stays scannable.
 */
function EffortList({
  current,
  levels,
  layout,
  disabled,
  onSelect,
  label,
  levelLabel,
  levelDescription,
}: LevelLabellers & {
  current: ThinkingLevel
  /** The tiers this surface offers — NOT the full ladder. */
  levels: readonly EffortTier[]
  layout: "wide" | "compact"
  disabled?: boolean
  onSelect: (level: ThinkingLevel) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="-mx-1 flex flex-col">
      {(["off", ...levels] as ThinkingLevel[]).map((level) => {
        const active = level === current
        const ultra = level === "ultracode"
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onSelect(level)}
            className={cn(
              "flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
              active ? "bg-accent/60" : "hover:bg-accent/40",
              disabled && "pointer-events-none opacity-50"
            )}
          >
            <CheckIcon
              aria-hidden
              className={cn("size-3 shrink-0", active ? "opacity-100" : "opacity-0")}
            />
            <span className="flex min-w-0 flex-col">
              <span
                className={cn(
                  "truncate text-[11px]",
                  active && "font-medium",
                  ultra ? "text-effort-ultra" : active && "text-foreground"
                )}
              >
                {levelLabel(level)}
              </span>
              {layout === "wide" && (
                <span className="truncate text-[10px] text-muted-foreground">
                  {levelDescription(level)}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
