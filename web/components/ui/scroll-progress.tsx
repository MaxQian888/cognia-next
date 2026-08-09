"use client"

import { motion, useReducedMotion, useScroll, type MotionProps } from "motion/react"

import { cn } from "@web/lib/utils"

interface ScrollProgressProps extends Omit<React.HTMLAttributes<HTMLElement>, keyof MotionProps> {
  ref?: React.Ref<HTMLDivElement>
}

export function ScrollProgress({ className, ref, ...props }: ScrollProgressProps) {
  const { scrollYProgress } = useScroll()
  const reduced = useReducedMotion() ?? false

  return (
    <div
      data-slot="scroll-progress"
      aria-hidden
      ref={ref}
      className={cn("fixed inset-x-0 top-16 z-40 h-px bg-hairline", className)}
      {...props}
    >
      {reduced ? null : (
        <motion.span
          className="absolute inset-0 origin-left bg-action"
          style={{ scaleX: scrollYProgress }}
        />
      )}
    </div>
  )
}
