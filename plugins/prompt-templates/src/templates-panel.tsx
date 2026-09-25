"use client"

/**
 * Context Workbench panel for the stored prompt templates.
 *
 * Registered imperatively (`ctx.contextPanels.register`) rather than through
 * `manifest.contextPanels`: that field resolves its renderer from a separate
 * `entry` module, which a `builtin://` plugin has no fetchable install path
 * for. Built-ins therefore always take this path.
 *
 * Each template offers Insert (appends the body, verbatim, to the composer of
 * the chat this workbench belongs to — `ctx.chat.appendToComposer`) and Copy.
 * The list re-reads whenever the panel becomes active AND whenever the store
 * reports a save / delete, so a `/template-add` while the panel is open shows
 * up immediately. A failed read shows an error with a retry, never a silent
 * empty list.
 */

import { useCallback, useEffect, useState } from "react"
import { ClipboardCopyIcon, TextCursorInputIcon } from "lucide-react"

import type { ContextPanelRenderProps, PluginContext } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import { Button } from "@cognia/plugin-ui"

import type { TemplateEntry, TemplateStore } from "./template-store"

export const PLUGIN_ID = "cognia-prompt-templates"

type PanelContext = Pick<PluginContext, "chat" | "clipboard" | "ui" | "logger">

type LoadState =
  { status: "loading" } | { status: "error" } | { status: "ready"; templates: TemplateEntry[] }

export function createTemplatesPanel(ctx: PanelContext, store: TemplateStore) {
  return function TemplatesPanel({ active, resource }: ContextPanelRenderProps) {
    const t = usePluginTranslations(PLUGIN_ID)
    const [state, setState] = useState<LoadState>({ status: "loading" })
    const [reloadToken, setReloadToken] = useState(0)
    const sessionId = resource.kind === "session" ? resource.sessionId : undefined

    // Storage is written by the slash commands, which can run while this panel
    // sits hidden behind `<Activity>` — re-read on every activation, and on
    // every store change while it is active.
    useEffect(() => {
      if (!active) return
      let cancelled = false
      const load = () => {
        store
          .readAll()
          .then((templates) => {
            if (!cancelled) setState({ status: "ready", templates })
          })
          .catch((error: unknown) => {
            ctx.logger.error("prompt-templates: reading templates failed", error)
            if (!cancelled) setState({ status: "error" })
          })
      }
      load()
      const unsubscribe = store.subscribe(load)
      return () => {
        cancelled = true
        unsubscribe()
      }
    }, [active, reloadToken])

    const insert = useCallback(
      (entry: TemplateEntry) => {
        try {
          ctx.chat.appendToComposer(entry.body, sessionId ? { sessionId } : undefined)
          ctx.ui.showToast(t("toast.inserted", { name: entry.name }), "success")
        } catch (error) {
          ctx.logger.error("prompt-templates: insert failed", error)
          ctx.ui.showToast(t("toast.insertFailed", { name: entry.name }), "error")
        }
      },
      [sessionId, t]
    )

    const copy = useCallback(
      async (entry: TemplateEntry) => {
        try {
          await ctx.clipboard.writeText(entry.body)
          ctx.ui.showToast(t("toast.copied", { name: entry.name }), "success")
        } catch (error) {
          ctx.logger.error("prompt-templates: copy failed", error)
          ctx.ui.showToast(t("toast.copyFailed", { name: entry.name }), "error")
        }
      },
      [t]
    )

    if (state.status === "loading") {
      return (
        <div
          role="status"
          className="flex h-full w-full min-w-0 max-w-full items-center justify-center overflow-x-hidden p-6 text-sm text-muted-foreground"
        >
          {t("panel.loading")}
        </div>
      )
    }

    if (state.status === "error") {
      return (
        <div
          role="alert"
          className="flex h-full w-full min-w-0 max-w-full flex-col items-center justify-center gap-2 overflow-x-hidden p-6 text-center"
        >
          <p className="text-sm text-destructive">{t("panel.loadFailed")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 sm:h-7"
            onClick={() => {
              setState({ status: "loading" })
              setReloadToken((token) => token + 1)
            }}
          >
            {t("panel.retry")}
          </Button>
        </div>
      )
    }

    if (state.templates.length === 0) {
      return (
        <div className="flex h-full w-full min-w-0 max-w-full flex-col items-center justify-center gap-1 overflow-x-hidden p-6 text-center">
          <p className="text-sm font-medium">{t("panel.emptyTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("panel.emptyHint")}</p>
          <code className="break-all text-xs">{t("panel.emptyCommand")}</code>
        </div>
      )
    }

    return (
      <ul className="flex h-full w-full min-w-0 max-w-full flex-col gap-1 overflow-x-hidden overflow-y-auto p-2">
        {state.templates.map((entry) => (
          <li
            key={entry.name}
            className="flex min-w-0 max-w-full items-start gap-2 rounded-md px-2 py-1.5 [@media(hover:hover)]:hover:bg-muted"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{entry.name}</p>
              <p className="line-clamp-2 whitespace-pre-line break-words text-xs text-muted-foreground">
                {entry.body}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-9 gap-1 px-2 text-xs sm:h-7"
                aria-label={t("panel.insertLabel", { name: entry.name })}
                onClick={() => insert(entry)}
              >
                <TextCursorInputIcon className="size-3.5" aria-hidden />
                {t("panel.insert")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 sm:size-7"
                aria-label={t("panel.copyLabel", { name: entry.name })}
                onClick={() => void copy(entry)}
              >
                <ClipboardCopyIcon className="size-3.5" aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    )
  }
}
