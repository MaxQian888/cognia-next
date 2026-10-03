"use client"

/**
 * The VS Code extension webviews, as tabs: panels from
 * `window.createWebviewPanel` and views from `registerWebviewViewProvider`.
 *
 * One tab is shown at a time. The others are kept alive only when their
 * webview asked to be (`retainContextWhenHidden`); otherwise their frame is
 * dropped and rebuilt when shown again, with the state it saved through
 * `setState`. A view's frame first appears when its tab does, which is when
 * its provider is asked to fill it. Panels can be closed; views belong to
 * their extension and stay while it runs.
 */

import { useSyncExternalStore } from "react"
import { X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useExtensionName } from "@/components/plugins/vscode/use-extension-name"
import {
  getSelectedWebview,
  listWebviews,
  selectWebview,
  subscribeWebviews,
  type VscodeWebviewRecord,
} from "@/lib/plugin/vscode-shim/webview-bridge"
import { closeWebview } from "@/lib/plugin/vscode-shim/webview-handlers"
import { cn } from "@/lib/utils"

import { VscodeWebviewFrame } from "./vscode-webview-frame"

export function useVscodeWebviews(): {
  webviews: readonly VscodeWebviewRecord[]
  selected: string | null
} {
  const webviews = useSyncExternalStore(subscribeWebviews, listWebviews, listWebviews)
  const selected = useSyncExternalStore(subscribeWebviews, getSelectedWebview, getSelectedWebview)
  return { webviews, selected }
}

function WebviewTab({ webview, selected }: { webview: VscodeWebviewRecord; selected: boolean }) {
  const t = useTranslations("plugins.vscodeWebviews")
  const extension = useExtensionName(webview.pluginId)
  const tooltip = [webview.title, webview.description, t("from", { extension })]
    .filter(Boolean)
    .join(" — ")
  return (
    <div
      className={cn(
        "flex max-w-48 shrink-0 items-center border-r text-xs",
        selected ? "bg-background text-foreground" : "bg-muted/40 text-muted-foreground"
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-controls={`vscode-webview-panel-${webview.handle}`}
        title={tooltip}
        onClick={() => selectWebview(webview.handle)}
        className="flex min-w-0 items-center gap-1.5 px-2 py-1.5"
      >
        <span className="truncate">{webview.title || webview.viewType}</span>
        {webview.description ? (
          <span className="text-muted-foreground truncate">{webview.description}</span>
        ) : null}
        {webview.badge && webview.badge.value > 0 ? (
          <Badge
            variant="secondary"
            className="h-4 px-1 text-[10px]"
            title={webview.badge.tooltip || undefined}
          >
            {webview.badge.value}
          </Badge>
        ) : null}
      </button>
      {webview.kind === "panel" ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="mr-1 size-5"
          aria-label={t("close", { title: webview.title || webview.viewType })}
          onClick={() => closeWebview(webview.handle)}
        >
          <X className="size-3" />
        </Button>
      ) : null}
    </div>
  )
}

export function VscodeExtensionPanel() {
  const t = useTranslations("plugins.vscodeWebviews")
  const { webviews, selected } = useVscodeWebviews()
  if (webviews.length === 0) {
    return (
      <div
        className="text-muted-foreground flex h-full w-full items-center justify-center p-4 text-center text-sm"
        data-testid="vscode-extension-panel-empty"
      >
        {t("empty")}
      </div>
    )
  }
  return (
    <div className="flex h-full min-h-0 w-full flex-col" data-testid="vscode-extension-panel">
      <div role="tablist" aria-label={t("tabs")} className="flex shrink-0 overflow-x-auto border-b">
        {webviews.map((webview) => (
          <WebviewTab
            key={webview.handle}
            webview={webview}
            selected={webview.handle === selected}
          />
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        {webviews.map((webview) => {
          const shown = webview.handle === selected
          if (!shown && !webview.options.retainContextWhenHidden) return null
          // A view has no content until its provider has been asked for it.
          if (webview.kind === "view" && !webview.resolved) return null
          return (
            <div
              key={webview.handle}
              id={`vscode-webview-panel-${webview.handle}`}
              role="tabpanel"
              hidden={!shown}
              className="absolute inset-0"
            >
              <VscodeWebviewFrame webview={webview} shown={shown} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
