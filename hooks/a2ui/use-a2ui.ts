/**
 * useA2UI Hook
 * Provides A2UI surface management and message processing
 */

import { useCallback, useEffect } from "react"
import { useA2UIStore } from "@/stores/a2ui"
import { parseA2UIInput, createA2UISurface } from "@/lib/a2ui/parser"
import { globalEventEmitter } from "@/lib/a2ui/events"
import type {
  A2UIServerMessage,
  A2UIUserAction,
  A2UIDataModelChange,
  A2UIComponent,
  A2UISurfaceType,
  A2UIWidgetMetadata,
} from "@/types/a2ui/schema"

interface UseA2UIOptions {
  onAction?: (action: A2UIUserAction) => void
  onDataChange?: (change: A2UIDataModelChange) => void
  autoProcess?: boolean
}

interface UseA2UIReturn {
  // Surface management
  createSurface: (
    surfaceId: string,
    type: A2UISurfaceType,
    options?: { title?: string; catalogId?: string; widget?: A2UIWidgetMetadata }
  ) => void
  deleteSurface: (surfaceId: string) => void
  getSurface: (
    surfaceId: string
  ) => ReturnType<typeof useA2UIStore.getState>["surfaces"][string] | undefined

  // Message processing
  processMessage: (message: A2UIServerMessage) => void
  processMessages: (messages: A2UIServerMessage[]) => void
  parseAndProcess: (
    input: unknown,
    options?: { fallbackSurfaceId?: string; autoProcess?: boolean }
  ) => { surfaceId: string | null; messages: A2UIServerMessage[]; errors: string[] }
  processJsonString: (json: string) => boolean
  extractAndProcess: (response: string) => string | null // Returns surfaceId if found

  // Quick surface creation
  createQuickSurface: (
    surfaceId: string,
    components: A2UIComponent[],
    dataModel?: Record<string, unknown>,
    options?: { type?: A2UISurfaceType; title?: string; widget?: A2UIWidgetMetadata }
  ) => void

  // Data model
  setDataValue: (surfaceId: string, path: string, value: unknown) => void
  getDataValue: <T = unknown>(surfaceId: string, path: string) => T | undefined

  // Event history
  eventHistory: (A2UIUserAction | A2UIDataModelChange)[]
  clearEventHistory: () => void

  // Active surface
  activeSurfaceId: string | null
  setActiveSurface: (surfaceId: string | null) => void
}

export function useA2UI(options: UseA2UIOptions = {}): UseA2UIReturn {
  const { onAction, onDataChange, autoProcess = true } = options

  // Store actions
  const createSurfaceStore = useA2UIStore((state) => state.createSurface)
  const deleteSurfaceStore = useA2UIStore((state) => state.deleteSurface)
  const getSurfaceStore = useA2UIStore((state) => state.getSurface)
  const processMessageStore = useA2UIStore((state) => state.processMessage)
  const processMessagesStore = useA2UIStore((state) => state.processMessages)
  const setDataValueStore = useA2UIStore((state) => state.setDataValue)
  const getDataValueStore = useA2UIStore((state) => state.getDataValue)
  const eventHistory = useA2UIStore((state) => state.eventHistory)
  const clearEventHistoryStore = useA2UIStore((state) => state.clearEventHistory)
  const activeSurfaceId = useA2UIStore((state) => state.activeSurfaceId)
  const setActiveSurfaceStore = useA2UIStore((state) => state.setActiveSurface)

  // Subscribe to events
  useEffect(() => {
    const unsubscribeAction = onAction ? globalEventEmitter.onAction(onAction) : undefined

    const unsubscribeDataChange = onDataChange
      ? globalEventEmitter.onDataChange(onDataChange)
      : undefined

    return () => {
      unsubscribeAction?.()
      unsubscribeDataChange?.()
    }
  }, [onAction, onDataChange])

  // Create surface
  const createSurface = useCallback(
    (
      surfaceId: string,
      type: A2UISurfaceType,
      opts?: { title?: string; catalogId?: string; widget?: A2UIWidgetMetadata }
    ) => {
      createSurfaceStore(surfaceId, type, opts)
    },
    [createSurfaceStore]
  )

  // Delete surface
  const deleteSurface = useCallback(
    (surfaceId: string) => {
      deleteSurfaceStore(surfaceId)
    },
    [deleteSurfaceStore]
  )

  // Get surface
  const getSurface = useCallback(
    (surfaceId: string) => {
      return getSurfaceStore(surfaceId)
    },
    [getSurfaceStore]
  )

  // Process single message
  const processMessage = useCallback(
    (message: A2UIServerMessage) => {
      processMessageStore(message)
    },
    [processMessageStore]
  )

  // Process multiple messages
  const processMessages = useCallback(
    (messages: A2UIServerMessage[]) => {
      processMessagesStore(messages)
    },
    [processMessagesStore]
  )

  // Parse and process mixed input payloads
  const parseAndProcess = useCallback(
    (
      input: unknown,
      options?: { fallbackSurfaceId?: string; autoProcess?: boolean }
    ): { surfaceId: string | null; messages: A2UIServerMessage[]; errors: string[] } => {
      const parsed = parseA2UIInput(input, {
        fallbackSurfaceId: options?.fallbackSurfaceId,
      })

      if ((options?.autoProcess ?? autoProcess) && parsed.messages.length > 0) {
        processMessagesStore(parsed.messages)
      }

      return parsed
    },
    [autoProcess, processMessagesStore]
  )

  // Process JSON string
  const processJsonString = useCallback(
    (json: string): boolean => {
      const parsed = parseAndProcess(json)
      return parsed.messages.length > 0
    },
    [parseAndProcess]
  )

  // Extract and process from AI response
  const extractAndProcess = useCallback(
    (response: string): string | null => {
      const parsed = parseAndProcess(response)
      return parsed.surfaceId
    },
    [parseAndProcess]
  )

  // Quick surface creation helper
  const createQuickSurface = useCallback(
    (
      surfaceId: string,
      components: A2UIComponent[],
      dataModel?: Record<string, unknown>,
      opts?: { type?: A2UISurfaceType; title?: string; widget?: A2UIWidgetMetadata }
    ) => {
      const messages = createA2UISurface(surfaceId, components, dataModel, {
        surfaceType: opts?.type,
        title: opts?.title,
        widget: opts?.widget,
      })
      processMessagesStore(messages)
    },
    [processMessagesStore]
  )

  // Set data value
  const setDataValue = useCallback(
    (surfaceId: string, path: string, value: unknown) => {
      setDataValueStore(surfaceId, path, value)
    },
    [setDataValueStore]
  )

  // Get data value
  const getDataValue = useCallback(
    <T = unknown>(surfaceId: string, path: string): T | undefined => {
      return getDataValueStore<T>(surfaceId, path)
    },
    [getDataValueStore]
  )

  // Clear event history
  const clearEventHistory = useCallback(() => {
    clearEventHistoryStore()
  }, [clearEventHistoryStore])

  // Set active surface
  const setActiveSurface = useCallback(
    (surfaceId: string | null) => {
      setActiveSurfaceStore(surfaceId)
    },
    [setActiveSurfaceStore]
  )

  return {
    createSurface,
    deleteSurface,
    getSurface,
    processMessage,
    processMessages,
    parseAndProcess,
    processJsonString,
    extractAndProcess,
    createQuickSurface,
    setDataValue,
    getDataValue,
    eventHistory,
    clearEventHistory,
    activeSurfaceId,
    setActiveSurface,
  }
}
