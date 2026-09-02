import { statfs } from "node:fs/promises"
import path from "node:path"

import { freeBytesAt } from "../util/disk"
import {
  runProjectPreflight,
  type EvalEnvironmentCompatibility,
  type EvalPreflightResult,
  type EvalProject,
} from "@cognia/eval-core"

const MINIMUM_RESERVATION_BYTES = 64 * 1024 * 1024
const ESTIMATED_BYTES_PER_TASK = 256 * 1024

export interface CliEvalPreflightDependencies {
  env: NodeJS.ProcessEnv
  statfs(pathname: string): Promise<{ bavail: bigint | number; bsize: bigint | number }>
  now(): number
}

const defaultDependencies: CliEvalPreflightDependencies = {
  env: process.env,
  statfs,
  now: Date.now,
}

function environmentName(providerId: string): string {
  return `COGNIA_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`
}

function requiredBytes(project: EvalProject): number {
  return Math.max(
    MINIMUM_RESERVATION_BYTES,
    project.dataset.caseIds.length * project.variants.length * 3 * ESTIMATED_BYTES_PER_TASK
  )
}

export async function checkCliEvalPreflight(
  project: EvalProject,
  projectPath: string,
  dependencies: CliEvalPreflightDependencies = defaultDependencies
): Promise<{
  project: EvalProject
  environmentCompatibility: EvalEnvironmentCompatibility
  result: EvalPreflightResult
}> {
  const resolvedProject: EvalProject = {
    ...project,
    variants: project.variants.map((variant) => ({
      ...variant,
      runtimeReady: variant.runtimeTarget === "web",
      credentialReady:
        variant.isLocal ||
        Boolean(variant.providerId && dependencies.env[environmentName(variant.providerId)]),
    })),
  }
  const required = requiredBytes(resolvedProject)
  const availableBytes = await freeBytesAt(
    path.dirname(path.resolve(projectPath)),
    dependencies.statfs
  )
  const environmentCompatibility: EvalEnvironmentCompatibility = {
    checkedAt: dependencies.now(),
    runtimeByVariant: Object.fromEntries(
      resolvedProject.variants.map((variant) => [
        variant.id,
        variant.runtimeReady
          ? { available: true }
          : { available: false, reason: "cli-runtime-unavailable" },
      ])
    ),
    storage:
      availableBytes === undefined
        ? { status: "unknown", requiredBytes: required }
        : {
            status: availableBytes >= required ? "available" : "insufficient",
            requiredBytes: required,
            availableBytes,
          },
  }
  return {
    project: resolvedProject,
    environmentCompatibility,
    result: runProjectPreflight(resolvedProject, environmentCompatibility),
  }
}
