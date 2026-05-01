"use client"

/**
 * A2UI Analysis Adapter
 * Bridges A2UIComponentProps to AcademicAnalysisPanel via withA2UIContext HOC
 */

import React from "react"
import type { A2UIComponentProps } from "@/types/a2ui/schema"
import type { PaperAnalysisType } from "@/types/academic"
import { AcademicAnalysisPanel } from "./academic-analysis-panel"

/**
 * A2UI-compatible wrapper for AcademicAnalysisPanel
 * Reads paper data from the A2UI data model and renders the analysis panel
 */
export function A2UIAnalysisAdapter({
  component: _component,
  dataModel,
  onAction,
  onDataChange,
}: A2UIComponentProps) {
  const paperTitle = (dataModel?.paperTitle as string) || ""
  const paperAbstract = dataModel?.paperAbstract as string | undefined
  const analysisType = ((dataModel?.analysisType as string) || "summary") as PaperAnalysisType
  const analysisContent = (dataModel?.analysisContent as string) || ""
  const suggestedQuestions = (dataModel?.suggestedQuestions as string[]) || []
  const relatedTopics = (dataModel?.relatedTopics as string[]) || []
  const isLoading = (dataModel?.isLoading as boolean) || false

  return (
    <AcademicAnalysisPanel
      paperTitle={paperTitle}
      paperAbstract={paperAbstract}
      analysisType={analysisType}
      analysisContent={analysisContent}
      suggestedQuestions={suggestedQuestions}
      relatedTopics={relatedTopics}
      isLoading={isLoading}
      onAnalysisTypeChange={(type) => {
        onDataChange?.("analysisType", type)
        onAction?.("analysisTypeChange", { type })
      }}
      onRegenerate={() => {
        onAction?.("regenerate", {})
      }}
      onAskFollowUp={(question) => {
        onAction?.("askFollowUp", { question })
      }}
      onCopy={(content) => {
        onAction?.("copy", { content })
      }}
    />
  )
}
