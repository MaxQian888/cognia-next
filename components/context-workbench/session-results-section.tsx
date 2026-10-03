"use client"

import { useMemo } from "react"
import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"
import { useTranslations } from "next-intl"
import { ArtifactList } from "@/components/artifacts/artifact-list"
import { ExternalLink } from "@/components/shared/external-link"
import { FilePartPreview } from "@/components/chat/message-parts/file-part-preview"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useSessionResourceChanges } from "@/hooks/chat/use-session-resource-changes"
import { collectAssistantOutputFiles, collectSharedLinks } from "@/lib/chat/session-links"

export interface SessionResultsSectionProps {
  session: ChatSession
  messages: readonly UIMessage[]
  onNavigate: (panelId: string) => void
}

/**
 * The results a session produced, in the dock's Task overview panel; editing
 * remains in each source's own panel. The compact summary of the same data is
 * the session summary card, which reads the same hooks.
 */
export function SessionResultsSection({
  session,
  messages,
  onNavigate,
}: SessionResultsSectionProps) {
  const t = useTranslations("contextWorkbench.taskOverview.results")
  const tResources = useTranslations("artifacts.workspace.taskResources")
  const changes = useSessionResourceChanges(session.id)
  const { resources, tracked } = changes
  const outputs = useMemo(() => collectAssistantOutputFiles(messages), [messages])
  const sharedLinks = useMemo(() => collectSharedLinks(messages, outputs), [messages, outputs])

  return (
    <section aria-label={t("title")} className="space-y-4 border-t pt-4">
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("artifacts")}</h4>
        <ArtifactList key={session.id} sessionId={session.id} lockSessionScope maxHeight="280px" />
      </div>
      <div className="space-y-2">
        <h4 className="text-xs font-medium text-muted-foreground">{t("files")}</h4>
        {!changes.available ? (
          <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
        ) : (
          <>
            {changes.settled && !tracked ? (
              <p className="text-xs text-muted-foreground">{t("unavailable")}</p>
            ) : null}
            {changes.loading ? (
              <p role="status" className="text-xs text-muted-foreground">
                {t("loading")}
              </p>
            ) : null}
            {changes.failed ? (
              <div role="alert" className="text-xs">
                <p>{t("failed")}</p>
                <Button variant="ghost" size="sm" onClick={changes.retry}>
                  {t("retry")}
                </Button>
              </div>
            ) : null}
            {tracked && resources?.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("emptyFiles")}</p>
            ) : null}
            {resources && resources.length > 0 ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t("fileCount", { count: resources.length })}
                </p>
                <ul className="space-y-1">
                  {resources.slice(0, 5).map((resource) => (
                    <li
                      key={`${resource.runId}:${resource.path}`}
                      className="flex min-w-0 items-center gap-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate" title={resource.path}>
                        {resource.path}
                      </span>
                      <Badge variant="outline">{tResources(resource.kind)}</Badge>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {tracked ? (
              <Button variant="outline" size="sm" onClick={() => onNavigate("workspace")}>
                {t("openWorkspace")}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {outputs.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("outputs")}</h4>
          <ul className="space-y-1">
            {outputs.map((output) => (
              <li key={output.url} className="min-w-0">
                <FilePartPreview
                  url={output.url}
                  filename={output.filename}
                  mediaType={output.mediaType}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {sharedLinks.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("sharedLinks")}</h4>
          <p className="text-xs text-muted-foreground">{t("sharedLinksDescription")}</p>
          <ul className="space-y-1">
            {sharedLinks.map((url) => (
              <li key={url} className="min-w-0">
                <ExternalLink
                  href={url}
                  preferEmbedded
                  className="block truncate text-xs text-primary underline"
                  title={url}
                >
                  {url}
                </ExternalLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
