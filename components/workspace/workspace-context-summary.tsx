"use client"

/**
 * What this workspace tells every conversation that runs in it: its
 * description, its instructions, its tags and its knowledge files.
 *
 * Read-only on purpose. The fields are edited in the workspace manager, the
 * one editor for a workspace row, and the Edit action here opens it on this
 * workspace rather than growing a second form.
 */

import { useTranslations } from "next-intl"
import { BookOpenIcon, PencilIcon } from "lucide-react"

import { ConsoleSection } from "@/components/surface/console-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Project } from "@/types"

export interface WorkspaceContextSummaryProps {
  workspace: Pick<
    Project,
    "description" | "customInstructions" | "tags" | "knowledgeBase" | "knowledgeSettings"
  > | null
  /** Opens the workspace manager on this workspace. */
  onEdit: () => void
}

export function WorkspaceContextSummary({ workspace, onEdit }: WorkspaceContextSummaryProps) {
  const t = useTranslations("workspace.context")
  const description = workspace?.description?.trim()
  const instructions = workspace?.customInstructions?.trim()
  const tags = workspace?.tags ?? []
  const files = workspace?.knowledgeBase?.length ?? 0
  // Knowledge is only injected when project RAG is on, and the default is on
  // (`resolveProjectKnowledgeSettings`); say so only when someone turned it off.
  const knowledgeOff = workspace?.knowledgeSettings?.enableProjectRag === false
  const configured = [description, instructions, files > 0].filter(Boolean).length

  return (
    <ConsoleSection
      id="context"
      pane="workspace-pane"
      idPrefix="workspace-section"
      icon={BookOpenIcon}
      title={t("title")}
      meta={
        <Button
          size="sm"
          variant="ghost"
          className="-my-1 h-7 gap-1"
          onClick={onEdit}
          disabled={!workspace}
          data-testid="workspace-context-edit"
        >
          <PencilIcon aria-hidden className="size-3.5" />
          {t("edit")}
        </Button>
      }
    >
      {configured === 0 && tags.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="workspace-context-empty">
          {t("empty")}
        </p>
      ) : (
        <dl className="flex flex-col gap-3 text-xs">
          {description ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-muted-foreground">{t("description")}</dt>
              <dd className="text-sm" data-testid="workspace-context-description">
                {description}
              </dd>
            </div>
          ) : null}
          <div className="flex flex-col gap-0.5">
            <dt className="text-muted-foreground">{t("instructions")}</dt>
            {instructions ? (
              <dd
                className="line-clamp-4 whitespace-pre-line rounded-control bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-relaxed"
                data-testid="workspace-context-instructions"
              >
                {instructions}
              </dd>
            ) : (
              <dd className="text-muted-foreground">{t("noInstructions")}</dd>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <dt className="sr-only">{t("knowledge")}</dt>
            <dd data-testid="workspace-context-knowledge">
              {t("knowledgeCount", { count: files })}
              {files > 0 && knowledgeOff ? (
                <span className="ml-1 text-muted-foreground">{t("knowledgeOff")}</span>
              ) : null}
            </dd>
            {tags.length > 0 ? (
              <>
                <dt className="sr-only">{t("tags")}</dt>
                <dd>
                  <ul className="flex flex-wrap gap-1" data-testid="workspace-context-tags">
                    {tags.map((tag) => (
                      <li key={tag}>
                        <Badge variant="secondary" className="max-w-40 truncate font-normal">
                          {tag}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </div>
        </dl>
      )}
    </ConsoleSection>
  )
}
