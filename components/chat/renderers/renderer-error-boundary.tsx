"use client"

import { Component, type ReactNode } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { loggers } from "@/lib/logging"

interface RendererErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  className?: string
  rendererName?: string
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
}

interface RendererErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  constructor(props: RendererErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    loggers.chat.error("renderer error boundary caught", error, {
      renderer: this.props.rendererName ?? "Renderer",
      componentStack: errorInfo.componentStack ?? undefined,
    })
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }
      return (
        <RendererErrorFallback
          error={this.state.error}
          rendererName={this.props.rendererName}
          onRetry={this.handleRetry}
          className={this.props.className}
        />
      )
    }

    return this.props.children
  }
}

interface RendererErrorFallbackProps {
  error: Error | null
  rendererName?: string
  onRetry: () => void
  className?: string
}

function RendererErrorFallback({
  error,
  rendererName,
  onRetry,
  className,
}: RendererErrorFallbackProps) {
  const t = useTranslations("chat.renderers.errorBoundary")
  const title = rendererName ? t("titleNamed", { name: rendererName }) : t("titleFallback")
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 p-4 rounded-lg border border-destructive/30 bg-destructive/5 my-3",
        className
      )}
      role="alert"
    >
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-5 w-5" />
        <span className="font-medium text-sm">{title}</span>
      </div>
      {error && (
        <pre className="max-w-md whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs text-muted-foreground">
          {error.message}
        </pre>
      )}
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-2">
        <RefreshCw className="h-3 w-3" />
        {t("retry")}
      </Button>
    </div>
  )
}

export function withRendererErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  rendererName?: string
): React.FC<P> {
  const displayName = WrappedComponent.displayName || WrappedComponent.name || "Component"

  const WithErrorBoundary: React.FC<P> = (props) => (
    <RendererErrorBoundary rendererName={rendererName || displayName}>
      <WrappedComponent {...props} />
    </RendererErrorBoundary>
  )

  WithErrorBoundary.displayName = `withRendererErrorBoundary(${displayName})`

  return WithErrorBoundary
}

export default RendererErrorBoundary
