"use client"

// Middle-column panel for a plugin-contributed view container (B1).
//
// Rendered by `components/desktop/channel-list.tsx` when
// `selectedGuild.kind === "plugin-view"`. For B1 it shows the container header
// (icon + title) and an empty body region; B2 (tree data providers / custom
// views) mounts the container's views into this body. If the container is no
// longer registered (plugin disabled), it shows an unavailable state.

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { icons, PuzzleIcon, type LucideIcon } from "lucide-react"
import {
  getViewContainerSnapshot,
  subscribeViewContainers,
} from "@/lib/plugin/registries/view-container-registry"
import { getViewSnapshot, subscribeViews } from "@/lib/plugin/registries/tree-view-registry"
import {
  getContextKeyRevision,
  subscribeContextKeys,
  evaluateContextWhen,
} from "@/lib/plugin/context-keys/context-key-store"
import { PluginTreeViewHost } from "@/components/plugins/plugin-tree-view-host"
import { PluginCustomViewHost } from "@/components/plugins/plugin-custom-view-host"
import { PluginExtensionBoundary } from "@/components/plugins/plugin-extension-slot"

/**
 * Render a plugin-supplied lucide icon name (or the puzzle fallback). Module-
 * scope component with an early-return fallback so the resolved component is a
 * stable reference at the render site (mirrors `A2UIIcon`). The lookup is a
 * direct `icons[name]` index (not a function call) to satisfy the
 * `react-hooks/static-components` rule.
 */
export function ResolvedRailIcon({ name, className }: { name?: string; className?: string }) {
  const Resolved = name ? (icons[name as keyof typeof icons] as LucideIcon | undefined) : undefined
  if (!Resolved) return <PuzzleIcon className={className} />
  return <Resolved className={className} />
}

interface Props {
  /** Namespaced container id (`<pluginId>:<localId>`). */
  containerId: string
}

export function PluginViewContainerPanel({ containerId }: Props) {
  const t = useTranslations("plugins.viewContainers")
  const containers = useSyncExternalStore(
    subscribeViewContainers,
    getViewContainerSnapshot,
    getViewContainerSnapshot
  )
  // Views registered for this container (B2). Re-render on view-registry and
  // context-key changes (the `when` filter reads the context store).
  const allViews = useSyncExternalStore(subscribeViews, getViewSnapshot, getViewSnapshot)
  useSyncExternalStore(subscribeContextKeys, getContextKeyRevision, () => 0)
  const entry = containers.find((c) => c.fullId === containerId)

  if (!entry) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center"
        data-plugin-view-container="unavailable"
      >
        <PuzzleIcon className="size-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
      </div>
    )
  }

  const views = allViews.filter((v) => v.containerId === containerId && evaluateContextWhen(v.when))

  return (
    <div className="flex h-full flex-col outline-none" data-plugin-view-container={containerId}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <ResolvedRailIcon name={entry.def.icon} className="size-4 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{entry.def.title}</span>
      </div>
      {views.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto" data-plugin-view-container-body={containerId}>
          {views.map((v) => (
            <section
              key={`${v.pluginId}:${v.viewId}`}
              data-plugin-view={`${v.pluginId}:${v.viewId}`}
            >
              {v.title && (
                <h3 className="px-3 py-1.5 text-xs font-medium uppercase text-muted-foreground">
                  {v.title}
                </h3>
              )}
              <PluginExtensionBoundary pluginId={v.pluginId} extensionId={v.viewId}>
                {v.kind === "tree" ? (
                  <PluginTreeViewHost provider={v.provider} pluginId={v.pluginId} />
                ) : (
                  <PluginCustomViewHost
                    component={v.component}
                    pluginId={v.pluginId}
                    viewId={v.viewId}
                  />
                )}
              </PluginExtensionBoundary>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
