"use client"

import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { LanguageModelUsage } from "ai"
import type { ComponentProps } from "react"
import { createContext, useContext, useMemo } from "react"
import { priceTokensForModel, type CostTokens } from "@/lib/usage/pricing"

const PERCENT_MAX = 100
const ICON_RADIUS = 10
const ICON_VIEWBOX = 24
const ICON_CENTER = 12
const ICON_STROKE_WIDTH = 2

type ModelId = string

interface ContextSchema {
  usedTokens: number
  maxTokens: number
  usage?: LanguageModelUsage
  modelId?: ModelId
}

const ContextContext = createContext<ContextSchema | null>(null)

const useContextValue = () => {
  const context = useContext(ContextContext)

  if (!context) {
    throw new Error("Context components must be used within Context")
  }

  return context
}

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema

export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => {
  const contextValue = useMemo(
    () => ({ maxTokens, modelId, usage, usedTokens }),
    [maxTokens, modelId, usage, usedTokens]
  )

  return (
    <ContextContext.Provider value={contextValue}>
      <HoverCard closeDelay={0} openDelay={0} {...props} />
    </ContextContext.Provider>
  )
}

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue()
  const circumference = 2 * Math.PI * ICON_RADIUS
  const usedPercent = usedTokens / maxTokens
  const dashOffset = circumference * (1 - usedPercent)

  return (
    <svg
      aria-label="Model context usage"
      height="20"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  )
}

export type ContextTriggerProps = ComponentProps<typeof Button>

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { usedTokens, maxTokens } = useContextValue()
  const usedPercent = usedTokens / maxTokens
  const renderedPercent = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(usedPercent)

  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <span className="font-medium text-muted-foreground">{renderedPercent}</span>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  )
}

export type ContextContentProps = ComponentProps<typeof HoverCardContent>

export const ContextContent = ({ className, ...props }: ContextContentProps) => (
  <HoverCardContent className={cn("min-w-60 divide-y overflow-hidden p-0", className)} {...props} />
)

export type ContextContentHeaderProps = ComponentProps<"div">

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens } = useContextValue()
  const usedPercent = usedTokens / maxTokens
  const displayPct = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(usedPercent)
  const used = new Intl.NumberFormat("en-US", {
    notation: "compact",
  }).format(usedTokens)
  const total = new Intl.NumberFormat("en-US", {
    notation: "compact",
  }).format(maxTokens)

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <p>{displayPct}</p>
            <p className="font-mono text-muted-foreground">
              {used} / {total}
            </p>
          </div>
          <div className="space-y-2">
            <Progress className="bg-muted" value={usedPercent * PERCENT_MAX} />
          </div>
        </>
      )}
    </div>
  )
}

export type ContextContentBodyProps = ComponentProps<"div">

export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
  <div className={cn("w-full p-3", className)} {...props}>
    {children}
  </div>
)

/**
 * Format the cost of a token slice for this popover.
 *
 * Previously `tokenlens.getUsage()` — a third-party price table completely
 * independent of the app's own, so this popover could show a different number
 * from the session cost badge inches away. It now shares `lib/usage/pricing.ts`,
 * the single pricing authority, which also brings cache-tier and CNY-native
 * rates that tokenlens did not model.
 *
 * No `providerId` is in scope here, so resolution falls through to the
 * model-keyed layers (synced catalog, then the static tables) — the same
 * information tokenlens had.
 *
 * Returns `undefined` when no layer knows the model so the caller can render
 * "—". Formatting an unknown price as "$0.00" is what made an unpriced model
 * indistinguishable from a free one.
 */
function formatSliceCost(modelId: string | undefined, tokens: CostTokens): string | undefined {
  if (!modelId) return undefined
  const { cost, known } = priceTokensForModel(undefined, modelId, tokens)
  if (!known) return undefined
  return new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" }).format(cost)
}

export type ContextContentFooterProps = ComponentProps<"div">

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { modelId, usage } = useContextValue()
  const totalCost =
    formatSliceCost(modelId, {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
    }) ?? "—"

  return (
    <div
      data-slot="ai-context"
      className={cn(
        "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">Total cost</span>
          <span>{totalCost}</span>
        </>
      )}
    </div>
  )
}

const TokensWithCost = ({ tokens, costText }: { tokens?: number; costText?: string }) => (
  <span>
    {tokens === undefined
      ? "—"
      : new Intl.NumberFormat("en-US", {
          notation: "compact",
        }).format(tokens)}
    {costText ? <span className="ml-2 text-muted-foreground">• {costText}</span> : null}
  </span>
)

export type ContextInputUsageProps = ComponentProps<"div">

export const ContextInputUsage = ({ className, children, ...props }: ContextInputUsageProps) => {
  const { usage, modelId } = useContextValue()
  const inputTokens = usage?.inputTokens ?? 0

  if (children) {
    return children
  }

  if (!inputTokens) {
    return null
  }

  const inputCostText = formatSliceCost(modelId, { inputTokens })

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Input</span>
      <TokensWithCost costText={inputCostText} tokens={inputTokens} />
    </div>
  )
}

export type ContextOutputUsageProps = ComponentProps<"div">

export const ContextOutputUsage = ({ className, children, ...props }: ContextOutputUsageProps) => {
  const { usage, modelId } = useContextValue()
  const outputTokens = usage?.outputTokens ?? 0

  if (children) {
    return children
  }

  if (!outputTokens) {
    return null
  }

  const outputCostText = formatSliceCost(modelId, { outputTokens })

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Output</span>
      <TokensWithCost costText={outputCostText} tokens={outputTokens} />
    </div>
  )
}

export type ContextReasoningUsageProps = ComponentProps<"div">

export const ContextReasoningUsage = ({
  className,
  children,
  ...props
}: ContextReasoningUsageProps) => {
  const { usage, modelId } = useContextValue()
  // AI SDK 7 removes the deprecated top-level `reasoningTokens`; the details
  // object is canonical and already populated on v6.
  const reasoningTokens = usage?.outputTokenDetails?.reasoningTokens ?? 0

  if (children) {
    return children
  }

  if (!reasoningTokens) {
    return null
  }

  // Reasoning tokens are a subset of output tokens and are billed at the output
  // rate by every provider that reports them, so they price as output here.
  const reasoningCostText = formatSliceCost(modelId, { outputTokens: reasoningTokens })

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Reasoning</span>
      <TokensWithCost costText={reasoningCostText} tokens={reasoningTokens} />
    </div>
  )
}

export type ContextCacheUsageProps = ComponentProps<"div">

export const ContextCacheUsage = ({ className, children, ...props }: ContextCacheUsageProps) => {
  const { usage, modelId } = useContextValue()
  // AI SDK 7 removes the deprecated top-level `cachedInputTokens`; the details
  // object is canonical and already populated on v6.
  const cacheTokens = usage?.inputTokenDetails?.cacheReadTokens ?? 0

  if (children) {
    return children
  }

  if (!cacheTokens) {
    return null
  }

  // Priced at the model's real cache-read rate when the catalog knows one,
  // otherwise 0.1x base input — tokenlens modelled neither.
  const cacheCostText = formatSliceCost(modelId, { cacheReadInputTokens: cacheTokens })

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Cache</span>
      <TokensWithCost costText={cacheCostText} tokens={cacheTokens} />
    </div>
  )
}
