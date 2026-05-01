"use client"

import { Loader2, Bot, Sparkles, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { useLoadingI18n } from "@/hooks/ui/use-loading-i18n"

interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg"
  className?: string
}

export function LoadingSpinner({ size = "md", className }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
  }

  return (
    <Loader2 className={cn("animate-spin text-muted-foreground", sizeClasses[size], className)} />
  )
}

interface LoadingDotsProps {
  className?: string
}

export function LoadingDots({ className }: LoadingDotsProps) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <span className="h-2 w-2 rounded-full bg-primary animate-bounce [animation-delay:-0.3s]" />
      <span className="h-2 w-2 rounded-full bg-primary animate-bounce [animation-delay:-0.15s]" />
      <span className="h-2 w-2 rounded-full bg-primary animate-bounce" />
    </div>
  )
}

interface LoadingOverlayProps {
  message?: string
  className?: string
}

export function LoadingOverlay({ message, className }: LoadingOverlayProps) {
  return (
    <div
      data-slot="loading-overlay"
      className={cn(
        "absolute inset-0 z-50 flex flex-col items-center justify-center",
        "bg-background",
        className
      )}
    >
      <LoadingSpinner size="lg" />
      {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
    </div>
  )
}

interface ThinkingIndicatorProps {
  variant?: "default" | "agent" | "research"
  message?: string
  className?: string
}

export function ThinkingIndicator({
  variant = "default",
  message,
  className,
}: ThinkingIndicatorProps) {
  const { thinking } = useLoadingI18n()
  const text = message ?? thinking

  const icons = {
    default: <Sparkles className="h-4 w-4" />,
    agent: <Bot className="h-4 w-4" />,
    research: <Search className="h-4 w-4" />,
  }

  const colors = {
    default: "text-primary",
    agent: "text-info",
    research: "text-success",
  }

  return (
    <div
      data-slot="thinking-indicator"
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg",
        "bg-muted border border-border/50",
        className
      )}
    >
      <span className={cn("animate-pulse", colors[variant])}>{icons[variant]}</span>
      <span className="text-sm text-muted-foreground">{text}</span>
      <LoadingDots className="ml-1" />
    </div>
  )
}

interface StreamingTextProps {
  text: string
  className?: string
  showCursor?: boolean
}

export function StreamingText({ text, className, showCursor = true }: StreamingTextProps) {
  return (
    <span className={className}>
      {text}
      {showCursor && <span className="inline-block w-0.5 h-4 ml-0.5 bg-foreground animate-pulse" />}
    </span>
  )
}

interface ProgressBarProps {
  progress: number
  label?: string
  showPercentage?: boolean
  className?: string
}

export function ProgressBar({
  progress,
  label,
  showPercentage = true,
  className,
}: ProgressBarProps) {
  const clampedProgress = Math.min(100, Math.max(0, progress))

  return (
    <div className={cn("space-y-1", className)}>
      {(label || showPercentage) && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {label && <span>{label}</span>}
          {showPercentage && <span>{Math.round(clampedProgress)}%</span>}
        </div>
      )}
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${clampedProgress}%` }}
        />
      </div>
    </div>
  )
}

interface PageLoadingProps {
  title?: string
  description?: string
}

export function PageLoading({ title, description }: PageLoadingProps) {
  const { pageLoading } = useLoadingI18n()
  const heading = title ?? pageLoading

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
        <div className="relative flex items-center justify-center h-16 w-16 rounded-full bg-primary/10">
          <Loader2 className="h-8 w-8 text-primary animate-spin" />
        </div>
      </div>
      <div className="text-center">
        <h3 className="text-lg font-medium">{heading}</h3>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
    </div>
  )
}

interface InlineLoadingProps {
  text?: string
  className?: string
}

export function InlineLoading({ text, className }: InlineLoadingProps) {
  const { inlineLoading } = useLoadingI18n()
  const label = text ?? inlineLoading

  return (
    <span className={cn("inline-flex items-center gap-1.5 text-muted-foreground", className)}>
      <Loader2 className="h-3 w-3 animate-spin" />
      <span className="text-sm">{label}</span>
    </span>
  )
}

// Chat-specific loading states
export function MessageLoading() {
  return (
    <div className="flex items-start gap-3 p-4">
      <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-3/4 rounded bg-muted animate-pulse" />
        <div className="h-4 w-1/2 rounded bg-muted animate-pulse" />
      </div>
    </div>
  )
}

export function SessionListLoading() {
  return (
    <div className="space-y-2 p-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-2 p-2 rounded-md">
          <div className="h-4 w-4 rounded bg-muted animate-pulse" />
          <div className="flex-1 h-4 rounded bg-muted animate-pulse" />
        </div>
      ))}
    </div>
  )
}

export function ArtifactPanelLoading() {
  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="h-6 w-6 rounded bg-muted animate-pulse" />
        <div className="h-5 w-32 rounded bg-muted animate-pulse" />
      </div>
      <div className="flex-1 rounded-lg bg-muted animate-pulse" />
    </div>
  )
}
