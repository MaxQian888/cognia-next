"use client"

/**
 * Turn a picked remote document into a staged composer attachment (ADR-0134).
 *
 * The point of this hook is that it does NOT invent a delivery path. Once the
 * body is text it becomes an ordinary `File` and rejoins the attachment
 * pipeline every dropped or pasted document already uses
 * (`prepareComposerAttachments` then `staged-attachment-store` then
 * `lib/chat/attachments/dispatch.ts`). That is what buys, for free and without
 * a second implementation: the PII redaction gate, the token count on the chip,
 * the `INLINE_TOKEN_CEILING` over-length confirmation, the "model view"
 * preview, and draft restoration.
 *
 * Three things are added on top:
 *   - the body is wrapped with `wrapUntrustedContent`, because a Feishu or
 *     Google document is third-party text that must not read as instructions;
 *   - a truncated fetch warns, so a capped spreadsheet never looks complete;
 *   - the file carries its citation into the intake, which binds it to the
 *     attachment the gate stages (`lib/chat/mentions/attachment-citations.ts`).
 *     A fetch that failed, or a file the gate refused, stages nothing and so
 *     cites nothing, and a chip removed before sending takes its citation with
 *     it.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { loggers } from "@cognia/logging"
import { remoteDocCitation } from "@/lib/chat/mentions/attachment-citations"
import type { ContextRef } from "@/lib/chat/mentions/types"
import { wrapUntrustedContent } from "@/lib/web/untrusted-content"
import {
  DocsProviderError,
  getDocsProvider,
  type RemoteDocContent,
  type RemoteDocRef,
} from "@/lib/docs-providers"

/** Extension per body format. It decides how `detectDocumentType` routes the file. */
const FORMAT_EXTENSION: Record<RemoteDocContent["format"], string> = {
  markdown: "md",
  text: "txt",
  csv: "csv",
}

const FORMAT_MIME: Record<RemoteDocContent["format"], string> = {
  markdown: "text/markdown",
  text: "text/plain",
  csv: "text/csv",
}

/** Characters unsafe in a filename on at least one supported OS, plus separators. */
const UNSAFE_FILENAME_CHARS = /[\x00-\x1f/\\:*?"<>|]/g

/**
 * Make a title safe as a filename without losing it: path separators and the
 * Windows-reserved characters go, everything else (CJK included) stays, and an
 * empty result falls back to the document id rather than to "untitled".
 */
export function remoteDocFileName(
  title: string,
  id: string,
  format: RemoteDocContent["format"]
): string {
  const cleaned = title
    .replace(UNSAFE_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
  return `${cleaned || id}.${FORMAT_EXTENSION[format]}`
}

/** Build the `File` the composer stages. Exported so the wrapping is testable. */
export function remoteDocToFile(content: RemoteDocContent): File {
  return new File(
    [wrapUntrustedContent(content.text)],
    remoteDocFileName(content.title, content.ref.id, content.format),
    { type: FORMAT_MIME[content.format] }
  )
}

export interface RemoteDocStagingItem {
  providerId: string
  accountId: string
  doc: RemoteDocRef
}

export interface UseRemoteDocStagingOptions {
  /**
   * The composer's own attachment intake, the same gate drops and pastes use.
   * Resolves to the files it actually staged; a refused file is absent, and
   * the gate has already toasted why. `citations` ride each file to the
   * attachment id the gate's `add()` mints.
   */
  acceptFiles: (
    files: File[],
    options: { citations: ReadonlyMap<File, ContextRef> }
  ) => Promise<readonly File[]>
}

/**
 * Returns the `stageRemoteDoc` capability the mention pick registry expects.
 *
 * Resolves to the staged `File`, or `null` when nothing was staged: no
 * provider, a failed fetch, or a file the attachment gate refused.
 */
export function useRemoteDocStaging({ acceptFiles }: UseRemoteDocStagingOptions) {
  const t = useTranslations("docsProviders")

  return useCallback(
    async (item: RemoteDocStagingItem): Promise<File | null> => {
      const provider = getDocsProvider(item.providerId)
      if (!provider) {
        toast.error(t("errors.notConfigured"))
        return null
      }
      const pending = toast.loading(t("picker.fetching", { title: item.doc.title }))
      let content: RemoteDocContent
      try {
        content = await provider.fetch(item.doc, { accountId: item.accountId })
      } catch (err) {
        loggers.chat.warn("remote doc fetch failed", {
          provider: item.providerId,
          kind: item.doc.kind,
          err: err instanceof Error ? err.message : String(err),
        })
        const message =
          err instanceof DocsProviderError
            ? t(`errors.${err.code}`, err.params ?? {})
            : t("errors.network", { reason: err instanceof Error ? err.message : String(err) })
        toast.error(message, { id: pending })
        return null
      }

      const file = remoteDocToFile(content)
      let staged: readonly File[]
      try {
        staged = await acceptFiles([file], {
          citations: new Map([[file, remoteDocCitation(item, content.title)]]),
        })
      } catch (err) {
        // Kept apart from the fetch failure above: the document WAS read, so
        // "could not reach the service" would send the user to the wrong fix.
        loggers.chat.warn("remote doc staging failed", {
          provider: item.providerId,
          kind: item.doc.kind,
          err: err instanceof Error ? err.message : String(err),
        })
        toast.error(t("picker.attachFailed", { title: content.title }), { id: pending })
        return null
      }
      if (!staged.includes(file)) {
        // The gate refused it (count headroom, size) and has toasted its own
        // reason. "Attached" here would contradict that toast.
        toast.dismiss(pending)
        return null
      }
      toast.success(t("picker.attached", { title: content.title }), { id: pending })
      if (content.truncated) {
        toast.warning(t("picker.truncated", { title: content.title }))
      }
      return file
    },
    [acceptFiles, t]
  )
}
