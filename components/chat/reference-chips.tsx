"use client"

// Visual list of files/folders the user has @-referenced for the next turn.
// Sits above the textarea inside the composer body. Clicking the X removes
// the reference from the chat-store; the @path token already in the textarea
// is left alone (the user can edit/remove the text manually).

import { useTranslations } from "next-intl"
import { FileIcon, FolderIcon, XIcon } from "lucide-react"
import { useChatStore } from "@/stores/chat"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ReferenceChips() {
  const t = useTranslations("chat.composer.references")
  const refs = useChatStore((s) => s.referencedPaths)
  const remove = useChatStore((s) => s.removeReferencedPath)

  if (refs.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-2 pt-2">
      {refs.map((r) => (
        <div
          key={r.absolute}
          className={cn(
            "group flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
          )}
          title={r.absolute}
        >
          {r.isDir ? (
            <FolderIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <FileIcon className="size-3.5 text-muted-foreground" />
          )}
          <span className="max-w-[min(280px,calc(100vw-6rem))] truncate font-mono">
            {r.relative}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("removeAria", { path: r.relative })}
            onClick={() => remove(r.absolute)}
            className="size-5 opacity-60 transition-opacity hover:opacity-100"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
    </div>
  )
}
