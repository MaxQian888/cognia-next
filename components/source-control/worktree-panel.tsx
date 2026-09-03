"use client"

/** Manual worktree creation shell around the canonical workspace inventory. */

import { useState } from "react"
import { useTranslations } from "next-intl"

import { NewWorktreeForm } from "@/components/workspace/new-worktree-form"
import { WorkspaceEnvironmentList } from "@/components/workspace/workspace-environment-list"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

interface WorktreePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  canMutate?: (command: string) => boolean
}

export function WorktreePanel({ open, onOpenChange, rootDir, canMutate }: WorktreePanelProps) {
  const t = useTranslations("sourceControl")
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col sm:max-w-lg"
        data-testid="worktree-panel"
      >
        <SheetHeader>
          <SheetTitle>{t("worktrees.title")}</SheetTitle>
          <SheetDescription>{t("worktrees.description")}</SheetDescription>
        </SheetHeader>

        <div className="border-b p-4">
          <NewWorktreeForm
            rootDir={rootDir}
            canMutate={canMutate}
            onCreated={() => setRefreshKey((current) => current + 1)}
          />
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <WorkspaceEnvironmentList
              presentation="sheet"
              rootDir={rootDir}
              refreshKey={refreshKey}
              showPrune
              canMutate={canMutate}
            />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
