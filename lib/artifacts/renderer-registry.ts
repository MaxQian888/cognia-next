/**
 * Plugin renderer registry — lets plugins claim ownership of specific
 * artifacts ahead of the built-in renderers. cognia-next has no plugin
 * runtime yet, so this map is always empty in practice; the surface is
 * preserved so upstream plugin code is API-compatible.
 */

import type { ReactElement } from "react"
import type { Artifact } from "@/types"
import { loggers } from "@/lib/logging"

export interface PluginArtifactRenderer {
  /** Stable id used for de-duplication when registered via plugin reload. */
  id: string
  /**
   * Plugin-facing renderer "type" tag (e.g., `"mermaid"`, `"chart"`).
   * The plugin API surface — `lib/plugin/api/artifact-api.ts:registerRenderer` —
   * forwards the namespaced `${pluginId}:${type}` here so the runtime can
   * surface a stable label per registration.
   */
  type?: string
  /** Human-readable label shown in renderer-aware UI. */
  name?: string
  /** Returns true when this renderer should claim the artifact. */
  canRender(artifact: Artifact): boolean
  /** Returns the rendered React subtree. */
  render(artifact: Artifact, container?: HTMLElement): ReactElement | null | (() => void)
  /** Optional priority hint; higher wins when multiple renderers claim. */
  priority?: number
}

const artifactRenderers = new Map<string, PluginArtifactRenderer>()

function safelyClaimsArtifact(renderer: PluginArtifactRenderer, artifact: Artifact): boolean {
  try {
    return renderer.canRender(artifact)
  } catch (error) {
    loggers.plugin.warn("artifacts.plugin.canRender-failed", {
      rendererId: renderer.id,
      artifactId: artifact.id,
      error,
    })
    return false
  }
}

export function registerArtifactRenderer(
  rendererId: string,
  renderer: PluginArtifactRenderer
): () => void {
  artifactRenderers.set(rendererId, renderer)

  return () => {
    artifactRenderers.delete(rendererId)
  }
}

export function getRegisteredArtifactRenderers(): PluginArtifactRenderer[] {
  return Array.from(artifactRenderers.values())
}

export function resolveRegisteredArtifactRenderer(
  artifact: Artifact
): PluginArtifactRenderer | null {
  for (const renderer of artifactRenderers.values()) {
    if (safelyClaimsArtifact(renderer, artifact)) {
      return renderer
    }
  }

  return null
}

export function clearRegisteredArtifactRenderers(): void {
  artifactRenderers.clear()
}
