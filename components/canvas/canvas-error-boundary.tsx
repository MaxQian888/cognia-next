"use client"

/**
 * Canvas Error Boundary - Graceful error handling for Canvas panel
 */

import React, { Component, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { ErrorTraceDetails } from "@/components/ai-elements/error-trace"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { loggers } from "@cognia/logging"

interface ErrorBoundaryProps {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  onReset?: () => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class CanvasErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo })

    loggers.ui.error("Canvas error:", error, { errorInfo })

    this.props.onError?.(error, errorInfo)
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    this.props.onReset?.()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <CanvasErrorFallback
          error={this.state.error}
          errorInfo={this.state.errorInfo}
          onReset={this.handleReset}
        />
      )
    }

    return this.props.children
  }
}

interface ErrorFallbackProps {
  error: Error | null
  errorInfo: React.ErrorInfo | null
  onReset: () => void
}

function CanvasErrorFallbackContent({ error, errorInfo, onReset }: ErrorFallbackProps) {
  const t = useTranslations("canvas")

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 bg-background">
      <Card className="max-w-lg border-destructive/50">
        <CardContent className="pt-6">
          <Alert variant="destructive" className="border-0 p-0">
            <AlertTriangle className="h-5 w-5" />
            <AlertTitle className="text-lg">{t("errorTitle")}</AlertTitle>
            <AlertDescription className="mt-2">
              <p className="mb-4 text-muted-foreground">{t("errorDescription")}</p>

              <div className="flex gap-2 mb-4">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button onClick={onReset} size="sm" className="gap-2">
                      <RefreshCw className="h-4 w-4" />
                      {t("tryAgain")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("tryAgain")}</TooltipContent>
                </Tooltip>
              </div>
              <ErrorTraceDetails
                componentStack={errorInfo?.componentStack ?? null}
                componentStackLabel="Component Stack"
                copyLabel={t("copyError")}
                error={error}
              />
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  )
}

function CanvasErrorFallback(props: ErrorFallbackProps) {
  return <CanvasErrorFallbackContent {...props} />
}
