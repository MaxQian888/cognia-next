"use client"

/**
 * Review panel — the 选题 gate, the research the crew gathered, and the drafts
 * it saved, rendered as a plugin modal.
 *
 * Opened by the `/zhihu` slash command via
 * `ctx.modal.openModal(ReviewModal, undefined, { size: "lg" })`. The host
 * draws the dialog frame, its width and its close button; this body sets no
 * width of its own (a fixed one overflowed a 375px screen) and bounds only its
 * height, scrolling inside it. Tables are read through the activate-published
 * pipeline DB with `useLiveQuery`; host calls go through the published
 * `ReviewHost` (`db/runtime.ts`).
 */

import { useId, useState } from "react"
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon } from "lucide-react"
import type { PluginModalProps } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import {
  Button,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
  useLiveQuery,
} from "@cognia/plugin-ui"
import { getPipelineDb, getReviewHost } from "../db/runtime"
import type { DraftRow, ResearchRow, TopicRow } from "../db/tables"
import { PLUGIN_ID } from "../ids"
import { startWritingForTopic } from "./start-writing"

/** 36px on touch-first narrow screens, compact from `sm` up. */
const TOUCH_BUTTON = "h-9 sm:h-8"

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A read that reports its failure instead of throwing into the renderer. */
type Loaded<T> = { rows: T[] } | { error: string }

function load<T>(read: (() => Promise<T[]>) | null): Promise<Loaded<T>> {
  if (!read) return Promise.resolve({ rows: [] })
  return read().then(
    (rows) => ({ rows }),
    (error: unknown) => ({ error: messageOf(error) })
  )
}

export function ReviewModal({ onClose }: PluginModalProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const db = getPipelineDb()
  const host = getReviewHost()
  const headingId = useId()
  const [actionError, setActionError] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [openDrafts, setOpenDrafts] = useState<ReadonlySet<string>>(() => new Set())

  const topics = useLiveQuery<Loaded<TopicRow>>(() => load(db ? () => db.listTopics() : null), [db])
  const research = useLiveQuery<Loaded<ResearchRow>>(
    () => load(db ? () => db.listResearch() : null),
    [db]
  )
  const drafts = useLiveQuery<Loaded<DraftRow>>(() => load(db ? () => db.listDrafts() : null), [db])

  const loadError = [topics, research, drafts].find((result): result is { error: string } =>
    Boolean(result && "error" in result)
  )?.error
  const allTopics = topics && "rows" in topics ? topics.rows : undefined
  const candidates = allTopics?.filter((topic) => topic.status === "candidate")
  const topicsById = new Map((allTopics ?? []).map((topic) => [topic.id, topic]))

  async function onStart(topic: TopicRow) {
    if (!db || !host) return
    setActionError(null)
    setStarting(topic.id)
    try {
      await startWritingForTopic(topic, {
        startSeededSession: (input) => host.session.startSeededSession(input),
        markTopicStatus: (id, status, sessionId) => db.setTopicStatus(id, status, sessionId),
        sessionTitle: (title) => t("session.title", { title }),
      })
      onClose()
    } catch (error) {
      setActionError(t("review.startFailed", { message: messageOf(error) }))
    } finally {
      setStarting(null)
    }
  }

  async function onCopy(draft: DraftRow) {
    if (!host) return
    try {
      await host.clipboard.writeText(draft.markdownBody)
      host.ui.showToast(t("review.draftCopied"), "success")
    } catch (error) {
      setActionError(t("review.draftCopyFailed", { message: messageOf(error) }))
    }
  }

  async function onOpenSession(sessionId: string) {
    if (!host) return
    try {
      await host.session.switchSession(sessionId)
      onClose()
    } catch (error) {
      setActionError(t("review.draftOpenFailed", { message: messageOf(error) }))
    }
  }

  const toggleDraft = (id: string) =>
    setOpenDrafts((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="zhihu-review">
      <DialogHeader>
        <DialogTitle id={headingId}>{t("review.title")}</DialogTitle>
        <DialogDescription>{t("review.subtitle")}</DialogDescription>
      </DialogHeader>

      <div className="-mx-1 flex max-h-[70dvh] min-w-0 flex-col gap-5 overflow-y-auto px-1">
        {!db ? (
          <p className="text-xs text-muted-foreground" data-testid="zhihu-review-no-storage">
            {t("review.storageUnavailable")}
          </p>
        ) : null}

        {loadError ? (
          <p role="alert" className="text-xs text-destructive">
            {t("review.loadFailed", { message: loadError })}
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="text-xs text-destructive" data-testid="zhihu-review-error">
            {actionError}
          </p>
        ) : null}

        <section className="space-y-2" aria-labelledby={`${headingId}-candidates`}>
          <h3 id={`${headingId}-candidates`} className="text-sm font-medium text-muted-foreground">
            {t("review.candidates")}
          </h3>
          {candidates === undefined ? (
            <p className="text-xs text-muted-foreground">{t("review.loading")}</p>
          ) : candidates.length === 0 ? (
            <div className="space-y-2" data-testid="zhihu-review-empty">
              <p className="text-xs text-muted-foreground">{t("review.empty")}</p>
              <Button
                variant="outline"
                size="sm"
                className={TOUCH_BUTTON}
                disabled={!host}
                onClick={() => {
                  if (host?.ui.navigate("/workflows")) onClose()
                }}
              >
                {t("review.openWorkflows")}
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {candidates.map((topic) => (
                <li
                  key={topic.id}
                  className="flex flex-col gap-2 py-2 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium break-words">{topic.title}</p>
                    {topic.reason ? (
                      <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
                        {topic.reason}
                      </p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      {topic.source}
                      {typeof topic.score === "number" ? ` · ${topic.score}` : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className={cn(TOUCH_BUTTON, "shrink-0 self-start")}
                    disabled={!host || starting !== null}
                    onClick={() => void onStart(topic)}
                    aria-label={t("review.startWritingAria", { title: topic.title })}
                  >
                    {t("review.startWriting")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2" aria-labelledby={`${headingId}-research`}>
          <h3 id={`${headingId}-research`} className="text-sm font-medium text-muted-foreground">
            {t("review.research")}
          </h3>
          {research === undefined ? (
            <p className="text-xs text-muted-foreground">{t("review.loading")}</p>
          ) : "rows" in research && research.rows.length > 0 ? (
            <ul className="divide-y" data-testid="zhihu-review-research">
              {research.rows.map((note) => (
                <li key={note.id} className="space-y-0.5 py-2 text-xs">
                  <p className="text-muted-foreground">
                    {note.kind}
                    {note.topicId && topicsById.get(note.topicId)
                      ? ` · ${topicsById.get(note.topicId)?.title}`
                      : ""}
                  </p>
                  <p className="break-words whitespace-pre-wrap">{note.content}</p>
                  {note.sourceUrl ? (
                    <a
                      href={note.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex min-h-9 items-center gap-1 break-all text-muted-foreground underline-offset-4 focus-visible:underline focus-visible:outline-none sm:min-h-0 [@media(hover:hover)]:hover:underline"
                    >
                      <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
                      {t("review.researchSource")}: {note.sourceUrl}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("review.researchEmpty")}</p>
          )}
        </section>

        <section className="space-y-2" aria-labelledby={`${headingId}-drafts`}>
          <h3 id={`${headingId}-drafts`} className="text-sm font-medium text-muted-foreground">
            {t("review.drafts")}
          </h3>
          {drafts === undefined ? (
            <p className="text-xs text-muted-foreground">{t("review.loading")}</p>
          ) : "rows" in drafts && drafts.rows.length > 0 ? (
            <ul className="divide-y">
              {drafts.rows.map((draft) => {
                const open = openDrafts.has(draft.id)
                const sessionId = draft.topicId
                  ? topicsById.get(draft.topicId)?.sessionId
                  : undefined
                const bodyId = `${headingId}-draft-${draft.id}`
                return (
                  <li key={draft.id} className="space-y-2 py-2" data-testid="zhihu-review-draft">
                    <p className="text-sm break-words">{draft.title}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className={TOUCH_BUTTON}
                        aria-expanded={open}
                        aria-controls={bodyId}
                        aria-label={t(open ? "review.draftHideAria" : "review.draftShowAria", {
                          title: draft.title,
                        })}
                        onClick={() => toggleDraft(draft.id)}
                      >
                        {open ? (
                          <ChevronDownIcon aria-hidden className="size-3.5" />
                        ) : (
                          <ChevronRightIcon aria-hidden className="size-3.5" />
                        )}
                        {t(open ? "review.draftHide" : "review.draftShow")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className={TOUCH_BUTTON}
                        disabled={!host}
                        aria-label={t("review.draftCopyAria", { title: draft.title })}
                        onClick={() => void onCopy(draft)}
                      >
                        <CopyIcon aria-hidden className="size-3.5" />
                        {t("review.draftCopy")}
                      </Button>
                      {sessionId ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className={TOUCH_BUTTON}
                          disabled={!host}
                          aria-label={t("review.draftOpenSessionAria", { title: draft.title })}
                          onClick={() => void onOpenSession(sessionId)}
                        >
                          {t("review.draftOpenSession")}
                        </Button>
                      ) : null}
                    </div>
                    {open ? (
                      <pre
                        id={bodyId}
                        className="max-h-80 overflow-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap"
                        data-testid="zhihu-review-draft-body"
                      >
                        {draft.markdownBody}
                      </pre>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("review.draftsEmpty")}</p>
          )}
        </section>
      </div>
    </div>
  )
}

export default ReviewModal
