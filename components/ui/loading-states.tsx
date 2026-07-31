"use client"

import { Bot, RefreshCw, Sparkles, Search } from "lucide-react"
import { useId } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useLoadingI18n } from "@/hooks/ui/use-loading-i18n"
import { useLoadingPhase } from "@/hooks/ui/use-loading-phase"

interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg"
  className?: string
  /**
   * Accessible name. Omit inside a `LoadingRegion` or a labelled control — see
   * `Spinner`, which this forwards to.
   */
  label?: string
}

export function LoadingSpinner({ size = "md", className, label }: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
  }

  return (
    <Spinner label={label} className={cn("text-muted-foreground", sizeClasses[size], className)} />
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
  variant?: "compact" | "workspace"
  allowReload?: boolean
}

export function PageLoading({
  title,
  description,
  variant = "compact",
  allowReload = false,
}: PageLoadingProps) {
  const loadingI18n = useLoadingI18n()
  const heading =
    title ?? (variant === "workspace" ? loadingI18n.page.title : loadingI18n.pageLoading)
  const detail = description ?? (variant === "workspace" ? loadingI18n.page.description : undefined)

  if (variant === "workspace") {
    return (
      <WorkspaceLoading
        title={heading}
        description={detail}
        progressLabel={loadingI18n.page.progressLabel}
        stages={loadingI18n.page.stages}
        stillWorking={loadingI18n.stillWorking}
        offlineLabel={loadingI18n.offline}
        reloadLabel={loadingI18n.page.reload}
        reloadHint={loadingI18n.page.reloadHint}
        allowReload={allowReload}
      />
    )
  }

  return <CompactPageLoading title={heading} description={detail} />
}

function CompactPageLoading({ title, description }: { title: string; description?: string }) {
  return (
    <div aria-busy="true" className="flex min-h-[400px] flex-col items-center justify-center gap-4">
      <div className="relative">
        {/* Halo: pure decoration. Reduced motion downgrades it to an
            opacity-only fade (globals.css tier 3) rather than killing it, so
            the composition does not lose its centre of gravity. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-full bg-primary/20"
        />
        <div className="relative flex size-16 items-center justify-center rounded-full bg-primary/10">
          <Spinner className="size-8 text-primary" />
        </div>
      </div>
      <div className="text-center">
        <h3 className="text-lg font-medium">{title}</h3>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  )
}

interface WorkspaceLoadingProps {
  title: string
  description?: string
  progressLabel: string
  stages: string[]
  stillWorking: (seconds: number) => string
  offlineLabel: string
  reloadLabel: string
  reloadHint: string
  allowReload: boolean
}

function WorkspaceLoading({
  title,
  description,
  progressLabel,
  stages,
  stillWorking,
  offlineLabel,
  reloadLabel,
  reloadHint,
  allowReload,
}: WorkspaceLoadingProps) {
  const titleId = useId()
  const { elapsedMs, offline, phase } = useLoadingPhase({ canEscalate: allowReload })
  const stageIndex = elapsedMs < 2000 ? 0 : elapsedMs < 4000 ? 1 : 2
  const currentStage = stages[stageIndex]
  const prolonged = phase === "prolonged" || phase === "escalated"
  const waitDetail = offline ? offlineLabel : stillWorking(Math.round(elapsedMs / 1000))

  return (
    <div className="flex min-h-[max(400px,calc(100dvh-5rem))] w-full items-center justify-center px-4 py-6 sm:px-8">
      <section
        aria-busy="true"
        aria-labelledby={titleId}
        className="grid w-full max-w-3xl overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm sm:grid-cols-[minmax(0,1.15fr)_minmax(15rem,0.85fr)]"
      >
        <div className="flex min-w-0 flex-col justify-center p-6 sm:p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Sparkles aria-hidden="true" className="size-5" />
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 size-3 rounded-full border-2 border-card bg-success"
              />
            </div>
            <div className="h-px flex-1 bg-border" aria-hidden="true" />
            <Spinner className="size-4 text-muted-foreground" />
          </div>

          <div className="space-y-2">
            <h1
              id={titleId}
              className="text-balance text-xl font-semibold tracking-tight sm:text-2xl"
            >
              {title}
            </h1>
            {description ? (
              <p className="max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>

          <div className="mt-6 space-y-3">
            <div
              role="progressbar"
              aria-label={progressLabel}
              aria-valuetext={currentStage}
              className="h-1.5 overflow-hidden rounded-full bg-primary/15"
            >
              <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
            </div>
            <div role="status" aria-live="polite" className="space-y-1">
              <p className="text-sm font-medium">{currentStage}</p>
              {prolonged ? (
                <p className="text-xs leading-5 text-muted-foreground">{waitDetail}</p>
              ) : null}
            </div>
          </div>

          <ol className="mt-5 grid grid-cols-3 gap-2" aria-hidden="true">
            {stages.map((stage, index) => (
              <li key={stage} className="min-w-0">
                <div
                  className={cn(
                    "mb-2 h-1 rounded-full transition-colors",
                    index <= stageIndex ? "bg-primary" : "bg-border"
                  )}
                />
                <span
                  className={cn(
                    "hidden min-h-8 text-pretty text-[11px] leading-4 sm:block",
                    index === stageIndex ? "text-foreground" : "text-muted-foreground"
                  )}
                >
                  {stage}
                </span>
              </li>
            ))}
          </ol>

          {phase === "escalated" && allowReload ? (
            <div className="mt-5 flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-muted-foreground">{reloadHint}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 shrink-0 sm:min-h-9"
                onClick={() => window.location.reload()}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                {reloadLabel}
              </Button>
            </div>
          ) : null}
        </div>

        <div
          aria-hidden="true"
          className="hidden border-l border-border/60 bg-muted/35 p-5 sm:flex sm:flex-col"
        >
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-border" />
            <span className="size-2 rounded-full bg-border" />
            <span className="size-2 rounded-full bg-border" />
          </div>
          <div className="mt-5 flex min-h-52 flex-1 gap-3 rounded-xl border border-border/60 bg-background/80 p-3 shadow-sm">
            <div className="w-12 shrink-0 space-y-2 rounded-lg bg-muted/70 p-2">
              <Skeleton className="size-6 rounded-lg" />
              <Skeleton className="size-6 rounded-lg" />
              <Skeleton className="size-6 rounded-lg" />
            </div>
            <div className="min-w-0 flex-1 space-y-3 py-1">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-16 w-full rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-2.5 w-full" />
                <Skeleton className="h-2.5 w-4/5" />
                <Skeleton className="h-2.5 w-3/5" />
              </div>
              <Skeleton className="h-8 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </section>
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
      {/* Decorative: the adjacent text already says it. */}
      <Spinner className="h-3 w-3" />
      <span className="text-sm">{label}</span>
    </span>
  )
}

// Chat-specific loading states.
//
// These use `Skeleton` rather than hand-rolled `bg-muted animate-pulse` divs.
// The difference is not cosmetic: the reduce-motion tier in `globals.css` keys
// its pulse exemption off `data-slot="skeleton"`, so a hand-rolled block would
// freeze into an inert grey rectangle for anyone who has asked for reduced
// motion, and would announce itself to a screen reader on top of that.
export function MessageLoading() {
  return (
    <div className="flex items-start gap-3 p-4">
      <Skeleton className="h-8 w-8 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  )
}

export function SessionListLoading() {
  return (
    <div className="space-y-2 p-2">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-2 p-2 rounded-md">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="flex-1 h-4" />
        </div>
      ))}
    </div>
  )
}

export function ArtifactPanelLoading() {
  return (
    <div className="flex flex-col h-full p-4">
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="h-6 w-6" />
        <Skeleton className="h-5 w-32" />
      </div>
      <Skeleton className="flex-1 rounded-lg" />
    </div>
  )
}
