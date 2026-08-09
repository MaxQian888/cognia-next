/**
 * Plugin renderer registry — lets plugins claim ownership of specific
 * namespaced custom artifacts ahead of the built-in renderers. Renderers use
 * an imperative mount/update/dispose lifecycle inside a host-owned container.
 */

import type { Artifact } from "@/types"
import { loggers } from "@cognia/logging"

export interface PluginArtifactRenderer {
  /** Stable id used for de-duplication when registered via plugin reload. */
  id: string
  /**
   * Plugin-facing renderer "type" tag (e.g., `"mermaid"`, `"chart"`).
   * The plugin API surface — `lib/plugin/api/artifact-api.ts:registerRenderer` —
   * forwards the namespaced `${pluginId}:${type}` here so the runtime can
   * surface a stable label per registration.
   */
  kind: string
  /** Human-readable label shown in renderer-aware UI. */
  name?: string
  /** Imperatively mount into the host-owned container. */
  mount(artifact: Artifact, container: HTMLElement): PluginArtifactRendererHandle
  /** Optional priority hint; higher wins when multiple renderers claim. */
  priority?: number
}

export interface PluginArtifactRendererHandle {
  update?: (artifact: Artifact) => void
  dispose(): void
}

const artifactRenderers = new Map<string, PluginArtifactRenderer>()

export function registerArtifactRenderer(
  rendererId: string,
  renderer: PluginArtifactRenderer
): () => void {
  artifactRenderers.set(renderer.kind, renderer)

  return () => {
    if (artifactRenderers.get(renderer.kind)?.id === rendererId) {
      artifactRenderers.delete(renderer.kind)
    }
  }
}

export function getRegisteredArtifactRenderers(): PluginArtifactRenderer[] {
  return Array.from(artifactRenderers.values())
}

export function resolveRegisteredArtifactRenderer(
  artifact: Artifact
): PluginArtifactRenderer | null {
  const kind = artifact.metadata?.plugin?.kind
  if (!kind) return null
  const renderer = artifactRenderers.get(kind) ?? null
  if (!renderer) {
    loggers.plugin.debug("artifacts.plugin.renderer-missing", { artifactId: artifact.id, kind })
  }
  return renderer
}

export function clearRegisteredArtifactRenderers(): void {
  artifactRenderers.clear()
}
