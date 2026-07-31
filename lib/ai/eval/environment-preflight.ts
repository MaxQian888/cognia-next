import type { EvalEnvironmentCompatibility, EvalProject, EvalVariant } from "@cognia/eval-core"
import { getWorkflow } from "@/lib/db/workflows"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

const MINIMUM_RESERVATION_BYTES = 64 * 1024 * 1024
const ESTIMATED_BYTES_PER_TASK = 256 * 1024

export interface EvalEnvironmentPreflightDependencies {
  hasTeam(id: string): Promise<boolean>
  hasWorkflow(id: string): Promise<boolean>
  isDesktop(): boolean
  estimateStorage(): Promise<{ usage?: number; quota?: number } | undefined>
  now(): number
}

const defaultDependencies: EvalEnvironmentPreflightDependencies = {
  hasTeam: async (id) => Boolean(useAgentTeamStore.getState().teams[id]),
  hasWorkflow: async (id) => Boolean(await getWorkflow(id)),
  isDesktop: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  estimateStorage: async () => {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return undefined
    return navigator.storage.estimate()
  },
  now: Date.now,
}

export function estimateEvalArtifactReservation(project: EvalProject): number {
  const taskCount = project.dataset.caseIds.length * project.variants.length * 3
  return Math.max(MINIMUM_RESERVATION_BYTES, taskCount * ESTIMATED_BYTES_PER_TASK)
}

async function checkVariantRuntime(
  variant: EvalVariant,
  dependencies: EvalEnvironmentPreflightDependencies
): Promise<{ available: boolean; reason?: string }> {
  if (variant.runtimeTarget === "desktop" && !dependencies.isDesktop()) {
    return { available: false, reason: "desktop-runtime-unavailable" }
  }
  if (variant.kind === "team" && !(await dependencies.hasTeam(variant.targetId ?? ""))) {
    return { available: false, reason: "team-target-unavailable" }
  }
  if (variant.kind === "workflow" && !(await dependencies.hasWorkflow(variant.targetId ?? ""))) {
    return { available: false, reason: "workflow-target-unavailable" }
  }
  return variant.runtimeReady === false
    ? { available: false, reason: "variant-runtime-unavailable" }
    : { available: true }
}

export async function checkEvalEnvironmentCompatibility(
  project: EvalProject,
  dependencies: EvalEnvironmentPreflightDependencies = defaultDependencies
): Promise<EvalEnvironmentCompatibility> {
  const runtimeEntries = await Promise.all(
    project.variants.map(
      async (variant) => [variant.id, await checkVariantRuntime(variant, dependencies)] as const
    )
  )
  const requiredBytes = estimateEvalArtifactReservation(project)
  let storageEstimate: { usage?: number; quota?: number } | undefined
  try {
    storageEstimate = await dependencies.estimateStorage()
  } catch {
    storageEstimate = undefined
  }
  const availableBytes =
    storageEstimate?.quota === undefined
      ? undefined
      : Math.max(0, storageEstimate.quota - (storageEstimate.usage ?? 0))
  return {
    checkedAt: dependencies.now(),
    runtimeByVariant: Object.fromEntries(runtimeEntries),
    storage:
      availableBytes === undefined
        ? { status: "unknown", requiredBytes }
        : {
            status: availableBytes >= requiredBytes ? "available" : "insufficient",
            requiredBytes,
            availableBytes,
          },
  }
}

export function applyEnvironmentReadiness(
  project: EvalProject,
  environment: EvalEnvironmentCompatibility
): EvalProject {
  return {
    ...project,
    variants: project.variants.map((variant) => ({
      ...variant,
      runtimeReady: environment.runtimeByVariant[variant.id]?.available ?? false,
    })),
  }
}
