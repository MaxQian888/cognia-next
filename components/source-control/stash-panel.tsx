"use client"

/**
 * Stash management Sheet: push (message + options) and a list of existing
 * stashes with pop / apply / drop.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArchiveIcon, Trash2Icon } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { GitStashEntry } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

interface StashPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  stashes: GitStashEntry[]
  actions: Pick<UseGitActionsResult, "stashPush" | "stashPop" | "stashApply" | "stashDrop"> &
    Partial<Pick<UseGitActionsResult, "can">>
}

export function StashPanel({ open, onOpenChange, stashes, actions }: StashPanelProps) {
  const t = useTranslations("sourceControl")
  const [message, setMessage] = useState("")
  const [includeUntracked, setIncludeUntracked] = useState(false)
  const [keepIndex, setKeepIndex] = useState(false)
  const can = actions.can ?? (() => true)

  const doPush = async () => {
    const failure = await actions.stashPush({
      message: message.trim() || undefined,
      includeUntracked,
      keepIndex,
    })
    if (failure) return
    setMessage("")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md" data-testid="stash-panel">
        <SheetHeader>
          <SheetTitle>{t("stash.title")}</SheetTitle>
          <SheetDescription>{t("stash.description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 p-4">
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("stash.pushMessage")}
            data-testid="stash-message"
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={includeUntracked}
              onCheckedChange={(v) => setIncludeUntracked(Boolean(v))}
              data-testid="stash-untracked"
            />
            {t("stash.includeUntracked")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={keepIndex}
              onCheckedChange={(v) => setKeepIndex(Boolean(v))}
              data-testid="stash-keep-index"
            />
            <Label className="cursor-pointer">{t("stash.keepIndex")}</Label>
          </label>
          <Button
            onClick={() => void doPush()}
            disabled={!can("git_stash_push")}
            className="gap-1.5"
            data-testid="stash-push"
          >
            <ArchiveIcon className="size-3.5" />
            {t("stash.push")}
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 border-t">
          <ul className="flex flex-col p-2">
            {stashes.map((s) => (
              <li
                key={s.index}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                data-testid={`stash-entry-${s.index}`}
              >
                <span className="min-w-0 flex-1 truncate" title={s.message}>
                  {s.message}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => void actions.stashPop(s.index)}
                  data-testid={`stash-pop-${s.index}`}
                  disabled={!can("git_stash_pop")}
                >
                  {t("stash.pop")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => void actions.stashApply(s.index)}
                  data-testid={`stash-apply-${s.index}`}
                  disabled={!can("git_stash_apply")}
                >
                  {t("stash.apply")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-destructive"
                  aria-label={t("stash.drop")}
                  onClick={() => void actions.stashDrop(s.index)}
                  data-testid={`stash-drop-${s.index}`}
                  disabled={!can("git_stash_drop")}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </li>
            ))}
            {stashes.length === 0 && (
              <li className="px-2 py-3 text-sm text-muted-foreground">{t("stash.empty")}</li>
            )}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
