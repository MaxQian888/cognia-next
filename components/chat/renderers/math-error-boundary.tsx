"use client"

import React from "react"
import { RefreshCw } from "lucide-react"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { useTranslations } from "next-intl"
import { RichBlockAction } from "@/components/chat/renderers/rich-block/rich-block-action"
import { RichBlockError } from "@/components/chat/renderers/rich-block/rich-block-error"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@cognia/logging"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Link labels must not contain independently focusable math controls. */
export const InlineMathLinkContext = React.createContext(false)

interface MathErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
  latex?: string
  onRetry?: () => void
  className?: string
  inline?: boolean
}

interface MathErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class MathErrorBoundary extends React.Component<
  MathErrorBoundaryProps,
  MathErrorBoundaryState
> {
  constructor(props: MathErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): MathErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    loggers.chat.error("math error boundary caught", error, {
      componentStack: errorInfo.componentStack ?? undefined,
    })
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
    this.props.onRetry?.()
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <MathErrorFallback
          error={this.state.error}
          latex={this.props.latex}
          onRetry={this.handleRetry}
          className={this.props.className}
          inline={this.props.inline}
        />
      )
    }
    return this.props.children
  }
}

interface MathErrorFallbackProps {
  error: Error | null
  latex?: string
  onRetry?: () => void
  className?: string
  inline?: boolean
}

export function MathErrorFallback({
  error,
  latex,
  onRetry,
  className,
  inline = false,
}: MathErrorFallbackProps) {
  const t = useTranslations("chat.renderers.math")
  const inLink = React.useContext(InlineMathLinkContext)
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const handleCopy = async () => {
    if (!latex) return
    await copy(latex)
  }

  // The shared block failure state (ADR-0218).
  const errorCard = (
    <RichBlockError
      className={inline ? "m-0 border-0 bg-transparent p-0" : className}
      title={t("renderError")}
      detail={error?.message}
      action={
        onRetry || latex ? (
          <div className="flex items-center gap-0.5">
            {onRetry && (
              <RichBlockAction label={t("retry")} onClick={onRetry}>
                <RefreshCw />
              </RichBlockAction>
            )}
            {latex && (
              <RichBlockAction label={t("copySource")} onClick={handleCopy}>
                <CopyFeedbackIcon copied={copied} size={12} />
              </RichBlockAction>
            )}
          </div>
        ) : undefined
      }
    >
      {latex ? (
        <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs">
          <code>{latex}</code>
        </pre>
      ) : null}
    </RichBlockError>
  )

  if (!inline) return errorCard

  if (inLink) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <code
            className={cn("rounded bg-destructive/10 px-1 text-destructive", className)}
            aria-label={t("renderError")}
          >
            {latex || t("renderError")}
          </code>
        </TooltipTrigger>
        <TooltipContent>{error?.message || t("renderError")}</TooltipContent>
      </Tooltip>
    )
  }

  // The recovery card contains block elements. Keep it in a portal so an
  // inline formula can expose recovery actions without breaking its paragraph.
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t("renderError")}
        className={cn(
          "cursor-pointer rounded bg-destructive/10 px-1 py-0.5 text-sm text-destructive",
          className
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <code>{latex || t("renderError")}</code>
      </PopoverTrigger>
      <PopoverContent onClick={(event) => event.stopPropagation()}>{errorCard}</PopoverContent>
    </Popover>
  )
}

export function withMathErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  getLatex?: (props: P) => string | undefined,
  inline = false
): React.FC<P & { onRenderError?: () => void }> {
  const WrappedComponent: React.FC<P & { onRenderError?: () => void }> = (props) => {
    const latex = getLatex?.(props)
    return (
      <MathErrorBoundary latex={latex} onRetry={props.onRenderError} inline={inline}>
        <Component {...props} />
      </MathErrorBoundary>
    )
  }

  WrappedComponent.displayName = `withMathErrorBoundary(${
    Component.displayName || Component.name || "Component"
  })`

  return WrappedComponent
}

export default MathErrorBoundary
