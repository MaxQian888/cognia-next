"use client"

/**
 * Remote management Sheet: lists configured remotes with redacted URLs (copy to
 * clipboard) and supports add / remove. Backed by `git_remotes` (read) +
 * `git_remote_add` / `git_remote_remove` (mutations via `useGitActions`).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CopyIcon, PlusIcon, Trash2Icon } from "lucide-react"
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
import { gitRemotes } from "@/lib/git/commands"
import type { GitRemote } from "@/types/git"
import type { UseGitActionsResult } from "@/hooks/git/use-git-actions"

interface RemotePanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rootDir: string
  actions: Pick<UseGitActionsResult, "remoteAdd" | "remoteRemove"> &
    Partial<Pick<UseGitActionsResult, "can">>
}

export function RemotePanel({ open, onOpenChange, rootDir, actions }: RemotePanelProps) {
  const t = useTranslations("sourceControl")
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const can = actions.can ?? (() => true)

  const reload = useCallback(async () => {
    setRemotes(await gitRemotes(rootDir))
  }, [rootDir])

  // Load on open via an async continuation (setState lands in `.then`, never
  // synchronously in the effect body). `reload` is reused by the handlers.
  useEffect(() => {
    if (!open) return
    let alive = true
    void gitRemotes(rootDir).then((r) => {
      if (alive) setRemotes(r)
    })
    return () => {
      alive = false
    }
  }, [open, rootDir])

  const doAdd = async () => {
    const n = name.trim()
    const u = url.trim()
    if (!n || !u) return
    const failure = await actions.remoteAdd(n, u)
    if (failure) return
    setName("")
    setUrl("")
    await reload()
  }

  const doRemove = async (remoteName: string) => {
    const failure = await actions.remoteRemove(remoteName)
    if (failure) return
    await reload()
  }

  const copyUrl = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t("remotes.copied"))
    } catch {
      toast.error(t("remotes.copyFailed"))
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md" data-testid="remote-panel">
        <SheetHeader>
          <SheetTitle>{t("remotes.title")}</SheetTitle>
          <SheetDescription>{t("remotes.description")}</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 p-4">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("remotes.namePlaceholder")}
            data-testid="remote-name"
          />
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("remotes.urlPlaceholder")}
            data-testid="remote-url"
          />
          <Button
            onClick={() => void doAdd()}
            disabled={!name.trim() || !url.trim() || !can("git_remote_add")}
            className="gap-1.5"
            data-testid="remote-add"
          >
            <PlusIcon className="size-3.5" />
            {t("remotes.add")}
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1 border-t">
          <ul className="flex flex-col p-2">
            {remotes.map((r) => (
              <li
                key={r.name}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                data-testid={`remote-entry-${r.name}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{r.name}</div>
                  <div className="truncate text-xs text-muted-foreground" title={r.fetchUrl}>
                    {r.fetchUrl}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={t("remotes.copyUrl")}
                  onClick={() => void copyUrl(r.fetchUrl)}
                  data-testid={`remote-copy-${r.name}`}
                >
                  <CopyIcon className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6 text-destructive"
                  aria-label={t("remotes.remove")}
                  onClick={() => void doRemove(r.name)}
                  data-testid={`remote-remove-${r.name}`}
                  disabled={!can("git_remote_remove")}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </li>
            ))}
            {remotes.length === 0 && (
              <li className="px-2 py-3 text-sm text-muted-foreground">{t("remotes.empty")}</li>
            )}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
