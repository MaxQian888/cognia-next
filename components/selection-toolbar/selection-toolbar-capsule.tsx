"use client"

/**
 * The visible pill. Purely presentational. `SelectionToolbarView` owns the
 * state machine, the IPC and the candidate, and this file owns layout and
 * motion.
 *
 * Icon-first by design: the toolbar appears directly over the user's text, and
 * six labelled buttons covered roughly three times the area six icons do.
 * Hovering expands the one button under the pointer into its label plus its
 * bound chord. The window is pre-sized to the widest of those states (see
 * `useSelectionToolbarGeometry`), so that expansion is pure layout animation,
 * with no window resize, no IPC and no flicker.
 *
 * Every floating piece here takes its tint, radius and elevation from
 * `selection-surface.tsx` rather than restating them, so the pill and the two
 * menus stay one object over a moving desktop.
 */

import { useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { useFormatter, useTranslations } from "next-intl"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Surface } from "@/components/surface/surface"
import { MOBILE_DURATION, MOBILE_EASE, MOBILE_SPRING } from "@/lib/ui/motion"
import type { SelectionToolbarPlacement } from "@/lib/tauri/selection-toolbar"
import { formatKeybinding } from "@/lib/shortcuts/utils"
import {
  TARGET_LOCALES,
  type SelectionActionDescriptor,
  type TargetLocale,
} from "./selection-toolbar-actions"
import {
  SELECTION_GLASS,
  SELECTION_GLASS_TINT,
  SelectionDivider,
  SelectionListItem,
  SelectionListPanel,
} from "./selection-surface"
import type { SelectionToolbarGeometryHandles } from "./use-selection-toolbar-geometry"

/** Shared id for the hover highlight that slides between buttons. */
const HIGHLIGHT_LAYOUT_ID = "selection-toolbar-highlight"
const WAVEFORM_BARS = [0.35, 0.7, 1, 0.55, 0.85, 0.4] as const

export type SelectionToolbarPhase =
  | { kind: "idle" }
  | { kind: "pending"; action: string }
  | { kind: "ok"; action: string }
  | { kind: "error"; action: string; reason: string }
  | { kind: "status"; action: string; message: string }
  | { kind: "speaking"; progress?: number }

export interface SelectionToolbarCapsuleProps {
  geometry: SelectionToolbarGeometryHandles
  /**
   * The buttons this selection earned, already ordered and capped by
   * `resolveVisibleActions`. Passed in rather than read from the table here so
   * the ghost row and the real row provably measure the same set. The ghost is
   * what pins the window width, so a divergence would clip a label.
   */
  actions: readonly SelectionActionDescriptor[]
  phase: SelectionToolbarPhase
  hovered: string | null
  onHoverChange: (id: string | null) => void
  onAction: (id: string) => void
  onStopSpeech: () => void
  chords: Record<string, string>
  isMac: boolean
  targetLocale: TargetLocale
  localeOpen: boolean
  onLocaleOpenChange: (open: boolean) => void
  onLocaleSelect: (locale: TargetLocale) => void
  truncated: boolean
  reduceMotion: boolean
  overflowActions?: readonly SelectionActionDescriptor[]
  moreOpen?: boolean
  onMoreOpenChange?: (open: boolean) => void
  overflowInitialParentId?: string
}

/**
 * Which band of the row an action belongs to.
 *
 * The row is not one list, it is up to four: the stable actions the user has
 * built habits on, the contextual ones this particular selection minted, the
 * ones a plugin contributed, and the overflow handle. They are all icons of the
 * same size, so without a mark the row reads as an undifferentiated strip and
 * the promoted contextual action looks like a button that moved.
 */
function bandOf(action: SelectionActionDescriptor): string {
  if (action.isMore) return "more"
  if (action.pluginActionId) return "plugin"
  return action.requires ? "contextual" : "generic"
}

/** True when a hairline belongs before `actions[index]`. */
function startsBand(actions: readonly SelectionActionDescriptor[], index: number): boolean {
  return index > 0 && bandOf(actions[index]) !== bandOf(actions[index - 1])
}

const CAPSULE_CLASS = "pointer-events-auto flex items-center gap-0.5 p-1"

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
  overflowActions = [],
  moreOpen = false,
  onMoreOpenChange,
  overflowInitialParentId,
}: SelectionToolbarCapsuleProps) {
  const t = useTranslations("selectionToolbar")
  const { shellRef, capsuleRef, panelRef, ghostRef, placement, remeasure } = geometry

  const enter = reduceMotion
    ? { opacity: 1, scale: 1, y: 0 }
    : { opacity: 0, scale: 0.9, y: placement === "above" ? 8 : -8 }
  const exit = reduceMotion
    ? { opacity: 0 }
    : { opacity: 0, scale: 0.96, y: placement === "above" ? 4 : -4 }

  const actionLabel = (action: SelectionActionDescriptor) =>
    action.label ?? (action.labelKey ? t(action.labelKey) : action.id)
  const localePanel = localeOpen ? (
    <LocalePanel
      containerRef={panelRef}
      placement={placement}
      targetLocale={targetLocale}
      onSelect={onLocaleSelect}
      onClose={() => onLocaleOpenChange(false)}
      onResize={remeasure}
      reduceMotion={reduceMotion}
      title={t("chooseLanguage")}
      label={(locale) => t(`languages.${locale}` as never)}
    />
  ) : null
  const overflowPanel = moreOpen ? (
    <ActionOverflowPanel
      containerRef={panelRef}
      placement={placement}
      actions={overflowActions}
      label={actionLabel}
      chords={chords}
      isMac={isMac}
      onAction={(id) => {
        onMoreOpenChange?.(false)
        onAction(id)
      }}
      onClose={() => onMoreOpenChange?.(false)}
      onResize={remeasure}
      title={t("more")}
      backLabel={t("back")}
      initialParentId={overflowInitialParentId}
      reduceMotion={reduceMotion}
    />
  ) : null
  const auxiliaryPanel = localePanel ?? overflowPanel

  return (
    <>
      <HoverWidthGhost
        ref={ghostRef}
        actions={actions}
        chords={chords}
        isMac={isMac}
        localeLabel={t(`languages.${targetLocale}` as never)}
        label={actionLabel}
      />

      <div
        ref={shellRef}
        className={cn(
          "flex w-max flex-col items-center gap-1.5",
          placement === "above" ? "justify-end" : "justify-start"
        )}
      >
        {placement === "above" ? auxiliaryPanel : null}
        <Surface asChild layer="overlay" radius="pill" elevation={3}>
          <motion.div
            ref={capsuleRef}
            layout={!reduceMotion}
            initial={enter}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={exit}
            // Spring in, tween out. The entrance can afford a spring's
            // settle because it grows out of the selection anchor and reads as
            // physical. The exit cannot, because Rust only holds the native
            // window for EXIT_ANIMATION_MS and a spring's tail would be cropped
            // mid-flight.
            transition={
              reduceMotion
                ? { duration: 0 }
                : { ...MOBILE_SPRING, opacity: { duration: MOBILE_DURATION.fast } }
            }
            style={{
              ...SELECTION_GLASS_TINT,
              transformOrigin: placement === "above" ? "bottom center" : "top center",
            }}
            className={cn(CAPSULE_CLASS, SELECTION_GLASS)}
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
                <MessageBar
                  key="error"
                  tone="error"
                  message={phase.reason}
                  reduceMotion={reduceMotion}
                />
              ) : phase.kind === "status" ? (
                <MessageBar
                  key="status"
                  tone="status"
                  message={phase.message}
                  reduceMotion={reduceMotion}
                />
              ) : (
                <motion.div
                  key="actions"
                  layout={!reduceMotion}
                  role="toolbar"
                  aria-orientation="horizontal"
                  aria-label={t("title")}
                  className="flex items-center gap-0.5"
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
                  transition={{ duration: reduceMotion ? 0 : MOBILE_DURATION.fast }}
                >
                  {actions.map((action, index) => (
                    <Band key={action.id}>
                      {startsBand(actions, index) ? <SelectionDivider /> : null}
                      <ActionButton
                        index={index}
                        action={action}
                        label={actionLabel(action)}
                        chord={action.shortcutId ? chords[action.shortcutId] : action.accelerator}
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
                    </Band>
                  ))}
                  {truncated ? (
                    <span
                      className="ml-0.5 rounded-pill bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                      title={t("truncatedHint")}
                    >
                      {t("truncated")}
                    </span>
                  ) : null}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </Surface>
        {placement === "below" ? auxiliaryPanel : null}
      </div>
    </>
  )
}

/**
 * A keyed pair of siblings: an optional band divider and the button after it.
 *
 * `motion` reads its children to drive layout animation, and a bare
 * `React.Fragment` is transparent to that, so the divider and the button it
 * precedes stay two independently animated boxes as they must.
 */
function Band({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

/**
 * Off-screen mirror of every hover state the capsule can be in, one row per
 * action, that action expanded. The container is `w-max`, so its width is the
 * widest of them, which is exactly the width the window has to be pinned to.
 *
 * Sizing the window once to this bound is what makes hovering free: the label
 * expansion becomes pure layout animation with no resize round-trip, so the
 * capsule never flickers and Rust is never asked to move a visible window
 * sixty times while the pointer sweeps the row.
 *
 * It mirrors the band dividers too. They are 1px plus margins each, and a row
 * measured without them is a row that clips its own last label.
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
          {actions.map((action, index) => {
            const chord = action.shortcutId ? chords[action.shortcutId] : action.accelerator
            const isExpanded = action.id === expandedAction.id
            return (
              <Band key={action.id}>
                {startsBand(actions, index) ? <SelectionDivider /> : null}
                <span className="flex h-8 items-center gap-1.5 rounded-pill px-2 text-xs font-medium">
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
              </Band>
            )
          })}
        </div>
      ))}
    </div>
  )
}

interface ActionButtonProps {
  index: number
  action: SelectionActionDescriptor
  label: string
  chord: string | undefined
  isMac: boolean
  expanded: boolean
  phase: SelectionToolbarPhase
  localeOpen: boolean
  localeLabel: string
  chooseLanguageLabel: string
  onHoverChange: (id: string | null) => void
  onAction: (id: string) => void
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
        aria-haspopup={action.isMore || action.children?.length ? "menu" : undefined}
        disabled={phase.kind === "pending"}
        whileTap={reduceMotion ? undefined : { scale: 0.96 }}
        onClick={() => onAction(action.id)}
        className={cn(
          "relative z-10 flex h-8 items-center gap-1.5 rounded-pill px-2 text-xs font-medium",
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
            className="flex text-success"
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
                <kbd className="rounded-control bg-foreground/10 px-1 py-px font-mono text-[10px] leading-none text-muted-foreground">
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
          className="absolute inset-0 rounded-pill bg-accent"
          aria-hidden
        />
      ) : null}
    </motion.div>
  )
}

/**
 * The More menu, one page deep.
 *
 * A parent with `children` (the built-in rewrite modes, or any plugin action
 * that declares sub-actions) opens as a second page rather than as a nested
 * flyout. A flyout would have to escape the measured shell to have anywhere to
 * go, and ADR-0093 forbids that: the native window is sized from the shell's
 * bounding box, so anything outside it is simply cropped.
 */
function ActionOverflowPanel({
  containerRef,
  placement,
  actions,
  label,
  chords,
  isMac,
  onAction,
  onClose,
  onResize,
  reduceMotion,
  title,
  backLabel,
  initialParentId,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  placement: SelectionToolbarPlacement
  actions: readonly SelectionActionDescriptor[]
  label: (action: SelectionActionDescriptor) => string
  chords: Record<string, string>
  isMac: boolean
  onAction: (id: string) => void
  onClose: () => void
  onResize: () => void
  reduceMotion: boolean
  title: string
  backLabel: string
  initialParentId?: string
}) {
  const [selectedParentId, setSelectedParentId] = useState<string | null | undefined>(undefined)
  const parentId = selectedParentId === undefined ? initialParentId : selectedParentId
  const parent = parentId ? (actions.find((action) => action.id === parentId) ?? null) : null
  const shownActions: SelectionActionDescriptor[] = parent?.children
    ? parent.children.map((child) => ({
        id: child.id,
        icon: parent.icon,
        label: child.title,
        mode: parent.mode,
        priority: parent.priority,
        pluginActionId: child.id,
        // No attribution on a child row. The user reached this page through
        // the parent, whose own row named the owner, so repeating it once per
        // mode is a column of the same word.
      }))
    : [...actions]

  return (
    <SelectionListPanel
      containerRef={containerRef}
      placement={placement}
      reduceMotion={reduceMotion}
      role="menu"
      label={parent ? label(parent) : title}
      onClose={onClose}
      // Skip the Back row: it is a way out, never the thing the user came for.
      focusIndex={parent ? 1 : 0}
      pageKey={parent?.id ?? "root"}
      onResize={onResize}
      className="min-w-52"
    >
      {parent ? (
        <>
          <SelectionListItem
            role="menuitem"
            label={backLabel}
            icon={<ArrowLeftIcon className="size-4" />}
            onClick={() => setSelectedParentId(null)}
            active
          />
          <SelectionDivider className="mx-1 my-1 h-px w-auto" />
        </>
      ) : null}
      {shownActions.map((action, index) => {
        const chord = action.shortcutId ? chords[action.shortcutId] : action.accelerator
        return (
          <SelectionListItem
            key={action.id}
            role="menuitem"
            label={label(action)}
            icon={<action.icon className="size-4" />}
            active={!parent && index === 0}
            // The plugin's own attribution, not the id's first segment. A row
            // reading `com.acme.tools` where the plugin is called "Acme Tools"
            // is the registry leaking into product copy.
            hint={
              chord ? (
                <kbd className="font-mono">{formatKeybinding(chord, isMac)}</kbd>
              ) : (
                (action.attribution ?? undefined)
              )
            }
            trailing={
              action.children?.length ? (
                <ChevronDownIcon className="size-3 -rotate-90 text-muted-foreground" />
              ) : null
            }
            onClick={() => {
              if (action.children?.length) setSelectedParentId(action.id)
              else onAction(action.id)
            }}
          />
        )
      })}
    </SelectionListPanel>
  )
}

function LocalePanel({
  containerRef,
  placement,
  targetLocale,
  onSelect,
  onClose,
  onResize,
  reduceMotion,
  title,
  label,
}: {
  containerRef: React.RefObject<HTMLElement | null>
  placement: SelectionToolbarPlacement
  targetLocale: TargetLocale
  onSelect: (locale: TargetLocale) => void
  onClose: () => void
  onResize: () => void
  reduceMotion: boolean
  title: string
  label: (locale: TargetLocale) => string
}) {
  const current = TARGET_LOCALES.indexOf(targetLocale)
  return (
    <SelectionListPanel
      containerRef={containerRef}
      placement={placement}
      reduceMotion={reduceMotion}
      role="listbox"
      label={title}
      onClose={onClose}
      // Land on the current target rather than nowhere.
      focusIndex={current >= 0 ? current : 0}
      onResize={onResize}
      className="min-w-40"
    >
      {TARGET_LOCALES.map((locale) => (
        <SelectionListItem
          key={locale}
          role="option"
          label={label(locale)}
          selected={locale === targetLocale}
          active={locale === targetLocale}
          onClick={() => onSelect(locale)}
          trailing={
            locale === targetLocale ? <CheckIcon className="size-3.5 shrink-0" /> : undefined
          }
        />
      ))}
    </SelectionListPanel>
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
        className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {/*
          A filled `SquareIcon` reads as a solid block against the pill, too
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
            // line rather than as a waveform.
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

/**
 * The one shape a sentence takes inside the pill.
 *
 * A refused write and a plugin's own status line are the same event as far as
 * the capsule is concerned: the action row is gone and one line of text has
 * taken its place. They differ in tone and in which live region announces
 * them, and in nothing else, so they are one component with two settings
 * rather than two components that were already drifting apart.
 */
function MessageBar({
  tone,
  message,
  reduceMotion,
}: {
  tone: "error" | "status"
  message: string
  reduceMotion: boolean
}) {
  const Icon = tone === "error" ? TriangleAlertIcon : InfoIcon
  return (
    <motion.div
      key={tone}
      layout={!reduceMotion}
      role={tone === "error" ? "alert" : "status"}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      transition={
        reduceMotion ? { duration: 0 } : { duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }
      }
      className={cn(
        "flex items-center gap-2 px-2 py-1 text-xs",
        tone === "error" ? "text-warning" : "text-muted-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="max-w-80 truncate whitespace-nowrap">{message}</span>
    </motion.div>
  )
}
