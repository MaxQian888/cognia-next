"use client"

import React from "react"
import { AlertCircle, RefreshCw, Copy, Check } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useCopy } from "@/hooks/ui/use-copy"
import { loggers } from "@/lib/logger"

interface MathErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
  latex?: string
  onRetry?: () => void
  className?: string
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
}

export function MathErrorFallback({ error, latex, onRetry, className }: MathErrorFallbackProps) {
  const t = useTranslations("chat.renderers.math")
  const { copied, copy } = useCopy({ logger: loggers.chat, scope: "chat" })

  const handleCopy = async () => {
    if (!latex) return
    await copy(latex)
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20",
        className
      )}
      role="alert"
      aria-label={t("renderError")}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span className="text-sm font-medium">{t("renderError")}</span>
        </div>
        <div className="flex items-center gap-1">
          {onRetry && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onRetry}
                  aria-label={t("retry")}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("retry")}</TooltipContent>
            </Tooltip>
          )}
          {latex && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={handleCopy}
                  aria-label={t("copySource")}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("copySource")}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
      {error && (
        <pre className="whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs text-muted-foreground">
          {error.message}
        </pre>
      )}
      {latex && (
        <pre className="mt-1 p-2 rounded bg-muted text-xs overflow-auto font-mono">
          <code>{latex}</code>
        </pre>
      )}
    </div>
  )
}

export function withMathErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  getLatex?: (props: P) => string | undefined
): React.FC<P & { onRenderError?: () => void }> {
  const WrappedComponent: React.FC<P & { onRenderError?: () => void }> = (props) => {
    const latex = getLatex?.(props)
    return (
      <MathErrorBoundary latex={latex} onRetry={props.onRenderError}>
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
