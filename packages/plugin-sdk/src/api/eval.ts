/**
 * Plugin SDK — `eval` capability surface.
 *
 * Running an evaluation is a plugin-shaped job — which datasets, which
 * scorers, which target — but the machinery underneath is not: the run
 * service, the artifact encryption key, the browser orchestrator and the
 * deterministic scorer set all have to be the SAME ones the host uses, or a
 * plugin-run eval produces numbers that cannot be compared with anything else.
 * `SCORING_VERSION` is the reason why: it stamps every report, and a private
 * scoring implementation stamped with the host's version is a silent lie.
 *
 * `loadEvalRuntimeContext()` is the prerequisite pair — resolved host settings
 * plus the unlocked account id. `ctx.settings` is a plugin-scoped key/value
 * store, deliberately not the host's settings, and there is no account API, so
 * without this a plugin cannot answer "may I run at all?" without reading the
 * renderer stores directly.
 */

export { getRunDetail, listDatasetSummaries, runEvalService } from "@/lib/ai/eval/service"
export { runCalibration } from "@/lib/ai/eval/calibration/runner"
export { loadOrCreateEvalArtifactKey } from "@/lib/ai/eval/artifact-crypto"
export { createBrowserEvalOrchestrator } from "@/lib/ai/eval/browser-execution"
export { EvalProjectService } from "@/lib/ai/eval/project-service"
export { SCORING_VERSION } from "@/lib/ai/eval/report"
export { deterministicScorers } from "@/lib/ai/eval/scorers"

export { loadEvalAppSettings, loadEvalRuntimeContext } from "@/lib/ai/eval/runtime-context"

export type { EvalRuntimeContext } from "@/lib/ai/eval/runtime-context"

export type { TargetSpec } from "@/types/eval/run-config"
