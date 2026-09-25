"use client"

import { useState, useSyncExternalStore, type ReactNode } from "react"
import { MoreHorizontalIcon } from "lucide-react"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  getExtensionRevision,
  getExtensionsForPoint,
  subscribeExtensionChanges,
} from "@/lib/plugin/api/extension-api"
import {
  getExtensionPointFormFactor,
  type CanonicalExtensionPoint,
} from "@/lib/plugin/contracts/plugin-points"

const EMPTY_FAILED_IDS: ReadonlySet<string> = new Set()

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
  /**
   * Host context handed to every contribution as its `context` prop — inline
   * and overflowed alike (see `ExtensionProps.context`).
   */
  context?: Readonly<Record<string, unknown>>
  /**
   * The host folded this slot to glyph size (a narrow composer toolbar). The
   * contributions' declared `minWidth`/`maxWidth` are dropped for inline
   * entries so a control can shrink to an icon the way the host's own chip
   * does; the slot's `context` should carry the same flag so the control knows
   * to render its compact form.
   */
  compact?: boolean
}

export function PluginExtensionSlotWithOverflow({
  point,
  limit,
  className,
  overflowClassName,
  overflowLabel,
  fallback,
  context,
  compact = false,
}: Props) {
  useSyncExternalStore(subscribeExtensionChanges, getExtensionRevision, () => 0)
  const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(EMPTY_FAILED_IDS)

  const all = getExtensionsForPoint(point)
  const ordered = [...all].sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0))

  // A crashed compact surface renders nothing but still counts here, so
  // without this filter the contribution's dead declared-width box both ate
  // the row's space and suppressed the host's fallback — the `chat.input.effort`
  // slot would blank the built-in chip whenever the plugin dial failed. When
  // every contribution failed, the fallback (if the host declared one) is the
  // honest thing to show. Slots without a fallback keep the dead boxes: their
  // width is a deliberate layout-stability contract (see the e2e compact-crash
  // case), and an empty row has nothing better to display.
  const visible = ordered.filter((ext) => !failedIds.has(ext.id))
  const display = visible.length === 0 && fallback === undefined ? ordered : visible

  if (display.length === 0) {
    return fallback ? <>{fallback}</> : null
  }

  const inline = display.slice(0, limit)
  const overflow = display.slice(limit)
  const formFactor = getExtensionPointFormFactor(point)

  const markFailed = (extensionId: string) =>
    setFailedIds((previous) => {
      if (previous.has(extensionId)) return previous
      const next = new Set(previous)
      next.add(extensionId)
      return next
    })

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
          minWidth={compact ? undefined : ext.options.minWidth}
          maxWidth={compact ? undefined : ext.options.maxWidth}
          onSilentFailure={() => markFailed(ext.id)}
        >
          <ext.component
            pluginId={ext.pluginId}
            extensionId={ext.id}
            formFactor={formFactor}
            context={context}
          />
        </PluginSurface>
      ))}
      {overflow.length > 0 && (
        // A popover, not a menu: overflowed contributions are arbitrary plugin
        // controls, not menu items, and a Radix menu's roving focus left the
        // keyboard no way to reach them.
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={overflowLabel}
                  data-testid={`plugin-extension-overflow-${point}`}
                  className="touch-hit size-7 text-muted-foreground hover:bg-muted/60 hover:text-foreground dark:hover:bg-muted/60"
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{overflowLabel}</TooltipContent>
          </Tooltip>
          <PopoverContent
            align="end"
            sideOffset={4}
            aria-label={overflowLabel}
            className={cn("flex w-auto flex-col gap-1 p-1", overflowClassName)}
          >
            {overflow.map((ext) => (
              <PluginSurface
                key={ext.id}
                pluginId={ext.pluginId}
                surfaceId={ext.id}
                formFactor={formFactor}
                minWidth={ext.options.minWidth}
                maxWidth={ext.options.maxWidth}
                onSilentFailure={() => markFailed(ext.id)}
              >
                <ext.component
                  pluginId={ext.pluginId}
                  extensionId={ext.id}
                  formFactor={formFactor}
                  context={context}
                />
              </PluginSurface>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
