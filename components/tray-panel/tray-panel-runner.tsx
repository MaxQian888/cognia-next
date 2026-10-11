"use client"

/**
 * The tray panel's action runner: values the user typed, validation errors,
 * the busy action, the failure line, and `run` itself.
 *
 * Shared by the delegate bar (the primary action) and the quick-actions module
 * (every other action), which used to live in one component. Splitting the
 * view into a glance stack (ADR-0225) would otherwise have duplicated this
 * state in two places that must agree on it: a validation error raised by the
 * delegate bar has to clear when the user fixes the field in the same bar, and
 * only one action may be in flight at a time across both.
 *
 * Nothing runs here either. A resolved action goes to Rust (native effects) or
 * to the main window over `tray-panel://run`, exactly as before.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import { showMainWindow } from "@/lib/tauri/pet-window"
import { closeTrayPanel, runNativeTrayAction, sendTrayPanelRequest } from "@/lib/tauri/tray-panel"
import { resolveLabel } from "@/lib/tray-panel/defaults"
import { resolveAction, type TrayPanelValidationError } from "@/lib/tray-panel/resolve"
import { defaultValuesFor } from "@/lib/tray-panel/template"
import type { TrayPanelAction, TrayPanelFieldValue, TrayPanelValues } from "@/lib/tray-panel/types"

/** Seed every action's form with its declared defaults. */
export function seedValues(actions: readonly TrayPanelAction[]): Record<string, TrayPanelValues> {
  const out: Record<string, TrayPanelValues> = {}
  for (const action of actions) out[action.id] = defaultValuesFor(action.fields)
  return out
}

export interface TrayPanelRunner {
  valuesFor: (actionId: string) => TrayPanelValues
  setFieldValue: (actionId: string, fieldId: string, value: TrayPanelFieldValue) => void
  invalidFields: (actionId: string) => Set<string>
  errorMessage: (actionId: string) => string | null
  busyId: string | null
  failure: string | null
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  run: (action: TrayPanelAction) => Promise<void>
  /** Drop everything transient. Called on every reveal. */
  reset: () => void
  /** Called when the main window reports a request's outcome. */
  settle: (ok: boolean, error?: string) => void
}

export function useTrayPanelRunnerState(actions: readonly TrayPanelAction[]): TrayPanelRunner {
  const t = useTranslations("trayPanel")
  const tRoot = useTranslations()

  // Declared defaults are DERIVED from the catalogue, never copied into state:
  // an action edited in settings while the panel was closed must not keep
  // values keyed to fields that no longer exist. Only what the user typed is
  // state, layered on top.
  const declaredDefaults = useMemo(() => seedValues(actions), [actions])
  const [overrides, setOverrides] = useState<Record<string, TrayPanelValues>>({})
  const [errorsByAction, setErrorsByAction] = useState<Record<string, TrayPanelValidationError[]>>(
    {}
  )
  const [busyId, setBusyId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const valuesFor = useCallback(
    (actionId: string): TrayPanelValues => ({
      ...(declaredDefaults[actionId] ?? {}),
      ...(overrides[actionId] ?? {}),
    }),
    [declaredDefaults, overrides]
  )

  const setFieldValue = useCallback(
    (actionId: string, fieldId: string, value: TrayPanelFieldValue) => {
      setOverrides((prev) => ({
        ...prev,
        [actionId]: { ...(prev[actionId] ?? {}), [fieldId]: value },
      }))
    },
    []
  )

  const reset = useCallback(() => {
    setOverrides({})
    setExpandedId(null)
    setErrorsByAction({})
    setBusyId(null)
    setFailure(null)
  }, [])

  const settle = useCallback(
    (ok: boolean, error?: string) => {
      setBusyId(null)
      if (!ok) setFailure(error ?? t("errors.runFailed"))
    },
    [t]
  )

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
      // `tray://*` events the main window listens for: no round trip, and they
      // keep working while that window is still booting.
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

      // Raise the window from here rather than waiting for the main window:
      // the feedback is instant and does not depend on a booting listener.
      if (resolved.request.focusMainWindow) void showMainWindow()

      const sent = await sendTrayPanelRequest(resolved.request)
      if (!sent) {
        setBusyId(null)
        setFailure(t("errors.deliveryFailed"))
        return
      }
      // Dismiss like a menu selection. The main window owns the outcome from
      // here; a failure arrives as a toast there and as `settle` here.
      void closeTrayPanel()
    },
    [valuesFor, t, tRoot]
  )

  const invalidFields = useCallback(
    (actionId: string): Set<string> =>
      new Set(
        (errorsByAction[actionId] ?? [])
          .filter(
            (e): e is Extract<TrayPanelValidationError, { kind: "required" }> =>
              e.kind === "required"
          )
          .map((e) => e.fieldId)
      ),
    [errorsByAction]
  )

  const errorMessage = useCallback(
    (actionId: string): string | null => {
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
    },
    [errorsByAction, t]
  )

  return {
    valuesFor,
    setFieldValue,
    invalidFields,
    errorMessage,
    busyId,
    failure,
    expandedId,
    setExpandedId,
    run,
    reset,
    settle,
  }
}

const RunnerContext = createContext<TrayPanelRunner | null>(null)

export function TrayPanelRunnerProvider({
  runner,
  children,
}: {
  runner: TrayPanelRunner
  children: ReactNode
}) {
  return <RunnerContext.Provider value={runner}>{children}</RunnerContext.Provider>
}

export function useTrayPanelRunner(): TrayPanelRunner {
  const value = useContext(RunnerContext)
  if (!value) throw new Error("useTrayPanelRunner must be used inside TrayPanelRunnerProvider")
  return value
}
