import { artifactSupportFor } from "./providers"
import type {
  MigrationArtifact,
  MigrationArtifactResult,
  MigrationPlan,
  MigrationPreview,
  MigrationProgress,
  MigrationResult,
  MigrationVendor,
} from "./types"

export interface PreviewArtifactOutput {
  items: unknown[]
  warnings: string[]
  metadata?: unknown
}

export interface MigrationPreviewDeps {
  previewArtifact: (
    vendor: MigrationVendor,
    artifact: MigrationArtifact,
    context?: { cwd?: string }
  ) => Promise<PreviewArtifactOutput>
}

export interface MigrationApplyDeps {
  applyArtifact: (
    vendor: MigrationVendor,
    artifact: MigrationArtifact,
    cell: NonNullable<MigrationPreview["artifacts"][MigrationArtifact]>,
    plan: MigrationPlan,
    signal?: AbortSignal
  ) => Promise<MigrationArtifactResult>
}

async function defaultPreviewDeps(): Promise<MigrationPreviewDeps> {
  const { previewMigrationArtifact } = await import("./artifacts")
  return { previewArtifact: previewMigrationArtifact }
}

async function defaultApplyDeps(): Promise<MigrationApplyDeps> {
  const { applyMigrationArtifact } = await import("./artifacts")
  return { applyArtifact: applyMigrationArtifact }
}

export async function buildMigrationPreview(
  vendor: MigrationVendor,
  artifacts: readonly MigrationArtifact[],
  deps?: MigrationPreviewDeps,
  context?: { cwd?: string }
): Promise<MigrationPreview> {
  const resolved = deps ?? (await defaultPreviewDeps())
  const preview: MigrationPreview = { vendor, artifacts: {} }
  for (const artifact of artifacts) {
    const support = artifactSupportFor(vendor, artifact)
    if (support === "unsupported") {
      preview.artifacts[artifact] = {
        artifact,
        status: "unsupported",
        count: 0,
        warnings: [],
        items: [],
      }
      continue
    }
    try {
      const result = await resolved.previewArtifact(vendor, artifact, context)
      preview.artifacts[artifact] = {
        artifact,
        status: support === "shared" ? "shared" : result.items.length > 0 ? "ready" : "empty",
        count: result.items.length,
        warnings: result.warnings,
        items: result.items,
        metadata: result.metadata,
      }
    } catch (error) {
      preview.artifacts[artifact] = {
        artifact,
        status: "error",
        count: 0,
        warnings: [error instanceof Error ? error.message : String(error)],
        items: [],
      }
    }
  }
  return preview
}

export async function applyMigration(
  plan: MigrationPlan,
  deps?: MigrationApplyDeps,
  onProgress?: (progress: MigrationProgress) => void,
  signal?: AbortSignal
): Promise<MigrationResult> {
  const resolved = deps ?? (await defaultApplyDeps())
  const result: MigrationResult = { vendor: plan.vendor, aborted: false, artifacts: {} }
  for (let index = 0; index < plan.artifacts.length; index += 1) {
    if (signal?.aborted) {
      result.aborted = true
      break
    }
    const artifact = plan.artifacts[index]
    const cell = plan.preview.artifacts[artifact]
    if (
      !cell ||
      cell.status === "shared" ||
      cell.status === "empty" ||
      cell.status === "unsupported"
    ) {
      result.artifacts[artifact] = {
        imported: 0,
        skipped: cell?.count ?? 0,
        warnings: cell?.warnings ?? [],
      }
      continue
    }
    onProgress?.({ artifact, phase: "started", done: index, total: plan.artifacts.length })
    try {
      result.artifacts[artifact] = await resolved.applyArtifact(
        plan.vendor,
        artifact,
        cell,
        plan,
        signal
      )
      onProgress?.({ artifact, phase: "completed", done: index + 1, total: plan.artifacts.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.artifacts[artifact] = { imported: 0, warnings: [], error: message }
      onProgress?.({ artifact, phase: "failed", done: index + 1, total: plan.artifacts.length })
    }
  }
  if (signal?.aborted) result.aborted = true
  return result
}

export * from "./types"
export { probeVendors } from "./probe"
