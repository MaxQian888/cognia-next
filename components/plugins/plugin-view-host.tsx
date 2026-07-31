"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { PluginCustomViewHost } from "@/components/plugins/plugin-custom-view-host"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import { PluginTreeViewHost } from "@/components/plugins/plugin-tree-view-host"
import { PluginWebviewHost } from "@/components/plugins/plugin-webview-host"
import type { ResolvedPluginView } from "@/types/plugin/plugin-view"
import type { ResolvedPluginWebview } from "@/types/plugin/plugin-webview"
import { resolvePluginLabel } from "@/lib/plugin/i18n/plugin-label"

interface Props {
  entry: ResolvedPluginView | ResolvedPluginWebview
}

function isWebview(entry: Props["entry"]): entry is ResolvedPluginWebview {
  return "srcDoc" in entry
}

export function PluginViewHost({ entry }: Props) {
  const t = useTranslations()
  const title = resolvePluginLabel(
    t as never,
    entry.pluginId,
    entry.titleKey,
    entry.title ?? entry.viewId
  )
  let content: ReactNode
  if (isWebview(entry)) {
    content = (
      <PluginWebviewHost
        fullId={`${entry.pluginId}:${entry.viewId}`}
        srcDoc={entry.srcDoc}
        title={title}
      />
    )
  } else if (entry.kind === "tree") {
    content = <PluginTreeViewHost provider={entry.provider} pluginId={entry.pluginId} />
  } else {
    content = (
      <PluginCustomViewHost
        component={entry.component}
        pluginId={entry.pluginId}
        viewId={entry.viewId}
      />
    )
  }

  return (
    <PluginSurface
      pluginId={entry.pluginId}
      surfaceId={`view:${entry.viewId}`}
      formFactor="panel"
      variant={isWebview(entry) ? "iframe" : "default"}
    >
      {content}
    </PluginSurface>
  )
}
