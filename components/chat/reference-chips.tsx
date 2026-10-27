"use client"

// Visual list of files/folders the user has @-referenced for the next turn.
// Sits above the textarea inside the composer body. Clicking the X removes
// the reference from the chat-store; the @path token already in the textarea
// is left alone (the user can edit/remove the text manually).

import { useTranslations } from "next-intl"
import { FolderIcon, XIcon } from "lucide-react"
import { useChatStore, useComposerReferencedPaths } from "@/stores/chat"
import { Button } from "@/components/ui/button"
import { FileTypeBadge } from "@/components/shared/file-type-icon"
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
            "group relative flex h-14 w-[13.5rem] max-w-full items-center gap-1.5 rounded-xl border bg-card py-1.5 pr-7 pl-1.5 text-xs shadow-xs hover:border-foreground/20"
          )}
          title={r.absolute}
        >
          <FileTypeBadge
            path={r.relative}
            icon={
              r.isDir ? <FolderIcon className="size-[18px] text-muted-foreground" /> : undefined
            }
            className="size-9"
          />
          <span className="min-w-0 truncate font-medium">{r.relative}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("removeAria", { path: r.relative })}
            onClick={() => remove(r.absolute, composerSessionId)}
            className="absolute top-1 right-1 size-5 rounded-full bg-background/90 p-0 opacity-80 shadow-xs ring-1 ring-border/60 transition-opacity hover:opacity-100 [&>svg]:size-2.5"
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
