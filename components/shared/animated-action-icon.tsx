"use client"

import {
  type ForwardRefExoticComponent,
  type HTMLAttributes,
  type RefAttributes,
  useCallback,
  useEffect,
  useRef,
} from "react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { CheckIcon } from "@/components/ui/check"
import { CopyIcon } from "@/components/ui/copy"
import { cn } from "@/lib/utils"

const ICON_ANIMATION_DURATION_MS = 700
const INTERACTIVE_ANCESTOR_SELECTOR =
  'button, a, [role="button"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])'

export interface AnimatedIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

export interface AnimatedIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

export type AnimatedIconComponent = ForwardRefExoticComponent<
  AnimatedIconProps & RefAttributes<AnimatedIconHandle>
>

export interface AnimatedActionIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  icon: AnimatedIconComponent
  size?: number
  /** Replays the icon whenever this value changes after the initial render. */
  animateOnChange?: string | number | boolean
}

export function AnimatedActionIcon({
  icon: Icon,
  size = 16,
  animateOnChange,
  className,
  style,
  ...props
}: AnimatedActionIconProps) {
  const { reduce, durationScale } = useFlowMotion()
  const iconRef = useRef<AnimatedIconHandle>(null)
  const containerRef = useRef<HTMLSpanElement>(null)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(false)

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current !== null) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
  }, [])

  const startAnimation = useCallback(() => {
    if (reduce) return
    clearStopTimer()
    iconRef.current?.startAnimation()
  }, [clearStopTimer, reduce])

  const stopAnimation = useCallback(() => {
    clearStopTimer()
    iconRef.current?.stopAnimation()
  }, [clearStopTimer])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const trigger = container.closest<HTMLElement>(INTERACTIVE_ANCESTOR_SELECTOR) ?? container

    trigger.addEventListener("mouseenter", startAnimation)
    trigger.addEventListener("mouseleave", stopAnimation)
    trigger.addEventListener("focusin", startAnimation)
    trigger.addEventListener("focusout", stopAnimation)

    return () => {
      trigger.removeEventListener("mouseenter", startAnimation)
      trigger.removeEventListener("mouseleave", stopAnimation)
      trigger.removeEventListener("focusin", startAnimation)
      trigger.removeEventListener("focusout", stopAnimation)
    }
  }, [startAnimation, stopAnimation])

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    if (animateOnChange === undefined || reduce) return

    startAnimation()
    stopTimerRef.current = setTimeout(stopAnimation, ICON_ANIMATION_DURATION_MS * durationScale)
    return clearStopTimer
  }, [animateOnChange, clearStopTimer, durationScale, reduce, startAnimation, stopAnimation])

  useEffect(() => clearStopTimer, [clearStopTimer])

  return (
    <span
      ref={containerRef}
      aria-hidden="true"
      data-slot="animated-action-icon"
      className={cn("inline-flex shrink-0", className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <Icon ref={iconRef} size={size} className="inline-flex size-full" />
    </span>
  )
}

export interface CopyFeedbackIconProps extends Omit<
  AnimatedActionIconProps,
  "animateOnChange" | "icon"
> {
  copied: boolean
}

export function CopyFeedbackIcon({ copied, ...props }: CopyFeedbackIconProps) {
  return (
    <AnimatedActionIcon
      icon={copied ? CheckIcon : CopyIcon}
      animateOnChange={copied}
      data-slot="copy-feedback-icon"
      data-state={copied ? "copied" : "idle"}
      {...props}
    />
  )
}
