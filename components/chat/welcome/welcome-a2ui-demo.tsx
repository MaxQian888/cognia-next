"use client"

/**
 * WelcomeA2UIDemo - Interactive A2UI demo surface for the welcome state
 * Shows quick interactive elements powered by A2UI for showcasing capabilities
 */

import { useEffect, useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { loggers } from "@/lib/logging"
import { cn } from "@/lib/utils"
import { useA2UI } from "@/hooks/a2ui"
import { A2UIInlineSurface } from "@/components/a2ui"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RefreshCw, Sparkles } from "lucide-react"
import type { A2UIComponent, A2UIUserAction, A2UIDataModelChange } from "@/types/a2ui/schema"

type DemoT = ReturnType<typeof useTranslations<"chat.welcomeDemo">>

interface WelcomeA2UIDemoProps {
  className?: string
  onAction?: (action: A2UIUserAction) => void
  onSuggestionClick?: (prompt: string) => void
  showSettings?: boolean
}

// Demo surface ID
const DEMO_SURFACE_ID = "welcome-demo-surface"
const STORAGE_KEY = "a2ui-demo-shown"

// Prompt templates for quick actions
const QUICK_ACTION_PROMPTS: Record<string, string> = {
  summarize:
    "Please summarize the key points of the following text in a clear and concise manner:\n\n[Paste your text here]",
  translate:
    "Please translate the following text to English (or specify target language):\n\n[Paste your text here]",
  analyze: "Please analyze the following data and provide insights:\n\n[Paste your data here]",
  "code-review":
    "Please review the following code for potential issues, improvements, and best practices:\n\n```\n[Paste your code here]\n```",
  "generate-ideas": "Please generate creative ideas for:\n\n[Describe your topic or challenge]",
  "explain-concept":
    "Please explain the following concept in simple terms with examples:\n\n[Enter concept]",
}

const log = loggers.chat.child("welcome-a2ui-demo")

// Create demo components for interactive showcase. The `t` translator is
// scoped to `chat.welcomeDemo`; the inner `QUICK_ACTION_PROMPTS` map remains
// English since those strings are LLM-bound prompts, not UI labels.
function createDemoComponents(t: DemoT, showSettings: boolean = true): A2UIComponent[] {
  const baseComponents: A2UIComponent[] = [
    {
      id: "root",
      component: "Column",
      children: showSettings
        ? ["header", "actions-row", "actions-row-2", "divider", "quick-settings"]
        : ["header", "actions-row", "actions-row-2"],
      className: "gap-3",
    },
    {
      id: "header",
      component: "Text",
      text: t("quickActions"),
      variant: "heading3",
    },
    {
      id: "actions-row",
      component: "Row",
      children: ["btn-summarize", "btn-translate", "btn-analyze"],
      className: "gap-2 flex-wrap justify-center",
    },
    {
      id: "btn-summarize",
      component: "Button",
      text: t("summarize"),
      variant: "outline",
      action: "summarize",
    },
    {
      id: "btn-translate",
      component: "Button",
      text: t("translate"),
      variant: "outline",
      action: "translate",
    },
    {
      id: "btn-analyze",
      component: "Button",
      text: t("analyze"),
      variant: "outline",
      action: "analyze",
    },
    {
      id: "actions-row-2",
      component: "Row",
      children: ["btn-code-review", "btn-ideas", "btn-explain"],
      className: "gap-2 flex-wrap justify-center",
    },
    {
      id: "btn-code-review",
      component: "Button",
      text: t("codeReview"),
      variant: "outline",
      action: "code-review",
    },
    {
      id: "btn-ideas",
      component: "Button",
      text: t("generateIdeas"),
      variant: "outline",
      action: "generate-ideas",
    },
    {
      id: "btn-explain",
      component: "Button",
      text: t("explainConcept"),
      variant: "outline",
      action: "explain-concept",
    },
  ] as A2UIComponent[]

  if (showSettings) {
    baseComponents.push(
      {
        id: "divider",
        component: "Divider",
      } as A2UIComponent,
      {
        id: "quick-settings",
        component: "Card",
        title: t("responseSettings"),
        children: ["settings-row"],
        className: "bg-muted/30",
      } as A2UIComponent,
      {
        id: "settings-row",
        component: "Row",
        children: ["tone-select", "length-select"],
        className: "gap-4 flex-wrap",
      } as A2UIComponent,
      {
        id: "tone-select",
        component: "Select",
        label: t("tone"),
        value: { path: "/settings/tone" },
        options: [
          { value: "professional", label: "👔 Professional" },
          { value: "casual", label: "😊 Casual" },
          { value: "creative", label: "🎨 Creative" },
          { value: "technical", label: "🔧 Technical" },
        ],
        placeholder: t("selectTonePlaceholder"),
      } as A2UIComponent,
      {
        id: "length-select",
        component: "Select",
        label: t("length"),
        value: { path: "/settings/length" },
        options: [
          { value: "brief", label: "📄 Brief" },
          { value: "moderate", label: "📋 Moderate" },
          { value: "detailed", label: "📚 Detailed" },
        ],
        placeholder: t("selectLengthPlaceholder"),
      } as A2UIComponent
    )
  }

  return baseComponents
}

// Initial data model for demo
const initialDataModel = {
  settings: {
    tone: "professional",
    length: "moderate",
  },
}

export function WelcomeA2UIDemo({
  className,
  onAction,
  onSuggestionClick,
  showSettings = true,
}: WelcomeA2UIDemoProps) {
  const t = useTranslations("chat.welcomeDemo")
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const [hasShown, setHasShown] = useState(() => {
    // Initialize from localStorage to avoid setState in effect
    if (typeof window !== "undefined") {
      return localStorage.getItem(STORAGE_KEY) === "true"
    }
    return false
  })

  const handleAction = useCallback(
    (action: A2UIUserAction) => {
      // Get prompt template for the action
      const promptTemplate = QUICK_ACTION_PROMPTS[action.action]
      if (promptTemplate && onSuggestionClick) {
        onSuggestionClick(promptTemplate)
      }
      onAction?.(action)
    },
    [onAction, onSuggestionClick]
  )

  const handleDataChange = useCallback((change: A2UIDataModelChange) => {
    // Settings changes can be used to customize AI responses
    log.debug("A2UI settings changed", {
      path: change.path,
      value: change.value,
    })
  }, [])

  const { createQuickSurface, getSurface, deleteSurface } = useA2UI({
    onAction: handleAction,
    onDataChange: handleDataChange,
  })

  // Create demo surface on mount
  useEffect(() => {
    const components = createDemoComponents(t, showSettings)
    createQuickSurface(DEMO_SURFACE_ID, components, initialDataModel, {
      type: "inline",
      title: t("dialogTitle"),
    })

    return () => {
      deleteSurface(DEMO_SURFACE_ID)
    }
  }, [createQuickSurface, deleteSurface, showSettings, t])

  const surface = getSurface(DEMO_SURFACE_ID)

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true)
    deleteSurface(DEMO_SURFACE_ID)
    const components = createDemoComponents(t, showSettings)
    createQuickSurface(DEMO_SURFACE_ID, components, initialDataModel, {
      type: "inline",
      title: t("dialogTitle"),
    })
    setTimeout(() => setIsRefreshing(false), 300)
  }, [createQuickSurface, deleteSurface, showSettings, t])

  const handleOpen = useCallback(() => {
    setIsOpen(true)
  }, [])

  const handleClose = useCallback(() => {
    setIsOpen(false)
    // Mark as shown so it won't appear again
    localStorage.setItem(STORAGE_KEY, "true")
    setHasShown(true)
  }, [])

  // Don't show anything if already shown
  if (hasShown) {
    return null
  }

  // Show a button that opens the dialog
  return (
    <div className={cn("a2ui-welcome-demo-trigger", className)}>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleClose()
          } else {
            setIsOpen(true)
          }
        }}
      >
        <Button
          onClick={handleOpen}
          variant="outline"
          className="w-full gap-2 animate-in fade-in-0 slide-in-from-bottom-4 duration-500"
        >
          <Sparkles className="h-4 w-4" />
          <span>{t("openDemo")}</span>
        </Button>

        <DialogContent className="max-w-2xl max-h-[80vh] max-w-[calc(100vw-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("dialogTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>

          {surface && (
            <div className="relative">
              <div className="absolute top-2 right-2 z-10 flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  aria-label={t("refresh")}
                >
                  <RefreshCw className={cn("h-3 w-3", isRefreshing && "animate-spin")} />
                </Button>
              </div>
              <A2UIInlineSurface
                surfaceId={DEMO_SURFACE_ID}
                className="rounded-lg border bg-card/50 p-4"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Compact version of the A2UI demo for mobile/limited space.
 * Intentionally returns null — mobile welcome does not show quick-start / try-prompt surfaces.
 */
export function WelcomeA2UIDemoCompact(_props: WelcomeA2UIDemoProps) {
  return null
}

export default WelcomeA2UIDemo
