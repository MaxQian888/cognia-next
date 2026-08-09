/**
 * Plugin Artifact API Implementation
 *
 * Provides artifact management capabilities to plugins.
 */

import { selectActiveArtifactId, useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
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
      const activeId = selectActiveArtifactId(store, useChatStore.getState().activeSessionId)
      if (!activeId) return null
      return store.artifacts[activeId] || null
    },

    getArtifact: (id: string): Artifact | null => {
      const store = useArtifactStore.getState()
      return store.artifacts[id] || null
    },

    createArtifact: async (options: CreateArtifactOptions): Promise<string> => {
      const store = useArtifactStore.getState()
      const sessionId = options.sessionId || ""
      const messageId = options.messageId || ""
      const resolvedType = options.type === "text" ? "document" : options.type || "code"
      const requestedKind = options.kind ?? `${pluginId}/artifact`
      const kind = requestedKind.includes("/") ? requestedKind : `${pluginId}/${requestedKind}`
      if (!kind.startsWith(`${pluginId}/`)) {
        throw new Error(`artifact kind must be owned by plugin ${pluginId}`)
      }
      const schemaVersion = options.schemaVersion ?? 1
      if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
        throw new Error("artifact schemaVersion must be a positive integer")
      }
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
          plugin: { kind, schemaVersion, ownerPluginId: pluginId },
        },
      })
      const id = typeof artifact === "string" ? artifact : artifact?.id || ""
      logger.info(`Created artifact: ${id}`)
      return id
    },

    updateArtifact: (id, updates) => {
      const store = useArtifactStore.getState()
      const artifact = store.artifacts[id]
      assertOwnedArtifact(pluginId, artifact, id)
      if (artifact.version !== updates.expectedVersion) {
        throw new Error(
          `artifact version conflict for ${id}: expected ${updates.expectedVersion}, current ${artifact.version}`
        )
      }
      if (
        updates.title === undefined &&
        updates.content === undefined &&
        updates.metadata === undefined
      ) {
        throw new Error("artifact update requires title, content, or metadata")
      }
      store.saveArtifactVersion(id, updates.changeDescription)
      const patch: Partial<Artifact> = {}
      if (updates.title !== undefined) patch.title = updates.title
      if (updates.content !== undefined) patch.content = updates.content
      if (updates.metadata !== undefined) {
        patch.metadata = {
          ...artifact.metadata,
          ...updates.metadata,
          plugin: artifact.metadata?.plugin,
        }
      }
      store.updateArtifact(id, patch)
      logger.info(`Updated artifact: ${id}`)
      return store.artifacts[id] ?? { ...artifact, ...patch, version: artifact.version + 1 }
    },

    deleteArtifact: (id: string) => {
      const store = useArtifactStore.getState()
      assertOwnedArtifact(pluginId, store.artifacts[id], id)
      store.deleteArtifact(id)
      logger.info(`Deleted artifact: ${id}`)
    },

    listVersions: (id) => {
      const store = useArtifactStore.getState()
      assertOwnedArtifact(pluginId, store.artifacts[id], id)
      return store.getArtifactVersions(id)
    },

    restoreVersion: (id, versionId, expectedVersion) => {
      const store = useArtifactStore.getState()
      const artifact = store.artifacts[id]
      assertOwnedArtifact(pluginId, artifact, id)
      if (artifact.version !== expectedVersion) {
        throw new Error(
          `artifact version conflict for ${id}: expected ${expectedVersion}, current ${artifact.version}`
        )
      }
      store.restoreArtifactVersion(id, versionId)
      return store.artifacts[id] ?? { ...artifact, version: artifact.version + 1 }
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
        // The active artifact is per-conversation now, so "the" active one is
        // whichever the on-screen conversation is parked on.
        const currentId = selectActiveArtifactId(state, useChatStore.getState().activeSessionId)
        if (currentId !== lastArtifactId) {
          lastArtifactId = currentId
          const artifact = currentId ? state.artifacts[currentId] : null
          handler(artifact || null)
        }
      })

      return unsubscribe
    },

    registerRenderer: (type: string, renderer: ArtifactRenderer) => {
      const kind = type.includes("/") ? type : `${pluginId}/${type}`
      if (!kind.startsWith(`${pluginId}/`)) {
        throw new Error(`artifact renderer kind must be owned by plugin ${pluginId}`)
      }
      const rendererId = kind
      const unregister = registerArtifactRenderer(rendererId, {
        id: rendererId,
        kind,
        name: renderer.name,
        mount: renderer.mount,
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
      listVersions: "artifact:read",
      restoreVersion: "artifact:write",
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

function assertOwnedArtifact(
  pluginId: string,
  artifact: Artifact | undefined,
  id: string
): asserts artifact is Artifact {
  if (!artifact) throw new Error(`artifact "${id}" was not found`)
  if (artifact.metadata?.plugin?.ownerPluginId !== pluginId) {
    throw new Error(`plugin ${pluginId} does not own artifact ${id}`)
  }
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
