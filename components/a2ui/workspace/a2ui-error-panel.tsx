"use client"

/**
 * A2UI Error Panel
 * Collapsible bottom panel showing surface errors
 */

import React from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, X, ChevronDown, ChevronUp } from "lucide-react"
import { ErrorTraceDetails } from "@/components/ai-elements/error-trace"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useA2UIStore } from "@/stores/a2ui"
import { useWorkspaceContext } from "./a2ui-workspace-context"

export function A2UIErrorPanel() {
  const t = useTranslations("a2ui")
  const { surfaceId } = useWorkspaceContext()
  const error = useA2UIStore((state) => state.errors[surfaceId])
  const setError = useA2UIStore((state) => state.setError)
  const [isOpen, setIsOpen] = React.useState(true)

  if (!error) return null

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border-t bg-destructive/5">
      <CollapsibleTrigger className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-destructive/10 transition-colors">
        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
        <Badge variant="destructive" className="text-[10px] h-4 px-1">
          {t("errorCount", { count: 1 })}
        </Badge>
        <span className="flex-1" />
        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ScrollArea className="max-h-32">
          <div className="px-3 py-2 text-xs">
            <div className="mb-2 flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <div className="flex-1">
                <ErrorTraceDetails error={{ message: error }} />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={() => setError(surfaceId, null)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  )
}
