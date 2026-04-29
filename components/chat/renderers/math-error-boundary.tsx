"use client"

import React, { useState } from "react"
import { AlertCircle, RefreshCw, Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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
    console.error("[math-error-boundary] caught", error, errorInfo.componentStack)
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
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!latex) return
    try {
      await navigator.clipboard.writeText(latex)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error("clipboard write failed", err)
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20",
        className
      )}
      role="alert"
      aria-label="Math render error"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <span className="text-sm font-medium">Math render error</span>
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
                  aria-label="Retry"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Retry</TooltipContent>
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
                  aria-label="Copy source"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy source</TooltipContent>
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
