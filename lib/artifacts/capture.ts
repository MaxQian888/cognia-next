"use client"

/**
 * Let the agent see what it made.
 *
 * Every check an agent can run on an artifact is structural (`artifact_read`
 * returns source; `office_validate_workbook` returns findings), so a
 * wrong-but-valid chart or a workbook whose column is `########` passes all of
 * them. This turns an artifact into the PNG a person would see, for
 * `artifact_capture` (`lib/claude/artifact-builtin-tools.ts`).
 *
 * Pixels come from `captureArtifactToPngBlob` (`lib/artifacts/export/raster.ts`):
 * plugin renderers are mounted off-screen, sources with a serialisable form
 * are re-rendered off-screen, and the rest — live Recharts / Mermaid / React
 * previews — only exist where the dock drew them. For those this reveals the
 * artifact, waits for its preview to register, and captures once more: the
 * agent is looking at an artifact it just produced for the user, so bringing
 * it on screen is the expected effect, not a surprise.
 */

import { getArtifactPreviewNode } from "@/lib/artifacts/preview-registry"
import { hasArtifactFrameCapturer } from "@/lib/artifacts/frame-capture-registry"
import { revealArtifactInWorkspace } from "@/lib/artifacts/reveal"
import type { CaptureOptions } from "@/lib/artifacts/export/raster"
import type { Artifact } from "@/types"

/** How long a revealed artifact's preview may take to mount. */
export const PREVIEW_MOUNT_WAIT_MS = 5_000
const PREVIEW_POLL_MS = 100

export interface ArtifactImage {
  /** Base64 PNG, no `data:` prefix. */
  data: string
  mimeType: "image/png"
}

export interface CaptureEnvironment {
  reveal?: (artifactId: string) => unknown
  isPreviewMounted?: (artifactId: string) => boolean
  waitMs?: number
}

function previewMounted(artifactId: string): boolean {
  return getArtifactPreviewNode(artifactId) !== null || hasArtifactFrameCapturer(artifactId)
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_MS))
  }
  return true
}

/**
 * Render `artifact` to a PNG. Throws the raster module's typed errors
 * (`ArtifactPreviewNotMountedError` when even a revealed preview never
 * mounted, `ArtifactTooLargeToRasteriseError`, `ArtifactNotRasterisableError`,
 * `ArtifactRenderTimeoutError`) for the caller to explain.
 */
export async function captureArtifactImage(
  artifact: Artifact,
  options: CaptureOptions = {},
  env: CaptureEnvironment = {}
): Promise<ArtifactImage> {
  const { captureArtifactToPngBlob, readAsDataUrl, ArtifactPreviewNotMountedError } =
    await import("@/lib/artifacts/export/raster")
  let blob: Blob
  try {
    blob = await captureArtifactToPngBlob(artifact, options)
  } catch (error) {
    if (!(error instanceof ArtifactPreviewNotMountedError)) throw error
    ;(env.reveal ?? revealArtifactInWorkspace)(artifact.id)
    const mounted = env.isPreviewMounted ?? previewMounted
    if (!(await waitFor(() => mounted(artifact.id), env.waitMs ?? PREVIEW_MOUNT_WAIT_MS)))
      throw error
    blob = await captureArtifactToPngBlob(artifact, options)
  }
  const dataUrl = await readAsDataUrl(blob)
  return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/png" }
}
