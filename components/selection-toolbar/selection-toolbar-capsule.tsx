"use client"

/**
 * The visible pill. Purely presentational — `SelectionToolbarView` owns the
 * state machine, the IPC and the candidate; this file owns layout and motion.
 *
 * Icon-first by design: the toolbar appears directly over the user's text, and
 * six labelled buttons covered roughly three times the area six icons do.
 * Hovering expands the one button under the pointer into its label plus its
 * bound chord. The window is pre-sized to the widest of those states (see
 * `useSelectionToolbarGeometry`), so that expansion is pure layout animation —
 * no window resize, no IPC, no flicker.
 */

import { useEffect, useRef } from "react"
import { AnimatePresence, motion } from "motion/react"
import { useFormatter, useTranslations } from "next-intl"
import { CheckIcon, ChevronDownIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { MOBILE_DURATION, MOBILE_EASE, MOBILE_SPRING } from "@/lib/ui/motion"
import type { SelectionToolbarPlacement } from "@/lib/tauri/selection-toolbar"
import { formatKeybinding } from "@/lib/shortcuts/utils"
import {
  SELECTION_ACTIONS,
  TARGET_LOCALES,
  type SelectionActionDescriptor,
  type SelectionActionId,
  type TargetLocale,
} from "./selection-toolbar-actions"
import type { SelectionToolbarGeometryHandles } from "./use-selection-toolbar-geometry"

/** Shared id for the hover highlight that slides between buttons. */
const HIGHLIGHT_LAYOUT_ID = "selection-toolbar-highlight"
const WAVEFORM_BARS = [0.35, 0.7, 1, 0.55, 0.85, 0.4] as const

export type SelectionToolbarPhase =
  | { kind: "idle" }
  | { kind: "pending"; action: SelectionActionId }
  | { kind: "ok"; action: SelectionActionId }
  | { kind: "error"; action: SelectionActionId; reason: string }
  | { kind: "speaking"; progress?: number }

export interface SelectionToolbarCapsuleProps {
  geometry: SelectionToolbarGeometryHandles
  /**
   * The buttons this selection earned, already ordered and capped by
   * `resolveVisibleActions`. Passed in rather than read from the table here so
   * the ghost row and the real row provably measure the same set — the ghost
   * is what pins the window width, so a divergence would clip a label.
   */
  actions: readonly SelectionActionDescriptor[]
  phase: SelectionToolbarPhase
  hovered: SelectionActionId | null
  onHoverChange: (id: SelectionActionId | null) => void
  onAction: (id: SelectionActionId) => void
  onStopSpeech: () => void
  chords: Record<string, string>
  isMac: boolean
  targetLocale: TargetLocale
  localeOpen: boolean
  onLocaleOpenChange: (open: boolean) => void
  onLocaleSelect: (locale: TargetLocale) => void
  truncated: boolean
  reduceMotion: boolean
}

const CAPSULE_CLASS =
  "pointer-events-auto flex items-center gap-0.5 rounded-full border bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-xl"

export function SelectionToolbarCapsule({
  geometry,
  actions,
  phase,
  hovered,
  onHoverChange,
  onAction,
  onStopSpeech,
  chords,
  isMac,
  targetLocale,
  localeOpen,
  onLocaleOpenChange,
  onLocaleSelect,
  truncated,
  reduceMotion,
}: SelectionToolbarCapsuleProps) {
  const t = useTranslations("selectionToolbar")
  const { shellRef, capsuleRef, panelRef, ghostRef, placement } = geometry

  const enter = reduceMotion
    ? { opacity: 1, scale: 1, y: 0 }
    : { opacity: 0, scale: 0.9, y: placement === "above" ? 8 : -8 }
  const exit = reduceMotion
    ? { opacity: 0 }
    : { opacity: 0, scale: 0.96, y: placement === "above" ? 4 : -4 }

  const localePanel = localeOpen ? (
    <LocalePanel
      containerRef={panelRef}
      placement={placement}
      targetLocale={targetLocale}
      onSelect={onLocaleSelect}
      onClose={() => onLocaleOpenChange(false)}
      reduceMotion={reduceMotion}
      label={(locale) => t(`languages.${locale}` as never)}
    />
  ) : null

  return (
    <>
      <HoverWidthGhost
        ref={ghostRef}
        actions={actions}
        chords={chords}
        isMac={isMac}
        localeLabel={t(`languages.${targetLocale}` as never)}
        label={(action) => t(action.labelKey)}
      />

      <div
        ref={shellRef}
        className={cn(
          "flex w-max flex-col items-center gap-1.5",
          placement === "above" ? "justify-end" : "justify-start"
        )}
      >
        {placement === "above" ? localePanel : null}
        <motion.div
          ref={capsuleRef}
          layout={!reduceMotion}
          initial={enter}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={exit}
          // Spring in, tween out. The entrance can afford a spring's
          // settle because it grows out of the selection anchor and reads as
          // physical; the exit cannot, because Rust only holds the native
          // window for EXIT_ANIMATION_MS and a spring's tail would be cropped
          // mid-flight.
          transition={
            reduceMotion
              ? { duration: 0 }
              : { ...MOBILE_SPRING, opacity: { duration: MOBILE_DURATION.fast } }
          }
          style={{ transformOrigin: placement === "above" ? "bottom center" : "top center" }}
          className={CAPSULE_CLASS}
          data-testid="selection-toolbar-capsule"
          data-placement={placement}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {phase.kind === "speaking" ? (
              <SpeechBar
                key="speech"
                progress={phase.progress}
                onStop={onStopSpeech}
                label={t("stopSpeaking")}
                reduceMotion={reduceMotion}
              />
            ) : phase.kind === "error" ? (
              <ErrorBar key="error" message={phase.reason} reduceMotion={reduceMotion} />
            ) : (
              <motion.div
                key="actions"
                layout={!reduceMotion}
                className="flex items-center gap-0.5"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                transition={{ duration: reduceMotion ? 0 : MOBILE_DURATION.fast }}
              >
                {actions.map((action, index) => (
                  <ActionButton
                    key={action.id}
                    index={index}
                    action={action}
                    label={t(action.labelKey)}
                    chord={action.shortcutId ? chords[action.shortcutId] : undefined}
                    isMac={isMac}
                    expanded={hovered === action.id}
                    phase={phase}
                    localeOpen={localeOpen}
                    localeLabel={t(`languages.${targetLocale}` as never)}
                    chooseLanguageLabel={t("chooseLanguage")}
                    onHoverChange={onHoverChange}
                    onAction={onAction}
                    onLocaleOpenChange={onLocaleOpenChange}
                    reduceMotion={reduceMotion}
                  />
                ))}
                {truncated ? (
                  <span
                    className="ml-0.5 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                    title={t("truncatedHint")}
                  >
                    {t("truncated")}
                  </span>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
        {placement === "below" ? localePanel : null}
      </div>
    </>
  )
}

/**
 * Off-screen mirror of every hover state the capsule can be in — one row per
 * action, that action expanded. The container is `w-max`, so its width is the
 * widest of them, which is exactly the width the window has to be pinned to.
 *
 * Sizing the window once to this bound is what makes hovering free: the label
 * expansion becomes pure layout animation with no resize round-trip, so the
 * capsule never flickers and Rust is never asked to move a visible window
 * sixty times while the pointer sweeps the row.
 */
function HoverWidthGhost({
  ref,
  actions,
  chords,
  isMac,
  localeLabel,
  label,
}: {
  ref: React.RefObject<HTMLDivElement | null>
  actions: readonly SelectionActionDescriptor[]
  chords: Record<string, string>
  isMac: boolean
  localeLabel: string
  label: (action: SelectionActionDescriptor) => string
}) {
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed -top-[9999px] left-0 flex w-max flex-col"
    >
      {actions.map((expandedAction) => (
        <div key={expandedAction.id} className="flex w-max items-center gap-0.5 p-1">
          {actions.map((action) => {
            const chord = action.shortcutId ? chords[action.shortcutId] : undefined
            const isExpanded = action.id === expandedAction.id
            return (
              <span
                key={action.id}
                className="flex h-8 items-center gap-1.5 rounded-full px-2 text-xs font-medium"
              >
                <action.icon className="size-4" />
                {isExpanded ? (
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span>{label(action)}</span>
                    {action.hasLocalePicker ? <span>· {localeLabel}</span> : null}
                    {chord ? (
                      <kbd className="px-1 py-px font-mono text-[10px] leading-none">
                        {formatKeybinding(chord, isMac)}
                      </kbd>
                    ) : null}
                  </span>
                ) : null}
                {action.hasLocalePicker ? <ChevronDownIcon className="size-3" /> : null}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}

interface ActionButtonProps {
  index: number
  action: (typeof SELECTION_ACTIONS)[number]
  label: string
  chord: string | undefined
  isMac: boolean
  expanded: boolean
  phase: SelectionToolbarPhase
  localeOpen: boolean
  localeLabel: string
  chooseLanguageLabel: string
  onHoverChange: (id: SelectionActionId | null) => void
  onAction: (id: SelectionActionId) => void
  onLocaleOpenChange: (open: boolean) => void
  reduceMotion: boolean
}

function ActionButton({
  index,
  action,
  label,
  chord,
  isMac,
  expanded,
  phase,
  localeOpen,
  localeLabel,
  chooseLanguageLabel,
  onHoverChange,
  onAction,
  onLocaleOpenChange,
  reduceMotion,
}: ActionButtonProps) {
  const busy = phase.kind === "pending" && phase.action === action.id
  const done = phase.kind === "ok" && phase.action === action.id
  const Icon = action.icon

  return (
    <motion.div
      layout={!reduceMotion}
      className="relative flex items-center"
      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE, delay: index * 0.025 }
      }
      onPointerEnter={() => onHoverChange(action.id)}
      onPointerLeave={() => onHoverChange(null)}
    >
      {/*
        A raw button rather than `components/ui/button`: the shared sliding
        highlight below already paints the hover state, and Button's own
        `hover:bg-accent` would double it.
      */}
      <motion.button
        type="button"
        layout={!reduceMotion}
        aria-label={label}
        aria-keyshortcuts={chord}
        disabled={phase.kind === "pending"}
        whileTap={reduceMotion ? undefined : { scale: 0.96 }}
        onClick={() => onAction(action.id)}
        className={cn(
          "relative z-10 flex h-8 items-center gap-1.5 rounded-full px-2 text-xs font-medium",
          "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:opacity-60",
          action.hasLocalePicker && "pr-1"
        )}
      >
        {busy ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : done ? (
          <motion.span
            initial={reduceMotion ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={reduceMotion ? { duration: 0 } : MOBILE_SPRING}
            className="flex"
          >
            <CheckIcon className="size-4" />
          </motion.span>
        ) : (
          <Icon className="size-4" />
        )}
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.span
              key="label"
              initial={reduceMotion ? false : { opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, width: 0 }}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }
              }
              className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap"
            >
              <span>{label}</span>
              {action.hasLocalePicker ? (
                <span className="text-muted-foreground">· {localeLabel}</span>
              ) : null}
              {chord ? (
                <kbd className="rounded bg-foreground/10 px-1 py-px font-mono text-[10px] leading-none text-muted-foreground">
                  {formatKeybinding(chord, isMac)}
                </kbd>
              ) : null}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </motion.button>

      {action.hasLocalePicker ? (
        <motion.button
          type="button"
          layout={!reduceMotion}
          aria-label={chooseLanguageLabel}
          aria-expanded={localeOpen}
          disabled={phase.kind === "pending"}
          whileTap={reduceMotion ? undefined : { scale: 0.96 }}
          onClick={() => onLocaleOpenChange(!localeOpen)}
          className="relative z-10 flex h-8 w-5 items-center justify-center rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60"
        >
          <motion.span
            animate={{ rotate: localeOpen ? 180 : 0 }}
            transition={reduceMotion ? { duration: 0 } : MOBILE_SPRING}
            className="flex"
          >
            <ChevronDownIcon className="size-3" />
          </motion.span>
        </motion.button>
      ) : null}

      {expanded ? (
        <motion.span
          layoutId={reduceMotion ? undefined : HIGHLIGHT_LAYOUT_ID}
          transition={MOBILE_SPRING}
          className="absolute inset-0 rounded-full bg-accent"
          aria-hidden
        />
      ) : null}
    </motion.div>
  )
}

function LocalePanel({
  containerRef,
  placement,
  targetLocale,
  onSelect,
  onClose,
  reduceMotion,
  label,
}: {
  /** Reported to Rust as a hit rect — see `useSelectionToolbarGeometry`. */
  containerRef: React.RefObject<HTMLElement | null>
  placement: SelectionToolbarPlacement
  targetLocale: TargetLocale
  onSelect: (locale: TargetLocale) => void
  onClose: () => void
  reduceMotion: boolean
  label: (locale: TargetLocale) => string
}) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Rust focuses the window while this panel is open (`set_interactive`), so
  // the keyboard genuinely reaches it. Land on the current target rather than
  // nowhere — this replaced a Radix DropdownMenu, which did roving focus for
  // free, and dropping that would have made the panel mouse-only.
  useEffect(() => {
    const index = TARGET_LOCALES.indexOf(targetLocale)
    optionRefs.current[index >= 0 ? index : 0]?.focus()
    // Deliberately mount-only: re-focusing whenever the target changes would
    // fight the user's own arrow-key movement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const moveFocus = (from: number, delta: number) => {
    const count = TARGET_LOCALES.length
    optionRefs.current[(from + delta + count) % count]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    const index = optionRefs.current.findIndex((option) => option === document.activeElement)
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        moveFocus(index < 0 ? -1 : index, 1)
        break
      case "ArrowUp":
        event.preventDefault()
        moveFocus(index < 0 ? 1 : index, -1)
        break
      case "Home":
        event.preventDefault()
        optionRefs.current[0]?.focus()
        break
      case "End":
        event.preventDefault()
        optionRefs.current[TARGET_LOCALES.length - 1]?.focus()
        break
      case "Escape":
        event.preventDefault()
        onClose()
        break
      default:
        break
    }
  }

  return (
    <motion.ul
      ref={(node) => {
        containerRef.current = node
      }}
      onKeyDown={onKeyDown}
      // Rendered inline instead of in a Radix portal: the native window is
      // sized from this shell's bounding box, and a portalled `position: fixed`
      // menu would sit outside it — so the window would never grow to contain
      // the menu and it would be clipped by `overflow: hidden`.
      role="listbox"
      aria-orientation="vertical"
      initial={
        reduceMotion ? false : { opacity: 0, scale: 0.96, y: placement === "above" ? 6 : -6 }
      }
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={
        reduceMotion ? { duration: 0 } : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }
      }
      style={{ transformOrigin: placement === "above" ? "bottom center" : "top center" }}
      className="pointer-events-auto flex w-max min-w-36 flex-col rounded-xl border bg-popover/95 p-1 text-popover-foreground shadow-xl backdrop-blur-xl"
    >
      {TARGET_LOCALES.map((locale, index) => (
        <li key={locale}>
          <button
            type="button"
            role="option"
            ref={(node) => {
              optionRefs.current[index] = node
            }}
            aria-selected={locale === targetLocale}
            // Roving tabindex: one stop for the whole list, as a listbox should
            // have — Tab moves past it, arrows move within it.
            tabIndex={locale === targetLocale ? 0 : -1}
            onClick={() => onSelect(locale)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus:bg-accent focus:outline-none"
          >
            <span className="flex-1">{label(locale)}</span>
            {locale === targetLocale ? <CheckIcon className="size-3.5" /> : null}
          </button>
        </li>
      ))}
    </motion.ul>
  )
}

function SpeechBar({
  progress,
  onStop,
  label,
  reduceMotion,
}: {
  progress?: number
  onStop: () => void
  label: string
  reduceMotion: boolean
}) {
  const format = useFormatter()
  return (
    <motion.div
      key="speech"
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={
        reduceMotion ? { duration: 0 } : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }
      }
      className="flex items-center gap-2 px-1"
    >
      <motion.button
        type="button"
        aria-label={label}
        whileTap={reduceMotion ? undefined : { scale: 0.96 }}
        onClick={onStop}
        className="flex size-8 items-center justify-center rounded-full hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {/*
          A filled `SquareIcon` reads as a solid block against the pill — too
          heavy, and closer to a record indicator than a stop button. A small
          rounded rect is the transport convention and sits with the capsule's
          own radius.
        */}
        <span className="size-3 rounded-[3px] bg-current" />
      </motion.button>
      <div
        className="flex h-8 items-end gap-0.5 pb-2"
        role="progressbar"
        aria-label={label}
        aria-valuenow={progress === undefined ? undefined : Math.round(progress * 100)}
      >
        {WAVEFORM_BARS.map((peak, index) => (
          <motion.span
            key={index}
            className="w-0.5 rounded-full bg-foreground/60"
            // Baseline 6px, not 4: at the trough of the loop the bars are the
            // only thing saying "still playing", and 4px reads as a dotted
            // line rather than a waveform.
            initial={{ height: 6 }}
            animate={
              reduceMotion
                ? { height: 6 + peak * 6 }
                : { height: [6, 6 + peak * 11, 6], opacity: [0.55, 1, 0.55] }
            }
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    duration: 0.9,
                    repeat: Infinity,
                    ease: "easeInOut",
                    delay: index * 0.08,
                  }
            }
          />
        ))}
      </div>
      {progress !== undefined ? (
        <span className="pr-1 font-mono text-[10px] text-muted-foreground">
          {format.number(progress, { style: "percent", maximumFractionDigits: 0 })}
        </span>
      ) : null}
    </motion.div>
  )
}

function ErrorBar({ message, reduceMotion }: { message: string; reduceMotion: boolean }) {
  return (
    <motion.div
      key="error"
      layout={!reduceMotion}
      role="alert"
      initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={
        reduceMotion ? { duration: 0 } : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }
      }
      className="flex items-center gap-2 px-2 py-1 text-xs text-warning"
    >
      <TriangleAlertIcon className="size-4 shrink-0" />
      <span className="whitespace-nowrap">{message}</span>
    </motion.div>
  )
}
