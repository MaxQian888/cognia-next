/**
 * A2UI Interactive Guide Type Definitions
 * Types for the InteractiveGuide component
 */

import type { A2UIBaseComponent, A2UIStringOrPath, A2UINumberOrPath } from "@/types/artifact/a2ui"

/**
 * A single guide step definition
 */
export interface A2UIGuideStep {
  id: string
  title: A2UIStringOrPath
  description?: A2UIStringOrPath
  content: string[] // Child component IDs for this step
  action?: string // Optional action to trigger when step is viewed
  icon?: string
  isOptional?: boolean
}

/**
 * A2UI Interactive Guide component interface
 */
export interface A2UIInteractiveGuideComponentDef extends A2UIBaseComponent {
  component: "InteractiveGuide"
  title?: A2UIStringOrPath
  steps: A2UIGuideStep[]
  currentStep?: A2UINumberOrPath // Controlled mode
  showProgress?: boolean
  showNavigation?: boolean
  showStepIndicator?: boolean
  allowSkip?: boolean
  onComplete?: string // Action when guide completes
  onStepChange?: string // Action when step changes
  onSkip?: string // Action when guide is skipped
}

/**
 * Props for step indicator dots sub-component
 */
export interface StepIndicatorProps {
  steps: A2UIGuideStep[]
  currentStep: number
  completedSteps: Set<number>
  onStepClick?: (step: number) => void
}
