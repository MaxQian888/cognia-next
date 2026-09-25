"use client"

/**
 * Tag management Sheet: lists tags (lightweight + annotated) and supports
 * create (optionally annotated with a message) and delete. Backed by
 * `git_tags` (read) + `git_create_tag` / `git_delete_tag` (mutations).
 */

import { useState } from "react"
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
import { Spinner } from "@/components/ui/spinner"
import { gitTags } from "@/lib/git/commands"
import { useGitRead } from "@/hooks/git/use-git-read"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"
import { ReadError } from "./read-error"

interface TagPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  actions: Pick<UseGitActionsResult, "createTag" | "deleteTag" | "pushTag"> &
    Partial<Pick<UseGitActionsResult, "can">>
}

export function TagPanel({ open, onOpenChange, rootDir, actions }: TagPanelProps) {
  const t = useTranslations("sourceControl")
  const [name, setName] = useState("")
  const [message, setMessage] = useState("")
  const can = actions.can ?? (() => true)

  // Read on open. A mutation re-reads through `retry`, which keeps the list
  // on screen while the new one lands.
  const list = useGitRead(`${rootDir}\u0000tags`, () => gitTags(rootDir), { enabled: open })
  const tags = list.data ?? []
  const reload = list.retry

  const doCreate = async () => {
    const n = name.trim()
    if (!n) return
    const failure = await actions.createTag(n, message.trim() || undefined)
    if (failure) return
    setName("")
    setMessage("")
    reload()
  }

  const doDelete = async (tagName: string) => {
    const failure = await actions.deleteTag(tagName)
    if (failure) return
    reload()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md" data-testid="tag-panel">
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
            disabled={!name.trim() || !can("git_create_tag")}
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
                  disabled={!can("git_push_tag")}
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
                  disabled={!can("git_delete_tag")}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </li>
            ))}
            {list.error ? (
              <li>
                <ReadError message={list.error} onRetry={list.retry} testId="tags-load-error" />
              </li>
            ) : list.loading ? (
              <li
                role="status"
                className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground"
                data-testid="tags-loading"
              >
                <Spinner className="size-3.5" />
                {t("read.loading")}
              </li>
            ) : tags.length === 0 ? (
              <li className="px-2 py-3 text-sm text-muted-foreground">{t("tags.empty")}</li>
            ) : null}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
