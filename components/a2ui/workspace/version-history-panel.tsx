"use client"

/**
 * Version History Panel
 * Shows undo history snapshots with restore capability
 */

import React, { useCallback } from "react"
import { useTranslations } from "next-intl"
import { History, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useA2UIStore } from "@/stores/a2ui"
import { useWorkspaceContext } from "./a2ui-workspace-context"

// Stable fallback so the selector keeps referential equality when the stack
// is absent (a fresh [] would re-render on every store change)
const EMPTY_UNDO_STACK: never[] = []

export function VersionHistoryPanel() {
  const t = useTranslations("a2ui")
  const { surfaceId } = useWorkspaceContext()
  const undoStack = useA2UIStore((state) => state.undoStacks[surfaceId] ?? EMPTY_UNDO_STACK)
  const undo = useA2UIStore((state) => state.undo)

  const handleRestore = useCallback(
    (targetIndex: number) => {
      // Undo from current state back to the target entry
      const stepsBack = undoStack.length - targetIndex
      for (let i = 0; i < stepsBack; i++) {
        undo(surfaceId)
      }
    },
    [undoStack.length, undo, surfaceId]
  )

  // Reverse order so most recent is at the top
  const entries = [...undoStack].reverse()

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t("versionHistory")}
        </span>
        <Badge variant="outline" className="text-[10px] h-5 ml-auto">
          {entries.length}
        </Badge>
      </div>
      <ScrollArea className="flex-1">
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">{t("noVersions")}</p>
        ) : (
          <div className="py-1">
            {entries.map((entry, i) => {
              const originalIndex = undoStack.length - 1 - i
              return (
                <div
                  key={entry.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent/50 group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{entry.description}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                  {i === 0 && (
                    <Badge variant="secondary" className="text-[10px] h-4 px-1 shrink-0">
                      {t("latest")}
                    </Badge>
                  )}
                  {i > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => handleRestore(originalIndex)}
                    >
                      <RotateCcw data-icon="inline-start" />
                      {t("restoreVersion")}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
