"use client"

import type { ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  StackTrace,
  StackTraceActions,
  StackTraceContent,
  StackTraceCopyButton,
  StackTraceError,
  StackTraceErrorMessage,
  StackTraceErrorType,
  StackTraceExpandButton,
  StackTraceFrames,
  StackTraceHeader,
} from "@/components/ai-elements/stack-trace"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useFileViewerStore } from "@/stores/terminal/file-viewer-store"

export interface ErrorTraceDetailsProps {
  error: Error | { message: string; stack?: string } | null
  componentStack?: string | null
  componentStackLabel?: string
  copyLabel?: string
  className?: string
  title?: string
  pluginId?: string
  pluginName?: string
  onDisablePlugin?: (pluginId: string) => void
  body?: ReactNode
}

export function ErrorTraceDetails({
  error,
  componentStack,
  componentStackLabel,
  copyLabel,
  className,
  title,
  pluginId,
  pluginName,
  onDisablePlugin,
  body,
}: ErrorTraceDetailsProps) {
  const t = useTranslations("errorPage")
  const openFile = useFileViewerStore((state) => state.openFile)
  if (!error) return null

  const message = "message" in error ? error.message : String(error)
  const stack = "stack" in error ? error.stack : undefined
  const headline = pluginId
    ? `${title ?? t("title")} — ${pluginName ?? pluginId}`
    : (title ?? t("title"))
  const trace = [
    [`Error: ${message}`, stack].filter(Boolean).join("\n"),
    componentStack ? `${componentStackLabel ?? t("componentStack")}\n${componentStack}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n")

  return (
    <Alert data-slot="ai-error-trace" variant="destructive" className={cn("space-y-2", className)}>
      <AlertCircle className="size-4" />
      <AlertTitle>{headline}</AlertTitle>
      <AlertDescription className="min-w-0 space-y-2">
        {body ?? <p className="text-sm">{message}</p>}
        {(stack || componentStack) && (
          <StackTrace
            trace={trace}
            onFilePathClick={(path, line, column) => openFile(path, line ?? null, column ?? null)}
          >
            <StackTraceHeader aria-label={t("showStack")}>
              <StackTraceError>
                <StackTraceErrorType />
                <StackTraceErrorMessage />
              </StackTraceError>
              <StackTraceActions aria-label={t("stackActions")}>
                <StackTraceCopyButton aria-label={copyLabel ?? t("copyStack")} />
                <StackTraceExpandButton aria-label={t("showStack")} />
              </StackTraceActions>
            </StackTraceHeader>
            <StackTraceContent>
              <StackTraceFrames emptyLabel={t("noStackFrames")} />
            </StackTraceContent>
          </StackTrace>
        )}
        {pluginId && onDisablePlugin && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onDisablePlugin(pluginId)}
          >
            {t("disablePlugin")}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
