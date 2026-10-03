"use client"

/**
 * The transient things a VS Code extension shows: messages (a toast, or a
 * dialog when modal), notification progress, and the "wrote to its output"
 * toast. The window presenter mounts them through sonner and the plugin
 * modal stack; they read live state from `window-ui-store`.
 */

import { useEffect, useRef, useSyncExternalStore } from "react"
import { AlertTriangle, CircleX, Info, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import type { VscodeMessageRequest } from "@/lib/plugin/vscode-shim/window-handlers"
import {
  getProgress,
  getVscodeWindowRevision,
  subscribeVscodeWindow,
} from "@/lib/plugin/vscode-shim/window-ui-store"
import { cn } from "@/lib/utils"
import type { PluginModalProps } from "@/types/plugin/plugin-modal"

import { CodiconLabel } from "./codicon-label"
import { useExtensionName } from "./use-extension-name"

const SEVERITY_ICON = { info: Info, warning: AlertTriangle, error: CircleX } as const
const SEVERITY_COLOR = {
  info: "text-sky-600 dark:text-sky-400",
  warning: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
} as const

function MessageBody({ request }: { request: VscodeMessageRequest }) {
  const t = useTranslations("plugins.vscodeWindow.message")
  const extension = useExtensionName(request.pluginId)
  const Icon = SEVERITY_ICON[request.severity]
  return (
    <div className="flex min-w-0 gap-3">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", SEVERITY_COLOR[request.severity])}
        aria-label={t(`severity.${request.severity}`)}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm break-words whitespace-pre-wrap">
          <CodiconLabel label={request.message} />
        </p>
        {request.detail ? (
          <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
            {request.detail}
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">{t("from", { extension })}</p>
      </div>
    </div>
  )
}

/** A non-modal message: the toast stays while it offers choices. */
export function VscodeMessageToast({
  request,
  onChoose,
}: {
  request: VscodeMessageRequest
  /** The chosen item's index, or `null` for a dismissal. */
  onChoose: (index: number | null) => void
}) {
  const t = useTranslations("plugins.vscodeWindow.message")
  return (
    <div
      data-testid="vscode-message-toast"
      className="bg-popover text-popover-foreground relative w-[360px] rounded-lg border p-4 pr-9 shadow-lg"
    >
      <MessageBody request={request} />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute top-2 right-2 size-6"
        aria-label={t("close")}
        onClick={() => onChoose(null)}
      >
        <X className="size-3.5" />
      </Button>
      {request.items.length > 0 ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {request.items.map((item, index) => (
            <Button
              key={index}
              type="button"
              size="sm"
              variant={index === 0 ? "default" : "outline"}
              onClick={() => onChoose(index)}
            >
              {item.title}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * A modal message. As in VS Code, a Cancel button is added unless one of the
 * items is the close affordance; dismissing the dialog answers with that
 * item, or with nothing.
 */
export function VscodeMessageDialog({ args, onClose }: PluginModalProps) {
  const t = useTranslations("plugins.vscodeWindow.message")
  const request = args?.request as VscodeMessageRequest
  const settle = args?.settle as (index: number | null) => void
  const settled = useRef(false)
  const closeIndex = request.items.findIndex((item) => item.isCloseAffordance)
  const answer = (index: number | null) => {
    if (settled.current) return
    settled.current = true
    settle(index)
  }

  useEffect(
    () => () => {
      // Closed without a choice (Escape, clicking outside).
      answer(closeIndex >= 0 ? closeIndex : null)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on unmount
    []
  )

  return (
    <div data-testid="vscode-message-dialog" className="space-y-4">
      <MessageBody request={request} />
      <div className="flex flex-wrap justify-end gap-2">
        {closeIndex < 0 ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              answer(null)
              onClose()
            }}
          >
            {t("cancel")}
          </Button>
        ) : null}
        {request.items.map((item, index) => (
          <Button
            key={index}
            type="button"
            variant={item.isCloseAffordance ? "outline" : index === 0 ? "default" : "secondary"}
            onClick={() => {
              answer(index)
              onClose()
            }}
          >
            {item.title}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** A notification-located `withProgress`, live until the task ends. */
export function VscodeProgressToast({
  handle,
  onCancel,
}: {
  handle: string
  onCancel: () => void
}) {
  const t = useTranslations("plugins.vscodeWindow.progress")
  useSyncExternalStore(subscribeVscodeWindow, getVscodeWindowRevision, getVscodeWindowRevision)
  const state = getProgress(handle)
  const extension = useExtensionName(state?.pluginId ?? "")
  if (!state) return null
  return (
    <div
      data-testid="vscode-progress-toast"
      className="bg-popover text-popover-foreground w-[360px] space-y-2 rounded-lg border p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        {state.percent === undefined ? <Spinner className="mt-0.5 size-4" /> : null}
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            <CodiconLabel label={state.title ?? extension} />
          </p>
          <p className="text-muted-foreground text-xs break-words">
            {state.message ? <CodiconLabel label={state.message} /> : t("working")}
          </p>
        </div>
        {state.cancellable ? (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            {t("cancel")}
          </Button>
        ) : null}
      </div>
      {state.percent !== undefined ? (
        <div className="flex items-center gap-2">
          <Progress value={state.percent} className="h-1.5" />
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("percent", { percent: Math.round(state.percent) })}
          </span>
        </div>
      ) : null}
    </div>
  )
}

/** `OutputChannel.show()`: the channel has output, and the logs are where it is. */
export function VscodeOutputToast({
  pluginId,
  channel,
  onOpenLogs,
  onDismiss,
}: {
  pluginId: string
  channel: string
  onOpenLogs: () => void
  onDismiss: () => void
}) {
  const t = useTranslations("plugins.vscodeWindow.output")
  const close = useTranslations("plugins.vscodeWindow.message")
  const extension = useExtensionName(pluginId)
  return (
    <div
      data-testid="vscode-output-toast"
      className="bg-popover text-popover-foreground flex w-[360px] items-center gap-3 rounded-lg border p-4 shadow-lg"
    >
      <p className="min-w-0 flex-1 text-sm">{t("shown", { extension, channel })}</p>
      <Button type="button" size="sm" onClick={onOpenLogs}>
        {t("openLogs")}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-6"
        aria-label={close("close")}
        onClick={onDismiss}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
