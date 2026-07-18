/**
 * A2UI Zustand Store
 * Manages A2UI surfaces, components, and data models
 */

import { create } from "zustand"
import { persist, subscribeWithSelector } from "zustand/middleware"
import type {
  A2UISurfaceState,
  A2UISurfaceType,
  A2UIComponent,
  A2UIDispatchMessage,
  A2UIUserAction,
  A2UIDataModelChange,
  A2UIWidgetMetadata,
} from "@/types/a2ui/schema"
import {
  isCreateSurfaceMessage,
  isUpdateComponentsMessage,
  isUpdateDataModelMessage,
  isDeleteSurfaceMessage,
  isSurfaceReadyMessage,
  isConnectorActionMessage,
} from "@/lib/a2ui/parser"
import { setValueByPath, getValueByPath, deepMerge, deepClone } from "@/lib/a2ui/data-model"
import { globalEventEmitter, createUserAction, createDataModelChange } from "@/lib/a2ui/events"

/**
 * History entry for undo/redo
 */
export interface A2UIHistoryEntry {
  id: string
  timestamp: number
  description: string
  components: Record<string, A2UIComponent>
  dataModel: Record<string, unknown>
}

const MAX_HISTORY_ENTRIES = 50
const HISTORY_DEBOUNCE_MS = 300

/**
 * Compute the undo/redo stack update for a snapshot of `surfaceId`.
 *
 * Extracted so mutating actions (updateComponents / updateDataModel) can fold
 * the snapshot into the same set() transaction as the mutation itself — a
 * separate pushSnapshot set() would notify every subscriber twice per patch,
 * which compounds badly during streaming.
 *
 * Returns null when the surface does not exist.
 */
function buildSnapshotUpdate(
  state: Pick<A2UIState, "surfaces" | "undoStacks" | "redoStacks">,
  surfaceId: string,
  description: string
): Partial<Pick<A2UIState, "undoStacks" | "redoStacks">> | null {
  const surface = state.surfaces[surfaceId]
  if (!surface) return null

  const stack = state.undoStacks[surfaceId] || []
  const lastEntry = stack[stack.length - 1]

  // Debounce: merge consecutive same-description snapshots within 300ms
  if (
    lastEntry &&
    lastEntry.description === description &&
    Date.now() - lastEntry.timestamp < HISTORY_DEBOUNCE_MS
  ) {
    // Update the latest entry's timestamp (keep original snapshot)
    const updatedStack = [...stack]
    updatedStack[updatedStack.length - 1] = { ...lastEntry, timestamp: Date.now() }
    return {
      undoStacks: { ...state.undoStacks, [surfaceId]: updatedStack },
    }
  }

  // The store mutates `components` / `dataModel` immutably (every
  // update replaces them via structural sharing — see
  // `lib/a2ui/data-model.ts`), so a snapshot can capture the current
  // references directly instead of deep-cloning the whole tree on
  // every component/data update. Structural sharing means the
  // retained snapshots also share unchanged subtrees, so undo history
  // costs O(changed-spine) memory rather than O(model size) per step.
  const entry: A2UIHistoryEntry = {
    id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    description,
    components: surface.components,
    dataModel: surface.dataModel,
  }

  const newStack = [...stack, entry].slice(-MAX_HISTORY_ENTRIES)

  return {
    undoStacks: { ...state.undoStacks, [surfaceId]: newStack },
    // Clear redo stack on new change
    redoStacks: { ...state.redoStacks, [surfaceId]: [] },
  }
}

/**
 * A2UI Store State
 */
export interface A2UIState {
  // Surface management
  surfaces: Record<string, A2UISurfaceState>
  activeSurfaceId: string | null

  // Event history (for debugging and AI context)
  eventHistory: (A2UIUserAction | A2UIDataModelChange)[]
  maxEventHistory: number

  // Loading states (Record instead of Set for JSON serialization compatibility)
  loadingSurfaces: Record<string, true>

  // Streaming state (Record instead of Set for JSON serialization compatibility)
  streamingSurfaces: Record<string, true>

  // Error tracking
  errors: Record<string, string>

  // Undo/redo history (per surface, not persisted)
  undoStacks: Record<string, A2UIHistoryEntry[]>
  redoStacks: Record<string, A2UIHistoryEntry[]>
}

/**
 * A2UI Store Actions
 */
export interface A2UIActions {
  // Surface lifecycle
  createSurface: (
    surfaceId: string,
    type: A2UISurfaceType,
    options?: { catalogId?: string; title?: string; widget?: A2UIWidgetMetadata }
  ) => void
  deleteSurface: (surfaceId: string) => void
  setActiveSurface: (surfaceId: string | null) => void

  // Component management
  updateComponents: (surfaceId: string, components: A2UIComponent[]) => void
  getComponent: (surfaceId: string, componentId: string) => A2UIComponent | undefined

  // Data model management
  updateDataModel: (surfaceId: string, data: Record<string, unknown>, merge?: boolean) => void
  setDataValue: (surfaceId: string, path: string, value: unknown) => void
  getDataValue: <T = unknown>(surfaceId: string, path: string) => T | undefined

  // Message processing
  processMessage: (message: A2UIDispatchMessage) => void
  processMessages: (messages: A2UIDispatchMessage[]) => void
  processMessageStream: (messages: A2UIDispatchMessage[], delayMs?: number) => Promise<void>
  setSurfaceStreaming: (surfaceId: string, streaming: boolean) => void

  // Event handling
  emitAction: (
    surfaceId: string,
    action: string,
    componentId: string,
    data?: Record<string, unknown>
  ) => void
  emitDataChange: (surfaceId: string, path: string, value: unknown) => void

  // Surface state
  setSurfaceReady: (surfaceId: string) => void
  setSurfaceLoading: (surfaceId: string, loading: boolean) => void
  setError: (surfaceId: string, error: string | null) => void

  // Undo/redo
  pushSnapshot: (surfaceId: string, description: string) => void
  undo: (surfaceId: string) => void
  redo: (surfaceId: string) => void
  canUndo: (surfaceId: string) => boolean
  canRedo: (surfaceId: string) => boolean

  // Utilities
  getSurface: (surfaceId: string) => A2UISurfaceState | undefined
  clearEventHistory: () => void
  reset: () => void
}

/**
 * Initial state
 */
const initialState: A2UIState = {
  surfaces: {},
  activeSurfaceId: null,
  eventHistory: [],
  maxEventHistory: 100,
  loadingSurfaces: {},
  streamingSurfaces: {},
  errors: {},
  undoStacks: {},
  redoStacks: {},
}

/**
 * Schema v3 migration (2026-05): merge legacy `DataExplorer` component into
 * the unified `Table` component. The Table schema now accepts the same
 * `sortKeyPath` / `sortDirectionPath` / `actionMeta` fields the DataExplorer
 * carried, so the migration is a field-preserving rename. Applied to incoming
 * messages (`updateComponents`) and rehydrated state alike.
 */
function migrateLegacyComponent(component: A2UIComponent): A2UIComponent {
  if (component && (component as { component?: string }).component === "DataExplorer") {
    const { component: _legacyType, ...rest } = component as A2UIComponent & {
      component: "DataExplorer"
    }
    return { ...rest, component: "Table" } as A2UIComponent
  }
  return component
}

function migrateComponentMap(
  components: Record<string, A2UIComponent>
): Record<string, A2UIComponent> {
  let mutated = false
  const next: Record<string, A2UIComponent> = {}
  for (const [id, value] of Object.entries(components)) {
    const migrated = migrateLegacyComponent(value)
    next[id] = migrated
    if (migrated !== value) mutated = true
  }
  return mutated ? next : components
}

function normalizePersistedSurfaces(persistedSurfaces: unknown): Record<string, A2UISurfaceState> {
  if (!persistedSurfaces || typeof persistedSurfaces !== "object") {
    return {}
  }

  const normalized: Record<string, A2UISurfaceState> = {}
  for (const [surfaceId, value] of Object.entries(persistedSurfaces as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue
    }

    const surface = value as Partial<A2UISurfaceState>
    const rawComponents =
      surface.components && typeof surface.components === "object"
        ? (surface.components as Record<string, A2UIComponent>)
        : {}
    const components = migrateComponentMap(rawComponents)
    const dataModel =
      surface.dataModel && typeof surface.dataModel === "object"
        ? (surface.dataModel as Record<string, unknown>)
        : {}
    const hasRenderableTree = Object.keys(components).length > 0

    normalized[surfaceId] = {
      id: typeof surface.id === "string" ? surface.id : surfaceId,
      type: surface.type ?? "inline",
      catalogId: surface.catalogId,
      title: surface.title,
      widget: surface.widget,
      components,
      dataModel,
      rootId: surface.rootId ?? "root",
      createdAt: typeof surface.createdAt === "number" ? surface.createdAt : Date.now(),
      updatedAt: typeof surface.updatedAt === "number" ? surface.updatedAt : Date.now(),
      // Metadata-only persistence cannot be treated as "ready"
      ready: Boolean(surface.ready) && hasRenderableTree,
    }
  }

  return normalized
}

/**
 * A2UI Store
 */
export const useA2UIStore = create<A2UIState & A2UIActions>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        ...initialState,

        // Surface lifecycle
        createSurface: (surfaceId, type, options) => {
          set((state) => ({
            surfaces: {
              ...state.surfaces,
              [surfaceId]: {
                id: surfaceId,
                type,
                catalogId: options?.catalogId,
                title: options?.title,
                widget: options?.widget,
                components: {},
                dataModel: {},
                rootId: "root",
                createdAt: Date.now(),
                updatedAt: Date.now(),
                ready: false,
              },
            },
            activeSurfaceId: state.activeSurfaceId ?? surfaceId,
          }))
        },

        deleteSurface: (surfaceId) => {
          set((state) => {
            const { [surfaceId]: _, ...remainingSurfaces } = state.surfaces
            const { [surfaceId]: __, ...remainingErrors } = state.errors
            const { [surfaceId]: ___, ...remainingLoading } = state.loadingSurfaces
            const { [surfaceId]: ____, ...remainingStreaming } = state.streamingSurfaces

            return {
              surfaces: remainingSurfaces,
              errors: remainingErrors,
              loadingSurfaces: remainingLoading,
              streamingSurfaces: remainingStreaming,
              activeSurfaceId:
                state.activeSurfaceId === surfaceId
                  ? (Object.keys(remainingSurfaces)[0] ?? null)
                  : state.activeSurfaceId,
            }
          })
        },

        setActiveSurface: (surfaceId) => {
          set({ activeSurfaceId: surfaceId })
        },

        // Component management
        updateComponents: (surfaceId, components) => {
          // Snapshot + mutation in one set() transaction (single notification)
          set((state) => {
            const surface = state.surfaces[surfaceId]
            if (!surface) return state

            const snapshot = buildSnapshotUpdate(state, surfaceId, "updateComponents")

            const updatedComponents = { ...surface.components }
            for (const component of components) {
              updatedComponents[component.id] = migrateLegacyComponent(component)
            }

            return {
              ...snapshot,
              surfaces: {
                ...state.surfaces,
                [surfaceId]: {
                  ...surface,
                  components: updatedComponents,
                  updatedAt: Date.now(),
                },
              },
            }
          })
        },

        getComponent: (surfaceId, componentId) => {
          const surface = get().surfaces[surfaceId]
          return surface?.components[componentId]
        },

        // Data model management
        updateDataModel: (surfaceId, data, merge = true) => {
          // Snapshot + mutation in one set() transaction (single notification)
          set((state) => {
            const surface = state.surfaces[surfaceId]
            if (!surface) return state

            const snapshot = buildSnapshotUpdate(state, surfaceId, "updateDataModel")
            const newDataModel = merge ? deepMerge(surface.dataModel, data) : deepClone(data)

            return {
              ...snapshot,
              surfaces: {
                ...state.surfaces,
                [surfaceId]: {
                  ...surface,
                  dataModel: newDataModel,
                  updatedAt: Date.now(),
                },
              },
            }
          })
        },

        setDataValue: (surfaceId, path, value) => {
          const changeEvent = createDataModelChange(surfaceId, path, value)

          // Mutation + event-history append in one set() transaction so each
          // keystroke fires a single store notification
          set((state) => {
            const eventHistory = [changeEvent, ...state.eventHistory].slice(
              0,
              state.maxEventHistory
            )
            const surface = state.surfaces[surfaceId]
            if (!surface) return { eventHistory }

            const newDataModel = setValueByPath(surface.dataModel, path, value)

            return {
              eventHistory,
              surfaces: {
                ...state.surfaces,
                [surfaceId]: {
                  ...surface,
                  dataModel: newDataModel,
                  updatedAt: Date.now(),
                },
              },
            }
          })

          // Emit to global event emitter
          globalEventEmitter.emitDataChange(changeEvent)
        },

        getDataValue: <T = unknown>(surfaceId: string, path: string): T | undefined => {
          const surface = get().surfaces[surfaceId]
          if (!surface) return undefined
          return getValueByPath<T>(surface.dataModel, path)
        },

        // Message processing
        processMessage: (message) => {
          const {
            createSurface,
            updateComponents,
            updateDataModel,
            deleteSurface,
            setSurfaceReady,
            emitAction,
          } = get()

          // Connector-action injection (a2ui_handle_connector_action MCP tool):
          // surface an IM-side callback as a userAction, exactly like an
          // in-renderer click. `value` carries the action id for buttons; for
          // submit/dismiss it is empty, so fall back to the action type.
          if (isConnectorActionMessage(message)) {
            const action =
              message.value && message.value.length > 0 ? message.value : message.actionType
            const data: Record<string, unknown> = {
              source: "connector",
              actionType: message.actionType,
            }
            if (message.value !== undefined) data.value = message.value
            if (message.platform !== undefined) data.platform = message.platform
            if (message.triggerId !== undefined) data.triggerId = message.triggerId
            if (message.conversationKey !== undefined)
              data.conversationKey = message.conversationKey
            if (message.payload !== undefined) data.payload = message.payload
            emitAction(message.surfaceId, action, message.componentId ?? "", data)
            return
          }

          if (isCreateSurfaceMessage(message)) {
            createSurface(message.surfaceId, message.surfaceType, {
              catalogId: message.catalogId,
              title: message.title,
              widget: message.widget,
            })
          } else if (isUpdateComponentsMessage(message)) {
            updateComponents(message.surfaceId, message.components)
          } else if (isUpdateDataModelMessage(message)) {
            updateDataModel(message.surfaceId, message.data, message.merge)
          } else if (isDeleteSurfaceMessage(message)) {
            deleteSurface(message.surfaceId)
          } else if (isSurfaceReadyMessage(message)) {
            setSurfaceReady(message.surfaceId)
          }
        },

        processMessages: (messages) => {
          const { processMessage } = get()
          for (const message of messages) {
            processMessage(message)
          }
        },

        processMessageStream: async (messages, delayMs = 50) => {
          const { processMessage, setSurfaceStreaming } = get()
          // Extract surface IDs from messages
          const surfaceIds = new Set<string>()
          for (const msg of messages) {
            if ("surfaceId" in msg) {
              surfaceIds.add((msg as { surfaceId: string }).surfaceId)
            }
          }
          // Mark surfaces as streaming
          for (const sid of surfaceIds) {
            setSurfaceStreaming(sid, true)
          }
          try {
            // Process messages with delay for progressive rendering
            for (let i = 0; i < messages.length; i++) {
              processMessage(messages[i])
              if (delayMs > 0 && i < messages.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, delayMs))
              }
            }
          } finally {
            // Always clear streaming state
            for (const sid of surfaceIds) {
              setSurfaceStreaming(sid, false)
            }
          }
        },

        setSurfaceStreaming: (surfaceId, streaming) => {
          set((state) => {
            if (streaming) {
              return {
                streamingSurfaces: { ...state.streamingSurfaces, [surfaceId]: true as const },
              }
            }
            const { [surfaceId]: _, ...rest } = state.streamingSurfaces
            return { streamingSurfaces: rest }
          })
        },

        // Event handling
        emitAction: (surfaceId, action, componentId, data) => {
          const actionEvent = createUserAction(surfaceId, action, componentId, data)

          // Add to history
          set((state) => {
            const newHistory = [actionEvent, ...state.eventHistory].slice(0, state.maxEventHistory)
            return { eventHistory: newHistory }
          })

          // Emit to global event emitter
          globalEventEmitter.emitAction(actionEvent)
        },

        emitDataChange: (surfaceId, path, value) => {
          const changeEvent = createDataModelChange(surfaceId, path, value)

          // Add to history
          set((state) => {
            const newHistory = [changeEvent, ...state.eventHistory].slice(0, state.maxEventHistory)
            return { eventHistory: newHistory }
          })

          // Emit to global event emitter
          globalEventEmitter.emitDataChange(changeEvent)
        },

        // Surface state
        setSurfaceReady: (surfaceId) => {
          set((state) => {
            const surface = state.surfaces[surfaceId]
            if (!surface) return state

            const { [surfaceId]: _, ...remainingLoading } = state.loadingSurfaces

            return {
              surfaces: {
                ...state.surfaces,
                [surfaceId]: {
                  ...surface,
                  ready: true,
                  updatedAt: Date.now(),
                },
              },
              loadingSurfaces: remainingLoading,
            }
          })
        },

        setSurfaceLoading: (surfaceId, loading) => {
          set((state) => {
            if (loading) {
              return { loadingSurfaces: { ...state.loadingSurfaces, [surfaceId]: true as const } }
            }
            const { [surfaceId]: _, ...rest } = state.loadingSurfaces
            return { loadingSurfaces: rest }
          })
        },

        setError: (surfaceId, error) => {
          set((state) => {
            if (error === null) {
              const { [surfaceId]: _, ...remainingErrors } = state.errors
              return { errors: remainingErrors }
            }
            return {
              errors: {
                ...state.errors,
                [surfaceId]: error,
              },
            }
          })
        },

        // Undo/redo
        pushSnapshot: (surfaceId, description) => {
          set((state) => buildSnapshotUpdate(state, surfaceId, description) ?? state)
        },

        undo: (surfaceId) => {
          const state = get()
          const undoStack = state.undoStacks[surfaceId] || []
          if (undoStack.length === 0) return

          const surface = state.surfaces[surfaceId]
          if (!surface) return

          const lastEntry = undoStack[undoStack.length - 1]

          // Save current state to redo stack — immutable refs (see pushSnapshot).
          const redoEntry: A2UIHistoryEntry = {
            id: `redo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            description: "undo",
            components: surface.components,
            dataModel: surface.dataModel,
          }

          set({
            surfaces: {
              ...state.surfaces,
              [surfaceId]: {
                ...surface,
                components: lastEntry.components,
                dataModel: lastEntry.dataModel,
                updatedAt: Date.now(),
              },
            },
            undoStacks: {
              ...state.undoStacks,
              [surfaceId]: undoStack.slice(0, -1),
            },
            redoStacks: {
              ...state.redoStacks,
              [surfaceId]: [...(state.redoStacks[surfaceId] || []), redoEntry],
            },
          })
        },

        redo: (surfaceId) => {
          const state = get()
          const redoStack = state.redoStacks[surfaceId] || []
          if (redoStack.length === 0) return

          const surface = state.surfaces[surfaceId]
          if (!surface) return

          const nextEntry = redoStack[redoStack.length - 1]

          // Save current state to undo stack — immutable refs (see pushSnapshot).
          const undoEntry: A2UIHistoryEntry = {
            id: `undo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            description: "redo",
            components: surface.components,
            dataModel: surface.dataModel,
          }

          set({
            surfaces: {
              ...state.surfaces,
              [surfaceId]: {
                ...surface,
                components: nextEntry.components,
                dataModel: nextEntry.dataModel,
                updatedAt: Date.now(),
              },
            },
            undoStacks: {
              ...state.undoStacks,
              [surfaceId]: [...(state.undoStacks[surfaceId] || []), undoEntry],
            },
            redoStacks: {
              ...state.redoStacks,
              [surfaceId]: redoStack.slice(0, -1),
            },
          })
        },

        canUndo: (surfaceId) => {
          return (get().undoStacks[surfaceId]?.length || 0) > 0
        },

        canRedo: (surfaceId) => {
          return (get().redoStacks[surfaceId]?.length || 0) > 0
        },

        // Utilities
        getSurface: (surfaceId) => {
          return get().surfaces[surfaceId]
        },

        clearEventHistory: () => {
          set({ eventHistory: [] })
        },

        reset: () => {
          set(initialState)
        },
      }),
      {
        name: "cognia-a2ui-surfaces",
        version: 3,
        migrate: (persistedState) => {
          if (!persistedState || typeof persistedState !== "object") {
            return persistedState as A2UIState & A2UIActions
          }

          const rawState = persistedState as {
            surfaces?: unknown
            activeSurfaceId?: unknown
          }
          const normalizedSurfaces = normalizePersistedSurfaces(rawState.surfaces)
          const activeSurfaceId =
            typeof rawState.activeSurfaceId === "string" &&
            normalizedSurfaces[rawState.activeSurfaceId]
              ? rawState.activeSurfaceId
              : null

          return {
            ...persistedState,
            surfaces: normalizedSurfaces,
            activeSurfaceId,
          } as A2UIState & A2UIActions
        },
        onRehydrateStorage: () => (state) => {
          if (!state) {
            return
          }

          const normalizedSurfaces = normalizePersistedSurfaces(state.surfaces)
          const activeSurfaceId =
            state.activeSurfaceId && normalizedSurfaces[state.activeSurfaceId]
              ? state.activeSurfaceId
              : (Object.keys(normalizedSurfaces)[0] ?? null)

          state.surfaces = normalizedSurfaces
          state.activeSurfaceId = activeSurfaceId
        },
        partialize: (state) => {
          // LRU: persist the 20 most recently used surfaces in full. The
          // component tree + data model MUST be persisted — nothing regenerates
          // them on reload (custom apps have no template, and template apps
          // carry user edits + live data-model state). Dropping them was what
          // left every surface stuck at `ready:false` (perpetual loading
          // spinner) after a refresh. `partialize` output round-trips through
          // `normalizePersistedSurfaces` on rehydrate, which restores `ready`
          // only when a renderable tree is present.
          const MAX_PERSISTED_SURFACES = 20
          const entries = Object.entries(state.surfaces)
          const sorted = entries
            .filter(([, s]) => s.ready)
            .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .slice(0, MAX_PERSISTED_SURFACES)

          const persistedSurfaces: Record<string, A2UISurfaceState> = {}
          for (const [id, surface] of sorted) {
            persistedSurfaces[id] = surface
          }

          return {
            surfaces: persistedSurfaces,
            activeSurfaceId: state.activeSurfaceId,
            // Exclude undo/redo stacks from persistence
          }
        },
      }
    )
  )
)

/**
 * Selectors
 */
export const selectSurface = (surfaceId: string) => (state: A2UIState) => state.surfaces[surfaceId]

export const selectActiveSurface = (state: A2UIState & A2UIActions) =>
  state.activeSurfaceId ? state.surfaces[state.activeSurfaceId] : undefined

export const selectSurfaceComponents = (surfaceId: string) => (state: A2UIState) =>
  state.surfaces[surfaceId]?.components ?? {}

export const selectSurfaceDataModel = (surfaceId: string) => (state: A2UIState) =>
  state.surfaces[surfaceId]?.dataModel ?? {}

export const selectIsSurfaceLoading = (surfaceId: string) => (state: A2UIState) =>
  surfaceId in state.loadingSurfaces

export const selectSurfaceError = (surfaceId: string) => (state: A2UIState) =>
  state.errors[surfaceId]

export const selectEventHistory = (state: A2UIState) => state.eventHistory

export const selectRecentEvents = (count: number) => (state: A2UIState) =>
  state.eventHistory.slice(0, count)

export const selectIsSurfaceStreaming = (surfaceId: string) => (state: A2UIState) =>
  surfaceId in state.streamingSurfaces
