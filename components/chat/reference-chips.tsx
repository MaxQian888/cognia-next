"use client"

// Visual list of files/folders the user has @-referenced for the next turn.
// Sits above the textarea inside the composer body. Clicking the X removes
// the reference from the chat-store; the @path token already in the textarea
// is left alone (the user can edit/remove the text manually).

import { useTranslations } from "next-intl"
import { FileIcon, FolderIcon, XIcon } from "lucide-react"
import { useChatStore, useComposerReferencedPaths } from "@/stores/chat"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useComposerSessionId } from "./composer/composer-session-context"

export interface ReferenceChipsProps {
  /**
   * When true, render only the chips (no padded container) so a parent bar can
   * lay references and attachments out in a single flex flow. Defaults to the
   * standalone, self-contained row.
   */
  bare?: boolean
}

export function ReferenceChips({ bare = false }: ReferenceChipsProps = {}) {
  const t = useTranslations("chat.composer.references")
  const composerSessionId = useComposerSessionId()
  // The pane's own conversation, matching the `remove` write below: reading the
  // focused projection made an unfocused pane list the other pane's chips, so
  // clicking × removed a chip from a slice nobody was displaying.
  const refs = useComposerReferencedPaths(composerSessionId)
  const remove = useChatStore((s) => s.removeReferencedPath)

  if (refs.length === 0) return null
  const chips = (
    <>
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
            onClick={() => remove(r.absolute, composerSessionId)}
            className="size-5 opacity-60 transition-opacity hover:opacity-100"
          >
            <XIcon className="size-3" />
          </Button>
        </div>
      ))}
    </>
  )
  if (bare) return chips
  return <div className="flex flex-wrap gap-1.5 px-2 pt-2">{chips}</div>
}
