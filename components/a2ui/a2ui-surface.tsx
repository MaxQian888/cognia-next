"use client"

/**
 * A2UI Surface Container
 * Renders an A2UI surface with its component tree
 */

import React, { useCallback, useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type {
  A2UIComponent,
  A2UISurfaceProps,
  A2UIUserAction,
  A2UIDataModelChange,
} from "@/types/a2ui/schema"
import type { A2UISurfaceContainerProps } from "@/types/a2ui/renderer"
import { useA2UIStore } from "@/stores/a2ui"
import { useSettingsStore } from "@/stores/settings"
import { globalEventEmitter } from "@/lib/a2ui/events"
import { resolveWidgetDefaults } from "@/lib/a2ui/catalog"
import { getA2UIWidgetSettingDefaults, resolveA2UICatalogId } from "@/lib/a2ui/runtime-settings"
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
  loadingText,
  readOnly = false,
}: A2UISurfaceContainerProps) {
  const t = useTranslations("a2ui")
  const surface = useA2UIStore((state) => state.surfaces[surfaceId])
  const isLoading = useA2UIStore((state) => surfaceId in state.loadingSurfaces)
  const isStreaming = useA2UIStore((state) => surfaceId in state.streamingSurfaces)
  const error = useA2UIStore((state) => state.errors[surfaceId])
  const runtimeSettings = useSettingsStore((state) => state.settings)
  const resolvedLoadingText = loadingText ?? t("surface.loading")

  // Keep latest handlers in refs so inline-closure props don't tear the
  // emitter subscription down and re-register it on every render
  const onActionRef = useRef(onAction)
  const onDataChangeRef = useRef(onDataChange)
  useEffect(() => {
    onActionRef.current = onAction
    onDataChangeRef.current = onDataChange
  }, [onAction, onDataChange])

  const hasAction = !!onAction
  const hasDataChange = !!onDataChange

  // Subscribe to events
  useEffect(() => {
    if (!hasAction && !hasDataChange) return

    const unsubscribeAction = hasAction
      ? globalEventEmitter.onAction((action: A2UIUserAction) => {
          if (action.surfaceId === surfaceId) {
            onActionRef.current?.(action)
          }
        })
      : undefined

    const unsubscribeDataChange = hasDataChange
      ? globalEventEmitter.onDataChange((change: A2UIDataModelChange) => {
          if (change.surfaceId === surfaceId) {
            onDataChangeRef.current?.(change)
          }
        })
      : undefined

    return () => {
      unsubscribeAction?.()
      unsubscribeDataChange?.()
    }
  }, [surfaceId, hasAction, hasDataChange])

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
        {resolvedLoadingText && (
          <span className="ml-2 text-sm text-muted-foreground">{resolvedLoadingText}</span>
        )}
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className={cn("p-4 text-destructive", className)}>
        <p className="font-medium">{t("surface.errorLoading")}</p>
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
        <p className="text-sm">{t("surface.noContent")}</p>
      </div>
    )
  }

  const surfaceType = surface.type
  const catalogId = resolveA2UICatalogId(surface.catalogId, runtimeSettings?.a2uiDefaultCatalogId)
  const widget = surface.widget
    ? resolveWidgetDefaults(surface.widget, getA2UIWidgetSettingDefaults(runtimeSettings))
    : undefined

  const surfaceBody = (
    <div className={cn(surfaceStyles[surfaceType], className)}>
      <div className={contentStyles[surfaceType]}>
        <A2UIProvider
          surfaceId={surfaceId}
          catalogId={catalogId}
          renderComponent={renderComponent}
          readOnly={readOnly}
        >
          <A2UIRenderer component={rootComponent} />
          {isStreaming && (
            <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{t("surface.rendering")}</span>
            </div>
          )}
        </A2UIProvider>
      </div>
    </div>
  )

  if (widget) {
    return (
      <A2UIWidgetShell
        title={surface.title}
        hostStrategy={widget.hostStrategy}
        sizing={widget.sizing}
        theme={widget.theme}
        status={widget.status}
        fallbackText={widget.fallbackText}
        showChrome={widget.showChrome}
        minHeight={widget.minHeight}
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
  const t = useTranslations("a2ui")
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
      aria-label={surface?.title || t("surface.dialogLabel")}
      tabIndex={-1}
    >
      <div className={contentStyles.dialog}>
        <A2UISurface surfaceId={surfaceId} onAction={onAction} onDataChange={onDataChange} />
      </div>
    </div>
  )
}
