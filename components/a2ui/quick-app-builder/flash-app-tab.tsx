"use client"

import React, { memo, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Zap, Loader2, Send } from "lucide-react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import type { FlashAppTabProps } from "@/types/a2ui/app"

export const FlashAppTab = memo(function FlashAppTab({ onGenerate }: FlashAppTabProps) {
  const t = useTranslations("a2ui")
  const [flashPrompt, setFlashPrompt] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)

  const handleGenerate = useCallback(async () => {
    if (!flashPrompt.trim() || isGenerating) return
    setIsGenerating(true)
    try {
      await onGenerate(flashPrompt)
      setFlashPrompt("")
    } finally {
      setIsGenerating(false)
    }
  }, [flashPrompt, isGenerating, onGenerate])

  const examples = [
    { icon: "Calculator", name: t("exampleCalculator"), desc: t("exampleCalculatorDesc") },
    { icon: "Timer", name: t("exampleTimer"), desc: t("exampleTimerDesc") },
    { icon: "CheckSquare", name: t("exampleTodo"), desc: t("exampleTodoDesc") },
    { icon: "BarChart3", name: t("exampleDashboard"), desc: t("exampleDashboardDesc") },
  ]

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col p-3 sm:p-4">
        <div className="text-center mb-4 sm:mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-primary/10 mb-3 sm:mb-4">
            <Zap className="h-6 w-6 sm:h-8 sm:w-8 text-primary" />
          </div>
          <h3 className="text-base sm:text-lg font-semibold mb-1 sm:mb-2">{t("flashTitle")}</h3>
          <p className="text-xs sm:text-sm text-muted-foreground">{t("flashDescription")}</p>
        </div>

        <div className="flex flex-col gap-3 sm:gap-4">
          <div className="relative">
            <Input
              value={flashPrompt}
              onChange={(e) => setFlashPrompt(e.target.value)}
              placeholder={t("flashPlaceholder")}
              className="pr-12 text-sm sm:text-base h-10 sm:h-11"
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
            />
            <Button
              size="icon"
              className="absolute right-1 top-1 h-8 w-8 sm:h-9 sm:w-9 touch-manipulation"
              onClick={handleGenerate}
              disabled={!flashPrompt.trim() || isGenerating}
            >
              {isGenerating ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("quickTry")}</p>
            <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 sm:flex-wrap sm:overflow-visible">
              {[
                t("suggestionTodo"),
                t("suggestionCalculator"),
                t("suggestionPomodoro"),
                t("suggestionExpense"),
                t("suggestionHabit"),
                t("suggestionChart"),
              ].map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  size="sm"
                  className="text-xs whitespace-nowrap flex-shrink-0 touch-manipulation h-8 sm:h-9"
                  onClick={() => setFlashPrompt(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>

          <div className="pt-3 sm:pt-4 border-t">
            <p className="text-xs text-muted-foreground mb-2 sm:mb-3">{t("exampleApps")}</p>
            <div className="grid grid-cols-2 gap-2">
              {examples.map((example) => {
                const ExIcon = resolveIcon(example.icon)
                return (
                  <Card
                    key={example.name}
                    className="p-2.5 sm:p-3 cursor-pointer hover:bg-muted/50 active:bg-muted transition-colors touch-manipulation"
                    onClick={() => setFlashPrompt(`${t("flashPromptPrefix")}${example.name}`)}
                  >
                    <div className="flex items-center gap-2">
                      {ExIcon &&
                        React.createElement(ExIcon, {
                          className: "h-4 w-4 text-muted-foreground flex-shrink-0",
                        })}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{example.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{example.desc}</p>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  )
})
