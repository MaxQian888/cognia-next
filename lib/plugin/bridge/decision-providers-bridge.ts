/**
 * Decision Providers Bridge (ADR-0194).
 *
 * Resolves `manifest.decisionProviders[]` on plugin enable and registers each
 * provider in the host decision registry as `<pluginId>:<id>` (through
 * `registerPluginDecisionProvider`, the same path `ctx.decisions.registerProvider`
 * uses). Mirrors `ocr-providers-bridge.ts`:
 *
 * - **python-backed** entries have no JS module: `describe()` supplies the plain
 *   descriptor (locality / calibrated / limits) and `decide` / `status`
 *   round-trip into the plugin's Python subprocess. Only the request crosses
 *   the RPC — the host's `AbortSignal` is not serializable, and `runDecision`
 *   races the call instead.
 * - **JS-backed** entries dynamic-import `entry` and call the named factory.
 *
 * The manifest owns the user-facing name (`label` / `labelKey`); the plugin
 * code owns what it can do. `decisions:provide` is checked per enable, so a
 * revoked grant stops registration without a reinstall. Errors are collected,
 * never thrown — one bad provider must not block the plugin's other
 * contributions.
 */

import type { PluginManifest } from "@/types/plugin/plugin"
import type {
  PluginDecisionProviderDef,
  PluginDecisionProviderFactory,
  PluginDecisionProviderInput,
} from "@/types/plugin/plugin-decisions"
import type {
  DecisionProviderLimits,
  DecisionProviderResponse,
  DecisionProviderStatus,
  DecisionRequest,
} from "@/types/decisions"
import { loggers } from "@/lib/plugin/core/logger"
import { resolvePluginPath } from "@/lib/plugin/core/plugin-path"
import {
  clearDecisionProvidersForPlugin,
  registerPluginDecisionProvider,
} from "@/lib/plugin/api/decisions-api"
import {
  createDescribedPythonContribution,
  isPythonBackedContribution,
} from "@/lib/plugin/bridge/_shared/python-backed-proxy"

export interface DecisionProvidersBridgeError {
  pluginId: string
  providerId: string
  message: string
}

export interface DecisionProvidersBridgeResult {
  registered: number
  errors: DecisionProvidersBridgeError[]
}

export interface DecisionProvidersBridgeOptions {
  importer?: (entry: string) => Promise<Record<string, unknown>>
  /** Live permission resolver (reflects revocation). */
  hasPermission: (permission: string) => boolean
  /** Test seam for the python branch. */
  describePython?: typeof createDescribedPythonContribution
}

const DEFAULT_IMPORTER: NonNullable<DecisionProvidersBridgeOptions["importer"]> = (entry) =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ entry)

const IDENTIFIER = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/
const FORBIDDEN_EXPORTS = new Set(["__proto__", "constructor", "prototype"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readLimits(value: unknown): DecisionProviderLimits | undefined {
  if (!isRecord(value)) return undefined
  const limits: DecisionProviderLimits = {}
  for (const key of ["headTokens", "inputTokens", "optionTokens"] as const) {
    const n = value[key]
    if (typeof n === "number" && Number.isFinite(n) && n > 0) limits[key] = Math.floor(n)
  }
  return Object.keys(limits).length ? limits : undefined
}

function readQuestionSets(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sets = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return sets.length ? sets : undefined
}

async function resolvePythonProvider(
  def: PluginDecisionProviderDef,
  pluginId: string,
  describe: typeof createDescribedPythonContribution
): Promise<PluginDecisionProviderInput> {
  const described = await describe<Record<string, unknown>>({
    pluginId,
    contributionId: def.id,
    methods: ["decide", "status"],
    label: "Decision provider",
  })
  const decide = described.decide
  const status = described.status
  if (typeof decide !== "function") {
    throw new Error(`python contribution "${def.id}" has no decide() method`)
  }
  const locality = described.locality === "remote" ? "remote" : "local"
  const limits = readLimits(described.limits)
  const validatedQuestionSets = readQuestionSets(described.validatedQuestionSets)
  return {
    id: def.id,
    label: def.label,
    ...(def.labelKey ? { labelKey: def.labelKey } : {}),
    locality,
    calibrated: described.calibrated === true,
    ...(limits ? { limits } : {}),
    ...(validatedQuestionSets ? { validatedQuestionSets } : {}),
    // Only the request crosses the RPC; see the module comment.
    decide: (request: DecisionRequest) =>
      (decide as (req: DecisionRequest) => Promise<DecisionProviderResponse>)(request),
    ...(typeof status === "function"
      ? { status: () => (status as () => Promise<DecisionProviderStatus>)() }
      : {}),
  }
}

async function resolveJsProvider(
  def: PluginDecisionProviderDef,
  pluginId: string,
  installRoot: string,
  importer: NonNullable<DecisionProvidersBridgeOptions["importer"]>
): Promise<PluginDecisionProviderInput> {
  if (!def.entry || !def.export) {
    throw new Error(
      `JS-backed decision provider "${def.id}" must declare both "entry" and "export"` +
        ` (set backend: "python" to run it in the plugin's Python subprocess)`
    )
  }
  if (!IDENTIFIER.test(def.export) || FORBIDDEN_EXPORTS.has(def.export)) {
    throw new Error(`decision provider "${def.id}" has an invalid export name`)
  }
  const mod = await importer(resolvePluginPath(installRoot, def.entry))
  const exported = Object.hasOwn(mod, def.export) ? mod[def.export] : undefined
  if (typeof exported !== "function") {
    throw new Error(
      `entry "${def.entry}" does not export a factory named "${def.export}" (got ${typeof exported})`
    )
  }
  const provider = await (exported as PluginDecisionProviderFactory)({
    providerId: `${pluginId}:${def.id}`,
    pluginId,
  })
  if (!isRecord(provider)) {
    throw new Error(`factory "${def.export}" returned an invalid decision provider`)
  }
  return {
    ...provider,
    id: def.id,
    label: def.label,
    ...(def.labelKey ? { labelKey: def.labelKey } : {}),
  }
}

/**
 * Register every provider in `manifest.decisionProviders[]`. Idempotent per
 * plugin: prior registrations are cleared first.
 */
export async function registerDecisionProvidersForPlugin(
  manifest: PluginManifest,
  installRoot: string,
  options: DecisionProvidersBridgeOptions
): Promise<DecisionProvidersBridgeResult> {
  const pluginId = manifest.id
  const defs = manifest.decisionProviders ?? []
  if (defs.length === 0) return { registered: 0, errors: [] }

  clearDecisionProvidersForPlugin(pluginId)
  const importer = options.importer ?? DEFAULT_IMPORTER
  const describe = options.describePython ?? createDescribedPythonContribution
  const errors: DecisionProvidersBridgeError[] = []
  let registered = 0

  for (const def of defs) {
    try {
      if (!options.hasPermission("decisions:provide")) {
        throw new Error("Permission denied: decisions:provide is required")
      }
      if (!def || typeof def.id !== "string" || !def.id) {
        throw new Error("decision provider entry needs an id")
      }
      if (typeof def.label !== "string" || !def.label) {
        throw new Error(`decision provider "${def.id}" needs a label`)
      }
      const provider = isPythonBackedContribution(def, manifest.type)
        ? await resolvePythonProvider(def, pluginId, describe)
        : await resolveJsProvider(def, pluginId, installRoot, importer)
      registerPluginDecisionProvider(pluginId, provider)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ pluginId, providerId: def?.id ?? "", message })
      loggers.manager.error(`[decision-bridge] failed to register ${pluginId}:${def?.id}`, err)
    }
  }
  return { registered, errors }
}

/** Plugin-disable hook — drop every decision provider the plugin contributed. */
export function unregisterDecisionProvidersForPlugin(pluginId: string): void {
  clearDecisionProvidersForPlugin(pluginId)
}
