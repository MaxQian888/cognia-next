"use client"

/**
 * Review panel — the 选题 gate + drafts review, rendered as a plugin modal.
 *
 * Opened by the `/zhihu` slash command via `ctx.modal.openModal(ReviewModal)`;
 * `<PluginModalRoot/>` (app/layout) renders it inside the app providers, so the
 * app hooks below resolve. Reads the plugin's namespaced Dexie tables through
 * the activate-published singleton (`getPipelineDb`) with `useLiveQuery` for
 * reactivity, and hands a chosen topic to the tool-enabled Writer chat via
 * `startWritingForTopic`.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { startSeededSession } from "@cognia/plugin-sdk/api/agent-turn"
import type { PluginModalProps } from "@cognia/plugin-sdk"
import { Button } from "@cognia/plugin-ui"
import { getPipelineDb } from "../db/runtime"
import type { DraftRow, TopicRow } from "../db/tables"
import { startWritingForTopic } from "./start-writing"
import { usePluginT } from "./use-plugin-t"

export function ReviewModal({ onClose }: PluginModalProps) {
  const t = usePluginT()
  const db = getPipelineDb()

  const topics = useLiveQuery<TopicRow[] | undefined>(
    () => (db ? db.listTopics("candidate") : Promise.resolve([])),
    [db]
  )
  const drafts = useLiveQuery<DraftRow[] | undefined>(
    () => (db ? db.listDrafts() : Promise.resolve([])),
    [db]
  )

  async function onStart(topic: TopicRow) {
    if (!db) return
    await startWritingForTopic(topic, {
      startSeededSession,
      markTopicStatus: (id, status) => db.setTopicStatus(id, status),
    })
    onClose()
  }

  return (
    <section
      aria-label={t("review.title")}
      className="flex max-h-[80vh] w-[min(640px,92vw)] flex-col gap-4 overflow-y-auto p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("review.title")}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("review.close")}
        </Button>
      </header>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">{t("review.candidates")}</h3>
        {topics === undefined ? (
          <p className="text-xs text-muted-foreground">{t("review.loading")}</p>
        ) : topics.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("review.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {topics.map((topic) => (
              <li
                key={topic.id}
                className="flex items-start justify-between gap-3 rounded-md border p-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{topic.title}</p>
                  {topic.reason ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{topic.reason}</p>
                  ) : null}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {topic.source}
                    {typeof topic.score === "number" ? ` · ${topic.score}` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => void onStart(topic)}
                  aria-label={t("review.startWritingAria", { title: topic.title })}
                >
                  {t("review.startWriting")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-muted-foreground">{t("review.drafts")}</h3>
        {drafts === undefined ? (
          <p className="text-xs text-muted-foreground">{t("review.loading")}</p>
        ) : drafts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("review.draftsEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {drafts.map((draft) => (
              <li key={draft.id} className="truncate rounded-md border p-2 text-sm">
                {draft.title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

export default ReviewModal
