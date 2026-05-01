"use client"

/**
 * A2UI Surface Container
 * Renders an A2UI surface with its component tree
 */

import React, { useCallback, useEffect } from "react"
import { cn } from "@/lib/utils"
import type {
  A2UIComponent,
  A2UISurfaceProps,
  A2UIUserAction,
  A2UIDataModelChange,
} from "@/types/a2ui/schema"
import type { A2UISurfaceContainerProps } from "@/types/a2ui/renderer"
import { useA2UIStore } from "@/stores/a2ui"
import { globalEventEmitter } from "@/lib/a2ui/events"
import { surfaceStyles, contentStyles } from "@/lib/a2ui/constants"
import { A2UIProvider } from "./a2ui-context"
import { A2UIRenderer } from "./a2ui-renderer"
import { A2UIWidgetShell } from "./a2ui-widget-shell"
import { Loader2 } from "lucide-react"

/**
 * A2UI Surface Container Component
 */
export function A2UISurface({
  surfaceId,
  className,
  onAction,
  onDataChange,
  showLoading = true,
  loadingText = "Loading...",
}: A2UISurfaceContainerProps) {
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const isLoading = useA2UIStore((state) => surfaceId in state.loadingSurfaces)
  const isStreaming = useA2UIStore((state) => surfaceId in state.streamingSurfaces)
  const error = useA2UIStore((state) => state.errors[surfaceId])

  // Subscribe to events
  useEffect(() => {
    if (!onAction && !onDataChange) return

    const unsubscribeAction = onAction
      ? globalEventEmitter.onAction((action: A2UIUserAction) => {
          if (action.surfaceId === surfaceId) {
            onAction(action)
          }
        })
      : undefined

    const unsubscribeDataChange = onDataChange
      ? globalEventEmitter.onDataChange((change: A2UIDataModelChange) => {
          if (change.surfaceId === surfaceId) {
            onDataChange(change)
          }
        })
      : undefined

    return () => {
      unsubscribeAction?.()
      unsubscribeDataChange?.()
    }
  }, [surfaceId, onAction, onDataChange])

  // Render component callback for provider
  const renderComponent = useCallback((component: A2UIComponent) => {
    return <A2UIRenderer key={component.id} component={component} />
  }, [])

  // Surface not found
  if (!surface) {
    return null
  }

  // Loading state
  if (isLoading && showLoading) {
    return (
      <div className={cn("flex items-center justify-center p-8", className)}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        {loadingText && <span className="ml-2 text-sm text-muted-foreground">{loadingText}</span>}
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className={cn("p-4 text-destructive", className)}>
        <p className="font-medium">Error loading surface</p>
        <p className="text-sm">{error}</p>
      </div>
    )
  }

  // Not ready yet
  if (!surface.ready) {
    return (
      <div className={cn("flex items-center justify-center p-4", className)}>
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // Get root component
  const rootComponent = surface.components[surface.rootId]
  if (!rootComponent) {
    return (
      <div className={cn("p-4 text-muted-foreground", className)}>
        <p className="text-sm">No content to display</p>
      </div>
    )
  }

  const surfaceType = surface.type

  const surfaceBody = (
    <div className={cn(surfaceStyles[surfaceType], className)}>
      <div className={contentStyles[surfaceType]}>
        <A2UIProvider
          surfaceId={surfaceId}
          catalogId={surface.catalogId}
          renderComponent={renderComponent}
        >
          <A2UIRenderer component={rootComponent} />
          {isStreaming && (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Rendering...</span>
            </div>
          )}
        </A2UIProvider>
      </div>
    </div>
  )

  if (surface.widget) {
    return (
      <A2UIWidgetShell
        title={surface.title}
        hostStrategy={surface.widget.hostStrategy}
        status={surface.widget.status}
        fallbackText={surface.widget.fallbackText}
        showChrome={surface.widget.showChrome}
      >
        {surfaceBody}
      </A2UIWidgetShell>
    )
  }

  return surfaceBody
}

/**
 * Inline A2UI surface for embedding in messages
 */
export function A2UIInlineSurface({
  surfaceId,
  className,
  onAction,
  onDataChange,
}: A2UISurfaceProps) {
  return (
    <A2UISurface
      surfaceId={surfaceId}
      className={cn("rounded-lg border bg-card p-3", className)}
      onAction={onAction}
      onDataChange={onDataChange}
      showLoading={false}
    />
  )
}

/**
 * Dialog A2UI surface
 */
export function A2UIDialogSurface({
  surfaceId,
  className,
  onAction,
  onDataChange,
}: A2UISurfaceProps) {
  const deleteSurface = useA2UIStore((state) => state.deleteSurface)
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])

  const handleClose = useCallback(() => {
    deleteSurface(surfaceId)
  }, [surfaceId, deleteSurface])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        handleClose()
      }
    },
    [handleClose]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        handleClose()
      }
    },
    [handleClose]
  )

  return (
    <div
      className={cn(surfaceStyles.dialog, className)}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label={surface?.title || "A2UI Dialog"}
      tabIndex={-1}
    >
      <div className={contentStyles.dialog}>
        <A2UISurface surfaceId={surfaceId} onAction={onAction} onDataChange={onDataChange} />
      </div>
    </div>
  )
}
