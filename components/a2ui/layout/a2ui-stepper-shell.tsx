"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { resolveArrayOrPath, resolveNumberOrPath, resolveStringOrPath } from "@/lib/a2ui/data-model"
import type {
  A2UIComponentProps,
  A2UIRichOutputStep,
  A2UIStepperShellComponent,
} from "@/types/a2ui/schema"

export function A2UIStepperShell({
  component,
  dataModel,
  onAction,
  onDataChange,
}: A2UIComponentProps<A2UIStepperShellComponent>) {
  const title = resolveStringOrPath(component.title ?? "", dataModel, "")
  const description = resolveStringOrPath(component.description ?? "", dataModel, "")
  const steps = resolveArrayOrPath(component.steps, dataModel, []) as A2UIRichOutputStep[]
  const currentStep = component.currentStep
    ? resolveNumberOrPath(component.currentStep, dataModel, 0)
    : 0
  const safeStep = Math.max(0, Math.min(currentStep, Math.max(steps.length - 1, 0)))
  const activeStep = steps[safeStep]

  const moveToStep = (nextStep: number) => {
    if (component.currentStepPath) {
      onDataChange(component.currentStepPath, nextStep)
    }

    if (component.stepChangeAction) {
      onAction(component.stepChangeAction, {
        ...component.actionMeta,
        stepId: steps[nextStep]?.id,
        stepIndex: nextStep,
      })
    }
  }

  return (
    <Card className="border-border/60 bg-background/80">
      {title || description ? (
        <CardHeader className="pb-3">
          {title ? <CardTitle className="text-sm">{title}</CardTitle> : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      {activeStep ? (
        <>
          <CardContent className="space-y-1 pt-0">
            <h4 className="text-sm font-medium">{activeStep.title}</h4>
            {activeStep.description ? (
              <p className="text-sm text-muted-foreground">{activeStep.description}</p>
            ) : null}
            {activeStep.body ? <p className="text-sm leading-6">{activeStep.body}</p> : null}
          </CardContent>
          <CardContent className="flex items-center justify-between pt-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1"
              disabled={safeStep <= 0}
              onClick={() => moveToStep(Math.max(0, safeStep - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              {component.previousLabel || "Previous"}
            </Button>
            <div className="text-xs text-muted-foreground">
              {safeStep + 1}/{steps.length || 1}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={safeStep >= steps.length - 1}
              onClick={() => moveToStep(Math.min(steps.length - 1, safeStep + 1))}
            >
              {component.nextLabel || "Next"}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </>
      ) : (
        <CardContent className="pt-0 text-sm text-muted-foreground">
          No steps are available yet.
        </CardContent>
      )}
    </Card>
  )
}
