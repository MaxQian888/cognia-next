"use client"

/**
 * A2UI Interactive Guide Component
 *
 * Provides step-by-step guided experiences within the A2UI system.
 * Supports progress tracking, navigation, and content rendering.
 */

import React, { memo, useState, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { ChevronLeft, ChevronRight, Check, Target, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps } from "@/types/a2ui/schema"
import { isPathValue } from "@/types/a2ui/schema"
import { getValueByPath } from "@/lib/a2ui/data-model"
import type {
  A2UIInteractiveGuideComponentDef,
  StepIndicatorProps,
} from "@/types/a2ui/interactive-guide"
import { useA2UIData } from "@/hooks/a2ui"

/**
 * Resolve string or path value
 */
function resolveValue<T>(
  value: T | { path: string } | undefined,
  dataModel: Record<string, unknown>,
  defaultValue: T
): T {
  if (value === undefined) return defaultValue
  if (isPathValue(value)) {
    const resolved = getValueByPath<T>(dataModel, value.path)
    return resolved === undefined ? defaultValue : resolved
  }
  return value as T
}

const StepIndicator = memo(function StepIndicator({
  steps,
  currentStep,
  completedSteps,
  onStepClick,
}: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center gap-1">
      {steps.map((step, index) => {
        const isCompleted = completedSteps.has(index)
        const isCurrent = index === currentStep

        return (
          <button
            key={step.id}
            onClick={() => onStepClick?.(index)}
            className={cn(
              "w-2 h-2 rounded-full transition-all",
              isCompleted && "bg-green-500 w-3 h-3",
              isCurrent && !isCompleted && "bg-primary w-3 h-3",
              !isCurrent && !isCompleted && "bg-muted-foreground/30 hover:bg-muted-foreground/50",
              onStepClick && "cursor-pointer"
            )}
            disabled={!onStepClick}
            aria-label={`Go to step ${index + 1}`}
          />
        )
      })}
    </div>
  )
})

/**
 * A2UI Interactive Guide Component
 */
export const A2UIInteractiveGuide = memo(function A2UIInteractiveGuide({
  component,
  onAction,
  renderChild,
}: A2UIComponentProps) {
  const { dataModel } = useA2UIData()
  const t = useTranslations("learning.guide")
  const prefersReducedMotion = useReducedMotion()

  const guideComponent = component as A2UIInteractiveGuideComponentDef
  const {
    title,
    steps,
    currentStep: controlledStep,
    showProgress = true,
    showNavigation = true,
    showStepIndicator = true,
    allowSkip = false,
    onComplete,
    onStepChange,
    onSkip,
    className,
  } = guideComponent

  // Resolve values from data model
  const resolvedTitle = resolveValue(title, dataModel, "")
  const resolvedControlledStep = resolveValue(controlledStep, dataModel, undefined)

  // Internal state
  const [internalStep, setInternalStep] = useState(0)
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set())

  // Use controlled or internal step
  const activeStep = resolvedControlledStep ?? internalStep
  const currentStepData = steps[activeStep]
  const isFirstStep = activeStep === 0
  const isLastStep = activeStep === steps.length - 1

  // Resolve step title and description
  const stepTitle = resolveValue(currentStepData?.title, dataModel, "")
  const stepDescription = resolveValue(currentStepData?.description, dataModel, "")

  // Calculate progress
  const progress = useMemo(() => {
    return Math.round(((activeStep + 1) / steps.length) * 100)
  }, [activeStep, steps.length])

  // Navigate to step
  const goToStep = useCallback(
    (stepIndex: number) => {
      if (stepIndex < 0 || stepIndex >= steps.length) return

      if (resolvedControlledStep === undefined) {
        setInternalStep(stepIndex)
      }

      // Trigger step change action
      if (onStepChange) {
        onAction(onStepChange, { step: stepIndex, stepId: steps[stepIndex].id })
      }

      // Trigger step action if defined
      if (steps[stepIndex].action) {
        onAction(steps[stepIndex].action!, { step: stepIndex })
      }
    },
    [steps, resolvedControlledStep, onStepChange, onAction]
  )

  // Handle next
  const handleNext = useCallback(() => {
    // Mark current step as completed
    setCompletedSteps((prev) => new Set(prev).add(activeStep))

    if (isLastStep) {
      if (onComplete) {
        onAction(onComplete, { completedSteps: Array.from(completedSteps) })
      }
    } else {
      goToStep(activeStep + 1)
    }
  }, [activeStep, isLastStep, completedSteps, onComplete, onAction, goToStep])

  // Handle previous
  const handlePrevious = useCallback(() => {
    if (!isFirstStep) {
      goToStep(activeStep - 1)
    }
  }, [isFirstStep, activeStep, goToStep])

  // Handle skip
  const handleSkip = useCallback(() => {
    if (onSkip) {
      onAction(onSkip, { skippedAt: activeStep })
    }
  }, [onSkip, activeStep, onAction])

  const animationProps = prefersReducedMotion
    ? {}
    : {
        initial: { opacity: 0, x: 20 },
        animate: { opacity: 1, x: 0 },
        exit: { opacity: 0, x: -20 },
        transition: { duration: 0.3 },
      }

  if (!currentStepData) {
    return (
      <Card className={cn("a2ui-interactive-guide", className)}>
        <CardContent className="py-8 text-center text-muted-foreground">
          No steps defined
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={cn("a2ui-interactive-guide overflow-hidden", className)}>
      {/* Header */}
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4 text-primary" />
            {resolvedTitle || t("guideTitle")}
          </CardTitle>
          {allowSkip && (
            <Button variant="ghost" size="sm" onClick={handleSkip}>
              <X className="h-4 w-4 mr-1" />
              {t("skipGuide")}
            </Button>
          )}
        </div>

        {/* Progress */}
        {showProgress && (
          <div className="space-y-1 mt-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{t("stepProgress", { current: activeStep + 1, total: steps.length })}</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-1.5" />
          </div>
        )}

        {/* Step indicator */}
        {showStepIndicator && steps.length <= 8 && (
          <div className="mt-2">
            <StepIndicator
              steps={steps}
              currentStep={activeStep}
              completedSteps={completedSteps}
              onStepClick={showNavigation ? goToStep : undefined}
            />
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Step content */}
        <AnimatePresence mode="wait">
          <motion.div key={currentStepData.id} {...animationProps}>
            {/* Step title */}
            <div className="space-y-1 mb-4">
              <div className="flex items-center gap-2">
                <h4 className="font-medium">{stepTitle}</h4>
                {currentStepData.isOptional && (
                  <Badge variant="outline" className="text-xs">
                    Optional
                  </Badge>
                )}
              </div>
              {stepDescription && (
                <p className="text-sm text-muted-foreground">{stepDescription}</p>
              )}
            </div>

            {/* Step content (rendered children) */}
            <div className="space-y-3">
              {currentStepData.content.map((childId) => (
                <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
              ))}
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Navigation */}
        {showNavigation && (
          <div className="flex items-center justify-between pt-3 border-t">
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrevious}
              disabled={isFirstStep}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              {t("previousStep")}
            </Button>

            <Button
              variant={isLastStep ? "default" : "outline"}
              size="sm"
              onClick={handleNext}
              className="gap-1"
            >
              {isLastStep ? (
                <>
                  <Check className="h-4 w-4" />
                  {t("complete")}
                </>
              ) : (
                <>
                  {t("nextStep")}
                  <ChevronRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
})
