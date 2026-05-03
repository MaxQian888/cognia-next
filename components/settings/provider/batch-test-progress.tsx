"use client"

import React from "react"
import { Check, AlertCircle, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"

export type BatchVerificationOperation = "verify-enabled" | "verify-selected" | "retry-failed"

interface BatchTestProgressProps {
  isRunning: boolean
  progress: number
  onCancel: () => void
  cancelRequested?: boolean
}

export const BatchTestProgress = React.memo(function BatchTestProgress({
  isRunning,
  progress,
  onCancel,
  cancelRequested = false,
}: BatchTestProgressProps) {
  const t = useTranslations("providers")

  if (!isRunning) return null

  return (
    <div className="space-y-2">
      <Progress value={progress} className="h-2" />
      <div className="flex items-center justify-center gap-2">
        <p className="text-xs text-muted-foreground text-center">
          {t("testingProviders", { progress: Math.round(progress) })}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onCancel}
          disabled={cancelRequested}
        >
          {t("cancel")}
        </Button>
      </div>
    </div>
  )
})

interface TestResultsSummaryProps {
  success: number
  failed: number
  total: number
  operationType?: BatchVerificationOperation
  completed?: number
  expectedTotal?: number
  canceled?: boolean
}

export const TestResultsSummary = React.memo(function TestResultsSummary({
  success,
  failed,
  total,
  operationType,
  completed,
  expectedTotal,
  canceled = false,
}: TestResultsSummaryProps) {
  const t = useTranslations("providers")

  if (total === 0) return null

  const operationLabel = operationType
    ? operationType === "retry-failed"
      ? t("batchOperationRetryFailed")
      : operationType === "verify-selected"
        ? t("batchOperationVerifySelected")
        : t("batchOperationVerifyEnabled")
    : null

  return (
    <div className="flex items-center gap-4 rounded-lg border p-3 bg-muted/30">
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t("testResults")}:</span>
        {operationLabel && (
          <span className="text-xs text-muted-foreground">({operationLabel})</span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1 text-sm text-green-600">
          <Check className="h-4 w-4" />
          {t("passedCount", { count: success })}
        </span>
        {failed > 0 && (
          <span className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {t("failedCount", { count: failed })}
          </span>
        )}
      </div>
      {typeof completed === "number" && typeof expectedTotal === "number" && (
        <span className="text-xs text-muted-foreground ml-auto">
          {canceled
            ? `${t("cancel")}: ${completed}/${expectedTotal}`
            : `${completed}/${expectedTotal}`}
        </span>
      )}
    </div>
  )
})

export default BatchTestProgress
