"use client"

import { useSyncExternalStore, type ReactNode } from "react"
import { MoreHorizontalIcon } from "lucide-react"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  getExtensionRevision,
  getExtensionsForPoint,
  subscribeExtensionChanges,
} from "@/lib/plugin/api"
import {
  getExtensionPointFormFactor,
  type CanonicalExtensionPoint,
} from "@/lib/plugin/contracts/plugin-points"

interface Props {
  point: CanonicalExtensionPoint
  /** Number of extensions to render inline before pushing the rest into an overflow menu. */
  limit: number
  /** Optional className applied to the inline wrapper. */
  className?: string
  /** Optional className applied to the overflow popover. */
  overflowClassName?: string
  /**
   * Localized aria-label for the overflow trigger. Required — callers supply
   * a translation from their own i18n namespace so this primitive stays
   * locale-agnostic.
   */
  overflowLabel: string
  /** Fallback rendered when there are no extensions registered. */
  fallback?: ReactNode
}

export function PluginExtensionSlotWithOverflow({
  point,
  limit,
  className,
  overflowClassName,
  overflowLabel,
  fallback,
}: Props) {
  useSyncExternalStore(subscribeExtensionChanges, getExtensionRevision, () => 0)

  const all = getExtensionsForPoint(point)
  const ordered = [...all].sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0))

  if (ordered.length === 0) {
    return fallback ? <>{fallback}</> : null
  }

  const inline = ordered.slice(0, limit)
  const overflow = ordered.slice(limit)
  const formFactor = getExtensionPointFormFactor(point)

  return (
    <div
      className={className}
      data-plugin-extension-slot={point}
      data-extension-count={ordered.length}
      data-extension-overflow={overflow.length}
      data-form-factor={formFactor}
    >
      {inline.map((ext) => (
        <PluginSurface
          key={ext.id}
          pluginId={ext.pluginId}
          surfaceId={ext.id}
          formFactor={formFactor}
          minWidth={ext.options.minWidth}
          maxWidth={ext.options.maxWidth}
        >
          <ext.component pluginId={ext.pluginId} extensionId={ext.id} formFactor={formFactor} />
        </PluginSurface>
      ))}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={overflowLabel}
              data-testid={`plugin-extension-overflow-${point}`}
              className="size-7"
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className={overflowClassName}>
            {overflow.map((ext) => (
              <PluginSurface
                key={ext.id}
                pluginId={ext.pluginId}
                surfaceId={ext.id}
                formFactor={formFactor}
                minWidth={ext.options.minWidth}
                maxWidth={ext.options.maxWidth}
              >
                <ext.component
                  pluginId={ext.pluginId}
                  extensionId={ext.id}
                  formFactor={formFactor}
                />
              </PluginSurface>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
