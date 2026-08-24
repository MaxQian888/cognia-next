"use client"

/**
 * "Folders in use" — adopt the directories the app is already working in.
 *
 * Before workspaces became the attribution unit, the managed-worktree registry
 * and the terminal dock each kept their own idea of where work happens. A
 * machine can be busy in six directories while the switcher lists one, and
 * nothing in the product ever proposed closing that gap: the user had to notice
 * and re-enter each folder by hand. This is that proposal.
 *
 * It creates nothing on disk and moves nothing. Adopting mounts an existing
 * directory as a workspace through {@link openPathAsWorkspace} — the same sink
 * every other "open" entry point uses, so a folder that is already a workspace
 * is re-activated rather than duplicated.
 */

import { useTranslations } from "next-intl"
import { FolderPlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAdoptionCandidates } from "@/hooks/workspace/use-adoption-candidates"
import { openPathAsWorkspace } from "@/lib/workspace/open-folder"

export interface AdoptWorkspacesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a folder is adopted and activated. */
  onAdopted?: (projectId: string) => void
  /** Injected in tests. */
  adopt?: typeof openPathAsWorkspace
}

export function AdoptWorkspacesDialog({
  open,
  onOpenChange,
  onAdopted,
  adopt = openPathAsWorkspace,
}: AdoptWorkspacesDialogProps) {
  const t = useTranslations("workspace.adopt")
  const { candidates, ready, dismiss, refresh } = useAdoptionCandidates()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="adopt-workspaces-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid="adopt-empty">
            {ready ? t("empty") : t("scanning")}
          </p>
        ) : (
          <ScrollArea className="max-h-[min(24rem,55vh)]">
            <ul className="flex flex-col gap-1 pr-2">
              {candidates.map((candidate) => (
                <li
                  key={candidate.path}
                  className="flex items-center gap-2 rounded-lg border px-3 py-2"
                  data-testid={`adopt-candidate-${candidate.path}`}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{candidate.suggestedName}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {candidate.path}
                    </span>
                  </div>
                  {/* Why it is being offered. Without this the list reads as a
                      pile of paths the app found somewhere. */}
                  <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                    {t(`origin.${candidate.origins[0]}`)}
                  </Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    data-testid={`adopt-candidate-${candidate.path}-adopt`}
                    onClick={() => {
                      const project = adopt(candidate.path, candidate.suggestedName)
                      // Re-collect rather than filtering locally: adopting one
                      // repository can claim several sighted paths at once.
                      refresh()
                      if (project) onAdopted?.(project.id)
                    }}
                  >
                    <FolderPlusIcon className="size-3.5" />
                    {t("adopt")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    aria-label={t("dismissLabel", { name: candidate.suggestedName })}
                    data-testid={`adopt-candidate-${candidate.path}-dismiss`}
                    onClick={() => dismiss(candidate.path)}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  )
}
