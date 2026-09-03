"use client"

/**
 * How the exporter reaches the pixels of a SANDBOXED artifact preview.
 *
 * `preview-registry.ts` solves the same problem for `renderer` types by
 * handing out the mounted DOM node, and it says plainly that iframe types
 * cannot work that way. This is why: a React artifact frame is
 * `sandbox="allow-scripts"` with no `allow-same-origin`, so its origin is
 * opaque, `contentDocument` is null to us, and html2canvas cannot walk into
 * it. Rasterising INSIDE the frame is not an option either, because
 * html2canvas clones the document into a child iframe and an opaque-origin
 * document cannot read even its own about:blank child.
 *
 * What is left is a conversation. The frame serialises what it drew and posts
 * the markup back, and the parent renders that in the same-origin capture
 * frame it already uses for `html` artifacts. This module owns the request /
 * response correlation for that round trip.
 *
 * A plain module-level Map for the same reason `preview-registry.ts` uses one:
 * nothing renders off it, it is read once per export, and a React context
 * would re-render every preview whenever an unrelated one mounted.
 */

/** A capture the frame could not answer. */
export class ArtifactFrameCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArtifactFrameCaptureError"
  }
}

/** The frame never answered. Almost always a preview that was closed mid-export. */
export class ArtifactFrameCaptureTimeoutError extends Error {
  constructor(artifactId: string, ms: number) {
    super(`artifact ${artifactId} preview did not answer a capture within ${ms}ms`)
    this.name = "ArtifactFrameCaptureTimeoutError"
  }
}

export interface ArtifactFrameSnapshot {
  /** A complete HTML document of what the frame rendered. */
  html: string
  width: number
  height: number
}

/**
 * Default ceiling on the round trip. Generous because the frame may still be
 * painting, but finite because a closed preview never answers at all.
 */
export const FRAME_CAPTURE_TIMEOUT_MS = 10_000

type Capturer = (timeoutMs: number) => Promise<ArtifactFrameSnapshot>

const capturers = new Map<string, Capturer>()

/**
 * Record how to ask `artifactId`'s live frame for a snapshot, returning a
 * disposer. Re-registering the same id replaces the entry, so a remount (the
 * preview iframe is keyed) never leaves the exporter holding a dead frame.
 */
export function registerArtifactFrameCapturer(artifactId: string, capture: Capturer): () => void {
  capturers.set(artifactId, capture)
  return () => {
    if (capturers.get(artifactId) === capture) capturers.delete(artifactId)
  }
}

/** Whether a live frame is currently able to answer for `artifactId`. */
export function hasArtifactFrameCapturer(artifactId: string): boolean {
  return capturers.has(artifactId)
}

/**
 * Ask `artifactId`'s frame for a snapshot, or `null` when no preview is
 * mounted. `null` rather than a throw so the caller can raise the same
 * "preview it first" error it already raises for renderer types.
 */
export async function captureArtifactFrame(
  artifactId: string,
  timeoutMs: number = FRAME_CAPTURE_TIMEOUT_MS
): Promise<ArtifactFrameSnapshot | null> {
  const capture = capturers.get(artifactId)
  if (!capture) return null
  return capture(timeoutMs)
}

/** Test seam. The registry is module state, so a suite has to be able to clear it. */
export function __resetArtifactFrameCapturersForTests(): void {
  capturers.clear()
}
