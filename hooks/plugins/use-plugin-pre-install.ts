"use client"

/**
 * usePluginPreInstall — wraps `runMarketplaceInstall` with the dialog state
 * required to surface Conflict → Permission → Config steps. The hook owns
 * a `target` React state slot; each step sets the target, returns a
 * Promise, and the dialog's Continue/Cancel buttons resolve that Promise.
 *
 * Marketplace components call `install(pluginId, version, name)` instead of
 * `market.install(id, version)`; the hook orchestrates the rest. The hook
 * surfaces the dialog state through the returned object so the caller
 * renders `<PluginPreInstallDialog target={..} onContinue={..} onCancel={..}/>`
 * next to its own JSX — no global dialog stack required.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import {
  runMarketplaceInstall,
  type RunMarketplaceInstallOpts,
  type RunMarketplaceInstallResult,
} from "@/lib/plugin/marketplace/install-flow"
import type {
  PreInstallTarget,
  PreInstallStepId,
} from "@/components/plugins/plugin-pre-install-dialog"

type MarketplaceClient = RunMarketplaceInstallOpts["client"]

export interface UsePluginPreInstall {
  /**
   * Run the chain: prompts the user through any applicable steps, then
   * either installs or returns a cancellation result.
   */
  install: (
    pluginId: string,
    version: string | undefined,
    pluginName: string
  ) => Promise<RunMarketplaceInstallResult>
  /** Current dialog target (read-only). */
  target: PreInstallTarget | null
  /** Confirm the active step. Caller forwards from the dialog. */
  resolveContinue: (value?: unknown) => void
  /** Cancel the chain entirely. Caller forwards from the dialog. */
  resolveCancel: () => void
  /** True while any step's Promise is pending. */
  busy: boolean
}

/**
 * Accepts a possibly-null client so the marketplace UI doesn't need to
 * fabricate a no-op stub while the lazy `loadPluginMarketplaceClient()`
 * resolves. When `client` is null the returned `install()` short-circuits
 * to a `failed/install/client_not_ready` result without mounting any
 * dialog state — callers should guard their UI (disabled install buttons)
 * to avoid reaching this branch in normal flows.
 */
export function usePluginPreInstall(client: MarketplaceClient | null): UsePluginPreInstall {
  const [target, setTarget] = useState<PreInstallTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const pendingResolver = useRef<((value: unknown) => void) | null>(null)
  // Track the active step so resolveContinue/resolveCancel can map a
  // generic "continue/cancel" into each step's discriminated result shape.
  const activeStep = useRef<PreInstallStepId | null>(null)

  const resolveContinue = useCallback((value?: unknown) => {
    const stepId = activeStep.current
    const resolver = pendingResolver.current
    pendingResolver.current = null
    activeStep.current = null
    setTarget(null)
    if (!resolver) return
    if (stepId === "conflict") resolver("continue")
    else if (stepId === "permission") resolver("approve")
    else if (stepId === "config") resolver({ result: "save", value: value ?? {} })
  }, [])

  const resolveCancel = useCallback(() => {
    const stepId = activeStep.current
    const resolver = pendingResolver.current
    pendingResolver.current = null
    activeStep.current = null
    setTarget(null)
    if (!resolver) return
    if (stepId === "conflict") resolver("cancel")
    else if (stepId === "permission") resolver("cancel")
    else if (stepId === "config") resolver({ result: "cancel" })
  }, [])

  const awaitStep = useCallback(
    <T>(stepId: PreInstallStepId, mountTarget: () => void): Promise<T> => {
      return new Promise<T>((resolve) => {
        activeStep.current = stepId
        pendingResolver.current = resolve as (v: unknown) => void
        mountTarget()
      })
    },
    []
  )

  const install = useCallback(
    async (
      pluginId: string,
      version: string | undefined,
      pluginName: string
    ): Promise<RunMarketplaceInstallResult> => {
      if (!client) {
        return {
          status: "failed",
          stage: "install",
          message: "client_not_ready",
        }
      }

      setBusy(true)

      // Pre-fetch the manifest once so we can compute totalSteps before any
      // step renders. Conflict count is unknown at this point (depends on
      // listPlugins lookup), so we conservatively show "1/N" with N including
      // the conflict step. Tightening this would need a synchronous
      // listPlugins which we don't have — acceptable trade-off.
      let totalSteps = 3
      try {
        const entry = await client.getPlugin(pluginId)
        if (entry) {
          const m = entry.manifest
          const hasPerms =
            (m.permissions ?? []).length > 0 || (m.optionalPermissions ?? []).length > 0
          const cfg = (m as { configSchema?: { type?: string; properties?: object } }).configSchema
          const hasConfig =
            !!cfg && cfg.type === "object" && Object.keys(cfg.properties ?? {}).length > 0
          totalSteps = 1 + (hasPerms ? 1 : 0) + (hasConfig ? 1 : 0)
        }
      } catch {
        // Fall back to default total; orchestrator surfaces the real error.
      }

      let stepCounter = 0
      const advanceStep = () => ++stepCounter

      try {
        const opts: RunMarketplaceInstallOpts = {
          pluginId,
          version,
          client,
          requestConflictReview: (conflict) =>
            awaitStep<"continue" | "cancel">("conflict", () => {
              setTarget({
                pluginId,
                pluginName,
                step: "conflict",
                conflict,
                stepNumber: advanceStep(),
                totalSteps,
              })
            }),
          requestPermissionReview: (permission) =>
            awaitStep<"approve" | "cancel">("permission", () => {
              setTarget({
                pluginId,
                pluginName,
                step: "permission",
                permission,
                stepNumber: advanceStep(),
                totalSteps,
              })
            }),
          requestConfig: (config) =>
            awaitStep<{ result: "save"; value: unknown } | { result: "cancel" }>("config", () => {
              setTarget({
                pluginId,
                pluginName,
                step: "config",
                config,
                stepNumber: advanceStep(),
                totalSteps,
              })
            }),
        }

        return await runMarketplaceInstall(opts)
      } finally {
        setBusy(false)
        // Belt and braces — leave no orphaned target if the orchestrator
        // throws.
        pendingResolver.current = null
        activeStep.current = null
        setTarget(null)
      }
    },
    [awaitStep, client]
  )

  return useMemo(
    () => ({
      install,
      target,
      resolveContinue,
      resolveCancel,
      busy,
    }),
    [install, target, resolveContinue, resolveCancel, busy]
  )
}
