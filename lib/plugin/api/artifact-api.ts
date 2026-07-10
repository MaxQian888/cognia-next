/**
 * Plugin Artifact API Implementation
 *
 * Provides artifact management capabilities to plugins.
 */

import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  buildArtifactSourceMetadata,
  clearRegisteredArtifactRenderers,
  getRegisteredArtifactRenderers,
  registerArtifactRenderer,
  revealArtifactInWorkspace,
} from "@/lib/artifacts"
import type {
  PluginArtifactAPI,
  CreateArtifactOptions,
  ArtifactFilter,
  ArtifactRenderer,
} from "@/types/plugin/plugin"
import type { Artifact } from "@/types/artifact"
import { createPluginSystemLogger } from "../core/logger"
import { createApiGuardedAPI } from "./api-permission-gate"
import {
  MermaidRenderer,
  ChartRenderer,
  MathRenderer,
  MarkdownRenderer,
  CodeRenderer,
  ArtifactRenderer as ArtifactRendererComponent,
} from "@/components/artifacts/artifact-renderers"
import { ArtifactPreview } from "@/components/artifacts/artifact-preview"

/**
 * Create the Artifact API for a plugin
 */
export function createArtifactAPI(pluginId: string): PluginArtifactAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginArtifactAPI = {
    getActiveArtifact: (): Artifact | null => {
      const store = useArtifactStore.getState()
      if (!store.activeArtifactId) return null
      return store.artifacts[store.activeArtifactId] || null
    },

    getArtifact: (id: string): Artifact | null => {
      const store = useArtifactStore.getState()
      return store.artifacts[id] || null
    },

    createArtifact: async (options: CreateArtifactOptions): Promise<string> => {
      const store = useArtifactStore.getState()
      const sessionId = options.sessionId || ""
      const messageId = options.messageId || ""
      const resolvedType =
        options.type === "text"
          ? "document"
          : (options.type as "code" | "react" | "html" | "svg" | "mermaid" | "document") || "code"
      const artifact = store.createArtifact({
        sessionId,
        messageId,
        type: resolvedType,
        title: options.title,
        content: options.content,
        language: options.language,
        metadata: {
          ...buildArtifactSourceMetadata({
            sessionId,
            messageId,
            type: resolvedType,
            content: options.content,
            language: options.language,
            sourceOrigin: options.metadata?.sourceOrigin || "tool",
            userInitiated: options.metadata?.userInitiated ?? true,
            metadata: options.metadata,
          }),
          ...options.metadata,
        },
      })
      const id = typeof artifact === "string" ? artifact : artifact?.id || ""
      logger.info(`Created artifact: ${id}`)
      return id
    },

    updateArtifact: (id: string, updates: Partial<Artifact>) => {
      const store = useArtifactStore.getState()
      store.updateArtifact(id, updates)
      logger.info(`Updated artifact: ${id}`)
    },

    deleteArtifact: (id: string) => {
      const store = useArtifactStore.getState()
      store.deleteArtifact(id)
      logger.info(`Deleted artifact: ${id}`)
    },

    listArtifacts: (filter?: ArtifactFilter): Artifact[] => {
      const store = useArtifactStore.getState()
      let artifacts = Object.values(store.artifacts)

      if (filter) {
        if (filter.sessionId) {
          artifacts = artifacts.filter((a) => a.sessionId === filter.sessionId)
        }
        if (filter.type) {
          artifacts = artifacts.filter((a) => a.type === filter.type)
        }
        if (filter.language) {
          artifacts = artifacts.filter((a) => a.language === filter.language)
        }
      }

      // Sort by updatedAt descending before applying pagination
      artifacts.sort((a, b) => {
        const dateA = a.updatedAt instanceof Date ? a.updatedAt : new Date(a.updatedAt)
        const dateB = b.updatedAt instanceof Date ? b.updatedAt : new Date(b.updatedAt)
        return dateB.getTime() - dateA.getTime()
      })

      if (filter) {
        if (filter.offset) {
          artifacts = artifacts.slice(filter.offset)
        }
        if (filter.limit) {
          artifacts = artifacts.slice(0, filter.limit)
        }
      }

      return artifacts
    },

    openArtifact: (id: string) => {
      const artifact = revealArtifactInWorkspace(id)
      if (artifact) {
        logger.info(`Opened artifact: ${id}`)
      }
    },

    closeArtifact: () => {
      const store = useArtifactStore.getState()
      store.closePanel()
      logger.info("Closed artifact panel")
    },

    onArtifactChange: (handler: (artifact: Artifact | null) => void) => {
      let lastArtifactId: string | null = null

      const unsubscribe = useArtifactStore.subscribe((state) => {
        const currentId = state.activeArtifactId || null
        if (currentId !== lastArtifactId) {
          lastArtifactId = currentId
          const artifact = currentId ? state.artifacts[currentId] : null
          handler(artifact || null)
        }
      })

      return unsubscribe
    },

    registerRenderer: (type: string, renderer: ArtifactRenderer) => {
      const rendererId = `${pluginId}:${type}`
      const unregister = registerArtifactRenderer(rendererId, {
        id: rendererId,
        type: rendererId,
        name: renderer.name,
        canRender: renderer.canRender,
        render: renderer.render,
      })
      logger.info(`Registered artifact renderer: ${type}`)

      return () => {
        unregister()
        logger.info(`Unregistered artifact renderer: ${type}`)
      }
    },
  }

  return createApiGuardedAPI(
    pluginId,
    api,
    {
      getActiveArtifact: "artifact:read",
      getArtifact: "artifact:read",
      createArtifact: "artifact:write",
      updateArtifact: "artifact:write",
      deleteArtifact: "artifact:write",
      listArtifacts: "artifact:read",
      openArtifact: "artifact:write",
      closeArtifact: "artifact:write",
      onArtifactChange: "artifact:read",
    },
    {
      // Contribution registration: exposes the plugin's own renderer, reads no
      // user artifact data.
      unguarded: ["registerRenderer"],
    }
  )
}

/**
 * Get all registered artifact renderers. Returns the registry's
 * `PluginArtifactRenderer` shape — every entry carries `id` plus the
 * plugin-API-style `type` / `name` tags filled in by `registerRenderer`.
 */
export function getArtifactRenderers() {
  return getRegisteredArtifactRenderers()
}

/**
 * Clear all artifact renderers (for testing purposes)
 */
export function clearArtifactRenderers(): void {
  clearRegisteredArtifactRenderers()
}

/**
 * Get the built-in artifact renderers provided by the platform.
 * Plugins can use these to render standard artifact types without
 * implementing their own rendering logic.
 */
export function getBuiltinRenderers() {
  return {
    MermaidRenderer,
    ChartRenderer,
    MathRenderer,
    MarkdownRenderer,
    CodeRenderer,
  }
}

/**
 * Get the default ArtifactRenderer component that routes to the
 * appropriate renderer based on artifact type.
 */
export function getDefaultArtifactRenderer() {
  return ArtifactRendererComponent
}

/**
 * Get the ArtifactPreview component for full artifact preview
 * including iframe-based rendering for HTML, SVG, and React types.
 */
export function getArtifactPreviewComponent() {
  return ArtifactPreview
}
