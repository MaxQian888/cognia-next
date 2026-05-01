/**
 * A2UI Animation Type Definitions
 * Types for the Animation component
 */

import type { A2UIBaseComponent } from "@/types/artifact/a2ui"

/**
 * Animation types supported by A2UI
 */
export type A2UIAnimationType =
  | "fadeIn"
  | "fadeOut"
  | "slideIn"
  | "slideOut"
  | "scale"
  | "bounce"
  | "pulse"
  | "shake"
  | "highlight"
  | "none"

/**
 * Animation direction for slide animations
 */
export type AnimationDirection = "up" | "down" | "left" | "right"

/**
 * A2UI Animation component interface
 */
export interface A2UIAnimationComponentDef extends A2UIBaseComponent {
  component: "Animation"
  type: A2UIAnimationType
  direction?: AnimationDirection
  duration?: number // Duration in seconds
  delay?: number // Delay before animation starts
  repeat?: number | "infinite"
  children?: string[] // Child component IDs to animate
  customAnimation?: {
    initial?: Record<string, unknown>
    animate?: Record<string, unknown>
    exit?: Record<string, unknown>
    transition?: Record<string, unknown>
  }
}
