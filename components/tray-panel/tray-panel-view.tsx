"use client"

/**
 * Root view of the tray quick panel (ADR-0225): a mini control center rendered
 * by `app/tray-panel/page.tsx` inside the frameless, always-on-top
 * `"tray-panel"` Tauri window Rust opens when the user clicks the tray icon.
 *
 * Layout, top to bottom: a header (workspace scope, overall status, refresh,
 * settings, close), the glance stack (scrolls past the user's max height), the
 * delegate bar, and a footer (Edit, preset switch, open app, freshness). One
 * container; sections separated by hairlines. Edit swaps the stack for the
 * layout editor in place (ADR-0225 §12); every edit is a glance request, so
 * the main window stays the only writer of the layout.
 *
 * The panel runs nothing itself and owns no data. Everything it shows is the
 * Glance snapshot the main window publishes (`useGlanceConsumer`); everything
 * it does is either a glance request (routes and light actions) or a resolved
 * tray action handed to the main window over `tray-panel://run`.
 *
 * The action catalogue arrives in the snapshot too (ADR-0225 §10). Until the
 * first snapshot lands the quick actions say they are loading and the
 * delegate bar is absent, rather than offering a catalogue that may not be
 * the user's.
 *
 * Transient state is reset on every reveal (a hidden → shown transition),
 * because the window survives a dismissal for cheap re-show and each click
 * should open a fresh panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import {
  CheckIcon,
  ChevronDownIcon,
  MonitorIcon,
  PencilIcon,
  RefreshCwIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react"

import { GlanceProvider, type GlanceContextValue } from "@/components/glance/glance-context"
import { GlancePresetMenu } from "@/components/glance/glance-preset-menu"
import { GlanceDot } from "@/components/glance/glance-primitives"
import { GlanceStack } from "@/components/glance/glance-stack"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useGlanceConsumer } from "@/hooks/glance/use-glance-consumer"
import { withEditedEntries, withPreset } from "@/lib/glance/layout-edit"
import { DEFAULT_GLANCE_PANEL_SETTINGS } from "@/lib/glance/presets"
import type { GlanceRequestBody } from "@/lib/glance/requests"
import { GLANCE_SNAPSHOT_VERSION, type GlanceSnapshotV1 } from "@/lib/glance/snapshot"
import { schedulePetWindowReveal } from "@/lib/pet/reveal"
import {
  closeTrayPanel,
  onTrayPanelResult,
  onTrayPanelVisibility,
  resizeTrayPanel,
} from "@/lib/tauri/tray-panel"
import {
  actionForChord,
  chordFromEvent,
  openTriggeredActions,
  splitPanelActions,
} from "@/lib/tray-panel/resolve"
import type { TrayPanelAction } from "@/lib/tray-panel/types"
import { defaultSnapshot } from "@/lib/tray/sync"
import { cn } from "@/lib/utils"
import {
  GLANCE_MAX_HEIGHT_MAX,
  GLANCE_MAX_HEIGHT_MIN,
  GLANCE_WIDTH_PX,
  type GlanceLayoutEntry,
  type GlancePanelSettings,
  type GlancePresetId,
  type GlanceScope,
  type GlanceWidthStep,
} from "@/types/glance/layout"

import { TrayPanelDelegateBar } from "./tray-panel-delegate-bar"
import { TrayPanelEditMode } from "./tray-panel-edit-mode"
import { TrayPanelQuickActions, TrayPanelQuickActionsProvider } from "./tray-panel-quick-actions"
import { TrayPanelRunnerProvider, useTrayPanelRunnerState } from "./tray-panel-runner"

/** Extra px around the measured card so its shadow isn't clipped. */
const SHADOW_MARGIN = 16

export const TRAY_PANEL_CONSUMER = "tray-panel"
export const TRAY_PANEL_WINDOW_LABEL = "tray-panel"

/** One stable empty catalogue while the first snapshot is on its way. */
const NO_ACTIONS: readonly TrayPanelAction[] = []

/** Used until the first snapshot lands: the shipped layout, every slice loading. */
export function placeholderSnapshot(): GlanceSnapshotV1 {
  return {
    version: GLANCE_SNAPSHOT_VERSION,
    epoch: 0,
    revision: 0,
    generatedAt: 0,
    config: DEFAULT_GLANCE_PANEL_SETTINGS,
    workspace: null,
    when: defaultSnapshot(),
    actions: [],
    fleet: null,
    usage: null,
    quota: null,
    agenda: null,
    activity: null,
    recents: null,
    pet: null,
  }
}

export type TrayPanelStatus =
  | { kind: "automation" }
  | { kind: "awaiting"; running: number; awaiting: number }
  | { kind: "running"; running: number }
  | { kind: "idle" }

/** The header pill: automation outranks a waiting task, which outranks work. */
export function trayPanelStatus(snapshot: GlanceSnapshotV1): TrayPanelStatus {
  if (snapshot.when.automation.running) return { kind: "automation" }
  const running = snapshot.fleet?.counts.working ?? snapshot.when.chat.activeCount ?? 0
  const awaiting = snapshot.fleet?.counts.awaiting ?? (snapshot.when.chat.awaitingApproval ? 1 : 0)
  if (awaiting > 0) return { kind: "awaiting", running, awaiting }
  if (running > 0) return { kind: "running", running }
  return { kind: "idle" }
}

/** Every element arrow keys may land on, in render order, visible only. */
function navTargets(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-glance-nav]")].filter(
    (el) => el.offsetParent !== null && !el.hasAttribute("disabled")
  )
}

export function TrayPanelView() {
  const t = useTranslations("trayPanel")
  const tGlance = useTranslations("glance")
  const format = useFormatter()
  const cardRef = useRef<HTMLDivElement>(null)

  const [visible, setVisible] = useState(true)
  const visibleRef = useRef(true)
  const {
    snapshot: received,
    receivedCount,
    send,
  } = useGlanceConsumer(TRAY_PANEL_CONSUMER, TRAY_PANEL_WINDOW_LABEL, visible)
  const receivedCountRef = useRef(receivedCount)
  useEffect(() => {
    receivedCountRef.current = receivedCount
  }, [receivedCount])
  const [placeholder] = useState(placeholderSnapshot)
  const snapshot = received ?? placeholder
  const actionsKnown = received !== null
  const actions = received?.actions ?? NO_ACTIONS

  // Edit mode shows the user's edits at once; each is also sent, and the
  // snapshot that follows confirms it. The draft wins until Done.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<GlancePanelSettings | null>(null)
  const config = editing && draft ? draft : snapshot.config

  const { delegate, quick } = useMemo(
    () => splitPanelActions(actions, snapshot.when, config.showDelegate),
    [actions, snapshot.when, config.showDelegate]
  )

  const runner = useTrayPanelRunnerState(actions)
  const { reset, run, settle } = runner
  const [glanceFailure, setGlanceFailure] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [revealNonce, setRevealNonce] = useState(0)
  // The snapshot count at the latest reveal: open-triggered actions wait for
  // a snapshot newer than that, so they run against the current catalogue.
  const [armedAt, setArmedAt] = useState(0)
  const firedForReveal = useRef<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // A clock for relative labels, ticking only while the panel is on screen.
  useEffect(() => {
    if (!visible) return
    const first = setTimeout(() => setNow(Date.now()), 0)
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [visible])

  // Paint through to the desktop while mounted (transparent page background).
  useEffect(() => {
    const root = document.documentElement
    root.dataset.petOverlay = "1"
    return () => {
      delete root.dataset.petOverlay
    }
  }, [])

  // Reveal only AFTER the first painted frame: Rust creates the window hidden
  // so the user never sees the pre-hydration opaque background. Focus so the
  // native blur-to-close arms and the keyboard works immediately.
  useEffect(() => schedulePetWindowReveal({ focus: true }), [])

  // A native re-show reuses this webview, so the reset hangs off the event.
  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void onTrayPanelVisibility((shown) => {
      if (disposed) return
      const wasVisible = visibleRef.current
      visibleRef.current = shown
      setVisible(shown)
      // Only a hidden → shown transition is a reveal. Rust also announces the
      // very first show, which this webview may hear after mounting: that is
      // the same reveal as the mount, not a second one.
      if (!shown || wasVisible) return
      reset()
      setGlanceFailure(null)
      setEditing(false)
      setDraft(null)
      setArmedAt(receivedCountRef.current)
      setRevealNonce((value) => value + 1)
    }).then((dispose) => {
      if (disposed) dispose()
      else off = dispose
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [reset])

  // The main window reports tray-action failures back, so the panel can say
  // what went wrong instead of silently dismissing.
  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void onTrayPanelResult((result) => {
      if (!disposed) settle(result.ok, result.error)
    }).then((dispose) => {
      if (disposed) dispose()
      else off = dispose
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [settle])

  // `open`-triggered actions fire once per reveal (read-only by construction).
  const openActions = useMemo(
    () => openTriggeredActions(actions, snapshot.when),
    [actions, snapshot.when]
  )
  useEffect(() => {
    if (receivedCount <= armedAt || firedForReveal.current === revealNonce) return
    firedForReveal.current = revealNonce
    if (openActions.length === 0) return
    queueMicrotask(() => {
      for (const action of openActions) void run(action)
    })
  }, [openActions, receivedCount, armedAt, revealNonce, run])

  /** Route to an owner surface: the panel steps aside once the main window took it. */
  const route = useCallback(
    (body: GlanceRequestBody) => {
      setGlanceFailure(null)
      void send(body).then((errorKey) => {
        if (errorKey) setGlanceFailure(tGlance(errorKey))
        else void closeTrayPanel()
      })
    },
    [send, tGlance]
  )
  const sendLight = useCallback(
    async (body: GlanceRequestBody) => {
      const errorKey = await send(body)
      setGlanceFailure(errorKey ? tGlance(errorKey) : null)
      return errorKey
    },
    [send, tGlance]
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await sendLight({ kind: "refresh" })
    setRefreshing(false)
  }, [sendLight])

  /** Apply an edit locally and send it; a failed send drops back to what is stored. */
  const edit = useCallback(
    (next: GlancePanelSettings, body: GlanceRequestBody) => {
      setDraft(next)
      void sendLight(body).then((errorKey) => {
        if (errorKey) setDraft(null)
      })
    },
    [sendLight]
  )
  const editEntries = (entries: GlanceLayoutEntry[]) =>
    edit(withEditedEntries(config, entries), { kind: "set-layout", entries })
  const applyPreset = (preset: GlancePresetId) => {
    const next = withPreset(config, preset)
    if (editing) edit(next, { kind: "apply-preset", preset })
    else void sendLight({ kind: "apply-preset", preset })
  }
  const setDelegateVisible = (shown: boolean) =>
    edit({ ...config, showDelegate: shown }, { kind: "set-delegate-visible", visible: shown })
  const setWidth = (width: GlanceWidthStep) =>
    edit({ ...config, width }, { kind: "set-width", width })
  const finishEditing = useCallback(() => {
    setEditing(false)
    setDraft(null)
  }, [])

  // Escape dismisses; arrows walk the rows; → / ← open and close an
  // expandable row; a bound chord runs its action. Blur dismissal is native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A control that handled the key itself (a menu, a drag in the editor
      // cancelling on Escape) owns it.
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      const typing = target?.tagName === "TEXTAREA" || target?.tagName === "INPUT"
      if (e.key === "Escape") {
        // In edit mode Escape leaves the editor; the panel stays open.
        if (editing) finishEditing()
        else void closeTrayPanel()
        return
      }
      // The editor's rows reorder with the arrows; no row walking or chords there.
      if (editing) return
      const card = cardRef.current
      if (card && !typing && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const targets = navTargets(card)
        if (targets.length === 0) return
        e.preventDefault()
        const index = targets.indexOf(document.activeElement as HTMLElement)
        const next =
          index < 0
            ? targets[e.key === "ArrowDown" ? 0 : targets.length - 1]
            : targets[
                Math.max(0, Math.min(targets.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))
              ]
        next.focus()
        next.scrollIntoView({ block: "nearest" })
        return
      }
      if (!typing && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        const active = document.activeElement as HTMLElement | null
        if (active?.dataset.glanceExpand !== undefined) {
          const open = active.getAttribute("aria-expanded") === "true"
          if ((e.key === "ArrowRight" && !open) || (e.key === "ArrowLeft" && open)) {
            e.preventDefault()
            active.click()
          }
        }
        return
      }
      if (typing) return
      const match = actionForChord(actions, snapshot.when, chordFromEvent(e))
      if (match) {
        e.preventDefault()
        void run(match)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [actions, snapshot.when, run, editing, finishEditing])

  // Max height: the stored value, or the live value while the edge is dragged.
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const maxHeight = dragHeight ?? config.maxHeight
  const onGripPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const card = cardRef.current
    if (!card) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = card.getBoundingClientRect().height
    const grip = event.currentTarget
    grip.setPointerCapture(event.pointerId)
    let latest = startHeight
    const move = (ev: PointerEvent) => {
      latest = Math.round(
        Math.min(
          GLANCE_MAX_HEIGHT_MAX,
          Math.max(GLANCE_MAX_HEIGHT_MIN, startHeight + ev.clientY - startY)
        )
      )
      setDragHeight(latest)
    }
    const up = () => {
      grip.removeEventListener("pointermove", move)
      grip.removeEventListener("pointerup", up)
      grip.removeEventListener("pointercancel", up)
      void sendLight({ kind: "set-max-height", maxHeight: latest }).then(() => setDragHeight(null))
    }
    grip.addEventListener("pointermove", move)
    grip.addEventListener("pointerup", up)
    grip.addEventListener("pointercancel", up)
  }
  const onGripKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    event.stopPropagation()
    const next = Math.min(
      GLANCE_MAX_HEIGHT_MAX,
      Math.max(GLANCE_MAX_HEIGHT_MIN, config.maxHeight + (event.key === "ArrowDown" ? 40 : -40))
    )
    void sendLight({ kind: "set-max-height", maxHeight: next })
  }

  // Fit the native window to the card: SIZE ONLY, never reposition, so the
  // panel grows from its fixed top-left.
  const lastSize = useRef<{ w: number; h: number } | null>(null)
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const fit = () => {
      const w = Math.ceil(el.offsetWidth) + SHADOW_MARGIN
      const h = Math.ceil(el.offsetHeight) + SHADOW_MARGIN
      if (w <= SHADOW_MARGIN || h <= SHADOW_MARGIN) return
      const prev = lastSize.current
      if (prev && prev.w === w && prev.h === h) return
      lastSize.current = { w, h }
      void resizeTrayPanel(w, h)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    return () => ro.disconnect()
  }, [])

  const status = trayPanelStatus(snapshot)
  const openSettings: TrayPanelAction = {
    id: "trayPanel.__settings",
    label: t("openSettings"),
    fields: [],
    trigger: { kind: "manual" },
    effect: { kind: "native", action: "settings" },
  }
  const openApp: TrayPanelAction = {
    id: "trayPanel.__openApp",
    label: t("footer.openApp"),
    fields: [],
    trigger: { kind: "manual" },
    effect: { kind: "native", action: "show" },
  }

  const glance: GlanceContextValue = {
    snapshot,
    platform: "desktop",
    width: config.width,
    now,
    send: sendLight,
    route,
  }

  const setScope = (scope: GlanceScope) => {
    if (scope !== config.scope) void sendLight({ kind: "set-scope", scope })
  }
  const failure = runner.failure ?? glanceFailure

  return (
    <div className="flex min-h-screen w-screen items-start justify-center bg-transparent p-2">
      <div
        ref={cardRef}
        data-testid="tray-panel-card"
        data-width={config.width}
        style={{ width: GLANCE_WIDTH_PX[config.width], maxHeight }}
        className="flex flex-col overflow-hidden rounded-xl border bg-popover/95 text-popover-foreground shadow-lg backdrop-blur-xl"
      >
        <GlanceProvider value={glance}>
          <TrayPanelRunnerProvider runner={runner}>
            <header className="flex shrink-0 items-center gap-1.5 border-b py-2 pl-3.5 pr-2">
              <span className="shrink-0 text-[13px] font-semibold tracking-tight">
                {t("title")}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("scope.label")}
                    className="inline-flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="truncate">
                      {config.scope === "workspace" && snapshot.workspace
                        ? snapshot.workspace.name
                        : t("scope.all")}
                    </span>
                    <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-60">
                  <DropdownMenuLabel className="text-xs">{t("scope.label")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => setScope("all")}>
                    <CheckIcon className={cn("size-3.5", config.scope !== "all" && "invisible")} />
                    {t("scope.all")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!snapshot.workspace}
                    onSelect={() => setScope("workspace")}
                  >
                    <CheckIcon
                      className={cn("size-3.5", config.scope !== "workspace" && "invisible")}
                    />
                    <span className="truncate">
                      {snapshot.workspace
                        ? t("scope.workspace", { name: snapshot.workspace.name })
                        : t("scope.noWorkspace")}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("scope.hint")}</p>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                data-testid="tray-panel-status"
                onClick={() =>
                  status.kind === "idle"
                    ? undefined
                    : route(
                        status.kind === "awaiting"
                          ? { kind: "open-fleet", filter: "awaiting" }
                          : { kind: "open-fleet" }
                      )
                }
                disabled={status.kind === "idle"}
                className="inline-flex min-w-0 items-center gap-1.5 overflow-hidden rounded-full bg-muted px-2 py-0.5 text-[11.5px] enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <GlanceDot
                  tone={
                    status.kind === "automation" || status.kind === "awaiting"
                      ? "warn"
                      : status.kind === "running"
                        ? "run"
                        : "idle"
                  }
                  pulse={status.kind === "running"}
                />
                <span className="truncate">
                  {status.kind === "automation"
                    ? t("status.automation")
                    : status.kind === "awaiting"
                      ? config.width === "narrow"
                        ? t("status.awaitingShort", {
                            running: status.running,
                            awaiting: status.awaiting,
                          })
                        : t("status.awaiting", {
                            running: status.running,
                            awaiting: status.awaiting,
                          })
                      : status.kind === "running"
                        ? t("status.running", { count: status.running })
                        : t("status.idle")}
                </span>
              </button>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0"
                aria-label={t("refresh")}
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0"
                aria-label={t("openSettings")}
                onClick={() => void run(openSettings)}
              >
                <SettingsIcon className="size-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-6 shrink-0"
                aria-label={t("dismiss")}
                onClick={() => void closeTrayPanel()}
              >
                <XIcon className="size-3.5" />
              </Button>
            </header>

            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
              data-testid="tray-panel-body"
            >
              {editing ? (
                <TrayPanelEditMode
                  config={config}
                  plugins={snapshot.plugins?.catalog}
                  onEntries={editEntries}
                  onDelegateVisible={setDelegateVisible}
                  onWidth={setWidth}
                />
              ) : (
                <TrayPanelQuickActionsProvider actions={actionsKnown ? quick : null}>
                  <GlanceStack
                    entries={config.entries}
                    renderers={{ quick: TrayPanelQuickActions }}
                  />
                </TrayPanelQuickActionsProvider>
              )}
            </div>

            {delegate && !editing ? (
              <TrayPanelDelegateBar
                action={delegate}
                autoFocus={config.autofocusDelegate}
                revealNonce={revealNonce}
              />
            ) : null}

            {failure ? (
              <p className="shrink-0 border-t px-3.5 py-1.5 text-xs text-destructive" role="alert">
                {failure}
              </p>
            ) : null}

            <footer className="flex shrink-0 items-center gap-1 px-2 pb-1 pt-1 text-[11.5px] text-muted-foreground">
              {editing ? (
                <button
                  type="button"
                  data-testid="tray-panel-edit-done"
                  onClick={finishEditing}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <CheckIcon aria-hidden className="size-3" />
                  {t("edit.done")}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="tray-panel-edit"
                  disabled={!received}
                  onClick={() => setEditing(true)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  <PencilIcon aria-hidden className="size-3" />
                  {t("edit.start")}
                </button>
              )}
              <GlancePresetMenu
                preset={config.preset}
                onApply={applyPreset}
                disabled={!received}
                side="top"
              />
              <button
                type="button"
                onClick={() => void run(openApp)}
                aria-label={t("footer.openApp")}
                title={t("footer.openApp")}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <MonitorIcon aria-hidden className="size-3" />
                {/* At the narrow width the footer keeps Edit and the preset readable; the icon carries the name. */}
                <span aria-hidden className={cn(config.width === "narrow" && "hidden")}>
                  {t("footer.openApp")}
                </span>
              </button>
              <span className="min-w-0 flex-1" />
              <span className="min-w-0 truncate tabular-nums" data-testid="tray-panel-updated">
                {received
                  ? t("footer.updated", {
                      when: format.relativeTime(new Date(snapshot.generatedAt), now),
                    })
                  : t("footer.connecting")}
              </span>
            </footer>
          </TrayPanelRunnerProvider>
        </GlanceProvider>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("resize")}
          aria-valuemin={GLANCE_MAX_HEIGHT_MIN}
          aria-valuemax={GLANCE_MAX_HEIGHT_MAX}
          aria-valuenow={maxHeight}
          tabIndex={0}
          data-testid="tray-panel-resize"
          onPointerDown={onGripPointerDown}
          onKeyDown={onGripKeyDown}
          className="group grid h-2 shrink-0 cursor-ns-resize place-items-center focus-visible:outline-none"
        >
          <span className="h-[3px] w-8 rounded-full bg-muted transition-colors group-hover:bg-muted-foreground/50 group-focus-visible:bg-ring" />
        </div>
      </div>
    </div>
  )
}
