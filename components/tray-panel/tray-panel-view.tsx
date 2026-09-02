"use client"

/**
 * Root view of the tray quick panel — rendered by `app/tray-panel/page.tsx`
 * inside the frameless, always-on-top `"tray-panel"` Tauri window that Rust
 * opens when the user clicks the tray icon.
 *
 * The panel runs NOTHING itself. It resolves an action against the values the
 * user typed and hands the result to the main window over `tray-panel://run`;
 * that window owns the chat stores, the router and the command registries. This
 * is the same split the selection toolbar uses, and it is what keeps this
 * webview least-privilege (see `src-tauri/capabilities/tray-panel.json`).
 *
 * Transient state — which action is expanded, half-typed values, validation
 * errors — is reset on every `tray-panel://shown`, because the window survives
 * a dismissal for cheap re-show and the user expects a fresh panel each time
 * they click the icon.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRightIcon, Loader2Icon, SendIcon, SettingsIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { schedulePetWindowReveal } from "@/lib/pet/reveal"
import { DELEGATE_PROMPT_FIELD, resolveLabel } from "@/lib/tray-panel/defaults"
import {
  actionForChord,
  chordFromEvent,
  openTriggeredActions,
  resolveAction,
  resolvePrimaryAction,
  visibleActions,
  type TrayPanelValidationError,
} from "@/lib/tray-panel/resolve"
import { useTrayPanelStore } from "@/lib/tray-panel/store"
import { defaultValuesFor } from "@/lib/tray-panel/template"
import type { TrayPanelAction, TrayPanelFieldValue, TrayPanelValues } from "@/lib/tray-panel/types"
import { defaultSnapshot } from "@/lib/tray/sync"
import { USAGE_REFRESH_COMMAND } from "@/lib/tray/usage-section"
import type { TrayStateSnapshot } from "@/lib/tray/types"
import {
  closeTrayPanel,
  onTrayPanelResult,
  onTrayPanelState,
  onTrayPanelVisibility,
  requestTrayPanelState,
  resizeTrayPanel,
  runNativeTrayAction,
  sendTrayPanelRequest,
} from "@/lib/tauri/tray-panel"
import { showMainWindow } from "@/lib/tauri/pet-window"
import { cn } from "@/lib/utils"

import { TrayPanelFieldControl } from "./tray-panel-field-control"
import { TrayPanelUsageSection } from "./tray-panel-usage-section"

/** Extra px around the measured card so its shadow isn't clipped. */
const SHADOW_MARGIN = 16

/** Synthetic action id for the usage refresh button, so `busyId` can track it. */
export const USAGE_REFRESH_ACTION_ID = "trayPanel.__usageRefresh"

/** Where "Open full usage" lands in the main window. */
export const USAGE_SETTINGS_PATH = "/settings?section=subscription"

/** Seed every visible action's form with its declared defaults. */
export function seedValues(actions: readonly TrayPanelAction[]): Record<string, TrayPanelValues> {
  const out: Record<string, TrayPanelValues> = {}
  for (const action of actions) out[action.id] = defaultValuesFor(action.fields)
  return out
}

export function TrayPanelView() {
  const t = useTranslations("trayPanel")
  const tRoot = useTranslations()
  const cardRef = useRef<HTMLDivElement>(null)

  const actions = useTrayPanelStore((s) => s.actions)
  const hydrate = useTrayPanelStore((s) => s.hydrate)
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // The panel has no Dexie and no app stores, so the snapshot its `when`
  // expressions read is pushed by the main window on request. Until it lands,
  // the neutral default keeps every ungated action visible rather than hiding
  // the whole list behind an unanswered request.
  const [snapshot, setSnapshot] = useState<TrayStateSnapshot>(() => defaultSnapshot())
  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void onTrayPanelState<TrayStateSnapshot>((next) => {
      if (!disposed && next) setSnapshot(next)
    }).then((dispose) => {
      if (disposed) dispose()
      else off = dispose
    })
    void requestTrayPanelState()
    return () => {
      disposed = true
      off?.()
    }
  }, [])

  const visible = useMemo(() => visibleActions(actions, snapshot), [actions, snapshot])
  const primary = useMemo(() => resolvePrimaryAction(actions, snapshot), [actions, snapshot])
  const secondary = useMemo(
    () => visible.filter((a) => a.id !== primary?.id && a.trigger.kind !== "open"),
    [visible, primary]
  )

  // Declared defaults are DERIVED from the catalogue, never copied into state:
  // an action edited in settings while the panel was closed must not keep
  // values keyed to fields that no longer exist, and seeding through an effect
  // would be a cascading render (`react-hooks/set-state-in-effect`). Only what
  // the user actually typed is state, layered on top.
  const declaredDefaults = useMemo(() => seedValues(actions), [actions])
  const [overrides, setOverrides] = useState<Record<string, TrayPanelValues>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [errorsByAction, setErrorsByAction] = useState<Record<string, TrayPanelValidationError[]>>(
    {}
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [revealNonce, setRevealNonce] = useState(0)
  const firedForRef = useRef<string | null>(null)

  const valuesFor = useCallback(
    (actionId: string): TrayPanelValues => ({
      ...(declaredDefaults[actionId] ?? {}),
      ...(overrides[actionId] ?? {}),
    }),
    [declaredDefaults, overrides]
  )

  /** Drop everything transient. Called from the re-open event, not an effect. */
  const reset = useCallback(() => {
    setOverrides({})
    setExpandedId(null)
    setErrorsByAction({})
    setBusyId(null)
    setFailure(null)
  }, [])

  // Paint through to the desktop while mounted (transparent page background).
  useEffect(() => {
    const root = document.documentElement
    root.dataset.petOverlay = "1"
    return () => {
      delete root.dataset.petOverlay
    }
  }, [])

  // Reveal only AFTER the first painted frame — Rust creates the window
  // `visible(false)` so the user never sees the pre-hydration opaque page
  // background inside what must be a transparent window. Focus so the native
  // blur-to-close arms and the composer is typeable immediately.
  useEffect(() => schedulePetWindowReveal({ focus: true }), [])

  // A native re-show reuses this webview, so the reset has to hang off the
  // event rather than off mount.
  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void onTrayPanelVisibility((shown) => {
      if (disposed || !shown) return
      reset()
      void hydrate().then(() => {
        if (disposed) return
        // Keep the previous reveal key armed until hydration settles: `reset`
        // changes the `run` callback identity, and clearing this earlier would
        // let that render execute the stale pre-hydration open action.
        firedForRef.current = null
        void requestTrayPanelState()
        setRevealNonce((value) => value + 1)
      })
    }).then((dispose) => {
      if (disposed) dispose()
      else off = dispose
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [hydrate, reset])

  // The main window reports failures back so the panel can say what went wrong
  // instead of silently dismissing. Successes need no message — the window is
  // already coming forward with the result.
  useEffect(() => {
    let disposed = false
    let off: (() => void) | undefined
    void onTrayPanelResult((result) => {
      if (disposed) return
      setBusyId(null)
      if (!result.ok) setFailure(result.error ?? t("errors.runFailed"))
    }).then((dispose) => {
      if (disposed) dispose()
      else off = dispose
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [t])

  const run = useCallback(
    async (action: TrayPanelAction) => {
      const label = resolveLabel(action, (key) => tRoot(key))
      const resolved = resolveAction(action, valuesFor(action.id), crypto.randomUUID(), label)
      if (!resolved.ok) {
        setErrorsByAction((prev) => ({ ...prev, [action.id]: resolved.errors }))
        // Expand so the offending field is on screen when it gets highlighted.
        if (action.fields.length > 0) setExpandedId(action.id)
        return
      }
      setErrorsByAction((prev) => ({ ...prev, [action.id]: [] }))
      setBusyId(action.id)
      setFailure(null)

      // Native actions are implemented in Rust and already emit the legacy
      // `tray://*` events the main window listens for — no round trip needed,
      // and they keep working while that window is still booting.
      if (resolved.request.effect.kind === "native") {
        const ok = await runNativeTrayAction(resolved.request.effect.action)
        setBusyId(null)
        if (!ok) {
          setFailure(t("errors.runFailed"))
          return
        }
        void closeTrayPanel()
        return
      }

      // Raise the window from here rather than waiting for the main window to
      // do it: the feedback is instant, and it does not depend on a listener
      // in a window that may still be booting.
      if (resolved.request.focusMainWindow) void showMainWindow()

      const sent = await sendTrayPanelRequest(resolved.request)
      if (!sent) {
        setBusyId(null)
        setFailure(t("errors.deliveryFailed"))
        return
      }
      // Dismiss like a menu selection. The main window owns the outcome from
      // here; a failure arrives as a toast there.
      void closeTrayPanel()
    },
    [valuesFor, t, tRoot]
  )

  // `open`-triggered actions fire once per reveal. Restricted to read-only
  // effects by `isTriggerLegal`, so this can never start a billed turn.
  const openActions = useMemo(() => openTriggeredActions(actions, snapshot), [actions, snapshot])
  useEffect(() => {
    if (openActions.length === 0) return
    const key = openActions.map((a) => a.id).join("|")
    if (firedForRef.current === key) return
    firedForRef.current = key
    // Deferred out of the effect body: `run` sets state on its synchronous
    // path (busy flag, cleared errors), and doing that inline would cascade a
    // render right after mount.
    queueMicrotask(() => {
      for (const action of openActions) void run(action)
    })
  }, [openActions, revealNonce, run])

  // Escape dismisses; a bound chord runs its action. Blur dismissal is native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void closeTrayPanel()
        return
      }
      const match = actionForChord(actions, snapshot, chordFromEvent(e))
      if (match) {
        e.preventDefault()
        void run(match)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [actions, snapshot, run])

  // Fit the native window to the card — SIZE ONLY, never reposition, so
  // expanding an action's form grows the panel from its fixed top-left.
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

  const setFieldValue = (actionId: string, fieldId: string, value: TrayPanelFieldValue) => {
    setOverrides((prev) => ({
      ...prev,
      [actionId]: { ...(prev[actionId] ?? {}), [fieldId]: value },
    }))
  }

  const invalidFields = (actionId: string): Set<string> =>
    new Set(
      (errorsByAction[actionId] ?? [])
        .filter(
          (e): e is Extract<TrayPanelValidationError, { kind: "required" }> => e.kind === "required"
        )
        .map((e) => e.fieldId)
    )

  const errorMessage = (actionId: string): string | null => {
    const errors = errorsByAction[actionId] ?? []
    if (errors.length === 0) return null
    const first = errors[0]
    switch (first.kind) {
      case "required":
        return t("errors.required")
      case "unknownPlaceholder":
        return t("errors.unknownPlaceholder", { ids: first.ids.join(", ") })
      case "badTarget":
        return t("errors.badTarget", { value: first.value })
      case "illegalTrigger":
        return t("errors.illegalTrigger")
      case "emptyEffect":
        return t("errors.emptyEffect")
    }
  }

  return (
    <div className="flex min-h-screen w-screen items-start justify-center bg-transparent p-2">
      <div
        ref={cardRef}
        data-testid="tray-panel-card"
        className="w-full overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg"
      >
        <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <span className="text-xs font-semibold tracking-tight">{t("title")}</span>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={t("openSettings")}
              onClick={() =>
                void run({
                  id: "trayPanel.__settings",
                  label: t("openSettings"),
                  fields: [],
                  trigger: { kind: "manual" },
                  effect: { kind: "native", action: "settings" },
                })
              }
            >
              <SettingsIcon className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={t("dismiss")}
              onClick={() => void closeTrayPanel()}
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </header>

        {/*
          Spend readout (ADR-0165). The projection's presence IS the gate: the
          main window only builds one when the tray leads with a spend metric,
          so a quota-configured install sees the panel it has always had and
          this component needs no second copy of that pref to stay in sync.
          Both controls travel the same cross-window request path as every
          other action, because this webview owns no Dexie and starts no scan.
        */}
        {snapshot.usage?.glance ? (
          <TrayPanelUsageSection
            glance={snapshot.usage.glance}
            metric={snapshot.usage.glance.query.metric}
            refreshing={busyId === USAGE_REFRESH_ACTION_ID}
            onRefresh={() =>
              void run({
                id: USAGE_REFRESH_ACTION_ID,
                label: t("usage.refresh"),
                fields: [],
                trigger: { kind: "manual" },
                effect: { kind: "command", commandId: USAGE_REFRESH_COMMAND },
                focusMainWindow: false,
              })
            }
            onOpenFull={() =>
              void run({
                id: "trayPanel.__usageOpen",
                label: t("usage.openFull"),
                fields: [],
                trigger: { kind: "manual" },
                effect: { kind: "navigate", path: USAGE_SETTINGS_PATH },
              })
            }
          />
        ) : null}

        {primary ? (
          <section className="space-y-2.5 border-b px-3 py-3" data-testid="tray-panel-primary">
            {primary.fields.map((field, index) => (
              <TrayPanelFieldControl
                key={field.id}
                field={field}
                value={valuesFor(primary.id)[field.id]}
                invalid={invalidFields(primary.id).has(field.id)}
                autoFocus={index === 0 && field.id === DELEGATE_PROMPT_FIELD}
                onChange={(next) => setFieldValue(primary.id, field.id, next)}
                onSubmit={() => void run(primary)}
              />
            ))}
            {errorMessage(primary.id) ? (
              <p className="text-xs text-destructive">{errorMessage(primary.id)}</p>
            ) : null}
            <Button
              size="sm"
              className="h-8 w-full"
              disabled={busyId === primary.id}
              onClick={() => void run(primary)}
            >
              {busyId === primary.id ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <SendIcon className="size-3.5" />
              )}
              {resolveLabel(primary, (key) => tRoot(key))}
            </Button>
          </section>
        ) : null}

        <ScrollArea className="max-h-64">
          <div className="flex flex-col p-1.5" data-testid="tray-panel-actions">
            {secondary.length === 0 ? (
              <p className="px-2 py-3 text-center text-xs text-muted-foreground">{t("empty")}</p>
            ) : null}
            {secondary.map((action) => {
              const Icon = resolveIcon(action.icon)
              const expanded = expandedId === action.id
              const hasFields = action.fields.length > 0
              return (
                <div key={action.id} className="min-w-0">
                  <button
                    type="button"
                    data-testid={`tray-panel-action-${action.id}`}
                    aria-expanded={hasFields ? expanded : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                      "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:bg-accent",
                      busyId === action.id && "opacity-60"
                    )}
                    onClick={() => {
                      // An action with inputs opens its form first; one without
                      // runs straight away, which is what a menu row should do.
                      if (hasFields) setExpandedId(expanded ? null : action.id)
                      else void run(action)
                    }}
                  >
                    {Icon ? <Icon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                    <span className="min-w-0 flex-1 truncate">
                      {resolveLabel(action, (key) => tRoot(key))}
                    </span>
                    {action.trigger.kind === "hotkey" ? (
                      <kbd className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                        {action.trigger.chord}
                      </kbd>
                    ) : null}
                    {hasFields ? (
                      <ChevronRightIcon
                        aria-hidden
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground transition-transform",
                          expanded && "rotate-90"
                        )}
                      />
                    ) : null}
                  </button>
                  {hasFields && expanded ? (
                    <div className="space-y-2.5 rounded-md bg-muted/40 px-2.5 py-2.5">
                      {action.fields.map((field) => (
                        <TrayPanelFieldControl
                          key={field.id}
                          field={field}
                          value={valuesFor(action.id)[field.id]}
                          invalid={invalidFields(action.id).has(field.id)}
                          onChange={(next) => setFieldValue(action.id, field.id, next)}
                          onSubmit={() => void run(action)}
                        />
                      ))}
                      {errorMessage(action.id) ? (
                        <p className="text-xs text-destructive">{errorMessage(action.id)}</p>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 w-full text-xs"
                        disabled={busyId === action.id}
                        onClick={() => void run(action)}
                      >
                        {t("run")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </ScrollArea>

        {failure ? (
          <p className="border-t px-3 py-2 text-xs text-destructive" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    </div>
  )
}
