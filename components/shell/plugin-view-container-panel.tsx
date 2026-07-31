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
import { getWebviewSnapshot, subscribeWebviews } from "@/lib/plugin/registries/webview-registry"
import {
  getContextKeyRevision,
  subscribeContextKeys,
  evaluateContextWhen,
} from "@/lib/plugin/context-keys/context-key-store"
import { PluginViewHost } from "@/components/plugins/plugin-view-host"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { resolveOptionalPluginLabel, resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"

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

/**
 * Section heading for one view/webview inside the container body.
 *
 * Takes the *resolved* title rather than the raw entry: the section is optional
 * and the decision to render it has to be made after `titleKey` has had its
 * turn, otherwise a manifest that ships only a key (`{ titleKey, title:
 * undefined }`) is silently headerless.
 */
function SectionTitle({ title }: { title?: string }) {
  if (!title) return null
  return (
    <h3 className="px-3 py-1.5 text-xs font-medium uppercase text-muted-foreground">{title}</h3>
  )
}

interface Props {
  /** Namespaced container id (`<pluginId>:<localId>`). */
  containerId: string
}

export function PluginViewContainerPanel({ containerId }: Props) {
  const t = useTranslations("plugins.viewContainers")
  const pluginT = useTranslations()
  const containers = useSyncExternalStore(
    subscribeViewContainers,
    getViewContainerSnapshot,
    getViewContainerSnapshot
  )
  // Views registered for this container (B2). Re-render on view-registry and
  // context-key changes (the `when` filter reads the context store).
  const allViews = useSyncExternalStore(subscribeViews, getViewSnapshot, getViewSnapshot)
  const allWebviews = useSyncExternalStore(
    subscribeWebviews,
    getWebviewSnapshot,
    getWebviewSnapshot
  )
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
  const webviews = allWebviews.filter(
    (w) => w.containerId === containerId && w.surface === "panel" && evaluateContextWhen(w.when)
  )
  const isEmpty = views.length === 0 && webviews.length === 0
  const containerTitle = resolvePluginLabel(
    pluginT as never,
    entry.pluginId,
    entry.def.titleKey,
    entry.def.title
  )

  return (
    <PluginSurface
      pluginId={entry.pluginId}
      surfaceId={`view-container:${entry.def.id}`}
      formFactor="panel"
    >
      <div className="flex h-full flex-col outline-none" data-plugin-view-container={containerId}>
        {!entry.def.hideHeader && (
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <ResolvedRailIcon name={entry.def.icon} className="size-4 text-muted-foreground" />
            <span className="truncate text-sm font-medium">{containerTitle}</span>
          </div>
        )}
        {isEmpty ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="text-xs text-muted-foreground">{t("empty")}</p>
          </div>
        ) : (
          <div
            className="flex flex-1 flex-col overflow-y-auto"
            data-plugin-view-container-body={containerId}
          >
            {views.map((v) => (
              <section
                key={`${v.pluginId}:${v.viewId}`}
                data-plugin-view={`${v.pluginId}:${v.viewId}`}
                // Tree views are hug-height lists; custom React panels are full-
                // bleed and rely on a definite-height parent (their inner
                // `h-full`/`flex-1` chain collapses otherwise). Give the latter the
                // same fill treatment as the webview branch below.
                className={v.kind === "tree" ? undefined : "flex min-h-0 flex-1 flex-col"}
              >
                <SectionTitle
                  title={resolveOptionalPluginLabel(
                    pluginT as never,
                    v.pluginId,
                    v.titleKey,
                    v.title
                  )}
                />
                <PluginViewHost entry={v} />
              </section>
            ))}
            {webviews.map((w) => (
              <section
                key={`${w.pluginId}:${w.viewId}`}
                className="flex min-h-48 flex-1 flex-col"
                data-plugin-webview-section={`${w.pluginId}:${w.viewId}`}
              >
                <SectionTitle
                  title={resolveOptionalPluginLabel(
                    pluginT as never,
                    w.pluginId,
                    w.titleKey,
                    w.title
                  )}
                />
                <PluginViewHost entry={w} />
              </section>
            ))}
          </div>
        )}
      </div>
    </PluginSurface>
  )
}
