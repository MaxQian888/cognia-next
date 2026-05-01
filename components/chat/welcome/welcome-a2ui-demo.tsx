"use client"

/**
 * WelcomeA2UIDemo - Interactive A2UI demo surface for the welcome state
 * Shows quick interactive elements powered by A2UI for showcasing capabilities
 */

import { useEffect, useState, useCallback } from "react"
import { loggers } from "@/lib/logger"
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

// Create demo components for interactive showcase
function createDemoComponents(showSettings: boolean = true): A2UIComponent[] {
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
      text: "✨ Quick Actions",
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
      text: "📝 Summarize",
      variant: "outline",
      action: "summarize",
    },
    {
      id: "btn-translate",
      component: "Button",
      text: "🌐 Translate",
      variant: "outline",
      action: "translate",
    },
    {
      id: "btn-analyze",
      component: "Button",
      text: "📊 Analyze",
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
      text: "💻 Code Review",
      variant: "outline",
      action: "code-review",
    },
    {
      id: "btn-ideas",
      component: "Button",
      text: "💡 Generate Ideas",
      variant: "outline",
      action: "generate-ideas",
    },
    {
      id: "btn-explain",
      component: "Button",
      text: "📖 Explain Concept",
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
        title: "⚙️ Response Settings",
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
        label: "Tone",
        value: { path: "/settings/tone" },
        options: [
          { value: "professional", label: "👔 Professional" },
          { value: "casual", label: "😊 Casual" },
          { value: "creative", label: "🎨 Creative" },
          { value: "technical", label: "🔧 Technical" },
        ],
        placeholder: "Select tone...",
      } as A2UIComponent,
      {
        id: "length-select",
        component: "Select",
        label: "Length",
        value: { path: "/settings/length" },
        options: [
          { value: "brief", label: "📄 Brief" },
          { value: "moderate", label: "📋 Moderate" },
          { value: "detailed", label: "📚 Detailed" },
        ],
        placeholder: "Select length...",
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
    const components = createDemoComponents(showSettings)
    createQuickSurface(DEMO_SURFACE_ID, components, initialDataModel, {
      type: "inline",
      title: "Interactive Demo",
    })

    return () => {
      deleteSurface(DEMO_SURFACE_ID)
    }
  }, [createQuickSurface, deleteSurface, showSettings])

  const surface = getSurface(DEMO_SURFACE_ID)

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true)
    deleteSurface(DEMO_SURFACE_ID)
    const components = createDemoComponents(showSettings)
    createQuickSurface(DEMO_SURFACE_ID, components, initialDataModel, {
      type: "inline",
      title: "Interactive Demo",
    })
    setTimeout(() => setIsRefreshing(false), 300)
  }, [createQuickSurface, deleteSurface, showSettings])

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
          <span>✨ Try Interactive Demo</span>
        </Button>

        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>✨ Quick Actions Demo</DialogTitle>
            <DialogDescription>
              Experience the power of A2UI - interactive AI-generated UI components
            </DialogDescription>
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
 * Compact version of the A2UI demo for mobile/limited space
 */
export function WelcomeA2UIDemoCompact({ className, onAction }: WelcomeA2UIDemoProps) {
  const { createQuickSurface, getSurface, deleteSurface } = useA2UI({
    onAction,
  })

  const compactSurfaceId = "welcome-demo-compact"

  useEffect(() => {
    const components: A2UIComponent[] = [
      {
        id: "root",
        component: "Row",
        children: ["btn-quick-1", "btn-quick-2"],
        className: "gap-2",
      },
      {
        id: "btn-quick-1",
        component: "Button",
        text: "✨ Quick Start",
        variant: "default",
        action: "quick-start",
      },
      {
        id: "btn-quick-2",
        component: "Button",
        text: "📚 Examples",
        variant: "outline",
        action: "show-examples",
      },
    ] as A2UIComponent[]

    createQuickSurface(
      compactSurfaceId,
      components,
      {},
      {
        type: "inline",
      }
    )

    return () => {
      deleteSurface(compactSurfaceId)
    }
  }, [createQuickSurface, deleteSurface])

  const surface = getSurface(compactSurfaceId)

  if (!surface) {
    return null
  }

  return (
    <div className={cn("a2ui-welcome-demo-compact", className)}>
      <A2UIInlineSurface surfaceId={compactSurfaceId} />
    </div>
  )
}

export default WelcomeA2UIDemo
