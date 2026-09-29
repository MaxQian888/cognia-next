"use client"

/**
 * One run artifact as a link. URLs and app routes are plain anchors; a Cognia
 * artifact (`artifact:<id>`) opens in the conversation it was made in, the
 * same way the Files page opens it (`openArtifactInSession`), since an
 * `artifact:` href means nothing to a browser.
 */

import { ExternalLinkIcon, FileIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { openArtifactInSession } from "@/lib/files-library/open"
import type { IssueRunArtifact } from "@/types/issues"

const LINK_CLASS = "inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"

export interface IssueRunArtifactLinkProps {
  artifact: IssueRunArtifact
  testId?: string
}

export function IssueRunArtifactLink({
  artifact,
  testId = "issue-run-artifact",
}: IssueRunArtifactLinkProps) {
  const t = useTranslations("issues")
  const router = useRouter()

  if (artifact.artifactId) {
    const { artifactId, sessionId } = artifact
    return (
      <button
        type="button"
        className={LINK_CLASS}
        data-testid={testId}
        onClick={() => {
          void (async () => {
            const opened = sessionId
              ? await openArtifactInSession(artifactId, sessionId, router)
              : false
            if (!opened) toast.error(t("deliverables.conversationGone"))
          })()
        }}
      >
        <FileIcon className="size-3" />
        {artifact.label}
      </button>
    )
  }

  return (
    <a
      href={artifact.href}
      target={artifact.href.startsWith("/") ? undefined : "_blank"}
      rel="noreferrer noopener"
      className={LINK_CLASS}
      data-testid={testId}
    >
      <ExternalLinkIcon className="size-3" />
      {artifact.label}
    </a>
  )
}
