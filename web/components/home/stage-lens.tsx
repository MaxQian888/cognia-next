"use client"

import type { ReactNode } from "react"
import { useReducedMotion } from "motion/react"

import { Lens } from "@web/components/ui/lens"
import { useFinePointer } from "@web/hooks/use-fine-pointer"

interface StageLensProps {
  children: ReactNode
  ariaLabel: string
}

/**
 * Wraps a ProductStage with Magic UI Lens for inspection on hover.
 *
 * Active only on fine pointer + hover-capable devices.
 * Reduced motion: lens disabled, children render normally. The underlying
 * content always remains available, so magnification never carries unique data.
 * Never hides native cursor.
 */
export function StageLens({ children, ariaLabel }: StageLensProps) {
  const reduced = useReducedMotion()
  const canHover = useFinePointer()

  if (reduced || !canHover) {
    return <>{children}</>
  }

  return (
    <Lens zoomFactor={1.2} lensSize={150} ariaLabel={ariaLabel}>
      {children}
    </Lens>
  )
}
