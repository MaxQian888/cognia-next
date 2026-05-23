"use client"

/**
 * A2UI Component Error Boundary
 * Prevents a single component render error from crashing the entire surface
 */

import React, { Component } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, RotateCcw } from "lucide-react"
import { ErrorTraceDetails } from "@/components/ai-elements/error-trace"
import { Button } from "@/components/ui/button"
import { loggers } from "@/lib/logging"
import type { A2UIErrorBoundaryProps, A2UIErrorBoundaryState } from "@/types/a2ui/renderer"

/**
 * Functional fallback so we can use `useTranslations()` — class components
 * can't access hooks directly. The class boundary forwards its state here.
 */
function A2UIErrorFallback({
  componentType,
  error,
  onRetry,
}: {
  componentType: string
  error: Error | null
  onRetry: () => void
}) {
  const t = useTranslations("a2ui")
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <div className="mb-2 flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {t("errorBoundary.renderError", { type: componentType })}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={onRetry}>
          <RotateCcw className="mr-1 h-3 w-3" />
          {t("errorBoundary.retry")}
        </Button>
      </div>
      <ErrorTraceDetails error={error} />
    </div>
  )
}

export class A2UIErrorBoundary extends Component<A2UIErrorBoundaryProps, A2UIErrorBoundaryState> {
  constructor(props: A2UIErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): A2UIErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    loggers.ui.error(
      `A2UI Component Error [${this.props.componentType}#${this.props.componentId}]:`,
      error,
      errorInfo as unknown as Record<string, unknown>
    )
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <A2UIErrorFallback
          componentType={this.props.componentType}
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      )
    }

    return this.props.children
  }
}
