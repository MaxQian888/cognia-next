/**
 * `/provider <usage|inspect|capabilities|probe>`, `/models` and `/balance`
 * controller. Every verb delegates to `cli/src/provider/*`, the same modules
 * `cognia-agent provider …` runs, so the panel and the terminal command
 * cannot answer differently.
 *
 * Overlays are the existing ones: `/models` seeds the real model switcher
 * (the `model` overlay) from the catalog and live-refreshes it with the
 * discovered inventory, `/balance` opens the `limits` panel filtered to
 * balance meters, and the rest render markdown in the document pager. The
 * loading overlays open immediately, like `/limits`, so a slow provider
 * cannot turn subsequent input into a queued steer.
 */

import type { ResolvedConfig } from "../../config/schema"
import { readProviderCapabilities } from "../../provider/capabilities"
import { readProviderLimits } from "../../provider/limits"
import { createCliProviderExecutor, type CliProviderExecutor } from "../../provider/local"
import { listProviderModels } from "../../provider/models"
import { probeProviders } from "../../provider/probe"
import {
  resolveProviderTransport,
  type ProviderTransportResolution,
} from "../../provider/transport"
import { readProviderUsage, type ReadUsageDeps } from "../../provider/usage"
import { collectModelOptions } from "../components/model-options"
import {
  formatCapabilitiesDocument,
  formatInspectDocument,
  formatMeterSummary,
  formatProbeDocument,
  formatUsageDocument,
} from "../format/provider"
import type { RateLimitSnapshot } from "../format/rate-limits"
import { analyzeSession } from "../format/usage-analysis"
import type { ToolStat, TuiAction } from "../state/types"

export const PROVIDER_ACTIONS = [
  "models",
  "balance",
  "usage",
  "inspect",
  "capabilities",
  "probe",
] as const
export type ProviderAction = (typeof PROVIDER_ACTIONS)[number]

type LimitsLoader = NonNullable<Parameters<typeof readProviderLimits>[0]["loadLimits"]>

export interface ProviderControllerDeps {
  dispatch: (action: TuiAction) => void
  config: ResolvedConfig
  /** Config home (`~/.cognia`), for the usage ledgers. */
  home: string
  action: string
  /** A provider id (usage, inspect, capabilities) or a model id (probe). */
  arg?: string
  signal?: AbortSignal
  now?: () => number
  usageHistory?: number[]
  toolStats?: Record<string, ToolStat>
  rateLimits?: RateLimitSnapshot
  /** Seams (tests). Production resolves the live planes and the real executor. */
  resolveTransport?: () => Promise<ProviderTransportResolution>
  createExecutor?: (config: ResolvedConfig) => CliProviderExecutor
  loadLimits?: LimitsLoader
  ensureDb?: ReadUsageDeps["ensureDb"]
  fsx?: ReadUsageDeps["fsx"]
  modelCatalog?: ReadUsageDeps["modelCatalog"]
  modelOptions?: (config: ResolvedConfig) => string[]
}

let nextProviderRequestId = 0

function isAction(value: string): value is ProviderAction {
  return (PROVIDER_ACTIONS as readonly string[]).includes(value)
}

function providerArg(deps: ProviderControllerDeps): string | null | undefined {
  const id = deps.arg?.trim()
  if (!id) return undefined
  if (deps.config.providers?.[id] || id === deps.config.provider) return id
  deps.dispatch({
    type: "NOTICE",
    message: `Provider "${id}" is not configured. Configured: ${Object.keys(deps.config.providers ?? {}).join(", ") || "none"}.`,
    severity: "error",
  })
  return null
}

function failureNotice(deps: ProviderControllerDeps, what: string, error: unknown): void {
  deps.dispatch({
    type: "NOTICE",
    message: `${what} failed: ${error instanceof Error ? error.message : String(error)}`,
    severity: "error",
  })
}

export async function runProvider(deps: ProviderControllerDeps): Promise<void> {
  const { dispatch, config } = deps
  const action = deps.action.trim()
  if (!isAction(action)) {
    dispatch({
      type: "NOTICE",
      message: `Unknown /provider verb "${action}". Try: ${PROVIDER_ACTIONS.join(", ")}.`,
      severity: "error",
    })
    return
  }
  const now = deps.now ?? (() => Date.now())
  const requestId = ++nextProviderRequestId
  const isCurrent = () => nextProviderRequestId === requestId
  const executor = (deps.createExecutor ?? ((c) => createCliProviderExecutor(c)))(config)
  const resolveTransport = deps.resolveTransport ?? (() => resolveProviderTransport({}))

  switch (action) {
    case "models": {
      const seed = (deps.modelOptions ?? collectModelOptions)(config)
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: { kind: "model", options: seed, index: 0, query: "" },
      })
      // The inventory is this credential's. Refresh the picker in place once
      // the provider answers, and say so when it does not.
      void listProviderModels({ config, executor, signal: deps.signal })
        .then((report) => {
          if (!isCurrent()) return
          if (report.failure) {
            dispatch({
              type: "NOTICE",
              message: `${report.providerId}: ${report.failure.availability}: ${report.failure.failure.message}`,
              severity: "error",
            })
            return
          }
          const ids = report.listing!.models.map((model) => model.id)
          if (ids.length === 0) {
            dispatch({ type: "NOTICE", message: `${report.providerId} lists no models.` })
            return
          }
          dispatch({ type: "OVERLAY_REFRESH_MODEL_OPTIONS", options: ids })
        })
        .catch((error: unknown) => {
          if (isCurrent()) failureNotice(deps, "Listing models", error)
        })
      return
    }

    case "balance": {
      const at = now()
      dispatch({
        type: "OVERLAY_OPEN",
        overlay: {
          kind: "limits",
          snapshots: [],
          loading: true,
          requestId,
          analysis: analyzeSession({ usageHistory: deps.usageHistory, toolStats: deps.toolStats }),
          now: at,
          rateLimits: deps.rateLimits,
          activeProvider: config.provider,
        },
      })
      void readProviderLimits({
        config,
        verb: "balance",
        now: () => at,
        ...(deps.loadLimits ? { loadLimits: deps.loadLimits } : {}),
      })
        .then((report) => {
          dispatch({ type: "LIMITS_LOADED", requestId, snapshots: report.snapshots })
          if (!isCurrent()) return
          const summary = formatMeterSummary(report.snapshots, at)
          if (summary) dispatch({ type: "NOTICE", message: summary })
          else if (report.silent.length > 0) {
            dispatch({
              type: "NOTICE",
              message: `No balance meter for ${report.silent.join(", ")}.`,
            })
          }
        })
        .catch((error: unknown) => {
          dispatch({
            type: "LIMITS_LOADED",
            requestId,
            snapshots: [
              {
                provider: config.provider,
                accountId: config.provider,
                accountLabel: config.provider,
                fetchedAt: at,
                meters: [],
                error: error instanceof Error ? error.message : String(error),
              },
            ],
          })
        })
      return
    }

    case "usage": {
      const providerId = providerArg(deps)
      if (providerId === null) return
      dispatch({ type: "NOTICE", message: "Reading usage…" })
      try {
        const report = await readProviderUsage({
          config,
          executor,
          home: deps.home,
          ...(providerId ? { providerId } : {}),
          now,
          ...(deps.ensureDb ? { ensureDb: deps.ensureDb } : {}),
          ...(deps.fsx ? { fsx: deps.fsx } : {}),
          ...(deps.modelCatalog ? { modelCatalog: deps.modelCatalog } : {}),
        })
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: providerId ? `Usage · ${providerId}` : "Provider usage",
            body: formatUsageDocument(report),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, "Reading usage", error)
      }
      return
    }

    case "capabilities": {
      const providerId = providerArg(deps)
      if (providerId === null) return
      dispatch({ type: "NOTICE", message: "Reading provider capabilities…" })
      try {
        const { transport } = await resolveTransport()
        const report = await readProviderCapabilities({
          config,
          executor,
          transport,
          ...(providerId ? { providerId } : {}),
        })
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: providerId ? `Capabilities · ${providerId}` : "Provider capabilities",
            body: formatCapabilitiesDocument(report),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, "Reading capabilities", error)
      }
      return
    }

    case "inspect": {
      const picked = providerArg(deps)
      if (picked === null) return
      const providerId = picked ?? config.provider
      dispatch({ type: "NOTICE", message: `Inspecting ${providerId}…` })
      try {
        const { transport } = await resolveTransport()
        const [capabilities, models] = await Promise.all([
          readProviderCapabilities({ config, executor, transport, providerId }),
          listProviderModels({ config, executor, providerId, signal: deps.signal }),
        ])
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: `Provider · ${providerId}`,
            body: formatInspectDocument({
              providerId,
              transportLabel: transport.label,
              capabilities: capabilities.providers[0]!,
              models,
            }),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, `Inspecting ${providerId}`, error)
      }
      return
    }

    case "probe": {
      const model = deps.arg?.trim() || undefined
      dispatch({
        type: "NOTICE",
        message: model
          ? `Probing ${model}… (one real request per candidate)`
          : "Probing every configured provider… (one real request each)",
      })
      try {
        const { transport } = await resolveTransport()
        const report = await probeProviders({
          config,
          executor,
          transport,
          ...(model ? { model } : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        })
        if (!isCurrent()) return
        dispatch({
          type: "OVERLAY_OPEN",
          overlay: {
            kind: "document",
            title: model ? `Probe · ${model}` : "Provider probe",
            body: formatProbeDocument(report),
            format: "markdown",
          },
        })
      } catch (error) {
        failureNotice(deps, "Probe", error)
      }
      return
    }
  }
}
