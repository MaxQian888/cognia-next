"use client"

/**
 * AcademicAnalysisPanel - A2UI component for displaying paper analysis
 * Renders AI-generated analysis with actions
 */

import React, { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import {
  Brain,
  Copy,
  Check,
  RefreshCw,
  MessageSquare,
  ChevronDown,
  Lightbulb,
  BookOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { AcademicAnalysisPanelProps } from "@/types/a2ui/app"
import type { PaperAnalysisType } from "@/types/academic"
import {
  ANALYSIS_TYPE_ICONS,
  ANALYSIS_TYPE_I18N_KEYS,
  ANALYSIS_TYPE_VALUES,
} from "@/lib/a2ui/constants"

export function AcademicAnalysisPanel({
  paperTitle,
  paperAbstract,
  analysisType,
  analysisContent,
  suggestedQuestions = [],
  relatedTopics = [],
  isLoading = false,
  onAnalysisTypeChange,
  onRegenerate,
  onAskFollowUp,
  onCopy,
  className,
}: AcademicAnalysisPanelProps) {
  const t = useTranslations("a2ui")
  const [copied, setCopied] = useState(false)
  const [showQuestions, setShowQuestions] = useState(true)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(analysisContent)
    setCopied(true)
    onCopy?.(analysisContent)
    setTimeout(() => setCopied(false), 2000)
  }, [analysisContent, onCopy])

  const currentIcon = ANALYSIS_TYPE_ICONS[analysisType]
  const currentLabel = t(ANALYSIS_TYPE_I18N_KEYS[analysisType])

  return (
    <div className={cn("flex flex-col h-full", className)}>
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <Brain className="h-5 w-5 text-primary" />
        <span className="font-semibold">{t("aiPaperAnalysis")}</span>
      </div>

      <Card className="mx-4 mt-4 bg-muted/30">
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium line-clamp-2">{paperTitle}</CardTitle>
          {paperAbstract && (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{paperAbstract}</p>
          )}
        </CardHeader>
      </Card>

      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-sm text-muted-foreground">{t("analysisLabel")}</span>
        <Select
          value={analysisType}
          onValueChange={(v) => onAnalysisTypeChange?.(v as PaperAnalysisType)}
          disabled={isLoading}
        >
          <SelectTrigger className="w-48 h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ANALYSIS_TYPE_VALUES.map((typeValue) => (
              <SelectItem key={typeValue} value={typeValue}>
                <span className="flex items-center gap-2">
                  <span>{ANALYSIS_TYPE_ICONS[typeValue]}</span>
                  <span>{t(ANALYSIS_TYPE_I18N_KEYS[typeValue])}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-8"
          onClick={onRegenerate}
          disabled={isLoading}
        >
          <RefreshCw className={cn("h-3 w-3 mr-1", isLoading && "animate-spin")} />
          {t("regenerate")}
        </Button>
      </div>

      <Separator />

      <ScrollArea className="flex-1 px-4 py-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Brain className="h-6 w-6 animate-pulse text-primary" />
            <span className="ml-2 text-muted-foreground">{t("analyzingPaper")}</span>
          </div>
        ) : (
          <div className="space-y-4">
            <Card>
              <CardHeader className="py-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{currentIcon}</span>
                  <CardTitle className="text-sm">{currentLabel}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="prose prose-sm dark:prose-invert max-w-none">
                  <div className="whitespace-pre-wrap text-sm">{analysisContent}</div>
                </div>
              </CardContent>
            </Card>

            {suggestedQuestions.length > 0 && (
              <Collapsible open={showQuestions} onOpenChange={setShowQuestions}>
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="py-3 cursor-pointer hover:bg-muted/50">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Lightbulb className="h-4 w-4 text-yellow-500" />
                          <CardTitle className="text-sm">{t("suggestedQuestions")}</CardTitle>
                        </div>
                        <ChevronDown
                          className={cn(
                            "h-4 w-4 transition-transform",
                            showQuestions && "rotate-180"
                          )}
                        />
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="pt-0 space-y-2">
                      {suggestedQuestions.map((question, idx) => (
                        <Button
                          key={idx}
                          variant="ghost"
                          className="w-full justify-start h-auto py-2 px-3 text-left text-sm"
                          onClick={() => onAskFollowUp?.(question)}
                        >
                          <MessageSquare className="h-3 w-3 mr-2 shrink-0" />
                          <span className="line-clamp-2">{question}</span>
                        </Button>
                      ))}
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            )}

            {relatedTopics.length > 0 && (
              <Card>
                <CardHeader className="py-3">
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-blue-500" />
                    <CardTitle className="text-sm">{t("relatedTopics")}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex flex-wrap gap-2">
                    {relatedTopics.map((topic, idx) => (
                      <Badge key={idx} variant="secondary" className="text-xs">
                        {topic}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </ScrollArea>

      <Separator />

      <div className="flex items-center gap-2 px-4 py-3">
        <Button
          size="sm"
          variant="outline"
          onClick={handleCopy}
          disabled={isLoading || !analysisContent}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 mr-1" />
              {t("copiedExclamation")}
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 mr-1" />
              {t("copyAnalysis")}
            </>
          )}
        </Button>

        <Button
          size="sm"
          variant="default"
          className="ml-auto"
          onClick={() => onAskFollowUp?.("")}
          disabled={isLoading}
        >
          <MessageSquare className="h-3 w-3 mr-1" />
          {t("askFollowUp")}
        </Button>
      </div>
    </div>
  )
}
