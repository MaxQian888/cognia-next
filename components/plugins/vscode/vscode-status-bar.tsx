"use client"

/**
 * One VS Code extension's status bar entries on one side of Cognia's status
 * bar: its newest status message and status-bar progress (left side), then
 * its visible items by priority. An item with a command is a button that
 * runs it.
 */

import { useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"

import { Spinner } from "@/components/ui/spinner"
import { executeCommandWithOptions } from "@/lib/plugin/commands/registry"
import { stripCodicons } from "@/lib/plugin/vscode-shim/codicon-text"
import {
  getVscodeWindowRevision,
  statusBarEntries,
  subscribeVscodeWindow,
  type StatusBarItemState,
} from "@/lib/plugin/vscode-shim/window-ui-store"
import { loggers } from "@cognia/logging"
import { cn } from "@/lib/utils"

import { CodiconLabel } from "./codicon-label"
import { useExtensionName } from "./use-extension-name"

const log = loggers.plugin.child("vscode-status-bar")

/**
 * The theme colors VS Code honors on status bar items. Other theme colors
 * have no counterpart in Cognia's theme and keep the default look.
 */
const THEME_BACKGROUNDS: Record<string, string> = {
  "theme:statusBarItem.errorBackground": "bg-destructive text-white",
  "theme:statusBarItem.warningBackground": "bg-amber-500 text-black",
  "theme:statusBarItem.prominentBackground": "bg-accent text-accent-foreground",
}
const THEME_FOREGROUNDS: Record<string, string> = {
  "theme:errorForeground": "text-destructive",
  "theme:statusBarItem.errorForeground": "text-white",
  "theme:statusBarItem.warningForeground": "text-black",
}

function itemStyle(item: StatusBarItemState): { className?: string; style?: React.CSSProperties } {
  const className = cn(
    item.backgroundColor ? THEME_BACKGROUNDS[item.backgroundColor] : undefined,
    item.color ? THEME_FOREGROUNDS[item.color] : undefined
  )
  const style: React.CSSProperties = {}
  if (item.color && !item.color.startsWith("theme:")) style.color = item.color
  return { className: className || undefined, style }
}

function StatusItem({ item, pluginId }: { item: StatusBarItemState; pluginId: string }) {
  const t = useTranslations("plugins.vscodeWindow.statusBar")
  const extension = useExtensionName(pluginId)
  const label =
    item.ariaLabel ?? (stripCodicons(item.text) || item.name || t("ariaFallback", { extension }))
  const { className, style } = itemStyle(item)
  const body = <CodiconLabel label={item.text} />
  const common = cn(
    "inline-flex h-full items-center rounded-sm px-1.5 text-xs whitespace-nowrap",
    className
  )
  if (!item.command) {
    return (
      <span className={common} style={style} title={item.tooltip} aria-label={label}>
        {body}
      </span>
    )
  }
  const { command, arguments: args = [] } = item.command
  return (
    <button
      type="button"
      className={cn(
        common,
        "hover:bg-muted focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none"
      )}
      style={style}
      title={item.tooltip}
      aria-label={label}
      onClick={() => {
        executeCommandWithOptions(command, { origin: "user" }, ...args).catch((error: unknown) => {
          log.warn("status bar command failed", {
            pluginId,
            command,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }}
    >
      {body}
    </button>
  )
}

export function VscodeStatusBarEntries({
  pluginId,
  alignment,
}: {
  pluginId: string
  alignment: 1 | 2
}) {
  useSyncExternalStore(subscribeVscodeWindow, getVscodeWindowRevision, getVscodeWindowRevision)
  const entries = statusBarEntries(pluginId, alignment)
  if (entries.length === 0) return null
  return (
    <div
      data-testid={`vscode-status-bar-${alignment === 1 ? "left" : "right"}`}
      className="flex h-full items-center gap-0.5"
    >
      {entries.map((entry) => {
        if (entry.kind === "item")
          return <StatusItem key={entry.key} item={entry.item} pluginId={pluginId} />
        if (entry.kind === "message") {
          return (
            <span
              key={entry.key}
              className="inline-flex items-center px-1.5 text-xs whitespace-nowrap"
            >
              <CodiconLabel label={entry.text} />
            </span>
          )
        }
        const { title, message } = entry.progress
        return (
          <span
            key={entry.key}
            className="inline-flex items-center gap-1 px-1.5 text-xs whitespace-nowrap"
          >
            <Spinner className="size-3" />
            <CodiconLabel label={[title, message].filter(Boolean).join(": ")} />
          </span>
        )
      })}
    </div>
  )
}
