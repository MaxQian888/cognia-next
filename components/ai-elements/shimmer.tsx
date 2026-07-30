"use client"

import { cn } from "@/lib/utils"
import type { CSSProperties, ElementType } from "react"
import { createElement, memo } from "react"

export interface TextShimmerProps {
  children: string
  as?: ElementType
  className?: string
  duration?: number
  spread?: number
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = (children?.length ?? 0) * spread
  const style = {
    "--shimmer-duration": `${duration}s`,
    "--shimmer-spread": `${dynamicSpread}px`,
  } as CSSProperties

  return createElement(
    Component,
    {
      className: cn("shimmer relative inline-block", className),
      style,
    },
    children
  )
}

export const Shimmer = memo(ShimmerComponent)
