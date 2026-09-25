"use client"

/**
 * Where this item lives and who put it there (ADR-0179 §1).
 *
 * `createdBy`, `createdAt` and `updatedAt` existed on every app task and no
 * pane rendered them. A user who finds an unfamiliar row needs to tell "I
 * set this up and forgot" from "something set this up on my behalf".
 */

import { useTranslations } from "next-intl"
import { ArrowUpRightIcon, MessagesSquareIcon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { FactList, FactRow } from "@/components/surface/fact-list"
import type { ScheduledTask } from "@/types/scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

import { focusSessionInItsWorkspace } from "../../run-artifact-links"

export interface OriginSectionProps {
  item: UnifiedScheduledItem
  task?: ScheduledTask
}

export function OriginSection({ item, task }: OriginSectionProps) {
  const t = useTranslations("scheduler")
  const tDetail = useTranslations("scheduler.detail")
  const router = useRouter()
  const createdBy = item.createdBySource ?? task?.createdBy?.kind
  // An agent that scheduled this recorded the conversation it was in; that is
  // where the user can ask why, or ask for it to be changed.
  const authoringSessionId =
    task?.createdBy?.kind === "agent" ? task.createdBy.sessionId : undefined
  // A link back to the page itself is not an "open elsewhere".
  const externalLink = !item.origin.deepLinkHref.startsWith("/scheduler")

  return (
    <div className="space-y-3">
      <FactList>
        <FactRow label={t("taskType")}>{t(`kindFilter.${item.kind}`)}</FactRow>
        {item.origin.tableName ? (
          <FactRow label={tDetail("storage")} mono>
            {item.origin.tableName}
          </FactRow>
        ) : null}
        {createdBy ? (
          <FactRow label={tDetail("createdBy")}>
            {createdBy === "user" ? tDetail("createdByUser") : t(`authoredBy.${createdBy}`)}
          </FactRow>
        ) : null}
        {task?.createdAt ? (
          <FactRow label={t("createdAt")}>{new Date(task.createdAt).toLocaleString()}</FactRow>
        ) : null}
        {task?.updatedAt ? (
          <FactRow label={tDetail("updatedAt")}>
            {new Date(task.updatedAt).toLocaleString()}
          </FactRow>
        ) : null}
        <FactRow label={tDetail("identifier")} mono>
          {item.sourceId}
        </FactRow>
      </FactList>
      {authoringSessionId ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() =>
            void focusSessionInItsWorkspace(authoringSessionId).then(() => router.push("/"))
          }
          data-testid="origin-open-conversation"
        >
          <MessagesSquareIcon className="mr-1.5 size-3.5" aria-hidden="true" />
          {tDetail("openAuthoringConversation")}
        </Button>
      ) : null}
      {externalLink ? (
        <Button
          asChild
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          data-testid="origin-open-source"
        >
          <Link href={item.origin.deepLinkHref}>
            <ArrowUpRightIcon className="mr-1.5 size-3.5" aria-hidden="true" />
            {item.kind === "workflow"
              ? t("openInWorkflowEditor")
              : item.kind === "plugin"
                ? t("openInPluginSettings")
                : t("openInSourceEditor")}
          </Link>
        </Button>
      ) : null}
    </div>
  )
}
