/**
 * The `routing` evaluation mode's host seam (ADR-0188 D12/D28, B6).
 *
 * The eval lab, the settings panel and `cognia eval routing` all reach the
 * routing experiment through this module and nothing else. It exists to keep
 * two promises at once:
 *
 *  - **Off means nothing loads.** With every Router + Fusion surface switched
 *    off, `routingExperimentAvailable` answers false and no caller goes
 *    further; the engine under `lib/router-fusion/eval/` is reached only by a
 *    dynamic `import()` behind that check, so a user who never turned Router +
 *    Fusion on never evaluates a byte of it. The only thing this file imports
 *    statically is the zero-import switches leaf.
 *  - **The offline path needs no database.** A simulated experiment is pure
 *    arithmetic over generated rows, so the CLI can run it in Node with no
 *    IndexedDB, no account vault and no provider. Only the recorded path opens
 *    the fusion database, and only inside the app.
 */

import {
  effectiveSurface,
  ROUTER_FUSION_SURFACES,
  type RouterFusionSwitches,
} from "@cognia/router-fusion/settings/switches"

export type { FusionRoutingSampleRow } from "@/lib/router-fusion/db/types"
export type {
  RoutingExperimentReport,
  RoutingExperimentResult,
  RoutingPromotionGateResult,
} from "@/lib/router-fusion/eval/routing-experiment"
export type {
  RoutingSampleExport,
  RoutingSampleExportRow,
} from "@/lib/router-fusion/eval/routing-sample"
export type { ShadowRunOutcome } from "@/lib/router-fusion/eval/shadow-router"
export type { PromotionRefusal } from "@/lib/router-fusion/eval/promotion"

/**
 * The evaluation modes the durable orchestrator drives. `model` and `agent`
 * come from `@cognia/eval-core`'s `EvalMode`; `routing` is this batch's, and it
 * is deliberately host-side only — a routing experiment has no variants, no
 * judge and no provider concurrency, so widening the package's `EvalMode` would
 * push a mode into every project form that can never be built there.
 */
export const ROUTING_EVAL_MODE = "routing" as const

export interface RoutingExperimentSettings {
  routerFusion?: RouterFusionSwitches | null
}

/**
 * Is the routing experiment reachable for these settings?
 *
 * True when Router + Fusion is on for at least one surface — which is exactly
 * when routed traffic exists to learn from. The master switch alone is not
 * enough: with every surface off nothing is ever routed, so an experiment would
 * have nothing but an empty sample set to report on.
 */
export function routingExperimentAvailable(
  settings: RoutingExperimentSettings | null | undefined
): boolean {
  const routerFusion = settings?.routerFusion
  return ROUTER_FUSION_SURFACES.some((surface) => effectiveSurface(routerFusion, surface))
}

export interface SimulatedRoutingExperimentOptions {
  seed: number
  /** ISO timestamp written into the manifests and the report. */
  createdAt: string
  sessionCount?: number
  explorationRate?: number
  /** Bootstrap replicates; tests lower it, the product does not. */
  iterations?: number
}

/**
 * Run the experiment end to end over a generated sample set. No database, no
 * network, no provider — and the report it returns is labelled `simulated` and
 * claims nothing (EVAL-04).
 */
export async function runSimulatedRoutingExperiment(
  options: SimulatedRoutingExperimentOptions
): Promise<import("@/lib/router-fusion/eval/routing-experiment").RoutingExperimentResult> {
  const [{ simulatedRoutingSamples }, { runRoutingExperiment }] = await Promise.all([
    import("@/lib/router-fusion/eval/simulated-samples"),
    import("@/lib/router-fusion/eval/routing-experiment"),
  ])
  const rows = simulatedRoutingSamples({
    seed: options.seed,
    ...(options.sessionCount === undefined ? {} : { sessionCount: options.sessionCount }),
    ...(options.explorationRate === undefined ? {} : { explorationRate: options.explorationRate }),
    now: Date.parse(options.createdAt),
  })
  return runRoutingExperiment(rows, {
    createdAt: options.createdAt,
    seed: options.seed,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
  })
}

export interface RecordedRoutingExperimentOptions {
  seed: number
  createdAt: string
  iterations?: number
}

/**
 * Run the experiment over samples that really happened — an export read off
 * disk, or rows collected from the fusion database.
 */
export async function runRecordedRoutingExperiment(
  rows: readonly import("@/lib/router-fusion/db/types").FusionRoutingSampleRow[],
  options: RecordedRoutingExperimentOptions
): Promise<import("@/lib/router-fusion/eval/routing-experiment").RoutingExperimentResult> {
  const { runRoutingExperiment } = await import("@/lib/router-fusion/eval/routing-experiment")
  return runRoutingExperiment(rows, {
    createdAt: options.createdAt,
    seed: options.seed,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
  })
}

/** Read a sample export back into rows, refusing anything it cannot vouch for. */
export async function parseRoutingSamples(
  value: unknown,
  options: { now: number }
): Promise<import("@/lib/router-fusion/db/types").FusionRoutingSampleRow[]> {
  const { parseRoutingSampleExport } = await import("@/lib/router-fusion/eval/routing-sample")
  return parseRoutingSampleExport(value, options)
}

/**
 * The database-backed half: collecting samples from real runs, shadowing,
 * promoting and rolling back. Opens the fusion database, so it runs inside the
 * app (or the headless brain), never in the plain CLI.
 */
export interface RoutingEvalWorkspace {
  collect(options?: {
    since?: number
    limit?: number
  }): Promise<import("@/lib/router-fusion/eval/sample-collector").CollectRoutingSamplesResult>
  listSamples(options?: {
    since?: number
    limit?: number
  }): Promise<import("@/lib/router-fusion/db/types").FusionRoutingSampleRow[]>
  exportSamples(options?: {
    since?: number
    limit?: number
  }): Promise<import("@/lib/router-fusion/eval/routing-sample").RoutingSampleExport>
  runExperiment(options: {
    seed: number
    createdAt: string
    iterations?: number
  }): Promise<import("@/lib/router-fusion/eval/routing-experiment").RoutingExperimentResult>
  shadow(options?: {
    limit?: number
    since?: number
  }): Promise<import("@/lib/router-fusion/eval/shadow-router").ShadowRunOutcome>
  listShadowDecisions(options?: {
    limit?: number
  }): Promise<import("@/lib/router-fusion/db/types").FusionShadowDecisionRow[]>
  activeManifest(): Promise<
    import("@/lib/router-fusion/db/types").FusionPredictorManifestRow | undefined
  >
  listManifests(options?: {
    limit?: number
  }): Promise<import("@/lib/router-fusion/db/types").FusionPredictorManifestRow[]>
  /**
   * Promote the experiment's published manifest. The guard runs first (a
   * simulated report and a gate that did not pass are both refusals), then the
   * pointer moves through `configuration-targets.ts`, which records the
   * previous value so the apply can be undone like any other recommendation.
   */
  promote(
    result: import("@/lib/router-fusion/eval/routing-experiment").RoutingExperimentResult
  ): Promise<RoutingPromotionOutcome>
  /**
   * Put the previous manifest back. With the apply record's id (the usual case
   * — the panel has just promoted) the generic rollback runs and the record is
   * marked undone; without it, the registry's own pointer is moved back, which
   * still restores exactly the manifest the active one replaced.
   */
  rollback(
    applicationId?: string
  ): Promise<import("@/lib/router-fusion/eval/promotion").RollbackRoutingPredictorResult>
}

export const ROUTING_PREDICTOR_TARGET = {
  targetType: "routing-predictor",
  targetId: "router-fusion",
} as const

export type RoutingPromotionOutcome =
  | {
      status: "promoted"
      manifestSha256: string
      /** The `evalConfigurationApplies` row; hand it back to `rollback` to undo. */
      applicationId: string
    }
  | {
      status: "refused"
      refusals: import("@/lib/router-fusion/eval/promotion").PromotionRefusal[]
    }

export interface RoutingEvalWorkspaceDeps {
  now?: () => number
}

/**
 * Open the workspace. Refuses — rather than opening the fusion database —
 * while Router + Fusion is off on every surface, so the off path is untouched.
 */
export async function openRoutingEvalWorkspace(
  settings: RoutingExperimentSettings | null | undefined,
  deps: RoutingEvalWorkspaceDeps = {}
): Promise<RoutingEvalWorkspace> {
  if (!routingExperimentAvailable(settings)) {
    throw new Error(
      "Router + Fusion is off on every surface; the routing experiment is unavailable"
    )
  }
  const now = deps.now ?? Date.now
  const [host, collector, sampleModule, experiment, shadow, promotion, store] = await Promise.all([
    import("@/lib/router-fusion/host"),
    import("@/lib/router-fusion/eval/sample-collector"),
    import("@/lib/router-fusion/eval/routing-sample"),
    import("@/lib/router-fusion/eval/routing-experiment"),
    import("@/lib/router-fusion/eval/shadow-router"),
    import("@/lib/router-fusion/eval/promotion"),
    import("@/lib/router-fusion/eval/routing-store"),
  ])
  const fusionStore = await host.currentFusionStore()
  const db = fusionStore.db

  return {
    async collect(options = {}) {
      return collector.collectRoutingSamples(
        db,
        {
          readArtifact: async (runId, artifactId) =>
            (await fusionStore.artifactStore(runId).get(artifactId))?.content ?? null,
          now,
        },
        options
      )
    },
    listSamples: (options = {}) => store.listRoutingSamples(db, options),
    async exportSamples(options = {}) {
      const rows = await store.listRoutingSamples(db, options)
      return sampleModule.buildRoutingSampleExport(rows, {
        exportedAt: new Date(now()).toISOString(),
      })
    },
    async runExperiment(options) {
      const rows = await store.listRoutingSamples(db, {
        featuresVersion: sampleModule.ROUTING_FEATURES_VERSION,
      })
      const result = await experiment.runRoutingExperiment(rows, {
        createdAt: options.createdAt,
        seed: options.seed,
        ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
      })
      // Every experiment leaves its manifest behind, promoted or not, so the
      // run is auditable from the registry alone.
      await promotion.recordRoutingManifest(db, {
        manifest: result.publishedManifest ?? result.trainingManifest,
        label: result.report.label,
        gateVerdict: result.report.gate.gate?.verdict ?? null,
        gateReasons: result.report.gate.gate?.reasons ?? result.report.gate.refusals,
        now: now(),
      })
      return result
    },
    shadow: (options = {}) => shadow.recordShadowDecisions(db, { now: now(), ...options }),
    listShadowDecisions: (options = {}) => store.listShadowDecisions(db, options),
    activeManifest: () => store.activePredictorManifest(db),
    listManifests: (options = {}) => store.listPredictorManifests(db, options),
    async promote(result) {
      const decision = promotion.routingPromotionDecision(result.report)
      if (!decision.allowed) return { status: "refused", refusals: decision.refusals }
      if (!result.publishedManifest) {
        return { status: "refused", refusals: ["NO_PUBLISHED_MANIFEST"] }
      }
      // Seal it into the registry first: the pointer may only ever name a
      // manifest that is already stored, verifiable and published.
      await promotion.recordRoutingManifest(db, {
        manifest: result.publishedManifest,
        label: result.report.label,
        gateVerdict: result.report.gate.gate?.verdict ?? null,
        gateReasons: result.report.gate.gate?.reasons ?? result.report.gate.refusals,
        now: now(),
      })
      const [{ applyEvalRecommendation }, { browserEvalConfigurationApplicationDeps }] =
        await Promise.all([
          import("./recommendation-application"),
          import("./configuration-targets"),
        ])
      const record = await applyEvalRecommendation(
        result.report.training.manifestSha256,
        { ...ROUTING_PREDICTOR_TARGET },
        { manifestSha256: result.publishedManifest.sha256 },
        await browserEvalConfigurationApplicationDeps()
      )
      return {
        status: "promoted",
        manifestSha256: result.publishedManifest.sha256,
        applicationId: record.id,
      }
    },
    async rollback(applicationId) {
      if (applicationId === undefined) {
        return promotion.rollbackRoutingPredictor(db, { now: now() })
      }
      const [{ rollbackEvalRecommendation }, { browserEvalConfigurationApplicationDeps }] =
        await Promise.all([
          import("./recommendation-application"),
          import("./configuration-targets"),
        ])
      await rollbackEvalRecommendation(
        applicationId,
        await browserEvalConfigurationApplicationDeps()
      )
      const active = await store.activePredictorManifest(db)
      return active ? { status: "rolled_back", row: active } : { status: "deactivated", row: null }
    },
  }
}
