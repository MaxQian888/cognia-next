"use client"

/**
 * Tag management Sheet: lists tags (lightweight + annotated) and supports
 * create (optionally annotated with a message) and delete. Backed by
 * `git_tags` (read) + `git_create_tag` / `git_delete_tag` (mutations).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowUpFromLineIcon, PlusIcon, TagIcon, Trash2Icon } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { gitTags } from "@/lib/git/commands"
import type { GitTag } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

interface TagPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  actions: Pick<UseGitActionsResult, "createTag" | "deleteTag" | "pushTag">
}

export function TagPanel({ open, onOpenChange, rootDir, actions }: TagPanelProps) {
  const t = useTranslations("sourceControl")
  const [tags, setTags] = useState<GitTag[]>([])
  const [name, setName] = useState("")
  const [message, setMessage] = useState("")

  const reload = useCallback(async () => {
    setTags(await gitTags(rootDir))
  }, [rootDir])

  // Load on open via an async continuation (setState lands in `.then`, never
  // synchronously in the effect body). `reload` is reused by the handlers.
  useEffect(() => {
    if (!open) return
    let alive = true
    void gitTags(rootDir).then((tg) => {
      if (alive) setTags(tg)
    })
    return () => {
      alive = false
    }
  }, [open, rootDir])

  const doCreate = async () => {
    const n = name.trim()
    if (!n) return
    await actions.createTag(n, message.trim() || undefined)
    setName("")
    setMessage("")
    await reload()
  }

  const doDelete = async (tagName: string) => {
    await actions.deleteTag(tagName)
    await reload()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96" data-testid="tag-panel">
        <SheetHeader>
          <SheetTitle>{t("tags.title")}</SheetTitle>
          <SheetDescription>{t("tags.description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 p-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("tags.namePlaceholder")}
            data-testid="tag-name"
          />
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("tags.messagePlaceholder")}
            data-testid="tag-message"
          />
          <Button
            onClick={() => void doCreate()}
            disabled={!name.trim()}
            className="gap-1.5"
            data-testid="tag-create"
          >
            <PlusIcon className="size-3.5" />
            {t("tags.create")}
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 border-t">
          <ul className="flex flex-col p-2">
            {tags.map((tag) => (
              <li
                key={tag.name}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                data-testid={`tag-entry-${tag.name}`}
              >
                <TagIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{tag.name}</div>
                  {tag.message && (
                    <div className="truncate text-xs text-muted-foreground" title={tag.message}>
                      {tag.message}
                    </div>
                  )}
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {tag.targetHash.slice(0, 7)}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={t("tags.push")}
                  title={t("tags.push")}
                  onClick={() => void actions.pushTag(tag.name)}
                  data-testid={`tag-push-${tag.name}`}
                >
                  <ArrowUpFromLineIcon className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-destructive"
                  aria-label={t("tags.delete")}
                  onClick={() => void doDelete(tag.name)}
                  data-testid={`tag-delete-${tag.name}`}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </li>
            ))}
            {tags.length === 0 && (
              <li className="px-2 py-3 text-sm text-muted-foreground">{t("tags.empty")}</li>
            )}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
