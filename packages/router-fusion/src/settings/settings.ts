/**
 * Router + Fusion user settings (ADR-0188 D36–D39).
 *
 * Opt-in by construction: the master switch and every surface switch default
 * to false, and `effectiveSurface` is the only reader call sites use. With the
 * master off, nothing in the system may behave differently from before the
 * feature existed. Persisted values from older or newer builds are normalized
 * here — unknown rule rows, malformed money and out-of-range limits are dropped
 * back to defaults rather than trusted.
 */

import type { ActionConfig, DataClass, ExecutionMode } from "../contracts/schemas"
import { DATA_CLASSES, EXECUTION_MODES } from "../contracts/schemas"
import { DEFAULT_RUN_CAP_USD_BY_MODE } from "../config/builtin-catalog"
import type { ActionLimits } from "../config/types"
import { MoneyError, usdToMicrousd } from "../money/microusd"
import { RULE_ROWS, type RuleRowId } from "../routing/action-router"
import { sanitizeActionOverride, sanitizeCustomAction } from "./action-catalog"
import { ROUTER_FUSION_SURFACES, type RouterFusionSurface } from "./switches"

export { ROUTER_FUSION_SURFACES, effectiveSurface } from "./switches"
export type { RouterFusionSurface, RouterFusionSwitches } from "./switches"

export type RuleRowProvenance = "user" | "migrated_legacy_auto"

/**
 * The rule rows this build can act on: those with an action whose mode runs.
 * B4 added `delegate_multifile`, so every row is wired — direct, cascade,
 * panel and delegate all execute.
 *
 * `delegate_multifile` still only ever MATCHES where delegate can really run:
 * its rule additionally requires a sandbox tier and an approved acceptance
 * profile (`capabilities.sandboxTier`, `capabilities.acceptanceProfileAvailable`
 * in `routing/action-router.ts`), which the host computes per request from the
 * project the run names. Approving the row on a machine with no sandbox, or in
 * a project with no approved profile, therefore changes no route — but it is
 * the capability that withholds it, not this list.
 *
 * `settings.test.ts` pins that every row here proposes a mode this build runs,
 * and that nothing is left dormant.
 */
export const WIRED_RULE_ROWS: readonly RuleRowId[] = [
  "economy_simple",
  "cascade_verifiable",
  "panel_research",
  "delegate_multifile",
]

/**
 * What the difficulty judge's settings were when the LLM classifier was first
 * enabled, and which of them were carried over (D18). `autoRouting` itself is
 * never modified, so this is provenance for the settings section, not a restore
 * point: switching the classifier off hands the judge back its own settings.
 */
export interface JudgeMigrationSnapshot {
  capturedAt: number
  /** `autoRouting.judge`, `routerModel`, `enableCache` and `cacheTTL` as they were. */
  judge: unknown
  carried: Array<"routerModel" | "timeoutMs" | "cacheTtlSeconds">
}

export const JUDGE_MIGRATION_FIELDS = ["routerModel", "timeoutMs", "cacheTtlSeconds"] as const

export interface LlmClassifierSettings {
  enabled: boolean
  /** The router model the classification call goes to; without it the rules classify. */
  routerProviderId?: string
  routerModelId?: string
  /** Hard ceiling on the classification, reservation included (default 1500). */
  timeoutMs: number
  /** How long a successful classification is reused; 0 turns the cache off (default 600). */
  cacheTtlSeconds: number
  /** Set on the first enable; its presence means the judge migration already ran. */
  judgeMigration?: JudgeMigrationSnapshot
}

export interface SurfaceTrip {
  trippedAt: number
  /** Stable fault code of the fault that crossed the threshold. */
  reason: string
}

export interface ActionOverride {
  enabled?: boolean
  roles?: Record<string, string>
  verifier_profile?: string
  runCapUsd?: string
  limits?: Partial<ActionLimits>
  webToolsEnabled?: boolean
}

export interface RouterFusionSettings {
  enabled: boolean
  surfaces: Record<RouterFusionSurface, boolean>
  budgetMode: "tracked" | "strict"
  approvedRuleRows: RuleRowId[]
  ruleRowProvenance: Partial<Record<RuleRowId, RuleRowProvenance>>
  runCapUsdByMode: Record<ExecutionMode, string>
  /**
   * Edits to the built-in actions and user-defined actions (D17), written by
   * the action catalog editor (`settings/action-catalog.ts`). Every route
   * compiles both into its snapshot; normalization keeps only what compiles.
   */
  actionOverrides: Record<string, ActionOverride>
  customActions: ActionConfig[]
  /** Conservative per-call hold for a deployment without an audited price (tracked only). */
  unknownPriceCallReserveUsd: string
  /** Default data class for work that names no workspace; workspaces may only raise it. */
  defaultDataClass: DataClass
  /**
   * Per-workspace data class, which may only raise the default (D30). Honoured
   * by chat routing through `resolveDataClass`. No settings control writes it in
   * B1; per-workspace labels arrive with the workspace settings in B2.
   */
  dataClassByWorkspaceId: Record<string, DataClass>
  restrictedGrantProviderIds: string[]
  /** Consecutive infrastructure faults before a surface trips back to the original path. */
  breakerThreshold: number
  /**
   * Surfaces the runtime breaker tripped (D38). A tripped surface runs the
   * original path until the user re-arms it; persisted so a restart does not
   * silently re-arm a surface that kept failing.
   */
  trippedSurfaces: Partial<Record<RouterFusionSurface, SurfaceTrip>>
  /**
   * The opt-in LLM classifier (D18, wired in B5). Off by default: every turn
   * is classified by the rules classifier. On, an Auto route — a chat turn
   * (`selectChatDeployment`, `selectChatFusionRun`) or a Run API / `cognia/auto`
   * request (`routeRunRequest`) — asks the router model once, ledgered and
   * PII-gated, and falls back to the rules classifier on a timeout, an invalid
   * reply, a PII hit or a fault (ROUTE-03). It also absorbs the difficulty judge
   * on the `utilityLedger` surface. The reader is
   * `lib/router-fusion/routing/llm-classifier.ts`, created per route host;
   * `settings.test.ts` pins its readers.
   */
  llmClassifier: LlmClassifierSettings
  /** Prior Auto settings captured at first enable, for one-click restore (D37). */
  legacyAutoSnapshot?: { capturedAt: number; autoRouting: unknown }
  migrationNoticeDismissed: boolean
}

export const DEFAULT_ROUTER_FUSION_SETTINGS: RouterFusionSettings = {
  enabled: false,
  surfaces: {
    chat: false,
    gatewayRuns: false,
    gatewayPassthroughLedger: false,
    agentsWorkflows: false,
    utilityLedger: false,
    companion: false,
  },
  budgetMode: "tracked",
  approvedRuleRows: [],
  ruleRowProvenance: {},
  runCapUsdByMode: { ...DEFAULT_RUN_CAP_USD_BY_MODE },
  actionOverrides: {},
  customActions: [],
  unknownPriceCallReserveUsd: "0.05",
  defaultDataClass: "internal",
  dataClassByWorkspaceId: {},
  restrictedGrantProviderIds: [],
  breakerThreshold: 3,
  trippedSurfaces: {},
  llmClassifier: { enabled: false, timeoutMs: 1500, cacheTtlSeconds: 600 },
  migrationNoticeDismissed: false,
}

function isMoney(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    usdToMicrousd(value)
    return true
  } catch (error) {
    if (error instanceof MoneyError) return false
    throw error
  }
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function normalizeTrips(raw: unknown): RouterFusionSettings["trippedSurfaces"] {
  if (!raw || typeof raw !== "object") return {}
  const out: RouterFusionSettings["trippedSurfaces"] = {}
  for (const surface of ROUTER_FUSION_SURFACES) {
    const trip = (raw as Record<string, unknown>)[surface] as Partial<SurfaceTrip> | undefined
    if (
      trip &&
      typeof trip === "object" &&
      Number.isSafeInteger(trip.trippedAt) &&
      typeof trip.reason === "string" &&
      trip.reason.length > 0
    ) {
      out[surface] = { trippedAt: trip.trippedAt as number, reason: trip.reason }
    }
  }
  return out
}

function normalizeOverrides(raw: unknown): Record<string, ActionOverride> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, ActionOverride> = {}
  for (const [actionId, value] of Object.entries(raw as Record<string, unknown>)) {
    const override = sanitizeActionOverride(value)
    if (override) out[actionId] = override
  }
  return out
}

/** Only actions that compile survive: one broken action would fail every route. */
function normalizeCustomActions(raw: unknown): ActionConfig[] {
  if (!Array.isArray(raw)) return []
  const out: ActionConfig[] = []
  for (const value of raw) {
    const action = sanitizeCustomAction(
      value,
      out.map((kept) => kept.id)
    )
    if (action) out.push(action)
  }
  return out
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
    ? (value as number)
    : fallback
}

function normalizeJudgeMigration(raw: unknown): JudgeMigrationSnapshot | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const snapshot = raw as Partial<Record<keyof JudgeMigrationSnapshot, unknown>>
  if (!Number.isSafeInteger(snapshot.capturedAt)) return undefined
  const carried = Array.isArray(snapshot.carried)
    ? JUDGE_MIGRATION_FIELDS.filter((field) => (snapshot.carried as unknown[]).includes(field))
    : []
  return {
    capturedAt: snapshot.capturedAt as number,
    judge: structuredClone(snapshot.judge ?? null),
    carried,
  }
}

/**
 * The classifier's settings. A router model is kept only as a complete pair —
 * half a deployment cannot be called — and the cache TTL may be 0 (no cache),
 * which is how a judge migrated with its cache off keeps it off.
 */
function normalizeLlmClassifier(
  raw: Record<string, unknown>,
  defaults: LlmClassifierSettings
): LlmClassifierSettings {
  const model =
    nonEmptyString(raw.routerProviderId) && nonEmptyString(raw.routerModelId)
      ? { routerProviderId: raw.routerProviderId, routerModelId: raw.routerModelId }
      : {}
  const judgeMigration = normalizeJudgeMigration(raw.judgeMigration)
  return {
    enabled: bool(raw.enabled, false),
    ...model,
    timeoutMs: intInRange(raw.timeoutMs, defaults.timeoutMs, 1, 60_000),
    cacheTtlSeconds: intInRange(raw.cacheTtlSeconds, defaults.cacheTtlSeconds, 0, 86_400),
    ...(judgeMigration ? { judgeMigration } : {}),
  }
}

/** Normalize whatever was persisted into a complete, valid settings object. */
export function normalizeRouterFusionSettings(raw: unknown): RouterFusionSettings {
  const d = DEFAULT_ROUTER_FUSION_SETTINGS
  if (!raw || typeof raw !== "object") return structuredClone(d)
  const r = raw as Partial<Record<keyof RouterFusionSettings, unknown>>

  const rawSurfaces = (r.surfaces && typeof r.surfaces === "object" ? r.surfaces : {}) as Record<
    string,
    unknown
  >
  const surfaces = Object.fromEntries(
    ROUTER_FUSION_SURFACES.map((s) => [s, bool(rawSurfaces[s], false)])
  ) as RouterFusionSettings["surfaces"]

  const approved = Array.isArray(r.approvedRuleRows)
    ? [
        ...new Set(
          r.approvedRuleRows.filter((row): row is RuleRowId =>
            (RULE_ROWS as readonly unknown[]).includes(row)
          )
        ),
      ]
    : []
  const provenanceRaw = (
    r.ruleRowProvenance && typeof r.ruleRowProvenance === "object" ? r.ruleRowProvenance : {}
  ) as Record<string, unknown>
  const ruleRowProvenance: RouterFusionSettings["ruleRowProvenance"] = {}
  for (const row of approved) {
    const value = provenanceRaw[row]
    ruleRowProvenance[row] = value === "migrated_legacy_auto" ? "migrated_legacy_auto" : "user"
  }

  const capsRaw = (
    r.runCapUsdByMode && typeof r.runCapUsdByMode === "object" ? r.runCapUsdByMode : {}
  ) as Record<string, unknown>
  const runCapUsdByMode = Object.fromEntries(
    EXECUTION_MODES.map((mode) => [
      mode,
      isMoney(capsRaw[mode]) ? capsRaw[mode] : d.runCapUsdByMode[mode],
    ])
  ) as RouterFusionSettings["runCapUsdByMode"]

  const classifierRaw = (
    r.llmClassifier && typeof r.llmClassifier === "object" ? r.llmClassifier : {}
  ) as Record<string, unknown>
  const positiveInt = (value: unknown, fallback: number, max: number) =>
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max
      ? (value as number)
      : fallback

  const dataClass = (value: unknown, fallback: DataClass): DataClass =>
    (DATA_CLASSES as readonly unknown[]).includes(value) ? (value as DataClass) : fallback
  const workspaceClassesRaw = (
    r.dataClassByWorkspaceId && typeof r.dataClassByWorkspaceId === "object"
      ? r.dataClassByWorkspaceId
      : {}
  ) as Record<string, unknown>

  return {
    enabled: bool(r.enabled, false),
    surfaces,
    budgetMode: r.budgetMode === "strict" ? "strict" : "tracked",
    approvedRuleRows: approved,
    ruleRowProvenance,
    runCapUsdByMode,
    actionOverrides: normalizeOverrides(r.actionOverrides),
    customActions: normalizeCustomActions(r.customActions),
    unknownPriceCallReserveUsd: isMoney(r.unknownPriceCallReserveUsd)
      ? r.unknownPriceCallReserveUsd
      : d.unknownPriceCallReserveUsd,
    defaultDataClass: dataClass(r.defaultDataClass, d.defaultDataClass),
    dataClassByWorkspaceId: Object.fromEntries(
      Object.entries(workspaceClassesRaw)
        .filter(([, value]) => (DATA_CLASSES as readonly unknown[]).includes(value))
        .map(([id, value]) => [id, value as DataClass])
    ),
    restrictedGrantProviderIds: Array.isArray(r.restrictedGrantProviderIds)
      ? [
          ...new Set(
            r.restrictedGrantProviderIds.filter(
              (id): id is string => typeof id === "string" && id.length > 0
            )
          ),
        ]
      : [],
    breakerThreshold: positiveInt(r.breakerThreshold, d.breakerThreshold, 100),
    trippedSurfaces: normalizeTrips(r.trippedSurfaces),
    llmClassifier: normalizeLlmClassifier(classifierRaw, d.llmClassifier),
    ...(r.legacyAutoSnapshot && typeof r.legacyAutoSnapshot === "object"
      ? {
          legacyAutoSnapshot: structuredClone(
            r.legacyAutoSnapshot as RouterFusionSettings["legacyAutoSnapshot"]
          ),
        }
      : {}),
    migrationNoticeDismissed: bool(r.migrationNoticeDismissed, false),
  }
}

/**
 * Data class for a unit of work: the workspace label may raise the account
 * default; a session override may raise it further. Nothing lowers it, and no
 * model output participates.
 */
export function resolveDataClass(
  settings: RouterFusionSettings,
  workspaceId: string | undefined,
  sessionOverride?: DataClass
): DataClass {
  const rank = (c: DataClass) => DATA_CLASSES.indexOf(c)
  let result = settings.defaultDataClass
  const workspace = workspaceId ? settings.dataClassByWorkspaceId[workspaceId] : undefined
  if (workspace && rank(workspace) > rank(result)) result = workspace
  if (sessionOverride && rank(sessionOverride) > rank(result)) result = sessionOverride
  return result
}
