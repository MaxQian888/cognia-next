"use client"

// Composer thinking-level ("reasoning effort") control — the labelled block at
// the bottom of the model picker's popover. Effort only ever qualifies a model,
// so it shares that one surface rather than owning a second toolbar chip.
//
// It surfaces the per-session tier, persisted by `thinkingLevelPatch` as BOTH
// `ChatSession.effort` (what every existing consumer reads) and
// `ChatSession.thinkingLevel` (the tier identity `effort` can't express — see
// `@/lib/ai/thinking-level`). `resolveSendOptions` consumes them at send time,
// so a change applies from the NEXT turn: there is no live-apply IPC here,
// unlike model switching.
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
// Self-gates to nothing when there is no session or the active model can't use
// effort, so it never clutters a picker where it would be a no-op.

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon, CheckIcon, InfoIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import {
  availableThinkingLevels,
  clampThinkingLevel,
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
  const tEffort = useTranslations("settings.general")
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const preferredMode = useSettingsStore((s) => s.settings?.composerBehavior?.effortSelectorMode)

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

  // Mirrors the toolbar's model resolution: per-session override > app default.
  const modelId = session?.model ?? defaultModel ?? "claude-sonnet-4-5"
  const providerId = session?.providerOverride ?? defaultProvider ?? "anthropic"

  // The tiers THIS provider+model actually distinguishes. Doubles as the
  // self-gate: a surface with no depth control offers none, so the block simply
  // does not render (a session-less composer likewise has nothing to configure).
  const levels = availableThinkingLevels({
    providerId,
    modelId,
    reasoning: modelSupportsEffort(providerId, modelId),
  })
  if (!session?.id) return null
  if (levels.length === 0) return null

  const sessionId = session.id
  // Display the tier the turn will REALLY carry: a level the active model does
  // not offer folds to the deepest one it does. The session keeps the user's
  // actual choice, which reapplies once a capable model is active again.
  const current = clampThinkingLevel(optimistic ?? resolveThinkingLevel(session), levels)
  const currentIndex = current === "off" ? -1 : levels.indexOf(current)
  const lastIndex = levels.length - 1
  const layout = effortSelectorLayout(width)
  const mode = modeProp ?? preferredMode ?? DEFAULT_EFFORT_SELECTOR_MODE

  const levelLabel = (level: ThinkingLevel) =>
    level === "off" ? t("auto") : tEffort(`effort.${level}` as "effort.low")
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

  const header = (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <BrainIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{t("aria")}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <span className="text-[11px] font-medium" data-testid="effort-selector-value">
          {levelLabel(current)}
        </span>
        {/* Own provider rather than relying on the one in `app/layout.tsx`:
            this block renders inside the model picker's portalled popover and
            is also mounted directly by tests/stories, and Radix throws outright
            when a Tooltip has no provider above it. Nesting is supported. */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("hintAria")}
                className="text-muted-foreground/70 hover:text-foreground"
              >
                <InfoIcon className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[16rem] text-xs">
              {t("hint")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    </div>
  )

  return (
    <div
      ref={rootRef}
      className={cn("flex flex-col gap-2 border-t px-3 py-2", className)}
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
          autoLabel={t("auto")}
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
 * The "slider" presentation: a Faster→Smarter track over the six non-off tiers,
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
  /** The tiers this provider+model offers — NOT the full ladder. */
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
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
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
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative h-6 w-full min-w-0 touch-none rounded-full bg-muted/60 outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
          disabled ? "pointer-events-none opacity-50" : "cursor-pointer",
          off && "opacity-60"
        )}
      >
        {/* Filled portion, up to the marker's centre. Hidden while off — an
            empty track reads as "nothing forwarded" more honestly than a
            zero-width fill. */}
        {!off && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-full bg-primary/45"
            style={{ width: effortTrackOffset(currentIndex, lastIndex) }}
          />
        )}
        {/* One tick per OFFERED tier. `ultracode` gets a larger, accented dot
            even when inactive: it is the one tick that changes more than depth,
            and the scale below reads as a plain ladder otherwise. */}
        {levels.map((level, index) => (
          <span
            key={level}
            aria-hidden
            className={cn(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
              level === "ultracode" ? "size-1.5 bg-primary" : "size-1 bg-muted-foreground/50"
            )}
            style={{ left: effortTrackOffset(index, lastIndex) }}
          />
        ))}
        {!off && (
          <span
            aria-hidden
            data-testid="effort-track-marker"
            className="absolute top-1/2 h-5 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-sm"
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
                  ? "font-medium text-foreground"
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
        <p className="min-w-0 flex-1 text-[10px] leading-snug text-muted-foreground">
          {levelDescription(current)}
        </p>
        <button
          type="button"
          aria-pressed={off}
          disabled={disabled}
          onClick={() => onSelect("off")}
          data-testid="effort-auto-toggle"
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] transition-colors",
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
 * the six depths — each with a check on the active row. Descriptions are
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
  /** The tiers this provider+model offers — NOT the full ladder. */
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
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onSelect(level)}
            className={cn(
              "flex items-center gap-2 rounded px-1.5 py-1 text-left transition-colors",
              active ? "bg-accent/60" : "hover:bg-accent/40",
              disabled && "pointer-events-none opacity-50"
            )}
          >
            <CheckIcon
              aria-hidden
              className={cn("size-3 shrink-0", active ? "opacity-100" : "opacity-0")}
            />
            <span className="flex min-w-0 flex-col">
              <span className={cn("truncate text-[11px]", active && "font-medium text-foreground")}>
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
